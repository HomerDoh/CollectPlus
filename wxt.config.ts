import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

const googleDriveClientId = process.env.VITE_GOOGLE_DRIVE_CLIENT_ID?.trim();
const extensionPublicKey = process.env.VITE_EXTENSION_PUBLIC_KEY?.trim();

export default defineConfig({
  srcDir: 'src',
  publicDir: 'src/public',
  modules: ['@wxt-dev/module-react', '@wxt-dev/i18n/module'],
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: {
    default_locale: 'zh_CN',
    name: 'Collect+',
    short_name: 'Collect+',
    description: '__MSG_extDescription__',
    ...(extensionPublicKey ? { key: extensionPublicKey } : {}),
    permissions: [
      'storage',
      'unlimitedStorage',
      'offscreen',
      'declarativeNetRequest',
      'scripting',
      'tabs',
      'activeTab',
      'identity',
    ],
    ...(googleDriveClientId
      ? {
          oauth2: {
            client_id: googleDriveClientId,
            scopes: [
              'https://www.googleapis.com/auth/drive.file',
              'https://www.googleapis.com/auth/userinfo.email',
            ],
          },
        }
      : {}),
    // 覆盖全网按需提取（scripting.executeScript）与 Offscreen 跨站防盗链下载；
    // 静态内容脚本（site.content.tsx / site-main.content.ts）仍严格限定仅注入已注册的 Tier 2/3 站点。
    host_permissions: ['https://*/*', 'http://*/*'],
    commands: {
      'capture-current-item': {
        suggested_key: {
          default: 'Alt+S',
        },
        description: '__MSG_commandCaptureDescription__',
      },
    },
    action: {
      default_title: 'Collect+',
    },
  },
});
