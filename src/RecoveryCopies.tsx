import { useEffect, useState } from "react";
import { useConfirm } from "./ConfirmDialog";
import { call, type Doc } from "./types";

type Copy = { key: string; savedAt: string; unreadable?: boolean; document: Partial<Doc> };
function Preview({ copyKey }: { copyKey: string }) {
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    call<Copy>("readRecoveryCopy", { key: copyKey }).then(copy => { if (alive) setBody(copy.document.body ?? ""); }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [copyKey]);
  return error ? <p role="alert">{error}</p> : <textarea aria-label="복구 사본 내용" readOnly value={body} rows={8} />;
}
export default function RecoveryCopies({ projectId, openDoc }: { projectId: string; openDoc: (id: string, pinned?: boolean) => Promise<void> }) {
  const [copies, setCopies] = useState<Copy[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [confirm, dialog] = useConfirm();
  useEffect(() => {
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
      } while (alive && pending);
      loading = false;
    };
    void load();
    const off = window.lof.onChange(() => void load());
    return () => { alive = false; off(); };
  }, [projectId]);
  const run = async (copy: Copy, remove: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      if (remove && !await confirm({ title: "복구 사본 삭제", message: `'${copy.document.title || "제목 없음"}' 복구 사본을 영구 삭제할까요? 현재 원고는 유지됩니다.`, confirmLabel: "사본 삭제", danger: true })) return;
      setError("");
      if (remove) {
        await call("deleteRecoveryCopy", { key: copy.key });
        setCopies(data => data.filter(item => item.key !== copy.key));
      } else {
        const doc = await call<Doc>("restoreRecoveryCopy", { key: copy.key, projectId });
        await openDoc(doc.id, true);
      }
    } catch (e: any) { setError(e.message || "처리하지 못했습니다. 사본은 보관함에 남아 있습니다."); }
    finally { setBusy(false); }
  };
  const shown = copies.filter(copy => showAll || !copy.document.projectId || copy.document.projectId === projectId);
  return <section className="recovery-copies">
    <h3>복구 사본 <small>{shown.length}</small></h3>
    <p>충돌을 정리하지 못했을 때 이 기기에 보관한 편집 내용입니다. 새 문서로 복원해 이어 쓸 수 있습니다.</p>
    {copies.some(copy => copy.document.projectId && copy.document.projectId !== projectId) && <button onClick={() => setShowAll(value => !value)}>{showAll ? "이 작품의 사본만 보기" : "다른 작품의 사본도 보기"}</button>}
    {error && <p role="alert">{error}</p>}
    {shown.map(copy => <details key={copy.key} open={expanded === copy.key} onToggle={event => { if (event.currentTarget.open) setExpanded(copy.key); else setExpanded(current => current === copy.key ? "" : current); }}>
      <summary>{copy.document.title || "제목 없음"} · {copy.savedAt ? new Date(copy.savedAt).toLocaleString("ko-KR") : "날짜 없음"}</summary>
      {expanded === copy.key && <Preview copyKey={copy.key} />}
      <div className="conflict-actions">
        <button disabled={busy || copy.unreadable} onClick={() => void run(copy, false)}>이 작품에 새 문서로 복원</button>
        <button disabled={busy} onClick={() => void run(copy, true)}>사본 삭제</button>
      </div>
    </details>)}
    {dialog}
  </section>;
}
