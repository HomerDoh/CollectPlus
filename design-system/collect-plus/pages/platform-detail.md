# Page Override: Platform Content Detail View

> Applies to `src/entrypoints/library/components/ItemDetailDrawer.tsx` and `src/entrypoints/library/components/ItemCommentsPanel.tsx`.  
> Runtime stylesheets are split per platform under `src/styles/platforms/<platform>.css`, aggregated by `src/styles/platform-detail-themes.css`, and registered in `src/theme/platform-detail-themes.ts`.

## Override Rule

While the Library shell, Sidebar, Grid, Settings, Popup, and Modals follow the global **Swiss Precision** palette (`--cp-*`), opening a saved item's **Detail View** mounts `data-platform={item.platform}` on `[data-testid="item-detail-dialog"]`.

All child surfaces inside the detail view consume `--pd-*` tokens:
- **Brand & Badge**: `--pd-brand-bar`, `--pd-badge-bg`, `--pd-badge-text`
- **Stage & Media Controls**: `--pd-stage`, `--pd-stage-bar`, `--pd-stage-border`, `--pd-stage-text`, `--pd-stage-muted`, `--pd-media-control-bg`, `--pd-media-control-hover`, `--pd-media-control-text`
- **Article & Surfaces**: `--pd-article-bg`, `--pd-article-text`, `--pd-article-muted`, `--pd-surface`, `--pd-surface-muted`, `--pd-input`
- **Typography & Borders**: `--pd-text`, `--pd-text-secondary`, `--pd-text-muted`, `--pd-border`, `--pd-divider`, `--pd-scrollbar-thumb`
- **Accents**: `--pd-accent`, `--pd-accent-hover`, `--pd-accent-soft`, `--pd-on-accent`, `--pd-accent-secondary`, `--pd-accent-secondary-soft`, `--pd-like-accent`
- **Geometry & Depth**: `--pd-dialog-shadow`, `--pd-radius-dialog`, `--pd-radius-control`, `--pd-radius-pill`

| Platform (`data-platform`) | Stylesheet | Light Accent / Secondary | Dark Accent / Secondary | Radius (Dialog / Pill) |
|---|---|---|---|---|
| `douyin` | `platforms/douyin.css` | `#FE2C55` / `#161823` | `#FE2C55` / `#F1F1F2` | `8px` / `4px` |
| `bilibili` | `platforms/bilibili.css` | `#FB7299` / `#00AEEC` | `#FB7299` / `#33C1F2` | `12px` / `9999px` |
| `xiaohongshu` | `platforms/xiaohongshu.css` | `#FF2442` / `#13386C` | `#FF2E4D` / `#7AA7E8` | `16px` / `9999px` |
| `zhihu` | `platforms/zhihu.css` | `#0066FF` / `#1772F6` | `#3B82F6` / `#60A5FA` | `8px` / `4px` |
| `v2ex` | `platforms/v2ex.css` | `#4D5256` / `#778087` | `#60A5FA` / `#93C5FD` | `6px` / `3px` |
| `youtube` | `platforms/youtube.css` | `#CC0000` / `#065FD4` | `#FF4E45` / `#3EA6FF` | `12px` / `9999px` |
| `twitter` | `platforms/twitter.css` | `#1D9BF0` / `#1D9BF0` | `#1D9BF0` / `#78C2F8` | `16px` / `9999px` |
| `instagram` | `platforms/instagram.css` | `#E1306C` / `#0095F6` | `#F56040` / `#38A8FF` | `12px` / `9999px` |

## Adding a New Platform

1. Create `src/styles/platforms/<id>.css` with both `[data-platform='<id>']` and `html[data-theme='dark'] [data-platform='<id>']` blocks.
2. Add `@import "./platforms/<id>.css";` to `src/styles/platform-detail-themes.css`.
3. Register the platform metadata in `src/theme/platform-detail-themes.ts`.
