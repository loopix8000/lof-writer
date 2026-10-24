import { ArchiveRestore, ArrowLeft, FileText, StickyNote, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import RecoveryCopies from "./RecoveryCopies";
import { call, type Doc } from "./types";

export default function MemoArchiveDialog({ space, title, documents, mobile = false, onClose, openDoc, openMemo }: {
  space: string;
  title: string;
  documents: Doc[];
  mobile?: boolean;
  onClose: () => void;
  openDoc: (id: string) => Promise<void>;
  openMemo: (space: string, path: string) => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState(new Set<string>());
  const panel = useRef<HTMLDivElement>(null);
  const common = space === "common";
  const archived = documents.filter(doc => doc.projectId === space && doc.kind !== "episode" && doc.archived && !restored.has(doc.id));
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => { if (previous?.isConnected && previous.getClientRects().length) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    if (!mobile) return;
    const previous = (window as any).__lofOverlayBack;
    const close = () => {
      if (document.querySelector(".confirm-backdrop")) {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
      } else onClose();
      return true;
    };
    (window as any).__lofOverlayBack = close;
    return () => {
      if ((window as any).__lofOverlayBack === close) (window as any).__lofOverlayBack = previous;
    };
  }, [mobile, onClose]);
  const openDocument = async (id: string) => { await openDoc(id); onClose(); };
  const unarchive = async (doc: Doc) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const current = await call<Doc>("readDocument", { id: doc.id });
      await call("saveDocument", { id: doc.id, expectedRevision: current.revision, archived: false });
      setRestored(ids => new Set([...ids, doc.id]));
    } catch (error: any) { setError(error.message || "보관함에서 꺼내지 못했습니다."); }
    finally { setBusy(false); }
  };
  const content = <>
    {!common && <section className="memo-archive-documents">
      <h3>보관된 문서 <small>{archived.length}</small></h3>
      {error && <p role="alert">{error}</p>}
      {!archived.length && <p>보관된 메모와 플롯이 없습니다.</p>}
      {archived.map(doc => <div className="memo-archive-row" key={doc.id}>
        <button className="memo-archive-open" disabled={busy} onClick={() => {
          void openDocument(doc.id).catch(error => setError(error.message));
        }}>
          {doc.kind === "plot" ? <FileText size={16} /> : <StickyNote size={16} />}
          <span>{doc.title || "제목 없음"}</span>
        </button>
        <button disabled={busy} onClick={() => void unarchive(doc)}>
          <ArchiveRestore size={15} />보관함에서 꺼내기
        </button>
      </div>)}
    </section>}
    <RecoveryCopies projectId={common ? "" : space} common={common} showEmpty={common} openDoc={openDocument}
      restore={common ? async copy => {
        const memo = await call<{ space: string; path: string }>("restoreRecoveryCopy", { key: copy.key, space: "common" });
        await openMemo(memo.space, memo.path);
        onClose();
      } : undefined} />
  </>;
  const heading = `${title} 보관함`;
  const dialog = <div className={mobile ? "m-dialog-page" : "modal wide memo-archive-dialog"}
    ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={heading} onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    }}>
    <header className={mobile ? "m-topbar m-topbar-centered" : "modal-header"}>
      {mobile && <button type="button" className="m-back-btn" onClick={onClose}><ArrowLeft size={18} /><span>메모</span></button>}
      {mobile ? <div className="m-topbar-title"><h1>{heading}</h1></div> : <h2>{heading}</h2>}
      {!mobile && <button type="button" aria-label="보관함 닫기" onClick={onClose}><X size={18} /></button>}
    </header>
    <div className={mobile ? "m-dialog-body" : "memo-archive-body"}>{content}</div>
  </div>;
  return mobile ? dialog : <div className="modal-backdrop" onMouseDown={event => {
    if (event.target === event.currentTarget) onClose();
  }}>{dialog}</div>;
}
