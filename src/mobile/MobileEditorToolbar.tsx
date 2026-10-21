import {
  Bold,
  CornerDownLeft,
  Heading2,
  ImagePlus,
  Italic,
  MessageSquareCode,
  Minus,
  MoreVertical,
  Redo2,
  Save,
  Sparkles,
  Strikethrough,
  Table2,
  Undo2,
} from "lucide-react";
import { Fragment } from "react";

const tools = [
  { action: "undo", label: "실행 취소", icon: Undo2 },
  { action: "redo", label: "다시 실행", icon: Redo2 },
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
  moreOpen,
  onToggleMore,
  onReplaceSymbols,
}: {
  disabled?: boolean;
  moreOpen: boolean;
  onToggleMore: () => void;
  onReplaceSymbols: () => void;
}) {
  return (
    <div className="m-floating-pill-wrap">
      <div className="m-floating-pill-bar" role="toolbar" aria-label="모바일 집필 툴바">
        <div className="m-pill-scroll-track">
          {tools.map(({ action, label, icon: Icon }) => (
            <Fragment key={action}>
              {action === "bold" && <span className="m-pill-sub-divider" aria-hidden="true" />}
              <button
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
            </Fragment>
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
  onSave,
}: {
  disabled?: boolean;
  tables: boolean;
  manualLineBreak: boolean;
  onClose: () => void;
  onSave: () => void;
}) {
  const actions = [
    { action: "image", label: "이미지 삽입", icon: ImagePlus },
    ...(tables ? [{ action: "table", label: "표 삽입", icon: Table2 }] : []),
    { action: "comment", label: "주석 추가", icon: MessageSquareCode },
  ];
  return (
    <div className="m-floating-popup-section">
      <button
        type="button"
        className="m-floating-popup-item"
        role="menuitem"
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          onClose();
          onSave();
        }}
      >
        <Save size={16} />
        <span>수동 저장</span>
      </button>
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
