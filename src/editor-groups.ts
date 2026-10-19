import type { CSSProperties } from "react";

export const editorSides = ["left", "right", "bottom-left", "bottom-right"] as const;
export type EditorSide = typeof editorSides[number];
export const isEditorSide = (value: unknown): value is EditorSide => editorSides.includes(value as EditorSide);
export const oppositeSide = (side: EditorSide): EditorSide =>
  ({ left: "right", right: "left", "bottom-left": "bottom-right", "bottom-right": "bottom-left" })[side] as EditorSide;
export const verticalSide = (side: EditorSide): EditorSide =>
  ({ left: "bottom-left", right: "bottom-right", "bottom-left": "left", "bottom-right": "right" })[side] as EditorSide;
export const hasEditorRows = (sides: EditorSide[]) => sides.some(side => side.startsWith("bottom") && sides.includes(verticalSide(side)));

export function editorSashStyle(axis: "x" | "y", sides: EditorSide[]): CSSProperties {
  const columns = sides.some(side => side.endsWith("left")) && sides.some(side => side.endsWith("right"));
  const leftPair = sides.includes("left") && sides.includes("bottom-left");
  const rightPair = sides.includes("right") && sides.includes("bottom-right");
  return axis === "x" ? { gridColumn: "2", gridRow: "1 / -1" }
    : { gridRow: "2", gridColumn: !columns || leftPair && !rightPair ? "1" : rightPair && !leftPair ? "3" : "1 / -1" };
}

export function editorGridStyle(sides: EditorSide[], x: number, y: number): CSSProperties {
  const columns = sides.some(s => s.endsWith("left")) && sides.some(s => s.endsWith("right"));
  const rows = hasEditorRows(sides);
  return {
    display: "grid",
    gridTemplateColumns: columns ? `minmax(0, ${x}fr) 4px minmax(0, ${1 - x}fr)` : "minmax(0, 1fr)",
    gridTemplateRows: rows ? `minmax(0, ${y}fr) 4px minmax(0, ${1 - y}fr)` : "minmax(0, 1fr)",
  };
}

export function editorGroupStyle(side: EditorSide, sides: EditorSide[]): CSSProperties {
  const left = side.endsWith("left"), bottom = side.startsWith("bottom");
  const columns = sides.some(s => s.endsWith("left")) && sides.some(s => s.endsWith("right"));
  const rows = hasEditorRows(sides);
  const sibling = sides.includes(verticalSide(side));
  return { gridColumn: columns && !left ? "3" : "1", gridRow: rows ? sibling ? bottom ? "3" : "1" : "1 / 4" : "1" };
}

export type EditorDropZone = {
  side: EditorSide;
  left: number;
  top: number;
  width: number;
  // 그룹의 탭 막대에 놓으면 화면을 나누지 않고 그 그룹에 새 탭으로 연다. 표시는 탭 막대 높이만큼만 한다.
  tabs?: boolean;
  height?: number;
};

// 분할 전에는 화면의 절반, 분할 후에는 실제 그룹의 위치를 놓을 곳으로 사용한다.
export function editorDropZone(
  target: EventTarget | null,
  clientX: number,
  container: HTMLElement | null,
  split: boolean,
  fromTree: boolean,
  clientY?: number,
  sides?: EditorSide[],
  sourceSide?: EditorSide,
): EditorDropZone | null {
  if (!(target instanceof Element) || !container) return null;
  const group = target.closest<HTMLElement>(".editor-group");
  if (!group || !container.contains(group)) return null;
  // 탭끼리의 드래그는 기존 탭 순서 변경이 처리한다.
  if (!fromTree && target.closest(".editor-tabs") && (sourceSide ? group.dataset.side === sourceSide : !group.classList.contains("inactive"))) return null;
  if (!sides && !fromTree && split && !group.classList.contains("inactive")) return null;

  const box = container.getBoundingClientRect();
  const rect = group.getBoundingClientRect();
  const tabs = group.querySelector<HTMLElement>(".editor-tabs");
  if (tabs && target.closest(".editor-tabs") === tabs) {
    const bar = tabs.getBoundingClientRect(),
      side = isEditorSide(group.dataset.side) ? group.dataset.side : "left";
    return { side, tabs: true, left: bar.left - box.left, top: bar.top - box.top, width: bar.width, height: bar.height };
  }
  const top = (tabs?.getBoundingClientRect().bottom ?? rect.top) - box.top;
  if (sides) {
    const current = group.dataset.side;
    if (!isEditorSide(current)) return null;
    const height = rect.bottom - box.top - top;
    const y = clientY ?? rect.top + rect.height / 2;
    const rowTarget = verticalSide(current), columnTarget = oppositeSide(current);
    if (!sides.includes(rowTarget) && (current.startsWith("bottom") ? y < rect.top + rect.height * 0.25 : y > rect.bottom - rect.height * 0.25)) {
      return { side: rowTarget, left: rect.left - box.left, top: top + (rowTarget.startsWith("bottom") ? height / 2 : 0), width: rect.width, height: height / 2 };
    }
    if (!sides.includes(columnTarget)) {
      const right = clientX >= rect.left + rect.width / 2;
      const side = right ? (current.endsWith("right") ? current : columnTarget) : (current.endsWith("left") ? current : columnTarget);
      if (side !== current) return { side, left: rect.left - box.left + (right ? rect.width / 2 : 0), top, width: rect.width / 2, height };
    }
    return { side: current, left: rect.left - box.left, top, width: rect.width, height };
  }
  if (split) {
    const side = group.dataset.side;
    if (!isEditorSide(side)) return null;
    return { side, left: rect.left - box.left, top, width: rect.width };
  }

  const side = clientX < rect.left + rect.width / 2 ? "left" : "right";
  return {
    side,
    left: rect.left - box.left + (side === "right" ? rect.width / 2 : 0),
    top,
    width: rect.width / 2,
  };
}
