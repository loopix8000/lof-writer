import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import { marked, type Token, type Tokens } from "marked";
import { ChevronDown, RefreshCw, Sparkles, X } from "lucide-react";
import currentNotes from "../RELEASE_NOTES.md?raw";

const RELEASES_URL = "https://api.github.com/repos/loopix8000/lof-writer/releases?per_page=30";
const SEEN_KEY = "lof.releaseNotesSeenVersion";

type Release = { version: string; name: string; body: string; date: string; prerelease: boolean };

// 릴리즈 본문을 HTML로 넣지 않고 토큰을 React 요소로 그려 스크립트나 외부 리소스가 실행되지 않게 한다.
function inline(tokens: Token[] | undefined): ReactNode {
  return tokens?.map((t, i) => {
    switch (t.type) {
      case "strong": return <strong key={i}>{inline((t as Tokens.Strong).tokens)}</strong>;
      case "em": return <em key={i}>{inline((t as Tokens.Em).tokens)}</em>;
      case "del": return <del key={i}>{inline((t as Tokens.Del).tokens)}</del>;
      case "codespan": return <code key={i}>{(t as Tokens.Codespan).text}</code>;
      case "br": return <br key={i} />;
      case "link": return <span key={i} className="release-link" title={(t as Tokens.Link).href}>{inline((t as Tokens.Link).tokens)}</span>;
      case "image": return null;
      default: return <Fragment key={i}>{"tokens" in t && t.tokens ? inline(t.tokens) : "text" in t ? t.text : t.raw}</Fragment>;
    }
  });
}

function blocks(tokens: Token[]): ReactNode {
  return tokens.map((t, i) => {
    switch (t.type) {
      case "heading": {
        const H = `h${Math.min(6, (t as Tokens.Heading).depth + 3)}` as "h4";
        return <H key={i}>{inline((t as Tokens.Heading).tokens)}</H>;
      }
      case "paragraph": return <p key={i}>{inline((t as Tokens.Paragraph).tokens)}</p>;
      case "text": return <p key={i}>{inline((t as Tokens.Text).tokens) ?? (t as Tokens.Text).text}</p>;
      case "list": {
        const list = t as Tokens.List;
        const L = list.ordered ? "ol" : "ul";
        return <L key={i}>{list.items.map((item, j) => <li key={j}>{
          item.tokens.map((c, k) => c.type === "text"
            ? <Fragment key={k}>{inline((c as Tokens.Text).tokens) ?? (c as Tokens.Text).text}</Fragment>
            : <Fragment key={k}>{blocks([c])}</Fragment>)
        }</li>)}</L>;
      }
      case "blockquote": return <blockquote key={i}>{blocks((t as Tokens.Blockquote).tokens)}</blockquote>;
      case "code": return <pre key={i}><code>{(t as Tokens.Code).text}</code></pre>;
      case "hr": return <hr key={i} />;
      default: return null;
    }
  });
}

export function ReleaseNotesBody({ markdown }: { markdown: string }) {
  const text = markdown.trim();
  if (!text) return <p className="settings-description">등록된 변경 사항이 없습니다.</p>;
  return <div className="release-notes-body">{blocks(marked.lexer(text, { gfm: true }))}</div>;
}

export function ReleaseNotesDialog({ version, onClose }: { version: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return <div className="modal-backdrop release-notes-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="modal release-notes-modal" role="dialog" aria-modal="true" aria-label={`${version} 릴리즈 노트`}>
      <div className="modal-header">
        <h2>Lof Writer {version} 변경 사항</h2>
        <button type="button" aria-label="닫기" onClick={onClose}><X size={18} /></button>
      </div>
      <ReleaseNotesBody markdown={currentNotes} />
    </div>
  </div>;
}

// 버전이 바뀐 뒤 처음 실행했을 때 한 번만 알린다. 새로 설치했다면 첫 설정이 끝나지 않았으므로 알리지 않는다.
export function useReleaseNotice(version: string, ready: boolean, existingUser: boolean) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!ready || !version) return;
    let seen: string | null = null;
    try { seen = localStorage.getItem(SEEN_KEY); } catch { return; }
    if (seen === version) return;
    try { localStorage.setItem(SEEN_KEY, version); } catch {}
    if (seen ? seen !== version : existingUser) setVisible(true);
  }, [ready, version, existingUser]);
  return { visible, dismiss: useCallback(() => setVisible(false), []) };
}

export function ReleaseNotice({ version, onOpen, onClose }: { version: string; onOpen: () => void; onClose: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onClose, 12000);
    return () => clearTimeout(timer);
  }, [onClose]);
  return <aside className="release-notice" aria-label="업데이트 완료">
    <button type="button" className="release-notice-open" onClick={() => { onClose(); onOpen(); }}>
      <Sparkles size={14} />
      <span><b>{version}</b>(으)로 업데이트했습니다.<small>변경 사항 보기</small></span>
    </button>
    <button type="button" className="release-notice-close" aria-label="업데이트 알림 닫기" onClick={onClose}><X size={13} /></button>
  </aside>;
}

let cache: Release[] | null = null;

async function fetchReleases(): Promise<Release[]> {
  const res = await fetch(RELEASES_URL, { headers: { Accept: "application/vnd.github+json" } });
  if (res.status === 403 || res.status === 429) throw Error("요청이 많아 잠시 뒤에 다시 시도해 주세요.");
  if (!res.ok) throw Error(`응답 코드 ${res.status}`);
  const list = await res.json() as any[];
  // 버전 태그(v1.2.3)만 보여 주고, 업데이트 채널용 고정 릴리즈와 초안은 뺀다.
  return list
    .filter((r) => !r.draft && /^v\d/.test(String(r.tag_name)))
    .map((r) => ({
      version: String(r.tag_name).slice(1),
      name: String(r.name || r.tag_name),
      body: String(r.body || ""),
      date: String(r.published_at || r.created_at || ""),
      prerelease: !!r.prerelease,
    }));
}

const formatDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
};

export function ReleaseHistory({ version }: { version: string }) {
  const [releases, setReleases] = useState<Release[] | null>(cache);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      cache = await fetchReleases();
      setReleases(cache);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && !cache && !loading && !error) void load();
  }, [open, load, loading, error]);

  return <details className="release-history" onToggle={(e) => setOpen(e.currentTarget.open)}>
    <summary>버전별 릴리즈 노트</summary>
    <div className="release-history-head">
      <p className="settings-description">GitHub에 공개된 버전별 변경 사항입니다.</p>
      <button type="button" disabled={loading} onClick={() => void load()}>
        <RefreshCw size={13} className={loading ? "spin" : undefined} />새로고침
      </button>
    </div>
    {loading && !releases && <p className="updater-status">릴리즈 목록을 불러오고 있습니다.</p>}
    {error && <p className="updater-error" role="alert">릴리즈 목록을 불러오지 못했습니다. {error}</p>}
    {releases && !releases.length && <p className="updater-status">공개된 릴리즈가 없습니다.</p>}
    {releases && releases.length > 0 && <ul className="release-list">
      {releases.map((r) => <li key={r.version}>
        <details open={r.version === version}>
          <summary>
            <ChevronDown size={14} className="release-chevron" />
            <span className="release-version">{r.version}</span>
            {r.prerelease && <span className="release-badge">베타</span>}
            {r.version === version && <span className="release-badge current">현재 버전</span>}
            <span className="release-date">{formatDate(r.date)}</span>
          </summary>
          <ReleaseNotesBody markdown={r.body} />
        </details>
      </li>)}
    </ul>}
  </details>;
}
