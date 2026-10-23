import { useCallback, useEffect, useRef, type DependencyList, type RefObject } from "react";

const INSET = 3;
const MIN_THUMB = 32;

type Options = {
  // 이 요소의 아래 끝부터 막대를 움직인다(목록 위에 떠 있는 머리 영역).
  startRef?: RefObject<HTMLElement | null>;
  // 막대 길이를 잴 실제 본문. 없으면 목록의 첫 자식을 쓴다.
  bodyRef?: RefObject<HTMLElement | null>;
  // 막대 길이를 잴 때 위에서 뺄 높이. 머리 영역이 접히고 펼쳐져도 막대 길이가 바뀌지 않게 고정값을 준다.
  reservedTop?: () => number;
};

// 목록 위에 덧씌우는 스크롤바. 목록 스크롤을 잠시 멈춰도 사라지거나 목록 폭을 바꾸지 않는다.
// 스크롤하는 동안 보이고, 멈추면 흐려진다.
export function useOverlayScrollbar(
  scrollRef: RefObject<HTMLElement | null>,
  deps: DependencyList,
  { startRef, bodyRef, reservedTop }: Options = {},
) {
  const thumbRef = useRef<HTMLDivElement>(null);
  const fadeTimer = useRef<number | undefined>(undefined);
  const reserved = useRef(reservedTop);
  reserved.current = reservedTop;

  const update = useCallback((show = false) => {
    const el = scrollRef.current, thumb = thumbRef.current;
    if (!el || !thumb) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    const child = bodyRef?.current ?? (el.firstElementChild as HTMLElement | null);
    // 펼쳐진 동안 목록 본문에 걸린 translateY 때문에 scrollHeight가 일시적으로 커져도,
    // 막대 길이와 진행률은 실제 본문 높이 기준으로 계산해 접힐 때 막대 길이가 늘어나지 않게 한다.
    const baseScrollHeight =
      child && reserved.current
        ? Math.max(clientHeight, child.offsetTop + child.offsetHeight + 32)
        : scrollHeight;
    const start = startRef?.current;
    const offset = start
      ? Math.min(clientHeight, Math.max(0, start.getBoundingClientRect().bottom - el.getBoundingClientRect().top))
      : 0;
    const track = clientHeight - offset - INSET * 2;
    const lengthTrack = clientHeight - (reserved.current?.() ?? offset) - INSET * 2;
    if (baseScrollHeight <= clientHeight + 1 || track <= MIN_THUMB) {
      thumb.hidden = true;
      return;
    }
    thumb.hidden = false;
    const height = Math.min(track, Math.max(MIN_THUMB, (lengthTrack * clientHeight) / baseScrollHeight));
    const progress = Math.min(1, Math.max(0, scrollTop / (baseScrollHeight - clientHeight)));
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
    // 창 크기나 목록 내용(묶음 펼치기, 탭 전환)이 바뀌면 막대 길이를 다시 잰다.
    const resize = new ResizeObserver(() => update());
    resize.observe(el);
    for (const child of Array.from(el.children)) resize.observe(child);
    // 머리 영역이 접히거나 펼쳐지는 동안 매 프레임 시작 위치를 따라간다.
    const start = startRef?.current;
    let rafId = 0;
    const follow = () => {
      update();
      rafId = window.requestAnimationFrame(follow);
    };
    const onTransitionStart = (e: TransitionEvent) => {
      if (e.target !== start || e.propertyName !== "transform") return;
      window.cancelAnimationFrame(rafId);
      rafId = window.requestAnimationFrame(follow);
    };
    const onTransitionDone = (e: TransitionEvent) => {
      if (e.target !== start || e.propertyName !== "transform") return;
      window.cancelAnimationFrame(rafId);
      update();
    };
    start?.addEventListener("transitionstart", onTransitionStart);
    start?.addEventListener("transitionend", onTransitionDone);
    start?.addEventListener("transitioncancel", onTransitionDone);
    update();
    return () => {
      window.cancelAnimationFrame(rafId);
      el.removeEventListener("scroll", onScroll);
      start?.removeEventListener("transitionstart", onTransitionStart);
      start?.removeEventListener("transitionend", onTransitionDone);
      start?.removeEventListener("transitioncancel", onTransitionDone);
      resize.disconnect();
    };
  }, [update, ...deps]);

  useEffect(() => () => window.clearTimeout(fadeTimer.current), []);

  return thumbRef;
}
