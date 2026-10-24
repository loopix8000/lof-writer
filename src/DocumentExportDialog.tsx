import { Code2, FileText } from "lucide-react";
import { useEffect } from "react";
import { MobileActionSheet } from "./mobile/MobileActionSheet";
import { call } from "./types";

const formats = [
  { format: "md", label: "마크다운 (.md)", description: "마크다운 서식과 문서 정보를 포함합니다.", icon: <Code2 size={18} /> },
  { format: "txt", label: "일반 텍스트 (.txt)", description: "서식 없이 본문만 저장합니다.", icon: <FileText size={18} /> },
] as const;

export default function DocumentExportDialog({ documentId, isMobile = false, flush, onClose, message, report }: {
  documentId: string;
  isMobile?: boolean;
  flush: () => Promise<void>;
  onClose: () => void;
  message: (text: string) => void;
  report: (error: unknown) => void;
}) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", close, true);
    return () => window.removeEventListener("keydown", close, true);
  }, [onClose]);

  function choose(format: "md" | "txt") {
    onClose();
    void (async () => {
      await flush();
      if (await call("exportDocument", { id: documentId, format })) message("원고를 내보냈습니다.");
    })().catch(report);
  }

  if (isMobile) return <MobileActionSheet open title="내보내기 형식" onClose={onClose}
    items={formats.map(option => ({ label: option.label, sublabel: option.description, icon: option.icon,
      action: () => choose(option.format) }))} />;

  return <div className="modal-backdrop confirm-backdrop" onMouseDown={event => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <div className="modal confirm-modal" role="dialog" aria-modal="true" aria-label="내보내기 형식">
      <div className="modal-header"><h2>내보내기 형식</h2></div>
      <div className="document-export-formats">
        {formats.map((option, index) => <button type="button" key={option.format} autoFocus={index === 0}
          onClick={() => choose(option.format)}>
          {option.icon}<span><strong>{option.label}</strong><small>{option.description}</small></span>
        </button>)}
      </div>
      <div className="modal-footer"><button type="button" onClick={onClose}>취소</button></div>
    </div>
  </div>;
}
