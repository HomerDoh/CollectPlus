# AGENTS.md

本文件遵循 [AGENTS.md](https://agents.md/) 开放规范，为所有参与 **Collect+** 项目的 AI Coding Agent（Cursor、Codex、Claude Code、Gemini CLI 等）提供持久化架构上下文、开发命令、工程红线与后续多平台拓展 SOP。

## 1. Project Overview

- **项目名称**：Collect+（包名 `collect-plus`，本地收藏库默认目录 `CollectVault`）
- **产品定位**：开源、本地优先、零外部后端依赖的 Chrome Manifest V3 跨平台防失效收藏管理扩展。当前已完成 **抖音（`www.douyin.com`）**、**B站（`www.bilibili.com`）** 与 **V2EX（`www.v2ex.com`）** 独立收藏插件闭环，全链路按 `PlatformAdapter` 插件化架构预留横向扩展能力（小红书、X/Twitter、Instagram、知乎、YouTube）。
- **核心技术栈**：
  - 扩展框架：`WXT` (`srcDir: 'src'`, `publicDir: 'src/public'`) + `Vite`
  - 前端 UI：`React 19` + `TypeScript` (`strict: true`) + `Tailwind CSS v4` + `lucide-react`
  - 媒体下载（方案 A）：Offscreen Document 内原生 `fetch()` + `ReadableStream` + `chrome.declarativeNetRequest`（会话级动态 Referer 防盗链）+ `Mediabunny`（纯 TS DASH/HLS 无损混流封装）
  - 双层存储：`Dexie.js` + `dexie-react-hooks`（IndexedDB 高速索引）+ `MiniSearch`（中英文全文检索）+ `OPFS`（后台静默流式暂存）+ `File System Access API`（本地 `CollectVault/` 真相源）
  - 自动化验证：`@playwright/test`（基于 Chrome for Testing 加载 `.output/chrome-mv3` 扩展，结合 `context.route()` 与浏览器级 CDP `Fetch` 拦截 Offscreen 下载，实现确定性全链路 E2E 回归）

## 2. Setup, Build & Verification Commands

使用 `pnpm` 管理依赖与构建。每次修改代码后，**必须**完成类型检查与生产构建并通过验证。

```bash
# 安装依赖（postinstall 会自动执行 wxt prepare）
pnpm install

# 首次运行 E2E 前安装 Playwright Chrome for Testing 浏览器内核
pnpm exec playwright install chromium

# 开发模式（热更新加载）
pnpm dev

# 严格 TypeScript 类型检查（必须 0 错误，覆盖 src/ 与 tests/）
pnpm compile

# 生产构建（产物输出至 .output/chrome-mv3/）
pnpm build

# 浏览器全链路 E2E 测试（无头模式，运行前须先执行 pnpm build）
pnpm test:e2e

# 有头可视化调试模式 / Playwright UI 交互式追踪
pnpm test:e2e:headed
pnpm test:e2e:ui

# 打包发布用 zip
pnpm zip
```

> **Windows PowerShell 提示**：本机默认终端可能为 Windows PowerShell 5.1，不支持 `&&` 链接命令；串行执行请使用 `; if ($LASTEXITCODE -eq 0) { ... }`。

### 每次改动后的必做验收检查

1. 运行 `pnpm compile`（`tsc --noEmit`）确认 0 类型错误。
2. 运行 `pnpm build`（`wxt build`）确认 `.output/chrome-mv3/manifest.json`、页面入口、Content Script 与图标完整生成。
3. 检索改动文件确认无 `any`、`@ts-ignore`、`@ts-expect-error` 或未实现的 `TODO` 空壳。
4. 涉及内容脚本、Shadow DOM、消息协议、Offscreen 下载管线、存储状态机或扩展页面 UI 改动时，运行 `pnpm test:e2e` 确认浏览器全链路 E2E 全部通过。
5. 如改动了核心纯逻辑（路径清洗、适配器解析、搜索分词），同步补充或运行断言/E2E 回归验证。

## 3. Repository Map

```text
.
├── wxt.config.ts                          # WXT 与 MV3 Manifest（权限、host_permissions、快捷键）
├── tsconfig.json                          # TS 严格配置（TS 7 显式声明 types: ["chrome", "node"]）
├── playwright.config.ts                   # Playwright E2E 配置（单 worker 串行、失败自动保留截图与 trace）
├── .cursor/agents/coder.md                # 专属编码子 Agent 规范（主 Agent 调度 + /coder 实现）
├── tests/
│   └── e2e/
│       ├── fixtures/
│       │   ├── extension.ts               # MV3 扩展测试 Fixture（launchPersistentContext、extensionId、SW、pageErrors）
│       │   └── douyin-mock.ts             # 抖音页面/API Mock + 浏览器级 CDP Fetch 拦截 Offscreen CDN 请求
│       ├── extension-smoke.spec.ts        # 启动冒烟：SW 初始化、DNR initiator 安全红线、Popup/Library 渲染
│       └── douyin-capture.spec.ts         # 抖音全链路 E2E：悬浮按钮/原生收藏、OPFS 暂存、快捷分类、检索、离线播放与画廊
└── src/
    ├── types/
    │   ├── schema.ts                      # 统一元数据 Schema、stripRecordToMeta、SettingRecord
    │   ├── adapter.ts                     # PlatformAdapter 契约、CapturedPayload、PAGE_BRIDGE_CHANNEL
    │   ├── messages.ts                    # target 隔离的跨上下文强类型消息协议与发送封装
    │   └── fs-access.d.ts                 # File System Access API 补充类型声明
    ├── storage/
    │   ├── path.ts                        # 跨平台文件名清洗、Unicode 码点截断、防路径穿越拆分
    │   ├── db.ts                          # CollectPlusDB（Dexie v1 五表）与事务 CRUD
    │   ├── opfs.ts                        # OPFS 流式写入/读取/中止清理（collect-plus-stage/{itemId}）
    │   ├── vault.ts                       # CollectVault 绑定、README.txt 守护、VaultFlusher、重建索引
    │   └── search.ts                      # MiniSearch 中英文混合分词（ASCII 整词 + CJK 单字/2-gram）
    ├── download/
    │   ├── action-icon.ts                 # 扩展图标 OffscreenCanvas 环形下载进度与多任务计数渲染
    │   ├── dnr.ts                         # Session DNR 防盗链规则原子同步（仅限扩展自身 initiator）
    │   ├── offscreen-manager.ts           # Offscreen Document 并发锁创建与 PING 握手保活
    │   └── pipeline.ts                    # 方案 A 流式下载（direct / dash_mux / hls_mux）与 WebP 缩略图
    ├── adapters/
    │   ├── registry.ts                    # 多平台适配器注册中心与 DNR 规则汇总
    │   ├── douyin/
    │   │   ├── parser.ts                  # 抖音 aweme 归一化（H.264 优先无水印视频、图集原图）
    │   │   └── main-hook.ts               # Main World fetch/XHR 旁路拦截、200 条 LRU、React Fiber 兜底
    │   ├── bilibili/
    │   │   ├── parser.ts                  # B站视频归一化（AVC 优先 DASH 无损混流 + durl 回退、评论）
    │   │   └── main-hook.ts               # Main World fetch/XHR 拦截、__INITIAL_STATE__/__playinfo__ 合并
    │   ├── v2ex/
    │   │   ├── dom-extractor.ts           # V2EX SSR HTML 提取（正文、附言、内嵌图、回复与 /my/topics）
    │   │   └── parser.ts                  # V2EX 主题文章与回复归一化
    │   ├── xiaohongshu/
    │   │   ├── parser.ts                  # 小红书笔记归一化（H.264 优先视频、无水印图文、评论）
    │   │   └── main-hook.ts               # Main World fetch/XHR 拦截、__INITIAL_STATE__ 收割、原生收藏/同步
    │   └── zhihu/
    │       ├── parser.ts                  # 知乎多形态归一化（回答、专栏文章、想法、知乎视频、评论）
    │       └── main-hook.ts               # Main World fetch/XHR 拦截、js-initialData 解析、data-zop 视口定位
    ├── components/
    │   ├── CaptureOverlay.tsx             # Shadow DOM 轻悬浮采集按钮（静默采集无弹窗）
    │   └── capture-overlay.css            # 独立 px 隔离样式（:host { all: initial }）
    ├── styles/globals.css                 # Tailwind CSS v4 全局样式
    ├── public/icon/                       # 扩展图标（16/32/48/128.png）
    └── entrypoints/
        ├── background.ts                  # MV3 Service Worker 事件中枢与受控并发下载调度器
        ├── offscreen/main.ts              # Offscreen 下载任务执行与进度回传
        ├── douyin-main.content.ts         # 抖音 world: 'MAIN', runAt: 'document_start'
        ├── douyin.content.tsx             # 抖音 Isolated World 桥接 + Shadow DOM 浮层挂载
        ├── bilibili-main.content.ts       # B站 world: 'MAIN', runAt: 'document_start'
        ├── bilibili.content.tsx           # B站 Isolated World 桥接 + Shadow DOM 浮层挂载
        ├── v2ex.content.tsx               # V2EX Isolated World 独立入口 + Shadow DOM 浮层挂载
        ├── xiaohongshu-main.content.ts    # 小红书 world: 'MAIN', runAt: 'document_start'
        ├── xiaohongshu.content.tsx        # 小红书 Isolated World 桥接 + Shadow DOM 浮层挂载
        ├── zhihu-main.content.ts          # 知乎 world: 'MAIN', runAt: 'document_start'
        ├── zhihu.content.tsx              # 知乎 Isolated World 桥接 + Shadow DOM 浮层挂载
        ├── popup/App.tsx                  # 扩展快捷弹窗（状态检测、一键触发采集、统计速览）
        └── library/                       # 全屏管理台（SidebarTree、SettingsPanel、ItemCardGrid、ItemDetailDrawer）
```

## 4. Code Style & TypeScript Invariants

- **零 `any` 铁律**：严格启用 `strict: true`，严禁使用 `any`、非必要类型断言或 `@ts-ignore`。所有外部 API、页面拦截数据、`window.postMessage` 和 `chrome.runtime.onMessage` 负载均以 `unknown` 接收，并经运行时类型守卫收窄。
- **模块导入规范**：遵循 `verbatimModuleSyntax`，纯类型导入必须使用 `import type`；相对导入保留显式 `.ts` / `.tsx` 扩展名。
- **TypeScript 7 全局类型**：项目使用 TypeScript 7，`tsconfig.json` 中显式声明 `"types": ["chrome", "node"]`（`playwright.config.ts` 与 `tests/e2e/**` 同样纳入 `pnpm compile` 严格校验与零 `any` 约束）。如新增仅依赖全局声明的 `@types/*` 包，必须同步补充到 `compilerOptions.types`。
- **跨上下文消息隔离**：所有内部扩展消息必须携带 `target: 'background' | 'offscreen' | 'content'`，各上下文监听器先用 `isBackgroundMessage` / `isOffscreenMessage` / `isContentMessage` 过滤，非目标消息直接 `return false`，防止 Background 与 Offscreen 互相误消费。
- **Main World 纯净性**：`world: 'MAIN'` 脚本（如 `main-hook.ts`、`*-main.content.ts`）运行在宿主网页上下文，**严禁**引入 `chrome.*` API、Dexie 或 React 运行时；仅允许通过 `window.postMessage` + `PAGE_BRIDGE_CHANNEL` 与 Isolated Content Script 通信。
- **Shadow DOM 样式隔离**：注入宿主页面的 UI 必须使用 WXT `createShadowRootUi` + `cssInjectionMode: 'ui'`，样式表优先使用固定 `px` 单位与 `:host { all: initial; }`，避免受宿主页字体缩放或全局 CSS 干扰。
- **资源生命周期管理**：任何在 UI 中创建的 `URL.createObjectURL(file)` 必须在 `useEffect` cleanup 中成对调用 `URL.revokeObjectURL()` 释放，避免离线视频播放与图集切换导致内存泄漏。

## 5. Storage & CollectVault Invariants

改动存储、同步或管理台逻辑时，必须严格守住以下数据不变量：

1. **File-first 真相源**：本地硬盘 `CollectVault/` 是唯一真相源，IndexedDB 仅作为可随时清空重建的高速索引缓存。
   ```text
   CollectVault/
   ├── README.txt                  # 自动生成并守护：说明结构与严禁手动修改/删除警告
   ├── .collect-vault.json         # Vault 配置（schemaVersion、vaultId、createdAt）
   ├── taxonomy.json               # 多级文件夹树 + 标签定义
   ├── items/{platform}/{YYYY-MM}/{YYYYMMDD}_{sourceId}_{sanitizedTitle}/
   │   ├── meta.json               # 纯净结构化元数据（全量相对路径，不含 thumbnailDataUrl）
   │   ├── comments.json           # 离线评论快照（可选，如抖音视频前 100 条评论，仅含相对路径）
   │   ├── cover.jpg
   │   ├── video.mp4               # 视频类
   │   ├── media/01.jpg ...        # 图集类
   │   └── comments/avatars/       # 评论者离线头像（按 URL 去重，如 001.jpg ...）
   └── .trash/
   ```
2. **相对路径与元数据纯净性**：
   - 写入 `meta.json` 前**必须**调用 `stripRecordToMeta(record)` 剥离仅用于 IndexedDB 渲染的 `thumbnailDataUrl`。
   - 所有目录与文件路径均存储 POSIX 风格相对路径，由 `src/storage/path.ts` 统一清洗（剔除 Windows/macOS 非法字符与保留设备名、按 Unicode 码点截断标题至 36 字符、通过 `splitRelativePath` 拦截 `..` 路径穿越）。
3. **同步状态机不可逆破坏防护**：
   - 状态流转：`pending_download` → `opfs_staged` → `vault_synced` ↔ `meta_dirty`（异常为 `failed`）。
   - 当条目仍处于 `opfs_staged`（媒体尚在 OPFS 未落盘硬盘）时，用户编辑分类/标签/备注**不得**将其直接改成 `vault_synced`，否则会导致 OPFS 媒体漏同步。
4. **`README.txt` 守护与容灾底线**：
   - 初始化绑定、落盘同步（`flushToVault`）与索引重建（`rebuildIndexFromVault`）前均须调用 `ensureVaultReadme(root)`。
   - 清空浏览器索引缓存时**绝不**删除硬盘文件，且**绝不**清除 IndexedDB `settings` 表中的 `vault_directory_handle`。
5. **100% 离线媒体读取**：管理台播放视频/浏览图集必须走 `readItemAssetFile(item, asset.relativePath, vaultHandle)`（优先 Vault、自动回退 OPFS），不得回退请求原站远程外链。

## 6. How to Extend: Adding a New Platform Adapter

后续 Phase 2 / Phase 3 接入 **B 站（DASH）**、**小红书**、**X/Twitter（HLS）** 或 **Instagram** 时，按以下标准流程扩展，**禁止破坏现有存储与 UI 契约**：

1. **平台标识与 DNR 段位**：确认 `src/types/schema.ts` 的 `PLATFORM_IDS` 与 `src/download/dnr.ts` 的 `PLATFORM_DNR_RULE_BASE` 已包含目标平台（已预留 `bilibili: 2000`、`xiaohongshu: 3000`、`twitter: 4000`、`instagram: 5000`、`zhihu: 6000`、`youtube: 7000`）。
2. **权限声明**：在 `wxt.config.ts` 的 `manifest.host_permissions` 中补充目标站点及媒体 CDN 域名。
3. **实现适配器目录 `src/adapters/<platform>/`**：
   - `parser.ts`：实现 `PlatformAdapter` 接口（`matchesUrl`、`getDnrRules`、`normalizeRawData`），将平台原始数据归一化为标准 `CapturedPayload`。
     - 直链 MP4 / 原图使用 `strategy: 'direct'`；
     - B 站等音视频分离 DASH 流使用 `strategy: 'dash_mux'` 并填充 `audioUrl`，自动接入 `src/download/pipeline.ts` 的 `Mediabunny` 无损混流；
     - X/Twitter 等 M3U8 流使用 `strategy: 'hls_mux'`，自动接入 HLS 无损封装管线。
   - `main-hook.ts`：采用被动旁路拦截 `fetch`/`XHR` + LRU 缓存 + DOM/状态树兜底策略，不主动构造需要反爬签名的额外请求，不阻塞原站响应。
4. **注册适配器**：在 `src/adapters/registry.ts` 的 `REGISTERED_ADAPTERS` 中加入新适配器，DNR 防盗链与 URL 匹配将自动生效。
5. **添加内容脚本入口**：在 `src/entrypoints/` 新增 `<platform>-main.content.ts`（`world: 'MAIN'`, `runAt: 'document_start'`）与 `<platform>.content.tsx`（复用 `CaptureOverlay` Shadow DOM 组件）。
6. **UI 文案与徽标**：在 `src/entrypoints/library/utils/format.ts` 的 `platformMeta` 中确认该平台的展示文案与配色。
7. **补齐 Playwright E2E 回归**：在 `tests/e2e/fixtures/<platform>-mock.ts` 与 `tests/e2e/<platform>-capture.spec.ts` 中编写确定性 Mock 采集与离线播放用例，运行 `pnpm build` 与 `pnpm test:e2e` 验收。

## 7. Browser E2E Testing with Playwright

本项目统一采用 **Playwright + Chrome for Testing** 作为 Agent 浏览器验证与回归测试方案（禁止使用无法加载 MV3 扩展的 Cursor 内置 Browser WebView 或缺乏断言体系的通用浏览代理替代回归测试）。

### 核心架构约束与避坑指南

1. **浏览器通道选择（Chrome 137+ 兼容性）**：
   - 品牌正式版 Google Chrome（137+）已移除 `--load-extension` 参数，**严禁**在 Fixture 中硬编码 `channel: 'chrome'`。
   - `tests/e2e/fixtures/extension.ts` 统一使用 `chromium.launchPersistentContext(userDataDir, { channel: 'chromium', headless, args: ['--disable-extensions-except=...', '--load-extension=...'] })`，调用 Playwright 自带的 Chrome for Testing，在无头（`pnpm test:e2e`）和有头（`pnpm test:e2e:headed`）模式下均可稳定加载 MV3 扩展与 Service Worker。
   - 注意：测试加载的是构建产物 `.output/chrome-mv3/`，每次修改 `src/` 代码后**必须先执行 `pnpm build` 再运行 `pnpm test:e2e`**。
2. **复用标准 Fixture（`tests/e2e/fixtures/extension.ts`）**：
   - 每个用例自动分配独立的临时 `userDataDir` 并在结束时清理，保证 IndexedDB、OPFS 与 DNR 会话状态 100% 隔离。
   - 直接解构使用 `{ context, serviceWorker, extensionId, extensionUrl, pageErrors }`：
     - `serviceWorker.evaluate(...)` 可直接验证后台 `chrome.declarativeNetRequest.getSessionRules()` 等扩展内部状态；
     - `extensionUrl('library.html' | 'popup.html')` 自动拼接动态 `extensionId`；
     - 用例结尾应断言 `expect(pageErrors).toEqual([])` 确保无未捕获运行时异常。
3. **MV3 Offscreen Document 网络拦截关键机制**：
   - Playwright 的 `page.route()` / `context.route()` **无法拦截** Chrome MV3 Offscreen Document 发出的 `fetch()` 请求。
   - 测试媒体下载链路时，**必须**参照 `tests/e2e/fixtures/douyin-mock.ts` 中的 `attachBrowserCdpCdnMock`，通过 `context.browser().newBrowserCDPSession()` 启用浏览器级 CDP `Fetch.enable` + `Fetch.fulfillRequest` 拦截 Offscreen 发出的媒体 CDN 请求，返回合法 PNG/MP4 二进制负载，从而 100% 离线验证：流式下载 → OPFS 落盘 → `createImageBitmap` 生成离线 WebP 缩略图 → 管理台 `blob:` 离线播放。
   - 用例结束后务必调用 `tracker.dispose()` 释放 CDP Session。
4. **Shadow DOM 交互与状态断言**：
   - Playwright CSS Locator 默认穿透开放 Shadow DOM（如 `page.locator('button.cp-fab-btn')`），无需手写 `shadowRoot` 查找。
   - File System Access API（`showDirectoryPicker`）受操作系统原生弹窗限制，若需单测 Vault 落盘逻辑应在页面上下文注入内存 Mock `FileSystemDirectoryHandle`，不要尝试自动化 OS 文件选择器弹窗。
5. **真实站点有头联调（按需手工验证）**：
   - 默认 E2E 全程走确定性 Mock，免登录、零风控、数秒完成回归。
   - 如需在真实抖音页面验证页面结构/接口变更，可配合持久化用户目录启动有头模式（`.playwright-profile/` 已加入 `.gitignore`）：
     ```powershell
     $env:E2E_USER_DATA_DIR=".playwright-profile"; pnpm test:e2e:headed
     ```
6. **失败诊断与 Agent 自修复**：
   - `playwright.config.ts` 已开启 `screenshot: 'only-on-failure'`、`trace: 'retain-on-failure'`，并配置 HTML 报告 `open: 'never'`（不会阻塞终端）。
   - 用例失败后，Agent 应优先读取 `test-results/<case>/error-context.md`（含页面无障碍树快照）与失败截图 `.png` 定位根因，再针对性修复代码并重新 `pnpm build` + `pnpm test:e2e` 验证。

## 8. Security & Anti-Abuse Guardrails

- **最小影响原则**：所有 Session DNR 规则**必须**设置 `initiatorDomains: [chrome.runtime.id]`，严禁修改用户正常浏览网页的请求头。
- **免风控被动采集**：严禁在扩展内逆向或高频主动调用平台受签名保护的私有接口，所有数据尽量由页面自然浏览响应旁路截获。
- **零敏感凭证落盘**：严禁在 `meta.json`、IndexedDB 或控制台日志中存储用户的 Cookie、`Authorization`、Session Token 或私有鉴权参数。
- **不引入未批准重型依赖**：优先复用现有技术栈与原生 Web/Extension API，新增运行时依赖前需确认体积与 MV3 CSP 兼容性（禁止 `eval` / 远程脚本）。

## 9. Multi-Agent Collaboration Workflow

- 本仓库在 `.cursor/agents/coder.md` 中配置了专属编码子 Agent（`/coder`）。推荐采用「**主 Agent 负责需求拆解、架构把关、任务书派发与构建验收；`/coder` 负责精准编码落地**」的协作模式。
- 编码改动应严格控制在当前里程碑或任务书范围内，不越权改动跨模块公开契约；如需调整 `src/types/*` 或存储 Schema 版本（`SCHEMA_VERSION`），必须同步评估向后兼容与 `rebuildIndexFromVault` 迁移策略。
- 当新增平台适配器、调整构建命令或变更存储不变量时，请同步更新本 `AGENTS.md`，使其始终作为仓库的活文档。
