# CollectPlus Design System — Master Specification (Swiss Precision)

> **Source of Truth** for all CollectPlus extension surfaces (`library`, `popup`, modals, and overlays).  
> Generated & adapted via `ui-ux-pro-max` (`Flat Design` / `Minimalism & Swiss Style`, Density `8/10`).

## 1. Visual Principles

- **Swiss Precision Flat Design**: Crisp `1px` structural borders, `4px–6px` sharp radii (`rounded` / `rounded-md`), zero decorative drop shadows, and zero layout-shifting hover lifts.
- **Semantic Token-Driven Theming**: Never hardcode `bg-white` / `bg-slate-50` / `text-slate-900` / `bg-indigo-*` in extension UI. Always consume `--cp-*` tokens from `src/styles/globals.css` and Tailwind `dark:` variants driven by `html[data-theme="dark"]`.
- **Default System Theme**: `src/theme/index.ts` defaults to `'system'` (`prefers-color-scheme`), persists user overrides (`'system' | 'light' | 'dark'`) in `chrome.storage.local` (`collect_plus_ui_theme`) + `localStorage` cache, and syncs live between `library.html` and `popup.html`.
- **Accessibility Baseline**: Body and muted text contrast `>= 4.5:1` in both light and dark modes; borders/dividers visibly distinct in both modes; vector-only SVG icons (`lucide-react`), never emojis as structural icons.

## 2. Color Tokens (`src/styles/globals.css`)

| Role | CSS Variable | Light Mode | Dark Mode |
|---|---|---|---|
| Canvas | `--cp-canvas` | `#F4F9F8` | `#0A1112` |
| Surface (Sidebar / Card / Modal) | `--cp-surface` | `#FFFFFF` | `#0F1819` |
| Surface Hover | `--cp-surface-hover` | `#F9FCFC` | `#152224` |
| Muted / Segmented Track | `--cp-muted` | `#EAF3F2` | `#19282B` |
| Input Field | `--cp-input` | `#F4F9F8` | `#0B1314` |
| Active / Selected Fill | `--cp-active` | `#E0F5F2` | `rgba(20, 184, 166, 0.16)` |
| Primary Text | `--cp-text` | `#0F2625` | `#ECFDFB` |
| Secondary Text | `--cp-text-secondary` | `#375250` | `#A9C5C2` |
| Muted Text | `--cp-text-muted` | `#587270` | `#7C9D9A` |
| Active Text | `--cp-text-active` | `#0B7A70` | `#2DD4BF` |
| Primary Accent (Teal) | `--cp-accent` | `#0D9488` | `#14B8A6` |
| Primary Accent Hover | `--cp-accent-hover` | `#0F766E` | `#2DD4BF` |
| On Accent | `--cp-on-accent` | `#FFFFFF` | `#05201E` |
| Secondary Accent (Action Orange) | `--cp-accent-2` | `#EA580C` | `#FB923C` |
| Border | `--cp-border` | `#D2E4E1` | `#203437` |
| Border Strong | `--cp-border-strong` | `#9CD0C8` | `#2E4B4F` |
| Divider | `--cp-divider` | `#E3EFED` | `#1A2B2E` |
| Modal Scrim | `--cp-scrim` | `rgba(10, 17, 18, 0.50)` | `rgba(2, 8, 9, 0.72)` |

## 3. Typography & Geometry

- **Font Stack**: `"Inter", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", system-ui, sans-serif`
- **Tabular Numbers**: Always apply `tabular-nums` to counts, sizes, durations, and timestamps.
- **Border Radius**: Controls & cards `4px` (`rounded`), dialogs/sections `6px` (`rounded-md`).
- **Modals**: Scrim `bg-[var(--cp-scrim)]`, container `rounded-md border border-[var(--cp-border-strong)] bg-[var(--cp-surface)]`, no blurred/heavy shadows.

## 4. Page Overrides

- **Platform Content Detail View** (`ItemDetailDrawer` + `ItemCommentsPanel`): See [pages/platform-detail.md](./pages/platform-detail.md).
