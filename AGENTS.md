# AGENTS.md

本文件遵循 [AGENTS.md](https://agents.md/) 开放规范，为所有参与 **Collect+** 项目的 AI Coding Agent（Cursor、Codex、Claude Code、Gemini CLI 等）提供持久化架构上下文、开发命令、工程红线与三层采集拓展 SOP。

## 1. Project Overview

- **项目名称**：Collect+（包名 `collect-plus`，本地收藏库默认目录 `CollectVault`）
- **产品定位**：开源、本地优先、零外部后端依赖的 Chrome Manifest V3 跨平台全网防失效收藏管理扩展。
- **核心采集架构（通用内核 + 三层渐进提取）**：
  - **Tier 1 通用全网提取引擎（Universal Web Extractor，`platform: 'web'`）**：零配置兜底任意 `http://` / `https://` 网页。平时**零注入、零内存占用**，仅在用户点击 Popup 或按下 `Alt+S` 时经 `chrome.scripting.executeScript` 按需注入轻量无 React 脚本，提取 JSON-LD / OpenGraph / 语义正文 / 高清配图 / `<video>` & `PerformanceResourceTiming`（`.mp4` / `.m3u8` / `.mpd`）媒体流，并经任务级动态 Session DNR 自动注入防盗链 `Referer`。
  - **Tier 2 声明式站点规则（Declarative Site Recipe）**：针对具有清晰全局变量、内联脚本或标准 DOM 结构的中轻度站点，通过几十行纯数据配置（零 `eval`、天然满足 MV3 CSP）即可接入，无需新建独立入口或手写网络劫持。当前内置 **XVideos**、**Pornhub** 规则作为范本。
  - **Tier 3 深度站点适配器（Deep Site Adapter）**：仅保留给具备复杂交互、无水印流优选、音视频分离混流、原生收藏双向同步、评论抓取或全量收藏夹同步的高价值复杂站点。当前覆盖 **抖音**、**B站**、**V2EX**、**小红书**、**知乎**、**YouTube**、**X / Twitter**，全部共享统一的 Main World 基座（`shared/main-bridge.ts`）与可组合 Isolated 运行时（`bridge-content-runtime.ts`）。
- **核心技术栈**：
  - 扩展框架：`WXT` (`srcDir: 'src'`, `publicDir: 'src/public'`) + `Vite`
  - 前端 UI：`React 19` + `TypeScript` (`strict: true`) + `Tailwind CSS v4` + `lucide-react`
  - 媒体下载（方案 A）：Offscreen Document 内原生 `fetch()` + `ReadableStream` + `chrome.declarativeNetRequest`（静态适配器规则段 + 下载任务级动态按需 Referer 规则池）+ `Mediabunny`（纯 TS DASH/HLS 无损混流封装）
  - 双层存储：`Dexie.js` + `dexie-react-hooks`（IndexedDB 高速索引）+ `MiniSearch`（中英文全文检索）+ `OPFS`（后台静默流式暂存）+ `File System Access API` / 云存储插件（本地 `CollectVault/` 真相源）
  - 自动化验证：原生 `node:test` 单元测试 + `@playwright/test`（基于 Chrome for Testing 加载 `.output/chrome-mv3` 扩展，结合 `context.route()` 与浏览器级 CDP `Fetch` 拦截 Offscreen 下载，实现确定性全链路 E2E 回归）

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

# 核心纯逻辑单元测试（自动分类、Recipe 编译与通用网页解析）
node --test tests/unit/*.test.ts

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
2. 运行 `node --test tests/unit/auto-folder.test.ts tests/unit/recipe-and-universal.test.ts` 确认核心纯逻辑单元测试通过。
3. 运行 `pnpm build`（`wxt build`）确认 `.output/chrome-mv3/manifest.json`（仅 2 个合并内容脚本入口 + 按需 `universal-capture.js`）、页面入口与图标完整生成。
4. 检索改动文件确认无 `any`、`@ts-ignore`、`@ts-expect-error` 或未实现的 `TODO` 空壳。
5. 涉及内容脚本、Shadow DOM、消息协议、Offscreen 下载管线、动态 DNR、存储状态机或扩展页面 UI 改动时，运行 `pnpm test:e2e` 确认浏览器全链路 E2E 全部通过。

## 3. Repository Map

```text
.
├── wxt.config.ts                          # WXT 与 MV3 Manifest（scripting + 全网 host_permissions、快捷键）
├── tsconfig.json                          # TS 严格配置（TS 7 显式声明 types: ["chrome", "node"]）
├── playwright.config.ts                   # Playwright E2E 配置（单 worker 串行、失败自动保留截图与 trace）
├── .cursor/agents/coder.md                # 专属编码子 Agent 规范（主 Agent 调度 + /coder 实现）
├── tests/
│   ├── unit/
│   │   ├── auto-folder.test.ts            # 本地智能自动分类单元测试
│   │   └── recipe-and-universal.test.ts   # 开放 PlatformId、Tier 2 Recipe 与 Tier 1 通用解析单测
│   └── e2e/
│       ├── fixtures/                      # MV3 扩展测试 Fixture 与各平台确定性 Mock + CDP 拦截
│       ├── extension-smoke.spec.ts        # 启动冒烟：SW 初始化、DNR initiator 安全红线、Popup/Library 渲染
│       ├── universal-capture.spec.ts      # Tier 1 全网通用采集（任意文章/视频 + 动态 DNR 注入与回收）
│       ├── new-platforms-capture.spec.ts  # YouTube / X（Tier 3）与 XVideos / Pornhub（Tier 2 Recipe）E2E
│       └── *-capture.spec.ts              # 抖音 / B站 / V2EX / 小红书 / 知乎等全链路回归
└── src/
    ├── types/
    │   ├── schema.ts                      # 开放 PlatformId slug、AssetRequestHeaders、统一元数据 Schema
    │   ├── storage-provider.ts            # 插件化持久化存储契约（VaultStorageBackend / VaultProviderPlugin）
    │   ├── adapter.ts                     # PlatformAdapter（含 tier / uiMeta / remoteUncollectEntryUrl）与桥接协议
    │   ├── messages.ts                    # target 隔离的跨上下文强类型消息协议与发送封装
    │   └── fs-access.d.ts                 # File System Access API 补充类型声明
    ├── storage/
    │   ├── path.ts                        # 跨平台文件名清洗、Unicode 码点截断、防路径穿越拆分、requestHeaders 透传
    │   ├── db.ts                          # CollectPlusDB（Dexie v1/v2 五表）与事务 CRUD
    │   ├── opfs.ts                        # OPFS 流式写入/读取/中止清理（collect-plus-stage/{itemId}）
    │   ├── vault.ts                       # 面向 VaultStorageBackend 的 Vault 业务核心（同步、容灾重建、双层回退）
    │   ├── providers/
    │   │   ├── registry.ts                # 持久化存储插件注册中心（本地目录 / Google Drive / 后续云存储）
    │   │   ├── local-fs/                  # 本地目录（File System Access API）独立驱动插件
    │   │   └── google-drive/              # Google Drive 远程持久化独立插件（OAuth、REST v3 分片上传、DNR 流式播放）
    │   └── search.ts                      # MiniSearch 中英文混合分词（ASCII 整词 + CJK 单字/2-gram）
    ├── download/
    │   ├── action-icon.ts                 # 扩展图标 OffscreenCanvas 环形下载进度与多任务计数渲染
    │   ├── dnr.ts                         # 三段式 Session DNR 管理（1000..29999 静态、30000..49999 任务动态池、50000+ 存储流）
    │   ├── offscreen-manager.ts           # Offscreen Document 并发锁创建与 PING 握手保活
    │   └── pipeline.ts                    # 方案 A 流式下载（direct / dash_mux / hls_mux）与 WebP 缩略图
    ├── adapters/
    │   ├── registry.ts                    # 三层适配器注册中心（单点真相源：Tier 3 -> Tier 2 -> Tier 1 兜底）
    │   ├── shared/
    │   │   └── main-bridge.ts             # Main World 共享基座（单次安装锁、只读 fetch/XHR 观察总线、LRU、桥接通道）
    │   ├── universal/                     # Tier 1 通用全网提取引擎（零外部依赖）
    │   │   ├── extractor.ts               # JSON-LD / OG / 语义正文清洗 / 配图 / video & PerformanceResourceTiming 嗅探
    │   │   └── parser.ts                  # universalWebAdapter（platform='web'，自动生成 Referer requestHeaders）
    │   ├── recipes/                       # Tier 2 声明式站点规则引擎（纯数据配置、零 eval、MV3 CSP 兼容）
    │   │   ├── schema.ts                  # SiteRecipe 强类型纯数据契约
    │   │   ├── executor.ts                # compileRecipeAdapter + installRecipeMainHook
    │   │   ├── builtin/                   # 内置声明式站点规则（xvideos.recipe.ts、pornhub.recipe.ts 等）
    │   │   └── index.ts                   # 内置 Recipe 汇总与编译导出
    │   ├── douyin/                        # Tier 3：抖音（parser.ts + main-hook.ts）
    │   ├── bilibili/                      # Tier 3：B站 DASH 混流（parser.ts + main-hook.ts）
    │   ├── v2ex/                          # Tier 3：V2EX SSR（dom-extractor.ts + parser.ts + isolated-driver.ts）
    │   ├── xiaohongshu/                   # Tier 3：小红书（parser.ts + main-hook.ts）
    │   ├── zhihu/                         # Tier 3：知乎多形态（parser.ts + main-hook.ts）
    │   ├── youtube/                       # Tier 3：YouTube DASH 混流（parser.ts + main-hook.ts）
    │   └── twitter/                       # Tier 3：X / Twitter GraphQL（parser.ts + main-hook.ts）
    ├── components/
    │   ├── bridge-content-runtime.ts      # 统一 Isolated 运行时（能力插槽：核心浮层 + fullSync / comments / remoteUncollect / isolatedDriver）
    │   ├── CaptureOverlay.tsx             # Shadow DOM 轻悬浮采集按钮与状态反馈浮层
    │   └── capture-overlay.css            # 独立 px 隔离样式（:host { all: initial }）
    ├── styles/
    │   ├── globals.css                    # Tailwind CSS v4 + Swiss Precision 亮/暗设计令牌（--cp-*）
    │   └── platform-detail-themes.css     # 各网站内容详情页原生明暗配色样式（--pd-* + 默认回退令牌）
    ├── theme/
    │   ├── index.ts                       # 全局主题状态（system/light/dark，chrome.storage.local 跨页同步）
    │   └── platform-detail-themes.ts      # 开放平台详情页主题表（未知平台/通用网页自动回退 Swiss 默认主题）
    ├── public/icon/                       # 扩展图标（16/32/48/128.png）
    └── entrypoints/
        ├── background.ts                  # MV3 Service Worker：并发下载调度、任务级动态 DNR 生命周期、通用网页按需采集
        ├── offscreen/main.ts              # Offscreen 下载任务执行与进度回传
        ├── site-main.content.ts           # 统一 Main World 入口（仅注入需 Main Hook 的 Tier 2/3 站点）
        ├── site.content.tsx               # 统一 Isolated World 入口（单份 React + Shadow DOM 浮层，覆盖全部 Tier 2/3 站点）
        ├── universal-capture.ts           # WXT Unlisted Script（零 React，仅在触发 Tier 1 通用网页采集时按需注入）
        ├── popup/App.tsx                  # 扩展快捷弹窗（专属站点 / 通用网页 / 浏览器内部页三态适配）
        └── library/                       # 全屏管理台（动态平台筛选、通用网页站点徽标、SidebarTree、SettingsPanel 等）
```

## 4. Code Style & TypeScript Invariants

- **零 `any` 铁律**：严格启用 `strict: true`，严禁使用 `any`、非必要类型断言或 `@ts-ignore`。所有外部 API、页面拦截数据、`window.postMessage` 和 `chrome.runtime.onMessage` 负载均以 `unknown` 接收，并经运行时类型守卫收窄。
- **开放 `PlatformId` 安全边界**：`PlatformId` 为开放字符串类型（不再硬编码封闭联合类型），所有跨边界入口（`vault.ts` 重建索引、`messages.ts`、路径构造）必须经过 `isPlatformId(value)` 校验（仅允许 `^[a-z0-9][a-z0-9_-]{0,31}$` 且排除 Windows 保留设备名）。UI、Popup、主题与删除弹窗严禁写封闭 `switch (platform)`，一律查询注册中心并提供通用默认回退。
- **模块导入规范**：遵循 `verbatimModuleSyntax`，纯类型导入必须使用 `import type`；相对导入保留显式 `.ts` / `.tsx` 扩展名。
- **TypeScript 7 全局类型**：项目使用 TypeScript 7，`tsconfig.json` 中显式声明 `"types": ["chrome", "node"]`（`playwright.config.ts` 与 `tests/**` 同样纳入 `pnpm compile` 严格校验与零 `any` 约束）。如新增仅依赖全局声明的 `@types/*` 包，必须同步补充到 `compilerOptions.types`。
- **跨上下文消息隔离**：所有内部扩展消息必须携带 `target: 'background' | 'offscreen' | 'content'`，各上下文监听器先用 `isBackgroundMessage` / `isOffscreenMessage` / `isContentMessage` 过滤，非目标消息直接 `return false`。
- **Main World 纯净性**：`world: 'MAIN'` 脚本（`shared/main-bridge.ts`、`*/main-hook.ts`、`site-main.content.ts`）运行在宿主网页上下文，**严禁**引入 `chrome.*` API、Dexie 或 React 运行时；仅允许通过 `window.postMessage` + `PAGE_BRIDGE_CHANNEL` 与 Isolated Content Script 通信。
- **Declarative Recipe CSP 红线**：Tier 2 `SiteRecipe` 必须保持纯 JSON 可序列化数据声明，**严禁**引入 `eval`、`new Function` 或可执行脚本字段。
- **Shadow DOM 样式隔离**：注入宿主页面的 UI 必须使用 WXT `createShadowRootUi` + `cssInjectionMode: 'ui'`，样式表优先使用固定 `px` 单位与 `:host { all: initial; }`。
- **资源生命周期管理**：任何在 UI 中创建的 `URL.createObjectURL(file)` 必须在 `useEffect` cleanup 中成对调用 `URL.revokeObjectURL()` 释放；Background 分配的任何任务级动态 DNR 规则必须在完成、失败、取消或 SW 重启恢复时成对释放。

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
   │   ├── comments.json           # 离线评论快照（可选，仅含相对路径）
   │   ├── cover.jpg
   │   ├── video.mp4               # 视频类
   │   ├── media/01.jpg ...        # 图集类
   │   └── comments/avatars/       # 评论者离线头像（按 URL 去重，如 001.jpg ...）
   └── .trash/
   ```
   > 通用网页采集条目统一落盘于 `CollectVault/items/web/{YYYY-MM}/...`，来源站点域名与站点名称存放在 `platformExtra.siteHost` / `platformExtra.siteName`，避免在硬盘生成数百个零散一级域名目录。
2. **相对路径与元数据纯净性**：
   - 写入 `meta.json` 前**必须**调用 `stripRecordToMeta(record)` 剥离仅用于 IndexedDB 渲染的 `thumbnailDataUrl`。
   - 所有目录与文件路径均存储 POSIX 风格相对路径，由 `src/storage/path.ts` 统一清洗；`asset.requestHeaders` 仅允许写入经过 `sanitizeAssetRequestHeaders` 校验的公开 `http(s)://` `referer` / `origin`，严禁包含任何 Cookie/Token/Authorization。
3. **同步状态机不可逆破坏防护**：
   - 状态流转：`pending_download` → `opfs_staged` → `vault_synced` ↔ `meta_dirty`（异常为 `failed`）。
   - 当条目仍处于 `opfs_staged`（媒体尚在 OPFS 未落盘硬盘）时，用户编辑分类/标签/备注**不得**将其直接改成 `vault_synced`，否则会导致 OPFS 媒体漏同步。
4. **`README.txt` 守护与容灾底线**：
   - 初始化绑定、落盘同步（`flushToVault`）与索引重建（`rebuildIndexFromVault`）前均须调用 `ensureVaultReadme(root)`。
   - 清空浏览器索引缓存时**绝不**删除硬盘文件，且**绝不**清除 IndexedDB `settings` 表中的 `vault_directory_handle`。
5. **100% 离线媒体读取**：管理台播放视频/浏览图集必须走 `readItemAssetFile(item, asset.relativePath, vaultHandle)`（优先 Vault、自动回退 OPFS），不得回退请求原站远程外链。

## 6. How to Extend: Three-Tier Site Support SOP

接入新网站时，**严格按“由泛到专”三层决策树选择最小成本方案**，禁止为普通站点新增独立内容脚本入口：

### Tier 1：零代码覆盖（首选，覆盖 80%~90% 网站）
- 博客、技术文档、新闻站、Substack、Medium、GitHub、常规图站、标准 HTML5 `<video>` / HLS / DASH 站点已由 `src/adapters/universal/` 自动覆盖。
- 若发现某类通用页面提取质量有普适提升空间（如常见正文容器、JSON-LD 变体、视频 URL 模式），优先增强 `src/adapters/universal/extractor.ts` 与 `parser.ts` 惠及全网。

### Tier 2：声明式 Site Recipe（中轻度定制，约 30~60 行纯配置）
- 当站点有特定播放器全局变量、内联脚本赋值、固定作者/标签选择器或原生收藏接口，但不需要复杂状态机时：
  1. 在 `src/adapters/recipes/builtin/` 新增 `<site>.recipe.ts`（参考 `xvideos.recipe.ts` / `pornhub.recipe.ts`）；
  2. 在 `src/adapters/recipes/index.ts` 的 `BUILTIN_SITE_RECIPES` 中注册；
  3. 在 `src/entrypoints/site.content.tsx`（及需要 Main World 全局变量时的 `site-main.content.ts`）的 `matches` 数组中追加该站点域名；
  4. **无需改动** `schema.ts`、`dnr.ts`、`popup/App.tsx`、`format.ts`、`SidebarTree.tsx`、`platform-detail-themes.ts` 或 `wxt.config.ts`；
  5. 在 `tests/unit/recipe-and-universal.test.ts` 补充单测（按需补充 E2E）。

### Tier 3：深度站点适配器（仅高价值复杂交互站点）
- 仅当站点需要无水印流优选、DASH 音视频分离参数拼接、React Fiber / GraphQL 深度遍历、全量收藏夹翻页同步、评论抓取或后台静默取消原站收藏时：
  1. 在 `src/adapters/<site>/` 实现 `parser.ts`（实现 `PlatformAdapter`，填写 `tier: 'deep'`、`uiMeta` 及可选 `remoteUncollectEntryUrl`）；
  2. 如需 Main World 旁路拦截，实现 `main-hook.ts` 并复用 `src/adapters/shared/main-bridge.ts`（严禁重复手写 `postMessage`/LRU/`sleepAbortable`/网络补丁）；如为纯 SSR 站点，参考 `src/adapters/v2ex/isolated-driver.ts` 实现 `IsolatedSiteDriver`；
  3. 在 `src/adapters/registry.ts` 的 `DEEP_SITE_ADAPTERS` 中注册；
  4. 在统一的 `src/entrypoints/site.content.tsx`（声明能力插槽 `fullSync`/`comments`/`remoteUncollect` 并追加 `matches`）与 `site-main.content.ts`（追加路由与 `matches`）中挂载——**禁止再创建新的独立 `<site>.content.tsx` 入口文件**；
  5. 如需站点专属详情页配色，可选在 `src/styles/platforms/<site>.css` 与 `src/theme/platform-detail-themes.ts` 补充（缺省自动使用 Swiss Precision 默认样式）；
  6. 补齐 Playwright E2E 回归并运行 `pnpm compile`、`pnpm build`、`pnpm test:e2e`。

### Adding a New Cloud / Remote Storage Persistence Plugin

后续拓展 **WebDAV（NAS）**、**S3 兼容对象存储（R2/OSS/MinIO）** 或 **OneDrive** 等远程持久化插件时，遵循以下独立插件规范（禁止侵入 `src/storage/vault.ts` 核心状态机）：

1. **声明插件 ID**：在 `src/types/storage-provider.ts` 的 `VAULT_PROVIDER_IDS` 中追加新标识（如 `'webdav'`、`'s3'`）。
2. **实现独立插件目录 `src/storage/providers/<provider>/`**：
   - `config.ts`：通过 `vault_provider_configs[<provider>]` 读写非敏感配置（严禁将 Token/密码/Secret 写入 IndexedDB 或 `meta.json`）；
   - `auth.ts`（如需 OAuth）：短期令牌仅存内存与 `chrome.storage.session`，在 Offscreen 中通过 `STORAGE_PROVIDER_AUTH` 经 Background 代理获取；
   - `backend.ts`：实现 `VaultStorageBackend`（POSIX 相对路径读写、大文件流式/分片上传、`scanItemMetaFiles` 批量扫描、可选 `resolvePlayableMedia` 复用 `src/download/dnr.ts` 的 `STORAGE_MEDIA_DNR_RULE_BASE` 会话级规则实现 `<video>` 流式播放）；
   - `index.ts`：导出 `VaultProviderPlugin` 实例。
3. **注册插件**：在 `src/storage/providers/registry.ts` 的 `REGISTERED_VAULT_PROVIDERS` 中加入新插件。
4. **独立设置面板**：在 `src/entrypoints/library/components/providers/` 新增配置卡片并在 `SettingsPanel.tsx` 挂载对应分支。
5. **补齐 E2E 回归**：参照 `tests/e2e/google-drive-vault.spec.ts` 编写离线 Mock 全链路测试。

## 7. Browser E2E Testing with Playwright

本项目统一采用 **Playwright + Chrome for Testing** 作为 Agent 浏览器验证与回归测试方案（禁止使用无法加载 MV3 扩展的内置 Browser WebView 替代回归测试）。

### 核心架构约束与避坑指南

1. **浏览器通道选择（Chrome 137+ 兼容性）**：
   - 品牌正式版 Google Chrome（137+）已移除 `--load-extension` 参数，**严禁**在 Fixture 中硬编码 `channel: 'chrome'`。
   - `tests/e2e/fixtures/extension.ts` 统一使用 `chromium.launchPersistentContext(userDataDir, { channel: 'chromium', headless, args: ['--disable-extensions-except=...', '--load-extension=...'] })`，在无头（`pnpm test:e2e`）和有头（`pnpm test:e2e:headed`）模式下均可稳定加载 MV3 扩展与 Service Worker。
   - 注意：测试加载的是构建产物 `.output/chrome-mv3/`，每次修改 `src/` 代码后**必须先执行 `pnpm build` 再运行 `pnpm test:e2e`**。
2. **复用标准 Fixture（`tests/e2e/fixtures/extension.ts`）**：
   - 每个用例自动分配独立的临时 `userDataDir` 并在结束时清理，保证 IndexedDB、OPFS 与 DNR 会话状态 100% 隔离。
   - 直接解构使用 `{ context, serviceWorker, extensionId, extensionUrl, pageErrors }`，用例结尾须断言 `expect(pageErrors).toEqual([])`。
3. **MV3 Offscreen Document 网络拦截与动态 DNR 校验**：
   - Playwright 的 `page.route()` / `context.route()` **无法拦截** Chrome MV3 Offscreen Document 发出的 `fetch()` 请求。
   - 测试媒体下载链路（含 `universal-capture.spec.ts`）时，必须通过 `context.browser().newBrowserCDPSession()` 启用浏览器级 CDP `Fetch.enable` + `Fetch.fulfillRequest` 拦截 Offscreen 发出的媒体请求，同时可断言请求头中的动态 `Referer` 以及任务结束后 `30000..49999` 动态 DNR 规则已回收；用例结束后务必调用 `dispose()` 释放 CDP Session。
4. **Shadow DOM 交互与状态断言**：
   - Playwright CSS Locator 默认穿透开放 Shadow DOM（如 `page.locator('button.cp-fab-btn')`），无需手写 `shadowRoot` 查找。
   - File System Access API（`showDirectoryPicker`）受操作系统原生弹窗限制，单测 Vault 落盘逻辑应在页面上下文注入内存 Mock `FileSystemDirectoryHandle`。
5. **真实站点有头联调（按需手工验证）**：
   - 默认 E2E 全程走确定性 Mock，免登录、零风控、数秒完成回归。
   - 如需在真实页面联调，可配合持久化用户目录启动有头模式（`.playwright-profile/` 已加入 `.gitignore`）：
     ```powershell
     $env:E2E_USER_DATA_DIR=".playwright-profile"; pnpm test:e2e:headed
     ```
6. **失败诊断与 Agent 自修复**：
   - `playwright.config.ts` 已开启 `screenshot: 'only-on-failure'`、`trace: 'retain-on-failure'`，并配置 HTML 报告 `open: 'never'`。
   - 用例失败后优先读取 `test-results/<case>/error-context.md` 与失败截图 `.png` 定位根因，修复后重新 `pnpm build` + `pnpm test:e2e` 验证。

## 8. Security & Anti-Abuse Guardrails

- **最小影响原则**：所有静态、任务动态与存储播放 Session DNR 规则**必须**设置 `initiatorDomains: [chrome.runtime.id]`，严禁修改用户正常浏览网页的请求头；静态内容脚本仅注入已注册的 Tier 2/3 站点，不对全网任意网页常驻注入脚本或 DOM。
- **免风控被动采集**：严禁在扩展内逆向或高频主动调用平台受签名保护的私有接口，所有数据尽量由页面自然浏览响应旁路截获。
- **零敏感凭证落盘**：严禁在 `meta.json`、`asset.requestHeaders`、IndexedDB 或控制台日志中存储用户的 Cookie、`Authorization`、Session Token 或私有鉴权参数。
- **不引入未批准重型依赖**：优先复用现有技术栈与原生 Web/Extension API，新增运行时依赖前需确认体积与 MV3 CSP 兼容性（禁止 `eval` / 远程脚本）。

## 9. Multi-Agent Collaboration Workflow

- 本仓库在 `.cursor/agents/coder.md` 中配置了专属编码子 Agent（`/coder`）。推荐采用「**主 Agent 负责需求拆解、架构把关、任务书派发与构建验收；`/coder` 负责精准编码落地**」的协作模式。
- 编码改动应严格控制在当前里程碑或任务书范围内，不越权改动跨模块公开契约；如需调整 `src/types/*` 或存储 Schema 版本（`SCHEMA_VERSION`），必须同步评估向后兼容与 `rebuildIndexFromVault` 迁移策略。
- 当新增平台适配器/Recipe、调整构建命令或变更存储不变量时，请同步更新本 `AGENTS.md`，使其始终作为仓库的活文档。
