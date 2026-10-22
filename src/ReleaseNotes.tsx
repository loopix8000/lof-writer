import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import { marked, type Token, type Tokens } from "marked";
import { ChevronDown, RefreshCw, Sparkles, X } from "lucide-react";
import { fetchRelease, fetchReleases, type Release } from "./github-releases";

const SEEN_KEY = "lof.releaseNotesSeenVersion";
const SHOW_UPDATE_NOTICE = import.meta.env.VITE_SHOW_UPDATE_NOTICE === "true";

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

export function ReleaseNotesForVersion({ version }: { version: string }) {
  const [release, setRelease] = useState<Release | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setRelease(null);
    setError("");
    void fetchRelease(version, controller.signal).then(result => {
      if (!controller.signal.aborted) setRelease(result);
    }).catch(error => {
      if (!controller.signal.aborted) setError(String(error instanceof Error ? error.message : error));
    });
    return () => controller.abort();
  }, [version, attempt]);

  if (error) return <div>
    <p className="updater-error" role="alert">변경 사항을 불러오지 못했습니다. {error}</p>
    <button type="button" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={13} />다시 시도</button>
  </div>;
  if (!release || release.version !== version.replace(/^v/, ""))
    return <p className="updater-status" role="status">변경 사항을 불러오고 있습니다.</p>;
  return <ReleaseNotesBody markdown={release.body} />;
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
      <ReleaseNotesForVersion key={version} version={version} />
    </div>
  </div>;
}

// 릴리즈 빌드에서 알림을 켠 버전만 첫 실행에 한 번 알린다. 새로 설치했다면 알리지 않는다.
export function useReleaseNotice(version: string, ready: boolean, existingUser: boolean) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!ready || !version) return;
    let seen: string | null = null;
    try { seen = localStorage.getItem(SEEN_KEY); } catch { return; }
    if (seen === version) return;
    try { localStorage.setItem(SEEN_KEY, version); } catch {}
    if (SHOW_UPDATE_NOTICE && (seen ? seen !== version : existingUser)) setVisible(true);
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

const formatDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
};

export function ReleaseHistory({ version }: { version: string }) {
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setReleases(null);
    void fetchReleases(controller.signal).then(result => {
      if (!controller.signal.aborted) setReleases(result);
    }).catch(error => {
      if (!controller.signal.aborted) setError(String(error instanceof Error ? error.message : error));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [open, attempt]);

  return <details className="release-history" onToggle={(e) => setOpen(e.currentTarget.open)}>
    <summary>버전별 릴리즈 노트</summary>
    <div className="release-history-head">
      <p className="settings-description">GitHub에 공개된 버전별 변경 사항입니다.</p>
      <button type="button" disabled={loading} onClick={() => setAttempt(value => value + 1)}>
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
            {r.prerelease && <span className="release-badge">{/-alpha/i.test(r.version) ? "알파" : "베타"}</span>}
            {r.version === version && <span className="release-badge current">현재 버전</span>}
            <span className="release-date">{formatDate(r.date)}</span>
          </summary>
          <ReleaseNotesBody markdown={r.body} />
        </details>
      </li>)}
    </ul>}
  </details>;
}
