import { useState } from "react";
import { BookOpen, Check, Search, Unlink } from "lucide-react";
import type { Doc } from "./types";
import { episodeNumbers } from "../core/episode.mjs";

export default function EpisodeBindingPicker({ doc, documents, onSelect, onCancel }: {
  doc: Doc;
  documents: Doc[];
  onSelect: (episodeId: string | null) => Promise<void>;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const episodes = documents.filter((d) =>
    d.projectId === doc.projectId && d.kind === "episode" && !d.archived,
  );
  const numbers = episodeNumbers(episodes);
  const filtered = episodes.filter((d) =>
    `${numbers.get(d.id)} ${d.title}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  async function select(id: string | null) {
    if (saving) return;
    setSaving(true);
    setError("");
    try { await onSelect(id); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setSaving(false); }
  }
  return (
    <div className="episode-binding-picker" aria-busy={saving}>
      <p className="binding-description"><b>{doc.title || "제목 없는 문서"}</b>을(를) 연결할 회차를 선택하세요.
        <span>연결한 문서는 해당 회차의 플롯·메모 위젯에 표시됩니다.</span></p>
      <button type="button" className={`binding-independent${!doc.episodeId ? " selected" : ""}`}
        disabled={saving} aria-pressed={!doc.episodeId} onClick={() => void select(null)}>
        <Unlink size={17} /><span><b>독립 문서로 두기</b><small>회차 연결 없이 제목과 본문을 그대로 보관합니다.</small></span>
        {!doc.episodeId && <Check size={16} />}
      </button>
      <label className="binding-search"><Search size={16} />
        <input autoFocus aria-label="연결할 회차 검색" placeholder="회차 번호 또는 제목으로 검색"
          value={query} disabled={saving} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing && filtered.length === 1) {
              e.preventDefault(); void select(filtered[0].id);
            }
          }} />
      </label>
      <div className="episode-picker" aria-label="연결할 에피소드">
        {filtered.map((ep) => (
          <button type="button" key={ep.id} className={doc.episodeId === ep.id ? "selected" : ""}
            disabled={saving} aria-pressed={doc.episodeId === ep.id} title={ep.title}
            onClick={() => void select(ep.id)}>
            <BookOpen size={15} /><span className="episode-number">{numbers.get(ep.id)}</span>
            <span className="binding-episode-title">{ep.title || "제목 없는 회차"}</span>
            {doc.episodeId === ep.id && <Check size={15} />}
          </button>
        ))}
        {!filtered.length && <p className="binding-empty">{episodes.length ? "검색 결과가 없습니다." : "연결할 에피소드가 없습니다. 먼저 에피소드를 만들어 주세요."}</p>}
      </div>
      {error && <p className="binding-error" role="alert">{error}</p>}
      <div className="modal-footer">
        {saving && <span className="muted" role="status">연결 저장 중…</span>}
        <button type="button" onClick={onCancel} disabled={saving}>취소</button>
      </div>
    </div>
  );
}
