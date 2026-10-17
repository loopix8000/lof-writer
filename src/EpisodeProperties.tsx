import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlignLeft,
  Asterisk,
  BookOpen,
  Bookmark,
  Check,
  ChevronDown,
  CircleArrowLeft,
  CircleArrowRight,
  Clock,
  MessageSquareQuote,
  Pencil,
  SquarePen,
  Tags,
  X,
  Link2,
  Unlink,
  ArrowUpRight,
} from "lucide-react";
import type { MenuItem } from "./ContextMenu";
import EpisodeTags from "./EpisodeTags";
import CustomProperties, { GrowingText } from "./CustomProperties";
import type { PropertyPreset } from "./custom-properties";
import type { Doc } from "./types";
import {
  STATUSES,
  STATUS_LABELS,
  TYPE_CHOICES,
  TYPE_LABELS,
  TYPE_ACTIONS,
  normalizeStatus,
  normalizeType,
} from "../core/episode.mjs";

// 문서의 기본 속성과 사용자 속성을 함께 편집한다.

export const STATUS_ICONS: Record<string, ReactNode> = {
  planned: <Clock size={15} />,
  in_progress: <SquarePen size={15} />,
  revision: <Pencil size={15} />,
  completed: <Check size={15} />,
};
const TYPE_ICONS: Record<number, ReactNode> = {
  0: <BookOpen size={15} />,
  2: <CircleArrowRight size={15} />,
  3: <CircleArrowLeft size={15} />,
  4: <Asterisk size={15} />,
  6: <Bookmark size={15} />,
};
// 상태별 메뉴 항목. 파일 트리 우클릭 메뉴에서도 쓴다.
export function statusItems(current: string, pick: (status: string) => void): MenuItem[] {
  return STATUSES.map((s) => ({
    label: STATUS_LABELS[s],
    icon: STATUS_ICONS[s],
    badge: s === "completed" ? "원고 보호" : undefined,
    disabled: normalizeStatus(current) === s,
    action: () => pick(s),
  }));
}

type Patch = Partial<Doc>;
type Prop = {
  id: string;
  label: string;
  description?: string;
  order: number;
  optional: boolean;
  fullWidth?: boolean;
  icon: ReactNode;
  present: (d: Doc) => boolean;
  // 속성을 뺄 때 기본값으로 되돌리는 패치와, 실행 취소로 되돌리는 패치.
  clear?: (d: Doc) => { next: Patch; restore: Patch };
};
const clearField = (k: keyof Doc, empty: any) => (d: Doc) => ({
  next: { [k]: empty } as Patch,
  restore: { [k]: d[k] } as Patch,
});
const PROPS: Prop[] = [
  { id: "episode-binding", label: "연결 회차", order: 10, optional: false, fullWidth: true,
    icon: <Link2 size={14} />, present: () => true },
  {
    id: "summary",
    label: "요약",
    description: "에피소드 내용을 짧게 정리합니다.",
    order: 0,
    optional: true,
    fullWidth: true,
    icon: <AlignLeft size={14} />,
    present: (d) => !!d.description?.trim(),
    clear: clearField("description", ""),
  },
  {
    id: "author-comment",
    label: "작가의 말",
    description: "독자에게 전할 메시지나 소감을 작성합니다.",
    order: 5,
    optional: true,
    fullWidth: true,
    icon: <MessageSquareQuote size={14} />,
    present: (d) => !!d.authorComment?.trim(),
    clear: clearField("authorComment", ""),
  },
  { id: "type", label: "유형", order: 10, optional: false, icon: <Bookmark size={14} />, present: () => true },
  { id: "status", label: "상태", order: 30, optional: false, icon: <Clock size={14} />, present: () => true },
  {
    id: "tags",
    label: "태그",
    description: "검색과 분류에 사용할 태그를 설정합니다.",
    order: 100,
    optional: true,
    fullWidth: true,
    icon: <Tags size={14} />,
    present: (d) => !!d.tags?.length,
    clear: clearField("tags", []),
  },
];

