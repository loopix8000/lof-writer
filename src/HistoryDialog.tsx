import { useEffect, useRef, useState } from "react";
import { call } from "./types";

type Entry = { name: string; savedAt: string; title: string; kind: string; commit?: string };
type Page = { entries: Entry[]; anchor: string | null; nextOffset: number | null; migrating: boolean };
const labels: Record<string, string> = { manual: "수동 저장", restore: "복원", beforeRestore: "복원 전", legacy: "기존 기록", auto: "자동 기록" };

export default function HistoryDialog({ documentId, onRestore, report }: {
  documentId: string;
  onRestore: (id: string, name: string) => Promise<void>;
  report: (error: any) => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [page, setPage] = useState<Page | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [mode, setMode] = useState<"body" | "compare">("compare");
  const [loading, setLoading] = useState(true);
  const [reading, setReading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const sequence = useRef(0);
  const alive = useRef(true);
  const currentId = useRef(documentId); currentId.current = documentId;
  useEffect(() => {
    alive.current = true;
    const request = ++sequence.current;
    setEntries([]); setPreview(null); setPage(null); setLoading(true);
    call<Page>("historyPage", { id: documentId }).then((result) => {
      if (alive.current && request === sequence.current) { setPage(result); setEntries(result.entries); }
    }).catch((error) => { if (alive.current && request === sequence.current) report(error); })
      .finally(() => { if (alive.current && request === sequence.current) setLoading(false); });
    return () => { alive.current = false; ++sequence.current; };
  }, [documentId]);
  async function more() {
    if (loading || page?.nextOffset == null) return;
    setLoading(true);
    try {
      const result = await call<Page>("historyPage", { id: documentId, offset: page.nextOffset, anchor: page.anchor });
      if (!alive.current || currentId.current !== documentId) return;
      setPage(result);
      setEntries((existing) => [...existing, ...result.entries.filter((entry) => !existing.some((old) => old.name === entry.name))]);
    } catch (error) { if (alive.current && currentId.current === documentId) report(error); }
    finally { if (alive.current && currentId.current === documentId) setLoading(false); }
  }
  async function select(entry: Entry) {
    const request = ++sequence.current;
    setReading(true); setPreview(null);
    try {
      const document = await call("historyRead", { id: documentId, name: entry.name, compare: true });
      if (alive.current && request === sequence.current) setPreview({ ...document, ...entry });
    } catch (error) { if (alive.current && request === sequence.current) report(error); }
    finally { if (alive.current && request === sequence.current) setReading(false); }
  }
  const comparison = preview?.comparison;
  return <div className="history-layout">
    <div className="history-list" aria-label="문서 변경 이력">
      {page?.migrating && <p className="muted" role="status">기존 이력을 Git으로 옮기는 중입니다. 먼저 기존 기록을 표시합니다.</p>}
      {entries.map((entry) => <button key={entry.name} disabled={restoring}
        className={preview?.name === entry.name ? "selected" : ""} onClick={() => void select(entry)}>
        <span>{new Date(entry.savedAt).toLocaleString("ko-KR")}</span>
        <small>{labels[entry.kind] ?? "기록"}</small>
      </button>)}
      {!loading && !entries.length && <p>아직 기록된 변경이 없습니다.</p>}
      {loading && <p role="status">기록을 불러오는 중…</p>}
      {page?.nextOffset != null && <button disabled={loading || restoring} onClick={() => void more()}>이전 기록 더 보기</button>}
    </div>
    <div className="history-preview">
      {reading ? <p role="status">원고를 불러오는 중…</p> : preview ? <>
        <b>{preview.title}</b>
        <div className="history-mode" role="group" aria-label="이력 보기 방식">
          <button aria-pressed={mode === "compare"} onClick={() => setMode("compare")}>현재 원고와 비교</button>
          <button aria-pressed={mode === "body"} onClick={() => setMode("body")}>원고 보기</button>
        </div>
        {mode === "body" ? <pre>{preview.body}</pre> : comparison?.available ? <>
          <p className="muted">이전 원고 → 현재 원고 · 추가 {comparison.added}줄 · 삭제 {comparison.removed}줄</p>
          {!comparison.added && !comparison.removed ? <p>본문은 같습니다. 제목이나 속성이 달라졌을 수 있습니다.</p>
            : <pre className="history-diff" aria-label="이전 원고와 현재 원고의 변경 비교">{comparison.lines.map((line: any, index: number) => <span key={index} className={`history-diff-${line.kind}`}>{line.text}{"\n"}</span>)}</pre>}
          {comparison.truncated && <p className="muted">변경량이 많아 앞부분만 표시합니다. 원고 보기에서 전체 내용을 확인할 수 있습니다.</p>}
        </> : <p>{comparison?.message ?? "원고 보기에서 내용을 확인해 주세요."}</p>}
        <div className="history-actions">
          <button className="primary" disabled={restoring} onClick={async () => {
            setRestoring(true);
            try { await onRestore(documentId, preview.name); }
            catch (error) { if (alive.current) report(error); }
            finally { if (alive.current) setRestoring(false); }
          }}>{restoring ? "복원 중…" : "이 버전으로 복원"}</button>
        </div>
      </> : <p>왼쪽에서 변경 이력을 선택하세요.</p>}
    </div>
  </div>;
}
