import type { ReactNode } from "react";
import type { SplitDrag } from "./controller";
import type { SplitGroupsApi } from "./useSplitGroups";

// 분할 그룹을 담는 영역. 놓기 영역 표시, 분할선, 끌어 놓기 처리를 화면마다 똑같이 그린다.
// 그룹 요소에는 groupAttributes, 탭 막대에는 tabBarAttributes를 붙인다.
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
  return (
    <div
      className={`editor-groups ${split.split ? "split" : ""} ${className}`}
      hidden={hidden}
      inert={hidden}
      onDragOverCapture={(e) => split.dragOver(e, drag())}
      onDragLeave={split.dragLeave}
      onDropCapture={(e) => {
        const run = split.drop(e, drag());
        if (run) onDrop(run);
      }}
    >
      <div className="editor-workspace" ref={split.containerRef}>
        {zone && (
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
        {children}
        {split.sashes.map((sash) => (
          <div
            key={`sash-${sash.path}`}
            className={`group-sash grid-sash ${sash.axis === "y" ? "horizontal" : ""}`}
            style={sash.style}
            role="separator"
            aria-orientation={sash.axis === "x" ? "vertical" : "horizontal"}
            aria-label="편집기 그룹 크기 조절"
            onPointerDown={(event) => split.startSash(event, sash)}
            onDoubleClick={() => split.resetSash(sash.path)}
          />
        ))}
      </div>
      {after}
    </div>
  );
}
