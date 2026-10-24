import { useEffect, useState } from "react";
import { ChevronRight, Copy as CopyIcon } from "lucide-react";
import { useConfirm } from "./ConfirmDialog";
import { call, type Doc } from "./types";

export type RecoveryCopy = { key: string; savedAt: string; unreadable?: boolean; document: Partial<Doc> };
type Copy = RecoveryCopy;
function Preview({ copyKey }: { copyKey: string }) {
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    call<Copy>("readRecoveryCopy", { key: copyKey }).then(copy => { if (alive) setBody(copy.document.body ?? ""); }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [copyKey]);
  return error ? <p role="alert">{error}</p> : <pre className="recovery-copy-preview" aria-label="사본 내용" tabIndex={0}>{body}</pre>;
}
export default function RecoveryCopies({ projectId, openDoc, common = false, showEmpty = false, restore }: {
  projectId: string;
  openDoc: (id: string, pinned?: boolean) => Promise<void>;
  common?: boolean;
  showEmpty?: boolean;
  restore?: (copy: RecoveryCopy) => Promise<void>;
}) {
  const [copies, setCopies] = useState<Copy[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [confirm, dialog] = useConfirm();
  useEffect(() => {
    setLoaded(false);
    let alive = true, loading = false, pending = false;
    const load = async () => {
      if (loading) { pending = true; return; }
      loading = true;
      do {
        pending = false;
        try {
          const data = await call<Copy[]>("recoveryCopies");
          if (alive) { setCopies(data); setError(""); }
        } catch (e: any) { if (alive) setError(e.message); }
        finally { if (alive) setLoaded(true); }
      } while (alive && pending);
      loading = false;
    };
    void load();
    const off = window.lof.onChange(() => void load());
    return () => { alive = false; off(); };
  }, [projectId, common]);
  const run = async (copy: Copy, remove: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      if (remove && !await confirm({ title: "복구 사본 삭제", message: `'${copy.document.title || "제목 없음"}' 복구 사본을 영구 삭제할까요? 현재 원고는 유지됩니다.`, confirmLabel: "사본 삭제", danger: true })) return;
      setError("");
      if (remove) {
        await call("deleteRecoveryCopy", { key: copy.key });
        setCopies(data => data.filter(item => item.key !== copy.key));
      } else if (restore) {
        await restore(copy);
      } else {
        const doc = await call<Doc>("restoreRecoveryCopy", { key: copy.key, projectId });
        await openDoc(doc.id, true);
      }
    } catch (e: any) { setError(e.message || "처리하지 못했습니다. 사본은 보관함에 남아 있습니다."); }
    finally { setBusy(false); }
  };
  const shown = copies.filter(copy => common ? !copy.document.projectId : showAll || !copy.document.projectId || copy.document.projectId === projectId);
  const hasOtherCopies = !common && copies.some(copy => copy.document.projectId && copy.document.projectId !== projectId);
  if (!common && !showEmpty && !shown.length && !hasOtherCopies && !error && !busy && !dialog) return null;
  return <section className="recovery-copies" aria-label="보관된 사본">
    {hasOtherCopies && <button onClick={() => setShowAll(value => !value)}>{showAll ? "이 작품의 사본만 보기" : "다른 작품의 사본도 보기"}</button>}
    {!loaded && <p role="status">불러오는 중…</p>}
    {loaded && common && !shown.length && !error && <p>보관함이 비어 있습니다.</p>}
    {error && <p role="alert">{error}</p>}
    {shown.map(copy => <details key={copy.key} open={expanded === copy.key} onToggle={event => { if (event.currentTarget.open) setExpanded(copy.key); else setExpanded(current => current === copy.key ? "" : current); }}>
      <summary>
        <CopyIcon size={16} aria-hidden />
        <span className="recovery-copy-title">{copy.document.title || "제목 없음"}</span>
        <span className="recovery-copy-label">사본</span>
        <time dateTime={copy.savedAt || undefined}>{copy.savedAt ? new Date(copy.savedAt).toLocaleString("ko-KR") : "날짜 없음"}</time>
        <ChevronRight size={15} className="recovery-copy-chevron" aria-hidden />
      </summary>
      {expanded === copy.key && <Preview copyKey={copy.key} />}
      <div className="conflict-actions">
        <button disabled={busy || copy.unreadable} onClick={() => void run(copy, false)}>{common ? "공용 메모에 새 메모로 복원" : "이 작품에 새 문서로 복원"}</button>
        <button disabled={busy} onClick={() => void run(copy, true)}>사본 삭제</button>
      </div>
    </details>)}
    {dialog}
  </section>;
}
