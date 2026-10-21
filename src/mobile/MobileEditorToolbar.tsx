import {
  Bold,
  Copy,
  CornerDownLeft,
  FileText,
  Heading2,
  History,
  ImagePlus,
  Italic,
  MessageSquareCode,
  Minus,
  MoreVertical,
  Redo2,
  Save,
  Sparkles,
  StickyNote,
  Strikethrough,
  Table2,
  Undo2,
} from "lucide-react";

const historyTools = [
  { action: "undo", label: "실행 취소", icon: Undo2 },
  { action: "redo", label: "되돌리기", icon: Redo2 },
] as const;

const formatTools = [
  { action: "bold", label: "굵게", icon: Bold },
  { action: "italic", label: "기울임", icon: Italic },
  { action: "strike", label: "취소선", icon: Strikethrough },
  { action: "heading", label: "소제목", icon: Heading2 },
  { action: "divider", label: "장면 구분선", icon: Minus },
] as const;

function editorAction(action: string) {
  window.dispatchEvent(new CustomEvent("lof:editor-action", { detail: action }));
}

export default function MobileEditorToolbar({
  disabled = false,
  saveDisabled = false,
  moreOpen,
  onToggleMore,
  onReplaceSymbols,
  onHistory,
  onSave,
  onCopy,
  onAddPlot,
  onAddMemo,
}: {
  disabled?: boolean;
  saveDisabled?: boolean;
  moreOpen: boolean;
  onToggleMore: () => void;
  onReplaceSymbols: () => void;
  onHistory?: () => void;
  onSave?: () => void;
  onCopy?: () => void;
  onAddPlot?: () => void;
  onAddMemo?: () => void;
}) {
  const quickActions = [
    ...(onHistory ? [{ key: "history", label: "기록", icon: History, onClick: onHistory, lockable: false }] : []),
    ...(onSave ? [{ key: "save", label: "저장", icon: Save, onClick: onSave, lockable: true }] : []),
    ...(onCopy ? [{ key: "copy", label: "복사", icon: Copy, onClick: onCopy, lockable: false }] : []),
    ...(onAddPlot ? [{ key: "plot", label: "플롯", icon: FileText, onClick: onAddPlot, lockable: false }] : []),
    ...(onAddMemo ? [{ key: "memo", label: "메모", icon: StickyNote, onClick: onAddMemo, lockable: false }] : []),
  ];

  return (
    <div className="m-floating-pill-wrap">
      <div className="m-floating-pill-bar" role="toolbar" aria-label="모바일 집필 툴바">
        <div className="m-pill-scroll-track">
          {historyTools.map(({ action, label, icon: Icon }) => (
            <button
              key={action}
              type="button"
              className="m-pill-tool-btn"
              aria-label={label}
              title={label}
              disabled={disabled}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => editorAction(action)}
            >
              <Icon size={18} strokeWidth={2} />
            </button>
          ))}
          {quickActions.length > 0 && (
            <>
              <span className="m-pill-sub-divider" aria-hidden="true" />
              {quickActions.map(({ key, label, icon: Icon, onClick, lockable }) => (
                <button
                  key={key}
                  type="button"
                  className="m-pill-tool-btn"
                  aria-label={label}
                  title={label}
                  disabled={(lockable && disabled) || (key === "save" && saveDisabled)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={onClick}
                >
                  <Icon size={18} strokeWidth={2} />
                </button>
              ))}
            </>
          )}
          <span className="m-pill-sub-divider" aria-hidden="true" />
          {formatTools.map(({ action, label, icon: Icon }) => (
            <button
              key={action}
              type="button"
              className="m-pill-tool-btn"
              aria-label={label}
              title={label}
              disabled={disabled}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => editorAction(action)}
            >
              <Icon size={18} strokeWidth={2} />
            </button>
          ))}
          <button
            type="button"
            className="m-pill-tool-btn"
            aria-label="기호 일괄 대치"
            title="기호 일괄 대치"
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onReplaceSymbols}
          >
            <Sparkles size={17} strokeWidth={2} />
          </button>
        </div>
        <span className="m-pill-divider" aria-hidden="true" />
        <button
          type="button"
          className={`m-pill-more-btn ${moreOpen ? "active" : ""}`}
          aria-label="더보기 팝업 메뉴"
          aria-expanded={moreOpen}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onToggleMore}
        >
          <MoreVertical size={19} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

export function MobileEditorMenuActions({
  disabled = false,
  tables,
  manualLineBreak,
  onClose,
}: {
  disabled?: boolean;
  tables: boolean;
  manualLineBreak: boolean;
  onClose: () => void;
}) {
  const actions = [
    { action: "image", label: "이미지 삽입", icon: ImagePlus },
    ...(tables ? [{ action: "table", label: "표 삽입", icon: Table2 }] : []),
    { action: "comment", label: "주석 추가", icon: MessageSquareCode },
  ];
  return (
    <div className="m-floating-popup-section">
      {actions.map(({ action, label, icon: Icon }) => (
        <button
          key={action}
          type="button"
          className="m-floating-popup-item"
          role="menuitem"
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onClose();
            editorAction(action);
          }}
        >
          <Icon size={16} />
          <span>{label}</span>
        </button>
      ))}
      <button
        type="button"
        className="m-floating-popup-item"
        role="menuitem"
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => editorAction("toggleLineBreak")}
      >
        <CornerDownLeft size={16} />
        <span>줄바꿈 관리</span>
        <small className="m-floating-popup-badge accent">
          {manualLineBreak ? "수동 줄바꿈" : "자동 줄바꿈"}
        </small>
      </button>
    </div>
  );
}
