import { useCallback, useEffect, useRef, type DependencyList, type RefObject } from "react";

const INSET = 3;
const MIN_THUMB = 32;

type Options = {
  // 이 요소의 아래 끝부터 막대를 움직인다(목록 위에 떠 있는 머리 영역).
  startRef?: RefObject<HTMLElement | null>;
  // 실제 목록 본문 요소. 본문이 보이는 영역보다 짧으면 막대를 숨긴다.
  bodyRef?: RefObject<HTMLElement | null>;
  // 스크롤 위치에 따른 막대 시작 높이를 직접 계산한다.
  offsetTop?: (scrollTop: number) => number;
  // 막대 길이를 잴 때 위에서 뺄 높이. 머리 영역이 접히고 펼쳐져도 막대 길이가 바뀌지 않게 고정값을 준다.
  reservedTop?: () => number;
};

// 목록 위에 덧씌우는 스크롤바. 목록 스크롤을 잠시 멈춰도 사라지거나 목록 폭을 바꾸지 않는다.
// 스크롤하는 동안 보이고, 멈추면 흐려진다.
export function useOverlayScrollbar(
  scrollRef: RefObject<HTMLElement | null>,
  deps: DependencyList,
  { startRef, bodyRef, offsetTop, reservedTop }: Options = {},
) {
  const thumbRef = useRef<HTMLDivElement>(null);
  const fadeTimer = useRef<number | undefined>(undefined);
  const offsetFn = useRef(offsetTop);
  offsetFn.current = offsetTop;
  const reserved = useRef(reservedTop);
  reserved.current = reservedTop;

  const update = useCallback((show = false) => {
    const el = scrollRef.current, thumb = thumbRef.current;
    if (!el || !thumb) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    const start = startRef?.current;
    const rawOffset = offsetFn.current
      ? offsetFn.current(Math.max(0, scrollTop))
      : start
        ? start.getBoundingClientRect().bottom - el.getBoundingClientRect().top
        : 0;
    const offset = Math.min(clientHeight, Math.max(0, rawOffset));
    const visibleHeight = clientHeight - offset;
    const track = visibleHeight - INSET * 2;
    const lengthTrack = clientHeight - (reserved.current?.() ?? offset) - INSET * 2;
    const body = bodyRef?.current;
    if (
      scrollHeight <= clientHeight + 1 ||
      track <= MIN_THUMB ||
      (body && body.offsetHeight <= visibleHeight)
    ) {
      thumb.hidden = true;
      return;
    }
    thumb.hidden = false;
    const height = Math.min(track, Math.max(MIN_THUMB, (lengthTrack * clientHeight) / scrollHeight));
    const progress = Math.min(1, Math.max(0, scrollTop / (scrollHeight - clientHeight)));
    thumb.style.height = `${height}px`;
    thumb.style.transform = `translateY(${offset + INSET + progress * (track - height)}px)`;
    if (!show) return;
    thumb.classList.add("visible");
    window.clearTimeout(fadeTimer.current);
    fadeTimer.current = window.setTimeout(() => thumb.classList.remove("visible"), 900);
  }, [scrollRef, startRef, bodyRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => update(true);
    el.addEventListener("scroll", onScroll, { passive: true });
    // 창 크기나 목록 내용(묶음 펼치기, 탭 전환), 머리 영역 높이가 바뀌면 막대 위치와 길이를 다시 잰다.
    const resize = new ResizeObserver(() => update());
    resize.observe(el);
    for (const child of Array.from(el.children)) resize.observe(child);
    const start = startRef?.current;
    if (start) resize.observe(start);
    const body = bodyRef?.current;
    if (body) resize.observe(body);
    update();
    return () => {
      el.removeEventListener("scroll", onScroll);
      resize.disconnect();
    };
  }, [update, ...deps]);

  useEffect(() => () => window.clearTimeout(fadeTimer.current), []);

  return thumbRef;
}
