import { useEffect, useRef, useState } from "react";
import { CopyPlus, RotateCcw, Trash2 } from "lucide-react";
import { useConfirm } from "./ConfirmDialog";
import { call } from "./types";

type Entry = { name: string; savedAt: string; title: string; kind: string; commit?: string };
type Page = { entries: Entry[]; anchor: string | null; nextOffset: number | null; migrating: boolean };
const labels: Record<string, string> = { manual: "수동 저장", restore: "복원", beforeRestore: "복원 전", legacy: "기존 기록", auto: "자동 기록" };
type MetadataChange = { key: string; property: boolean; previous: unknown; current: unknown; previousExists: boolean; currentExists: boolean };
const fieldLabels: Record<string, string> = {
  title: "제목", status: "상태", kind: "문서 유형", order: "순서", archived: "보관",
  episodeType: "회차 유형", description: "설명", authorComment: "작가의 말", tags: "태그",
  manualLineBreak: "줄바꿈 수동 관리", bookmarks: "북마크", episodeId: "연결 회차",
};
function metadataValue(change: MetadataChange, value: unknown, exists: boolean): string {
  if (!exists) return "없음";
  if (value === null) return "null";
  if (!change.property) {
    if (change.key === "status") return ({ in_progress: "집필 중", revision: "퇴고 중", completed: "집필 완료" } as Record<string, string>)[String(value)] ?? String(value);
    if (change.key === "kind") return ({ episode: "회차", plot: "플롯", memo: "메모" } as Record<string, string>)[String(value)] ?? String(value);
    if (change.key === "episodeType") return ({ 0: "일반", 2: "프롤로그", 3: "에필로그", 4: "특별편", 6: "단편" } as Record<string, string>)[String(value)] ?? String(value);
  }
  if (typeof value === "string") return change.property || value === "" ? JSON.stringify(value) : value;
  return JSON.stringify(value, null, 2);
}

