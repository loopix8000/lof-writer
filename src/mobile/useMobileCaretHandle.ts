import { useEffect, type RefObject } from "react";

// 입력 위치와 포커스는 그대로 두고 터치로 생긴 삽입 핸들만 정리한다.
export function useMobileCaretHandle(rootRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let composing = false;
    let touch: { x: number; y: number; time: number; scrolling: boolean } | null = null;
    let scrollPending = false;
    let frame: number | undefined;
    const editorSelector = ".m-manuscript-sheet .tiptap, .m-manuscript-sheet .cm-content";
    const hideHandle = () => {
      if (composing) return;
      const focused = document.activeElement;
      if (!(focused instanceof HTMLElement) || !root.contains(focused) || !focused.matches(editorSelector)) return;
      const selection = window.getSelection();
      // 범위 선택은 유지해 선택 핸들을 계속 조작할 수 있게 한다.
      if (!selection?.isCollapsed || !selection.anchorNode || !focused.contains(selection.anchorNode)) return;
      selection.collapse(selection.anchorNode, selection.anchorOffset);
    };
    const scroll = () => {
      if (!scrollPending || frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        scrollPending = false;
        hideHandle();
      });
    };
    const start = (event: TouchEvent) => {
      scrollPending = false;
      if (frame !== undefined) { cancelAnimationFrame(frame); frame = undefined; }
      touch = event.touches.length === 1
        ? { x: event.touches[0].clientX, y: event.touches[0].clientY, time: performance.now(), scrolling: false }
        : null;
    };
    const move = (event: TouchEvent) => {
      if (!touch || event.touches.length !== 1) { touch = null; return; }
      // 길게 누른 뒤의 선택 조작은 스크롤로 처리하지 않는다.
      if (!touch.scrolling && performance.now() - touch.time > 350) { touch = null; return; }
      const point = event.touches[0];
      if (Math.hypot(point.clientX - touch.x, point.clientY - touch.y) < 8) return;
      if (!touch.scrolling) {
        touch.scrolling = true;
        scrollPending = true;
      }
    };
    const end = () => { touch = null; };
    const cancel = () => { touch = null; scrollPending = false; };
    const wheel = () => { scrollPending = true; };
    const otherAction = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && !target.closest(editorSelector)) hideHandle();
    };
    const compositionStart = () => { composing = true; scrollPending = false; };
    const compositionEnd = () => { composing = false; };
    root.addEventListener("scroll", scroll, true);
    root.addEventListener("touchstart", start, { capture: true, passive: true });
    root.addEventListener("touchmove", move, { capture: true, passive: true });
    root.addEventListener("touchend", end, true);
    root.addEventListener("touchcancel", cancel, true);
    root.addEventListener("wheel", wheel, { capture: true, passive: true });
    root.addEventListener("pointerdown", otherAction, true);
    root.addEventListener("click", otherAction, true);
    root.addEventListener("compositionstart", compositionStart, true);
    root.addEventListener("compositionend", compositionEnd, true);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      root.removeEventListener("scroll", scroll, true);
      root.removeEventListener("touchstart", start, true);
      root.removeEventListener("touchmove", move, true);
      root.removeEventListener("touchend", end, true);
      root.removeEventListener("touchcancel", cancel, true);
      root.removeEventListener("wheel", wheel, true);
      root.removeEventListener("pointerdown", otherAction, true);
      root.removeEventListener("click", otherAction, true);
      root.removeEventListener("compositionstart", compositionStart, true);
      root.removeEventListener("compositionend", compositionEnd, true);
    };
  }, [rootRef]);
}
