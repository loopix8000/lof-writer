import { Check, Folder, FolderOpen, X } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";

export type MobileActionItem =
  | "separator"
  | {
      label: string;
      sublabel?: string;
      icon?: React.ReactNode;
      danger?: boolean;
      disabled?: boolean;
      checked?: boolean;
      action: () => void;
    };

export function MobileActionSheet({
  open,
  title,
  subtitle,
  items,
  onClose,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  items: MobileActionItem[];
  onClose: () => void;
}) {
  if (!open) return null;

  return (
    <div
      className="m-sheet-backdrop"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="m-action-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="m-sheet-handle" aria-hidden="true" />
        <div className="m-sheet-header">
          <div className="m-sheet-title-group">
            <h3>{title}</h3>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button
            type="button"
            className="m-icon-btn"
            aria-label="닫기"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <div className="m-sheet-list">
          {items.map((item, idx) => {
            if (item === "separator") {
              return <div key={`sep-${idx}`} className="m-sheet-divider" />;
            }
            return (
              <button
                key={`${item.label}-${idx}`}
                type="button"
                className={`m-sheet-item ${item.danger ? "danger" : ""} ${item.checked ? "checked" : ""}`}
                disabled={item.disabled}
                onClick={() => {
                  onClose();
                  item.action();
                }}
              >
                {item.icon && <span className="m-sheet-item-icon">{item.icon}</span>}
                <span className="m-sheet-item-text">
                  <strong>{item.label}</strong>
                  {item.sublabel && <small>{item.sublabel}</small>}
                </span>
                {item.checked && <Check size={18} className="m-sheet-check" />}
              </button>
            );
          })}
        </div>
        <div className="m-sheet-Cancel-wrap">
          <button type="button" className="m-sheet-cancel" onClick={onClose}>
            취소
          </button>
        </div>
      </div>
    </div>
  );
}

export function MobilePromptSheet({
  open,
  title,
  description,
  placeholder,
  initialValue,
  confirmLabel = "확인",
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description?: string;
  placeholder?: string;
  initialValue: string;
  confirmLabel?: string;
  onConfirm: (value: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setValue(initialValue);
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 60);
    }
  }, [open, initialValue]);

  if (!open) return null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    onClose();
    void onConfirm(trimmed);
  };

  return (
    <div className="m-sheet-backdrop" onClick={onClose} role="presentation">
      <form
        className="m-prompt-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <div className="m-sheet-header">
          <div className="m-sheet-title-group">
            <h3>{title}</h3>
            {description && <p>{description}</p>}
          </div>
          <button
            type="button"
            className="m-icon-btn"
            aria-label="닫기"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <div className="m-prompt-body">
          <input
            ref={inputRef}
            type="text"
            className="m-text-input"
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        <div className="m-prompt-footer">
          <button type="button" className="m-btn-secondary" onClick={onClose}>
            취소
          </button>
          <button
            type="submit"
            className="m-btn-primary"
            disabled={!value.trim()}
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

export function MobileFolderPickerSheet({
  open,
  title,
  currentFolder,
  folders,
  onSelect,
  onClose,
}: {
  open: boolean;
  title: string;
  currentFolder: string;
  folders: string[];
  onSelect: (folder: string) => void;
  onClose: () => void;
}) {
  if (!open) return null;

  return (
    <div className="m-sheet-backdrop" onClick={onClose} role="presentation">
      <div
        className="m-action-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="m-sheet-handle" aria-hidden="true" />
        <div className="m-sheet-header">
          <div className="m-sheet-title-group">
            <h3>{title}</h3>
            <p>이동할 폴더를 선택하세요</p>
          </div>
          <button
            type="button"
            className="m-icon-btn"
            aria-label="닫기"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <div className="m-sheet-list">
          <button
            type="button"
            className={`m-sheet-item ${currentFolder === "" ? "checked" : ""}`}
            onClick={() => {
              onClose();
              onSelect("");
            }}
          >
            <span className="m-sheet-item-icon">
              <FolderOpen size={18} />
            </span>
            <span className="m-sheet-item-text">
              <strong>최상위 폴더 (기본 위치)</strong>
            </span>
            {currentFolder === "" && <Check size={18} className="m-sheet-check" />}
          </button>
          {folders.map((folder) => (
            <button
              key={folder}
              type="button"
              className={`m-sheet-item ${currentFolder === folder ? "checked" : ""}`}
              onClick={() => {
                onClose();
                onSelect(folder);
              }}
            >
              <span className="m-sheet-item-icon">
                <Folder size={18} />
              </span>
              <span className="m-sheet-item-text">
                <strong>{folder}</strong>
              </span>
              {currentFolder === folder && <Check size={18} className="m-sheet-check" />}
            </button>
          ))}
        </div>
        <div className="m-sheet-Cancel-wrap">
          <button type="button" className="m-sheet-cancel" onClick={onClose}>
            취소
          </button>
        </div>
      </div>
    </div>
  );
}
