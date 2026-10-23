import { useLayoutEffect, useRef, useState, type RefObject } from "react";

// compositionend 뒤의 마지막 input과 편집기 DOM 반영까지 기다린다.
export function useEditorComposition(target: HTMLElement | RefObject<HTMLElement | null> | null) {
  const composing = useRef(false);
  const [settled, setSettled] = useState(0);
  useLayoutEffect(() => {
    const element = target && "current" in target ? target.current : target;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = () => {
      clearTimeout(timer); timer = undefined;
      composing.current = true;
    };
    const finish = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        composing.current = false;
        setSettled(value => value + 1);
      }, 50);
    };
    const input = (event: Event) => {
      const native = event as InputEvent;
      if (native.isComposing || (native.inputType === "insertCompositionText" && timer === undefined)) start();
      else if (composing.current) finish();
    };
    const blur = () => { if (composing.current) finish(); };
    element.addEventListener("compositionstart", start, true);
    element.addEventListener("compositionend", finish, true);
    element.addEventListener("beforeinput", input, true);
    element.addEventListener("input", input, true);
    element.addEventListener("focusout", blur, true);
    return () => {
      clearTimeout(timer); composing.current = false;
      element.removeEventListener("compositionstart", start, true);
      element.removeEventListener("compositionend", finish, true);
      element.removeEventListener("beforeinput", input, true);
      element.removeEventListener("input", input, true);
      element.removeEventListener("focusout", blur, true);
    };
  }, [target]);
  return { composing, settled };
}
