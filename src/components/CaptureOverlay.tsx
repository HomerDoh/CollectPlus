/**
 * Collect+ 页面 Shadow DOM 轻悬浮采集按钮组件（支持折叠与加载防重，无页面弹窗干扰）。
 */

import { BookmarkPlus, ChevronLeft, Loader2 } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';

/** 浮层整体只读快照 */
export interface CaptureOverlaySnapshot {
  isCapturing: boolean;
  floatingButtonEnabled: boolean;
}

/** 轻量外部状态存储接口，供 Content Script 驱动 React Shadow DOM 渲染 */
export interface CaptureOverlayStore {
  getSnapshot: () => CaptureOverlaySnapshot;
  subscribe: (listener: () => void) => () => void;
}

/** 浮层交互动作回调集合 */
export interface CaptureOverlayActions {
  onTriggerCapture: () => void;
}

export interface CaptureOverlayProps {
  store: CaptureOverlayStore;
  actions: CaptureOverlayActions;
}

export function CaptureOverlay({ store, actions }: CaptureOverlayProps) {
  const { isCapturing, floatingButtonEnabled } = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
  );
  const [fabCollapsed, setFabCollapsed] = useState(false);

  if (!floatingButtonEnabled) {
    return null;
  }

  return (
    <div className="cp-overlay-root">
      <div className="cp-fab-wrap">
        {fabCollapsed ? (
          <button
            type="button"
            className="cp-fab-mini-btn"
            title="展开 Collect+ 收藏按钮 (Alt+S)"
            aria-label="展开 Collect+ 收藏按钮"
            onClick={() => setFabCollapsed(false)}
          >
            {isCapturing ? (
              <Loader2 size={16} className="cp-spin" />
            ) : (
              <BookmarkPlus size={16} />
            )}
          </button>
        ) : (
          <>
            <button
              type="button"
              className="cp-fab-btn"
              title="收藏当前作品到 Collect+ (快捷键 Alt+S)"
              disabled={isCapturing}
              onClick={actions.onTriggerCapture}
            >
              <span className="cp-fab-icon-badge" aria-hidden="true">
                {isCapturing ? (
                  <Loader2 size={14} className="cp-spin" />
                ) : (
                  <BookmarkPlus size={14} />
                )}
              </span>
              <span>{isCapturing ? '采集中...' : '收藏当前'}</span>
              <span className="cp-fab-kbd">Alt+S</span>
            </button>
            <button
              type="button"
              className="cp-fab-collapse-btn"
              title="收起悬浮按钮"
              aria-label="收起悬浮按钮"
              onClick={() => setFabCollapsed(true)}
            >
              <ChevronLeft size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