export default function HistoryDialog({ documentId, memoContext, onRestore, onSaveCopy, report }: {
  documentId: string;
  memoContext?: { space: string; path: string };
  onRestore: (id: string, name: string) => Promise<void>;
  // 고른 이력의 원고를 새 문서로 저장한다. 없으면 사본 저장 단추를 숨긴다.
  onSaveCopy?: (id: string, version: { title?: string; body: string; savedAt: string }) => Promise<void>;
  report: (error: any) => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [page, setPage] = useState<Page | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [mode, setMode] = useState<"body" | "compare">("compare");
  const [loading, setLoading] = useState(true);
  const [reading, setReading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [copying, setCopying] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const sequence = useRef(0);
  const alive = useRef(true);
  const requestKey = JSON.stringify([documentId, memoContext?.space, memoContext?.path]);
  const currentId = useRef(requestKey); currentId.current = requestKey;
  useEffect(() => {
    alive.current = true;
    const request = ++sequence.current;
    setEntries([]); setPreview(null); setPage(null); setLoading(true);
    call<Page>("historyPage", { id: documentId, ...memoContext }).then((result) => {
      if (alive.current && request === sequence.current) { setPage(result); setEntries(result.entries); }
    }).catch((error) => { if (alive.current && request === sequence.current) report(error); })
      .finally(() => { if (alive.current && request === sequence.current) setLoading(false); });
    return () => { alive.current = false; ++sequence.current; };
  }, [documentId, memoContext?.space, memoContext?.path]);
  async function more() {
    if (loading || page?.nextOffset == null) return;
    setLoading(true);
    try {
      const result = await call<Page>("historyPage", { id: documentId, ...memoContext, offset: page.nextOffset, anchor: page.anchor });
      if (!alive.current || currentId.current !== requestKey) return;
      setPage(result);
      setEntries((existing) => [...existing, ...result.entries.filter((entry) => !existing.some((old) => old.name === entry.name))]);
    } catch (error) { if (alive.current && currentId.current === requestKey) report(error); }
    finally { if (alive.current && currentId.current === requestKey) setLoading(false); }
  }
  async function select(entry: Entry) {
    const request = ++sequence.current;
    setReading(true); setPreview(null);
    try {
      const document = await call("historyRead", { id: documentId, ...memoContext, name: entry.name, compare: true });
      if (alive.current && currentId.current === requestKey && request === sequence.current) setPreview({ ...document, ...entry });
    } catch (error) { if (alive.current && currentId.current === requestKey && request === sequence.current) report(error); }
    finally { if (alive.current && currentId.current === requestKey && request === sequence.current) setReading(false); }
  }
  // 고른 이력 하나를 지운다. 지운 이력은 목록에서 빠지므로 다음 쪽을 읽을 자리도 하나 당긴다.
  async function remove(entry: Entry) {
    const ok = await confirm({
      title: "이력 삭제",
      message: <><b>{new Date(entry.savedAt).toLocaleString("ko-KR")}</b> 이력을 삭제할까요?</>,
      detail: "삭제한 이력은 목록에서 사라지며 다시 복원할 수 없습니다.",
      confirmLabel: "삭제",
      danger: true,
    });
    if (!ok || !alive.current || currentId.current !== requestKey) return;
    setDeleting(true);
    try {
      await call("deleteHistory", { id: documentId, ...memoContext, name: entry.name });
      if (!alive.current || currentId.current !== requestKey) return;
      setEntries((existing) => existing.filter((old) => old.name !== entry.name));
      setPage((current) => current && current.nextOffset != null ? { ...current, nextOffset: Math.max(0, current.nextOffset - 1) } : current);
      setPreview((current: any) => current?.name === entry.name ? null : current);
    } catch (error) { if (alive.current && currentId.current === requestKey) report(error); }
    finally { if (alive.current && currentId.current === requestKey) setDeleting(false); }
  }
  const comparison = preview?.comparison;
  const busy = restoring || deleting || copying;
  return <div className="history-layout">
    <div className="history-list" aria-label="문서 변경 이력">
      {page?.migrating && <p className="muted" role="status">기존 이력을 Git으로 옮기는 중입니다. 먼저 기존 기록을 표시합니다.</p>}
      {entries.map((entry) => <button key={entry.name} disabled={busy}
        className={preview?.name === entry.name ? "selected" : ""} onClick={() => void select(entry)}>
        <span>{new Date(entry.savedAt).toLocaleString("ko-KR")}</span>
        <small>{labels[entry.kind] ?? "기록"}</small>
      </button>)}
      {!loading && !entries.length && <p>아직 기록된 변경이 없습니다.</p>}
      {loading && <p role="status">기록을 불러오는 중…</p>}
      {page?.nextOffset != null && <button disabled={loading || busy} onClick={() => void more()}>이전 기록 더 보기</button>}
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
          {!comparison.added && !comparison.removed ? <p>{comparison.metadataChanges?.length ? "본문은 같습니다." : "본문과 제목·속성이 모두 같습니다."}</p>
            : <pre className="history-diff" aria-label="이전 원고와 현재 원고의 변경 비교">{comparison.lines.map((line: any, index: number) => <span key={index} className={`history-diff-${line.kind}`}>{line.text}{"\n"}</span>)}</pre>}
          {comparison.truncated && <p className="muted">변경량이 많아 앞부분만 표시합니다. 원고 보기에서 전체 내용을 확인할 수 있습니다.</p>}
        </> : <p>{comparison?.message ?? "원고 보기에서 내용을 확인해 주세요."}</p>}
        {mode === "compare" && !!comparison?.metadataChanges?.length && <dl className="history-metadata" aria-label="제목과 속성 변경">
          {comparison.metadataChanges.map((change: MetadataChange) => <div key={`${change.property}:${change.key}`}>
            <dt>{change.property ? `속성 · ${change.key === "_lofPropertyIcons" ? "아이콘" : change.key}` : fieldLabels[change.key] ?? change.key}</dt>
            <dd><span className="history-diff-removed"><span className="muted">이전: </span>{metadataValue(change, change.previous, change.previousExists)}</span>
              <span className="history-diff-added"><span className="muted">현재: </span>{metadataValue(change, change.current, change.currentExists)}</span></dd>
          </div>)}
        </dl>}
        <div className="history-actions">
          <button className="primary" disabled={busy} onClick={async () => {
            setRestoring(true);
            try { await onRestore(documentId, preview.name); }
            catch (error) { if (alive.current) report(error); }
            finally { if (alive.current) setRestoring(false); }
          }}>
            <RotateCcw size={16} />
            {restoring ? "복원 중…" : "이 버전으로 복원"}
          </button>
          {onSaveCopy && <button disabled={busy} onClick={async () => {
            setCopying(true);
            try { await onSaveCopy(documentId, { title: preview.title, body: preview.body ?? "", savedAt: preview.savedAt }); }
            catch (error) { if (alive.current) report(error); }
            finally { if (alive.current) setCopying(false); }
          }}>
            <CopyPlus size={16} />
            {copying ? "저장 중…" : "사본으로 저장"}
          </button>}
          <button className="history-delete danger-outline" disabled={busy} onClick={() => void remove(preview)}
            aria-label="이 이력 삭제" title="이 이력 삭제">
            <Trash2 size={16} />
            {deleting && <span>삭제 중…</span>}
          </button>
        </div>
      </> : <p>왼쪽에서 변경 이력을 선택하세요.</p>}
    </div>
    {confirmDialog}
  </div>;
}