export default function EpisodeProperties({
  doc,
  readOnly = false,
  open,
  onToggle,
  onEdit,
  onMenu,
  onNotice,
  boundEpisode,
  onBind,
  onUnbind,
  onOpenBound,
  propertyPresets,
  onSavePresets,
  favoriteTags,
}: {
  doc: Doc;
  boundEpisode?: Doc;
  onBind?: () => void;
  onUnbind?: () => void;
  onOpenBound?: () => void;
  propertyPresets?: unknown;
  onSavePresets?: (presets: PropertyPreset[]) => Promise<void>;
  favoriteTags?: unknown;
  readOnly?: boolean;
  open: boolean;
  onToggle: () => void;
  onEdit: (patch: Patch) => void;
  // 버튼 아래에 메뉴를 띄운다.
  onMenu: (anchor: DOMRect, items: MenuItem[]) => void;
  // 토스트. action이 있으면 '실행 취소' 같은 버튼을 단다.
  onNotice: (text: string, action?: { label: string; run: () => void }) => void;
}) {
  const edit = !readOnly;
  // 이번에 연 회차에서 보이는 선택 속성(값이 있거나 방금 추가한 것). 다른 회차를 열면 다시 계산한다.
  const [shown, setShown] = useState<Set<string>>(() => new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  useEffect(() => {
    setShown(new Set());
    setFocusId(null);
  }, [doc.id]);
  useEffect(() => {
    setShown((s) => {
      const next = new Set(s);
      for (const p of PROPS) if (p.optional && p.present(doc)) next.add(p.id);
      return next.size === s.size ? s : next;
    });
  }, [doc]);
  const status = normalizeStatus(doc.status),
    type = normalizeType(doc.episodeType);
  const available = PROPS.filter((p) => doc.kind === "episode"
    ? p.id !== "episode-binding"
    : ["episode-binding", "tags"].includes(p.id));
  const visible = available.filter((p) => !p.optional || p.present(doc) || shown.has(p.id));
  const addable = available.filter((p) => p.optional && !visible.includes(p));
  const menuAt = (e: React.MouseEvent<HTMLElement>, items: MenuItem[]) =>
    onMenu(e.currentTarget.getBoundingClientRect(), items);

  function remove(p: Prop) {
    if (!p.clear) return;
    const { next, restore } = p.clear(doc);
    onEdit(next);
    setShown((s) => {
      const n = new Set(s);
      n.delete(p.id);
      return n;
    });
    setFocusId(null);
    onNotice(`${p.label} 속성을 제거했어요.`, {
      label: "실행 취소",
      run: () => {
        onEdit(restore);
        setShown((s) => new Set(s).add(p.id));
      },
    });
  }
  function pickStatus(s: string) {
    onEdit({ status: s });
    if (s === "completed")
      onNotice("원고 보호 모드로 전환되었습니다. 집필 완료된 에피소드는 편집이 제한됩니다.");
  }

  const control = (p: Prop): ReactNode => {
    switch (p.id) {
      case "summary":
        return (
          <GrowingText
            label="요약"
            dim
            value={doc.description || ""}
            disabled={!edit}
            onChange={(description) => onEdit({ description })}
          />
        );
      case "author-comment":
        return (
          <GrowingText
            label="작가의 말"
            value={doc.authorComment || ""}
            disabled={!edit}
            onChange={(authorComment) => onEdit({ authorComment })}
          />
        );
      case "tags":
        return <EpisodeTags key={doc.id} tags={doc.tags || []} editable={edit} favorites={favoriteTags}
          onChange={(tags) => onEdit({ tags })} onMenu={onMenu} />;
      case "episode-binding":
        return (
          <div className="property-binding">
            <button type="button" className="property-select" onClick={onBind} disabled={!edit || !onBind}
              aria-label={`연결 회차: ${boundEpisode?.title || "독립 문서"}`}
              title={boundEpisode?.title || "다른 에피소드에 연결하기"}>
              <span>{boundEpisode?.title || "독립 문서"}</span><ChevronDown size={14} />
            </button>
            {boundEpisode && onOpenBound && <button type="button" className="property-binding-action"
              aria-label="연결된 에피소드 열기" title="연결된 에피소드 열기" onClick={onOpenBound}>
              <ArrowUpRight size={14} />
            </button>}
            {edit && doc.episodeId && onUnbind && <button type="button" className="property-binding-action"
              aria-label="연결 해제하여 독립 문서로" title="연결 해제하여 독립 문서로" onClick={onUnbind}>
              <Unlink size={14} /><span>연결 해제</span>
            </button>}
          </div>
        );
      case "type":
        return (
          <button
            type="button"
            className="property-select"
            aria-label={`유형: ${TYPE_LABELS[type]}`}
            title={TYPE_LABELS[type]}
            disabled={!edit}
            onClick={(e) =>
              menuAt(
                e,
                TYPE_CHOICES.map((t) => ({
                  label: TYPE_ACTIONS[t],
                  icon: TYPE_ICONS[t],
                  disabled: type === t,
                  action: () => onEdit({ episodeType: t }),
                })),
              )
            }
          >
            <span>{TYPE_LABELS[type]}</span>
            {edit && <ChevronDown size={14} />}
          </button>
        );
      case "status":
        return (
          <button
            type="button"
            className={`property-select${status === "completed" ? " is-completed" : ""}`}
            aria-label={`상태: ${STATUS_LABELS[status]}`}
            title={STATUS_LABELS[status]}
            disabled={!edit}
            onClick={(e) => menuAt(e, statusItems(status, pickStatus))}
          >
            {STATUS_ICONS[status]}
            <span>{STATUS_LABELS[status]}</span>
            {edit && <ChevronDown size={14} />}
          </button>
        );
    }
    return null;
  };

  return (
    <section className="episode-info">
      {open && (
        <div className="property-grid">
          {visible.map((p) => (
            <PropertyRow
              key={p.id}
              prop={p}
              autoFocus={focusId === p.id}
              onRemove={edit && p.optional && p.clear ? () => remove(p) : undefined}
            >
              {control(p)}
            </PropertyRow>
          ))}
          <CustomProperties key={doc.id} properties={doc.properties} presets={propertyPresets} onSavePresets={onSavePresets} readOnly={!edit}
            onChange={(properties) => onEdit({ properties })} onMenu={onMenu} onNotice={onNotice}
            builtinItems={addable.map((p) => ({
              label: p.label,
              icon: <span className="faded-icon">{p.icon}</span>,
              hint: p.description,
              action: () => {
                setShown((s) => new Set(s).add(p.id));
                setFocusId(p.id);
              },
            }))} />
        </div>
      )}
      <button
        type="button"
        className="episode-info-toggle"
        aria-expanded={open}
        onClick={onToggle}
      >
        <ChevronDown size={14} className={open ? "flipped" : ""} />
        상세 정보 {open ? "접기" : "펼치기"}
      </button>
    </section>
  );
}

function PropertyRow({
  prop,
  autoFocus,
  onRemove,
  children,
}: {
  prop: Prop;
  autoFocus: boolean;
  onRemove?: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    const frame = requestAnimationFrame(() =>
      ref.current
        ?.querySelector<HTMLElement>("input, textarea, button:not(.property-remove)")
        ?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [autoFocus]);
  const removeLabel = `${prop.label} 속성 제거`;
  return (
      <div
        ref={ref}
        role="group"
        aria-label={prop.label}
        className={`property-row${prop.fullWidth ? " full" : ""}`}
      >
        <div className="property-label">
          {prop.icon}
          <span>{prop.label}</span>
        </div>
        <div className="property-control">{children}</div>
        {onRemove && (
          <button
            type="button"
            className="property-remove"
            aria-label={removeLabel}
            title={removeLabel}
            onClick={onRemove}
          >
            <X size={13} />
          </button>
        )}
      </div>
  );
}
