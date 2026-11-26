import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  srcDir: 'src',
  publicDir: 'src/public',
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: {
    name: 'Collect+',
    short_name: 'Collect+',
    description: '本地优先的跨平台防失效收藏管理扩展',
    permissions: [
      'storage',
      'unlimitedStorage',
      'offscreen',
      'declarativeNetRequest',
      'tabs',
      'activeTab',
    ],
    host_permissions: [
      'https://www.douyin.com/*',
      'https://*.douyin.com/*',
      'https://*.douyinvod.com/*',
      'https://*.byteimg.com/*',
      'https://*.douyinpic.com/*',
      'https://*.snssdk.com/*',
      'https://*.pstatp.com/*',
      'https://*.zjcdn.com/*',
      'https://*.ibytedtos.com/*',
    ],
    commands: {
      'capture-current-item': {
        suggested_key: {
          default: 'Alt+S',
        },
        description: '立即收藏当前页面视频或图集到 Collect+',
      },
    },
    action: {
      default_title: 'Collect+',
    },
  },
});
