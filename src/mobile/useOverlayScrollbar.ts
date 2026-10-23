import { useCallback, useEffect, useRef, type DependencyList, type RefObject } from "react";

const INSET = 3;
const MIN_THUMB = 32;

// 목록 위에 덧씌우는 스크롤바. 목록 스크롤을 잠시 멈춰도 사라지거나 목록 폭을 바꾸지 않는다.
// 스크롤하는 동안 보이고, 멈추면 흐려진다.
export function useOverlayScrollbar(scrollRef: RefObject<HTMLElement | null>, deps: DependencyList) {
  const thumbRef = useRef<HTMLDivElement>(null);
  const fadeTimer = useRef<number | undefined>(undefined);

  const update = useCallback((show = false) => {
    const el = scrollRef.current, thumb = thumbRef.current;
    if (!el || !thumb) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    const track = clientHeight - INSET * 2;
    if (scrollHeight <= clientHeight + 1 || track <= MIN_THUMB) {
      thumb.hidden = true;
      return;
    }
    thumb.hidden = false;
    const height = Math.max(MIN_THUMB, (track * clientHeight) / scrollHeight);
    const progress = Math.min(1, Math.max(0, scrollTop / (scrollHeight - clientHeight)));
    thumb.style.height = `${height}px`;
    thumb.style.transform = `translateY(${INSET + progress * (track - height)}px)`;
    if (!show) return;
    thumb.classList.add("visible");
    window.clearTimeout(fadeTimer.current);
    fadeTimer.current = window.setTimeout(() => thumb.classList.remove("visible"), 900);
  }, [scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => update(true);
    el.addEventListener("scroll", onScroll, { passive: true });
    // 창 크기나 목록 내용(묶음 펼치기, 탭 전환)이 바뀌면 막대 길이를 다시 잰다.
    const resize = new ResizeObserver(() => update());
    resize.observe(el);
    for (const child of Array.from(el.children)) resize.observe(child);
    update();
    return () => {
      el.removeEventListener("scroll", onScroll);
      resize.disconnect();
    };
  }, [update, ...deps]);

  useEffect(() => () => window.clearTimeout(fadeTimer.current), []);

  return thumbRef;
}
