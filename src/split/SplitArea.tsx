import { useEffect, useRef, useState, type ReactNode } from "react";
import type { SplitDrag } from "./controller";
import type { SplitGroupsApi } from "./useSplitGroups";

// 분할 그룹을 담는 영역. 놓기 영역 표시, 분할선, 끌어 놓기 처리를 화면마다 똑같이 그린다.
// 그룹 요소에는 groupAttributes, 탭 막대에는 tabBarAttributes, 탭에는 tabAttributes를 붙인다.
export default function SplitArea<T>({ split, drag, onDrop, className = "", hidden, children, after }: {
  split: SplitGroupsApi<T>;
  // 지금 끌고 있는 것. 탭이나 파일 트리 항목을 끌지 않으면 null.
  drag: () => SplitDrag<T> | null;
  // 놓은 뒤 끌기 상태를 정리하고 run을 실행한다.
  onDrop: (run: () => Promise<unknown>) => void;
  className?: string;
  hidden?: boolean;
  children: ReactNode;
  // 그룹 영역 옆에 함께 놓는 요소(미리보기 등).
  after?: ReactNode;
}) {
  const zone = split.dropZone;
  const [hoverPaths, setHoverPaths] = useState<string[]>([]);
  const hoverTimer = useRef<number | undefined>(undefined);
  function clearHoverTimer() {
    if (hoverTimer.current !== undefined) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = undefined;
    }
  }
  function enterSash(paths: string[]) {
    clearHoverTimer();
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = undefined;
      setHoverPaths(paths);
    }, 300);
  }
  function leaveSash() {
    clearHoverTimer();
    setHoverPaths((prev) => (prev.length ? [] : prev));
  }
  const dragRef = useRef(drag);
  dragRef.current = drag;
  useEffect(() => {
    const onStart = (e: globalThis.DragEvent) => {
      const isTab = e.target instanceof Element && !!e.target.closest("[data-split-tab]");
      if (isTab || dragRef.current()) {
        document.body.classList.add("split-dragging");
        const active = document.activeElement;
        if (active instanceof HTMLElement && active.closest(".group-body")) active.blur();
      }
    };
    const onEnd = () => document.body.classList.remove("split-dragging");
    window.addEventListener("dragstart", onStart);
    window.addEventListener("dragend", onEnd, true);
    window.addEventListener("drop", onEnd, true);
    return () => {
      clearHoverTimer();
      onEnd();
      window.removeEventListener("dragstart", onStart);
      window.removeEventListener("dragend", onEnd, true);
      window.removeEventListener("drop", onEnd, true);
    };
  }, []);

  return (
    <div
      className={`editor-groups ${split.split ? "split" : ""} ${className}`}
      hidden={hidden}
      inert={hidden}
      onDragEnterCapture={(e) => {
        const d = drag();
        if (d) {
          document.body.classList.add("split-dragging");
          split.dragOver(e, d);
        }
      }}
      onDragOverCapture={(e) => {
        const d = drag();
        if (d) document.body.classList.add("split-dragging");
        split.dragOver(e, d);
      }}
      onDragLeave={split.dragLeave}
      onDropCapture={(e) => {
        const run = split.drop(e, drag());
        if (run) onDrop(run);
      }}
    >
      <div className="editor-workspace" ref={split.containerRef}>
        {zone && !zone.tabs && (
          <div
            className="group-drop-zone"
            style={{
              left: zone.left,
              top: zone.top,
              width: zone.width,
              ...(zone.height !== undefined && { height: zone.height, bottom: "auto" }),
            }}
          />
        )}
        {zone && zone.tabs && zone.indicatorLeft !== undefined && (
          <div
            className="tab-drop-indicator"
            style={{
              left: zone.indicatorLeft,
              top: zone.top,
              height: zone.height ?? 36,
            }}
          />
        )}
        {children}
        {split.sashes.map((sash) => (
          <div
            key={`sash-${sash.path}`}
            className={`group-sash grid-sash ${sash.axis === "y" ? "horizontal" : ""} ${
              hoverPaths.includes(sash.path) ? "hover" : ""
            }`}
            style={sash.style}
            role="separator"
            aria-orientation={sash.axis === "x" ? "vertical" : "horizontal"}
            aria-label="편집기 그룹 크기 조절"
            onPointerEnter={() => enterSash(sash.linkedPath !== undefined ? [sash.path, sash.linkedPath] : [sash.path])}
            onPointerLeave={leaveSash}
            onPointerDown={(event) => {
              leaveSash();
              split.startSash(event, sash);
            }}
            onDoubleClick={() => split.resetSash(sash)}
          />
        ))}
        {split.intersection && (
          <div
            className="group-sash-intersection"
            style={split.intersection.style}
            role="separator"
            aria-label="편집기 4분할 교차점 크기 조절"
            onPointerEnter={() => enterSash(["", "0", "1"])}
            onPointerLeave={leaveSash}
            onPointerDown={(event) => {
              leaveSash();
              split.startIntersection(event, split.intersection!);
            }}
            onDoubleClick={() => split.resetIntersection()}
          />
        )}
      </div>
      {after}
    </div>
  );
}
