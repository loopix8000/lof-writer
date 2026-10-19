import LayoutIcon from "./LayoutIcon";

import {
  ArrowLeft,
  ArrowRight
} from "lucide-react";
import { useEffect, useState } from "react";
import { type Navigation } from "./model";

import type * as React from "react";

type Props = {
  navigation: Navigation;
  attempt: (fn: () => Promise<any>) => () => Promise<any>;
  travel: (direction: number) => Promise<void>;
  treeOpen: boolean;
  isWorkspace: boolean;
  toggleTree: () => void;
  right: boolean;
  focus: boolean;
  setRight: React.Dispatch<React.SetStateAction<boolean>>;
};

export default function TitleBar({ navigation, attempt, travel, treeOpen, isWorkspace, toggleTree, right, focus, setRight }: Props) {
  const [winMaximized, setWinMaximized] = useState(false);
  useEffect(() => {
    const syncMax = () => {
      window.lof.windowIsMaximized?.().then(setWinMaximized).catch(() => { });
    };
    syncMax();
    window.addEventListener("resize", syncMax);
    return () => window.removeEventListener("resize", syncMax);
  }, []);

  return (
    <header
      className="titlebar"
      data-tauri-drag-region
      onMouseDown={(e) => {
        if (e.button === 0 && !(e.target as HTMLElement).closest("button")) {
          if (e.detail === 2) {
            window.lof.windowToggleMaximize?.().then(setWinMaximized).catch(() => { });
          } else {
            window.lof.windowStartDragging?.().catch(() => { });
          }
        }
      }}
    >
      <div className="titlebar-content" data-tauri-drag-region>
        <div className="history-navigation" role="group" aria-label="화면 이동">
          <button aria-label="뒤로가기" title="뒤로가기"
            disabled={navigation.index === 0}
            onClick={attempt(() => travel(-1))}>
            <ArrowLeft size={19} />
          </button>
          <button aria-label="앞으로가기" title="앞으로가기"
            disabled={navigation.index === navigation.entries.length - 1}
            onClick={attempt(() => travel(1))}>
            <ArrowRight size={19} />
          </button>
        </div>
        <div className="layout-controls start">
          <button
            aria-label="파일 트리 표시/숨기기"
            title="파일 트리 표시/숨기기 (Ctrl+B)"
            aria-pressed={treeOpen}
            disabled={!isWorkspace}
            onClick={toggleTree}
          >
            <LayoutIcon side="left" open={treeOpen} />
          </button>
        </div>
        <div className="layout-controls end">
          <button
            aria-label="위젯 보드 표시/숨기기"
            title="위젯 보드 표시/숨기기 (Ctrl+Alt+B)"
            aria-pressed={right && !focus}
            disabled={!isWorkspace || focus}
            onClick={() => setRight((r) => !r)}
          >
            <LayoutIcon side="right" open={right && !focus} />
          </button>
        </div>
      </div>
      {window.lof.windowClose && (
        <div className="window-controls" role="group" aria-label="창 제어">
          <button
            type="button"
            className="window-control"
            aria-label="최소화"
            title="최소화"
            onClick={() => window.lof.windowMinimize?.()}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M 1,5.5 L 9,5.5" stroke="currentColor" strokeWidth="1" shapeRendering="crispEdges" />
            </svg>
          </button>
          <button
            type="button"
            className="window-control"
            aria-label={winMaximized ? "이전 크기로 복원" : "최대화"}
            title={winMaximized ? "이전 크기로 복원" : "최대화"}
            onClick={() =>
              window.lof.windowToggleMaximize?.().then(setWinMaximized).catch(() => { })
            }
          >
            {winMaximized ? (
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path
                  d="M 2.5,2.5 L 2.5,0.5 L 9.5,0.5 L 9.5,7.5 L 7.5,7.5 M 0.5,2.5 L 7.5,2.5 L 7.5,9.5 L 0.5,9.5 Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1"
                  shapeRendering="crispEdges"
                />
              </svg>
            ) : (
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <rect
                  x="1.5"
                  y="1.5"
                  width="7"
                  height="7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1"
                  shapeRendering="crispEdges"
                />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="window-control close"
            aria-label="닫기"
            title="닫기"
            onClick={() => window.lof.windowClose?.()}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path
                d="M 1,1 L 9,9 M 9,1 L 1,9"
                stroke="currentColor"
                strokeWidth="1.1"
              />
            </svg>
          </button>
        </div>
      )}
    </header>
  );
}
