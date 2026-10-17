import { useCallback, useLayoutEffect, useRef, type ReactNode } from "react";

type ScrollPosition = {
  top: number;
  left: number;
  sourceTop: number;
  sourceLeft: number;
};

export type EditorScrollPositions = Map<string, ScrollPosition>;

// 문서마다 스크롤을 기억하고, 편집기 내용이 붙은 뒤 화면을 그리기 전에 복원한다.
export default function EditorScroll({ documentId, positions, visible = true, children }: {
  documentId: string;
  positions: EditorScrollPositions;
  visible?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const remember = useCallback(() => {
    const element = ref.current;
    // 메모 화면이나 PIN 화면에 가려진 동안의 높이 0을 저장하지 않는다.
    if (!element?.clientHeight) return;
    const source = element.querySelector<HTMLElement>(".source-editor .cm-scroller");
    positions.set(documentId, {
      top: element.scrollTop,
      left: element.scrollLeft,
      sourceTop: source?.scrollTop ?? 0,
      sourceLeft: source?.scrollLeft ?? 0,
    });
  }, [documentId, positions]);

  useLayoutEffect(() => {
    const element = ref.current;
    const saved = positions.get(documentId);
    let observer: MutationObserver | undefined, frame: number | undefined;
    const restore = () => {
      if (!element || !saved) return;
      element.scrollTop = saved.top;
      element.scrollLeft = saved.left;
      const source = element.querySelector<HTMLElement>(".source-editor .cm-scroller");
      if (source) {
        source.scrollTop = saved.sourceTop;
        source.scrollLeft = saved.sourceLeft;
      }
    };
    if (element && saved && visible) {
      restore();
      // 원문 편집기 코드를 처음 읽는 동안에는 준비가 끝난 뒤에도 위치를 복원한다.
      if (element.querySelector(".source-editor") && !element.querySelector(".cm-scroller")) {
        observer = new MutationObserver(() => {
          if (!element.querySelector(".source-editor .cm-scroller")) return;
          observer?.disconnect(); frame = requestAnimationFrame(restore);
        });
        observer.observe(element, { childList: true, subtree: true });
      }
    }
    return () => {
      observer?.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      remember();
    };
  }, [documentId, positions, visible, remember]);

  return <div ref={ref} className="editor-scroll" onScrollCapture={remember}>{children}</div>;
}
