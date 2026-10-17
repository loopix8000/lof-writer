export type EditorSide = "left" | "right";

export type EditorDropZone = {
  side: EditorSide;
  left: number;
  top: number;
  width: number;
};

// 분할 전에는 화면의 절반, 분할 후에는 실제 그룹의 위치를 놓을 곳으로 사용한다.
export function editorDropZone(
  target: EventTarget | null,
  clientX: number,
  container: HTMLElement | null,
  split: boolean,
  fromTree: boolean,
): EditorDropZone | null {
  if (!(target instanceof Element) || !container) return null;
  const group = target.closest<HTMLElement>(".editor-group");
  if (!group || !container.contains(group)) return null;
  // 탭끼리의 드래그는 기존 탭 순서 변경이 처리한다.
  if (!fromTree && target.closest(".editor-tabs")) return null;
  if (!fromTree && split && !group.classList.contains("inactive")) return null;

  const box = container.getBoundingClientRect();
  const rect = group.getBoundingClientRect();
  const tabs = group.querySelector<HTMLElement>(".editor-tabs");
  const top = (tabs?.getBoundingClientRect().bottom ?? rect.top) - box.top;
  if (split) {
    const side = group.dataset.side;
    if (side !== "left" && side !== "right") return null;
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
