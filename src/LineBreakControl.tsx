import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { WrapText } from "lucide-react";
import { lineBreakLabel } from "../core/episode.mjs";

// 편집 도구 막대의 줄바꿈 방식 버튼. 누르면 바꿀지 묻는 작은 창을 띄운다. 바꾸면 본문의 빈 줄도 그 방식에 맞게 바뀐다.
// 도구 막대는 가로로 스크롤되고 단추 모양도 바꾸므로, 작은 창은 앱 최상단에 화면 기준 위치로 띄운다.
export default function LineBreakControl({
  manual,
  def,
  disabled = false,
  onChange,
  defaultLabel = "새 에피소드 기본값",
}: {
  manual: boolean;
  def: boolean;
  disabled?: boolean;
  onChange: (manual: boolean) => void;
  defaultLabel?: string;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const ref = useRef<HTMLDivElement>(null),
    popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!anchor) return;
    const close = (e: Event) => {
      const inside = [ref.current, popRef.current].some((el) => el?.contains(e.target as Node));
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !inside) setAnchor(null);
    };
    const closeOnScroll = () => setAnchor(null);
    window.addEventListener("mousedown", close, true);
    window.addEventListener("keydown", close, true);
    window.addEventListener("scroll", closeOnScroll, true);
    window.addEventListener("resize", closeOnScroll);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("scroll", closeOnScroll, true);
      window.removeEventListener("resize", closeOnScroll);
    };
  }, [anchor]);
  const differs = manual !== def,
    label = lineBreakLabel(manual);
  return (
    <div className="line-break-control" ref={ref}>
      <button
        type="button"
        className={`line-break-button${anchor ? " active" : ""}`}
        aria-label={`줄바꿈: ${label}`}
        aria-expanded={!!anchor}
        title={
          differs
            ? `줄바꿈: ${label} · ${defaultLabel}(${lineBreakLabel(def)})과 다른 방식입니다.`
            : `줄바꿈: ${label}`
        }
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setAnchor((a) => (a ? null : rect));
        }}
      >
        <WrapText size={16} />
        <span>{label}</span>
      </button>
      {anchor && createPortal(
        <div
          ref={popRef}
          className="line-break-pop"
          role="dialog"
          style={{ top: anchor.bottom + 4, left: Math.max(8, Math.min(anchor.left - 6, window.innerWidth - 238)) }}
        >
          <b title="줄바꿈 방식 변경은 이 문서에만 적용되며, 본문의 빈 줄도 그 방식에 맞게 바뀝니다.">
            {manual ? "자동 줄바꿈 관리로 전환할까요?" : "수동 줄바꿈 관리로 전환할까요?"}
          </b>
          <p>
            {manual
              ? "한 줄이 한 문단이 되고, 문단 사이의 빈 줄은 단락 간격으로 바뀝니다. 빈 줄 1줄은 지워지고, 여러 줄이면 절반만 남습니다."
              : "단락 간격 대신 문단 사이에 실제 빈 줄을 넣습니다. Enter로 줄바꿈합니다."}
          </p>
          <div>
            <button type="button" onClick={() => setAnchor(null)}>취소</button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                onChange(!manual);
                setAnchor(null);
              }}
            >
              변경
            </button>
          </div>
        </div>,
        // 테마 색 변수가 .app에 있으므로 그 안에 띄운다.
        ref.current?.closest(".app") ?? document.body,
      )}
    </div>
  );
}
