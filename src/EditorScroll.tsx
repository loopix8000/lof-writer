import { useCallback, useLayoutEffect, useRef, type ReactNode } from "react";
import { readWorkspaceState, saveWorkspaceState } from "./workspace-state";

type ScrollPosition = {
  top: number;
  left: number;
  sourceTop: number;
  sourceLeft: number;
};

export type EditorScrollPositions = Map<string, ScrollPosition>;

// 문서마다 스크롤을 기억하고, 편집기 내용이 붙은 뒤 화면을 그리기 전에 복원한다.
export default function EditorScroll({ documentId, positions, scope, visible = true, children }: {
  documentId: string;
  positions: EditorScrollPositions;
  scope?: string;
  visible?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const restoring = useRef(false);
  const remember = useCallback(() => {
    const element = ref.current;
    // 메모 화면이나 PIN 화면에 가려진 동안의 높이 0을 저장하지 않는다.
    if (!element?.clientHeight || restoring.current) return;
    const source = element.querySelector<HTMLElement>(".source-editor .cm-scroller");
    const position = {
      top: element.scrollTop,
      left: element.scrollLeft,
      sourceTop: source?.scrollTop ?? 0,
      sourceLeft: source?.scrollLeft ?? 0,
    };
    positions.set(documentId, position);
    if (scope) {
      const scroll = readWorkspaceState(scope).scroll ?? {};
      const previous = scroll[documentId];
      if (JSON.stringify(previous) !== JSON.stringify(position))
        saveWorkspaceState(scope, { scroll: { ...scroll, [documentId]: position } });
    }
  }, [documentId, positions, scope]);

  useLayoutEffect(() => {
    const element = ref.current;
    const value = scope ? readWorkspaceState(scope).scroll?.[documentId] : positions.get(documentId);
    const saved = value && typeof value === "object" &&
      ["top", "left", "sourceTop", "sourceLeft"].every(key => Number.isFinite((value as any)[key]) && (value as any)[key] >= 0)
      ? value as ScrollPosition : undefined;
    let observer: MutationObserver | undefined, resize: ResizeObserver | undefined;
    let frame: number | undefined, timeout: ReturnType<typeof setTimeout> | undefined;
    let canceled = false;
    const restore = () => {
      if (!element || !saved || canceled || !element.clientHeight) return;
      element.scrollTop = saved.top;
      element.scrollLeft = saved.left;
      const source = element.querySelector<HTMLElement>(".source-editor .cm-scroller");
      if (source) {
        source.scrollTop = saved.sourceTop;
        source.scrollLeft = saved.sourceLeft;
      }
    };
    if (element && saved && visible) {
      restoring.current = true;
      restore();
      frame = requestAnimationFrame(restore);
      // 글꼴이나 원문 편집기가 늦게 준비되어도 첫 높이로 저장값을 덮어쓰지 않는다.
      const scheduleRestore = () => {
        if (canceled) return;
        if (frame !== undefined) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(restore);
      };
      resize = new ResizeObserver(scheduleRestore);
      if (element.firstElementChild) resize.observe(element.firstElementChild);
      void document.fonts.ready.then(scheduleRestore);
      timeout = setTimeout(() => { restore(); stopRestoring(); }, 1500);
      // 원문 편집기 코드를 처음 읽는 동안에는 준비가 끝난 뒤에도 위치를 복원한다.
      if (element.querySelector(".source-editor") && !element.querySelector(".cm-scroller")) {
        observer = new MutationObserver(() => {
          if (!element.querySelector(".source-editor .cm-scroller")) return;
          observer?.disconnect(); frame = requestAnimationFrame(restore);
        });
        observer.observe(element, { childList: true, subtree: true });
      }
    }
    function stopRestoring() {
      canceled = true;
      restoring.current = false;
      observer?.disconnect(); resize?.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      clearTimeout(timeout);
    }
    element?.addEventListener("wheel", stopRestoring, { passive: true });
    element?.addEventListener("pointerdown", stopRestoring, { passive: true });
    element?.addEventListener("keydown", stopRestoring);
    element?.addEventListener("touchstart", stopRestoring, { passive: true });
    return () => {
      const wasRestoring = restoring.current;
      stopRestoring();
      element?.removeEventListener("wheel", stopRestoring);
      element?.removeEventListener("pointerdown", stopRestoring);
      element?.removeEventListener("keydown", stopRestoring);
      element?.removeEventListener("touchstart", stopRestoring);
      if (!wasRestoring) remember();
    };
  }, [documentId, positions, scope, visible, remember]);

  return <div ref={ref} className="editor-scroll" onScrollCapture={remember}>{children}</div>;
}
