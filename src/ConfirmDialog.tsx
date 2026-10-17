import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type ConfirmOptions = {
  title: string;
  message: ReactNode;
  // 본문 아래 흐린 글씨로 덧붙이는 설명(예: 되돌릴 수 없음).
  detail?: ReactNode;
  confirmLabel?: string;
  // 지우기처럼 되돌릴 수 없는 일이면 확인 단추를 빨갛게 하고, 실수로 누르지 않게 취소에 포커스를 둔다.
  danger?: boolean;
  icon?: ReactNode;
};

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };

// 브라우저 기본 확인 창 대신 쓰는 앱 모양의 확인 창. confirm(옵션)은 누른 단추에 따라 true나 false로 끝난다.
// 설정·이력 창 위에도 겹쳐 떠야 하므로 앱의 대화상자와 따로 그린다. element를 화면 어딘가에 그려 둔다.
export function useConfirm() {
  const [pending, setPending] = useState<Pending | null>(null);
  const confirm = useCallback(
    (options: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ ...options, resolve })),
    [],
  );
  const close = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };
  const element =
    pending &&
    // 테마 색 변수가 .app에 있으므로 그 안에 띄운다.
    createPortal(<ConfirmBox {...pending} onClose={close} />, document.querySelector(".app") ?? document.body);
  return [confirm, element] as const;
}

function ConfirmBox({
  title,
  message,
  detail,
  confirmLabel = "확인",
  danger = false,
  icon,
  onClose,
}: ConfirmOptions & { onClose: (ok: boolean) => void }) {
  // Esc는 이 창만 닫고, 아래에 깔린 설정·이력 창까지 닫히지 않게 한다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div
      // 삭제처럼 되돌릴 수 없는 일을 묻는 창은 배경을 어둡게 하지 않는다.
      className={`modal-backdrop confirm-backdrop${danger ? " plain-backdrop" : ""}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose(false);
      }}
    >
      <div className="modal confirm-modal" role="alertdialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <h2>{title}</h2>
        </div>
        <p>{message}</p>
        {detail && <p className="muted">{detail}</p>}
        <div className="modal-footer">
          <button autoFocus={danger} onClick={() => onClose(false)}>
            취소
          </button>
          <button autoFocus={!danger} className={danger ? "danger-solid" : "primary"} onClick={() => onClose(true)}>
            {icon}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
