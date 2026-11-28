/**
 * 零依赖 AWS Signature Version 4（SigV4）签名实现，专用于 Cloudflare R2 S3 API。
 *
 * 基于浏览器原生 Web Crypto API（`crypto.subtle`）计算 SHA-256 与 HMAC-SHA256，
 * 支持标准请求头签名与 `<video>` 流式播放专用的预签名 GET URL。
 */

export const R2_S3_REGION = 'auto';
export const R2_S3_SERVICE = 's3';
export const EMPTY_SHA256_HEX =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const textEncoder = new TextEncoder();

/** RFC 3986 严格百分比编码（含 `! ' ( ) *`） */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function bytesToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}

function toUtf8Bytes(input: string): Uint8Array<ArrayBuffer> {
  const encoded = textEncoder.encode(input);
  const copy = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  copy.set(encoded);
  return copy;
}

export async function sha256Hex(
  data: string | ArrayBuffer | Uint8Array<ArrayBuffer>,
): Promise<string> {
  const bytes = typeof data === 'string' ? toUtf8Bytes(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToHex(digest);
}

async function hmacSha256(
  keyData: ArrayBuffer | Uint8Array<ArrayBuffer>,
  message: string,
): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, toUtf8Bytes(message));
}

async function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region = R2_S3_REGION,
  service = R2_S3_SERVICE,
): Promise<ArrayBuffer> {
  const kDate = await hmacSha256(toUtf8Bytes(`AWS4${secretAccessKey}`), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

function formatAmzDates(date: Date): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

function buildCanonicalUri(pathname: string): string {
  if (!pathname || pathname === '/') {
    return '/';
  }
  return pathname
    .split('/')
    .map((segment) => {
      if (!segment) {
        return '';
      }
      // URL.pathname 可能已经过百分比编码，先解码再按 RFC 3986 统一重编码
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // 保留原始片段
      }
      return encodeRfc3986(decoded);
    })
    .join('/');
}

function buildCanonicalQueryString(searchParams: URLSearchParams): string {
  const pairs: Array<[string, string]> = [];
  for (const [key, value] of searchParams.entries()) {
    pairs.push([encodeRfc3986(key), encodeRfc3986(value)]);
  }
  pairs.sort((a, b) => {
    if (a[0] !== b[0]) {
      return a[0] < b[0] ? -1 : 1;
    }
    if (a[1] !== b[1]) {
      return a[1] < b[1] ? -1 : 1;
    }
    return 0;
  });
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

export interface SignS3RequestInput {
  method: string;
  url: URL;
  accessKeyId: string;
  secretAccessKey: string;
  bodyBytes?: ArrayBuffer;
  contentType?: string;
  now?: Date;
}

/**
 * 为 S3/R2 请求生成 AWS SigV4 签名请求头。
 * 返回值不含浏览器禁止手动设置的 `Host` 头（但 `host` 已纳入签名计算）。
 */
export async function signS3Request(
  input: SignS3RequestInput,
): Promise<Record<string, string>> {
  const { amzDate, dateStamp } = formatAmzDates(input.now ?? new Date());
  const payloadHash =
    input.bodyBytes && input.bodyBytes.byteLength > 0
      ? await sha256Hex(input.bodyBytes)
      : EMPTY_SHA256_HEX;

  const headerEntries: Array<[string, string]> = [
    ['host', input.url.host],
    ['x-amz-content-sha256', payloadHash],
    ['x-amz-date', amzDate],
  ];
  if (input.contentType) {
    headerEntries.push(['content-type', input.contentType.trim()]);
  }
  headerEntries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const canonicalHeaders = `${headerEntries.map(([k, v]) => `${k}:${v}`).join('\n')}\n`;
  const signedHeaders = headerEntries.map(([k]) => k).join(';');
  const canonicalRequest = [
    input.method.toUpperCase(),
    buildCanonicalUri(input.url.pathname),
    buildCanonicalQueryString(input.url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${R2_S3_REGION}/${R2_S3_SERVICE}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = await deriveSigningKey(input.secretAccessKey, dateStamp);
  const signature = bytesToHex(await hmacSha256(signingKey, stringToSign));

  const fetchHeaders: Record<string, string> = {
    Authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (input.contentType) {
    fetchHeaders['Content-Type'] = input.contentType.trim();
  }
  return fetchHeaders;
}

export interface CreatePresignedGetUrlInput {
  url: URL;
  accessKeyId: string;
  secretAccessKey: string;
  /** 链接有效期（秒，默认 3600 秒） */
  expiresInSeconds?: number;
  now?: Date;
}

/**
 * 生成支持 HTTP Range 拖拽播放的 S3/R2 SigV4 预签名 GET URL。
 * 仅签名 `host` 头并使用 `UNSIGNED-PAYLOAD`，天然兼容 `<video>` 多段 Range 请求。
 */
export async function createPresignedGetUrl(
  input: CreatePresignedGetUrlInput,
): Promise<string> {
  const { amzDate, dateStamp } = formatAmzDates(input.now ?? new Date());
  const expires = Math.max(60, Math.min(86_400, Math.trunc(input.expiresInSeconds ?? 3600)));
  const credentialScope = `${dateStamp}/${R2_S3_REGION}/${R2_S3_SERVICE}/aws4_request`;

  const signedUrl = new URL(input.url.toString());
  signedUrl.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  signedUrl.searchParams.set(
    'X-Amz-Credential',
    `${input.accessKeyId}/${credentialScope}`,
  );
  signedUrl.searchParams.set('X-Amz-Date', amzDate);
  signedUrl.searchParams.set('X-Amz-Expires', String(expires));
  signedUrl.searchParams.set('X-Amz-SignedHeaders', 'host');

  const canonicalRequest = [
    'GET',
    buildCanonicalUri(signedUrl.pathname),
    buildCanonicalQueryString(signedUrl.searchParams),
    `host:${signedUrl.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = await deriveSigningKey(input.secretAccessKey, dateStamp);
  const signature = bytesToHex(await hmacSha256(signingKey, stringToSign));

  signedUrl.searchParams.set('X-Amz-Signature', signature);
  return signedUrl.toString();
}
