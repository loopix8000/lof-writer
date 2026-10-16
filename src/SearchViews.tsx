import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  FileText,
  Search,
  StickyNote,
  X,
} from "lucide-react";
import { call } from "./types";

const icons = { episode: BookOpen, plot: FileText, memo: StickyNote, common: StickyNote };
export type QuickItem = {
  key: string;
  label: string;
  detail: string;
  icon: keyof typeof icons;
  updatedAt?: string;
};

// 띄엄띄엄 친 글자가 순서대로 들어 있으면 일치로 본다(VS Code의 Ctrl+P).
// 붙어 있는 글자와 맨 앞 글자에 점수를 더 준다. 일치하지 않으면 null.
function fuzzy(query: string, text: string): number | null {
  const q = query.toLocaleLowerCase().replace(/\s+/g, ""),
    t = text.toLocaleLowerCase();
  if (!q) return 0;
  let from = 0,
    last = -2,
    score = 0;
  for (const ch of q) {
    const i = t.indexOf(ch, from);
    if (i < 0) return null;
    score += i === last + 1 ? 5 : 1;
    if (i === 0) score += 3;
    last = i;
    from = i + 1;
  }
  return score - t.length * 0.01;
}

// 빠른 열기(Ctrl+P): 파일 이름으로 찾아 연다. 입력 전에는 최근에 고친 순서로 보여 준다.
export function QuickOpen({
  items,
  onPick,
  onClose,
}: {
  items: QuickItem[];
  onPick: (item: QuickItem) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(""),
    [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => {
    if (!query.trim())
      return [...items]
        .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
        .slice(0, 50);
    return items
      .map((item) => {
        const a = fuzzy(query, item.label),
          b = fuzzy(query, item.detail);
        const score = a === null ? (b === null ? null : b - 2) : Math.max(a, b === null ? -Infinity : b - 2);
        return { item, score };
      })
      .filter((x): x is { item: QuickItem; score: number } => x.score !== null)
      .sort((x, y) => y.score - x.score)
      .slice(0, 50)
      .map((x) => x.item);
  }, [items, query]);
  useEffect(() => setSelected(0), [query]);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(".quick-item.selected")
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  return (
    <div className="quick-open-backdrop" onMouseDown={onClose}>
      <div className="quick-open" role="dialog" aria-label="파일 이름으로 열기" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          aria-label="파일 이름"
          placeholder="파일 이름으로 찾기 (회차·플롯·메모)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelected((i) => Math.min(shown.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelected((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (shown[selected]) onPick(shown[selected]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
        />
        <div className="quick-list" ref={listRef} role="listbox">
          {shown.map((item, i) => {
            const Icon = icons[item.icon];
            return (
              <button
                key={item.key}
                role="option"
                aria-selected={i === selected}
                className={`quick-item ${i === selected ? "selected" : ""}`}
                onMouseMove={() => setSelected(i)}
                onClick={() => onPick(item)}
              >
                <Icon size={15} />
                <span>{item.label}</span>
                <small>{item.detail}</small>
              </button>
            );
          })}
          {!shown.length && <p className="muted">일치하는 파일이 없습니다.</p>}
        </div>
      </div>
    </div>
  );
}

export type SearchMatch = { index: number; line: number; text: string; start: number; length: number };
export type SearchResult = {
  id: string;
  projectId: string;
  kind: "episode" | "plot" | "memo";
  title: string;
  relPath?: string;
  archived: boolean;
  matches: SearchMatch[];
};
type ProjectHit = { id: string; title: string; tags: string[]; fields: string[]; description: string };
type FileHit = Omit<SearchResult, "matches"> & { tags?: string[] };
type CommonHit = { space: string; path: string; name: string; matches?: SearchMatch[] };
type SearchData = {
  projects: ProjectHit[];
  files: FileHit[];
  results: SearchResult[];
  total: number;
  truncated: boolean;
  common: { files: CommonHit[]; results: CommonHit[] };
};
const emptyData: SearchData = {
  projects: [],
  files: [],
  results: [],
  total: 0,
  truncated: false,
  common: { files: [], results: [] },
};

// 이름에서 검색어와 일치한 첫 부분을 강조한다.
function Highlight({ text, query, caseSensitive }: { text: string; query: string; caseSensitive: boolean }) {
  const q = query.replace(/^#+/, "");
  const at = q
    ? (caseSensitive ? text : text.toLocaleLowerCase()).indexOf(caseSensitive ? q : q.toLocaleLowerCase())
    : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  );
}
function MatchLine({ m, onClick }: { m: SearchMatch; onClick: () => void }) {
  return (
    <button className="search-hit" title={`${m.line}번째 줄`} onClick={onClick}>
      {m.text.slice(0, m.start)}
      <mark>{m.text.slice(m.start, m.start + m.length)}</mark>
      {m.text.slice(m.start + m.length)}
    </button>
  );
}

// 통합 검색(Ctrl+Shift+F): 작품(제목·소개·태그), 파일 이름(제목·경로·태그), 본문, 공용 메모를 한 번에 찾아 묶음별로 보여 준다.
// '#'으로 시작하면 태그만 찾는다.
export function SearchPanel({
  projectId,
  scope,
  query,
  setQuery,
  caseSensitive,
  setCaseSensitive,
  focus,
  refresh,
  onOpen,
  onOpenFile,
  onOpenProject,
  onOpenCommon,
  onClose,
  report,
}: {
  projectId: string;
  scope: string;
  query: string;
  setQuery: (q: string) => void;
  caseSensitive: boolean;
  setCaseSensitive: (v: boolean) => void;
  // 바뀔 때마다 입력칸에 포커스를 준다(Ctrl+Shift+F를 다시 눌렀을 때).
  focus: number;
  // 서재가 바뀌면 다시 찾는다.
  refresh: unknown;
  onOpen: (result: SearchResult, match: SearchMatch) => void;
  onOpenFile: (id: string) => void;
  onOpenProject: (id: string) => void;
  onOpenCommon: (path: string) => void;
  onClose: () => void;
  report: (e: any) => void;
}) {
  const [data, setData] = useState<SearchData>(emptyData),
    [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focus]);
  useEffect(() => {
    let canceled = false;
    const t = setTimeout(
      () =>
        call<SearchData>("searchText", { query, projectId: projectId || undefined, caseSensitive })
          .then((r) => !canceled && setData({ ...emptyData, ...r }))
          .catch(report),
      220,
    );
    return () => {
      canceled = true;
      clearTimeout(t);
    };
  }, [query, projectId, caseSensitive, refresh, report]);
  const toggle = (key: string) =>
    setCollapsed((old) => {
      const next = new Set(old);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  // 묶음 머리줄(작품, 파일 이름, 본문, 공용 메모). 눌러서 접고 편다.
  const group = (key: string, title: string, count: number, children: React.ReactNode) =>
    count > 0 && (
      <section className="search-group" key={key}>
        <button className="search-group-head" onClick={() => toggle("group:" + key)}>
          {collapsed.has("group:" + key) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          <span>{title}</span>
          <em>{count}</em>
        </button>
        {!collapsed.has("group:" + key) && children}
      </section>
    );
  // 본문 결과의 문서 한 묶음(머리줄 + 일치한 줄).
  const fileBlock = (
    key: string,
    Icon: (typeof icons)[keyof typeof icons],
    title: string,
    path: string | undefined,
    archived: boolean,
    matches: SearchMatch[],
    open: (m: SearchMatch) => void,
  ) => {
    const shown = !collapsed.has(key);
    return (
      <div key={key} className="search-file">
        <button className="search-file-head" title={path} onClick={() => toggle(key)}>
          {shown ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <Icon size={14} />
          <span>{title || "제목 없음"}</span>
          {archived && <small>보관</small>}
          <em>{matches.length}</em>
        </button>
        {shown && matches.map((m) => <MatchLine key={m.index} m={m} onClick={() => open(m)} />)}
      </div>
    );
  };
  const commonFiles = data.common.files,
    commonResults = data.common.results,
    found =
      data.projects.length + data.files.length + data.results.length + commonFiles.length + commonResults.length;
  return (
    <div className="search-panel">
      <div className="panel-caption">
        <span>
          <Search size={15} />
          검색
        </span>
        <button title="검색 닫기" aria-label="검색 닫기" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <div className="search-box">
        <label className="search-field">
          <input
            ref={inputRef}
            aria-label="검색어"
            placeholder="파일 이름, 본문, #태그 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                onClose();
              }
            }}
          />
          <button
            className={caseSensitive ? "active" : ""}
            title="대/소문자 구분"
            aria-label="대/소문자 구분"
            aria-pressed={caseSensitive}
            onClick={() => setCaseSensitive(!caseSensitive)}
          >
            <CaseSensitive size={16} />
          </button>
        </label>
        <small className="search-scope">
          {scope}
          {query.trim() && data.truncated && " · 본문 결과는 일부만 표시"}
        </small>
      </div>
      <div className="search-results-tree">
        {group(
          "projects",
          "작품",
          data.projects.length,
          data.projects.map((p) => (
            <button
              key={p.id}
              className="search-item"
              title={p.description || p.title}
              onClick={() => onOpenProject(p.id)}
            >
              <BookOpen size={14} />
              <span>
                <Highlight text={p.title || "제목 없는 작품"} query={query} caseSensitive={caseSensitive} />
              </span>
              <small>
                {p.tags.length
                  ? p.tags.map((t) => "#" + t).join(" ")
                  : p.fields.join("·")}
              </small>
            </button>
          )),
        )}
        {group(
          "files",
          "파일 이름",
          data.files.length,
          data.files.map((f) => {
            const Icon = icons[f.kind],
              rel = f.relPath?.replace(/^(?:assets|doc|episodes|plot|memo)\//i, "");
            return (
              <button
                key={f.id}
                className="search-item"
                title={rel}
                onClick={() => onOpenFile(f.id)}
              >
                <Icon size={14} />
                <span>
                  <Highlight text={f.title || "제목 없음"} query={query} caseSensitive={caseSensitive} />
                </span>
                <small>
                  {f.tags?.length
                    ? f.tags.map((t) => "#" + t.replace(/^#+/, "")).join(" ")
                    : rel}
                  {f.archived ? " · 보관" : ""}
                </small>
              </button>
            );
          }),
        )}
        {group(
          "content",
          "본문",
          data.total,
          data.results.map((r) =>
            fileBlock(
              r.id,
              icons[r.kind],
              r.title,
              r.relPath?.replace(/^(?:assets|doc|episodes|plot|memo)\//i, ""),
              r.archived,
              r.matches,
              (m) => onOpen(r, m),
            ),
          ),
        )}
        {group(
          "common",
          "공용 메모",
          commonFiles.length + commonResults.reduce((n, r) => n + (r.matches?.length || 0), 0),
          <>
            {commonFiles.map((f) => (
              <button
                key={"name:" + f.path}
                className="search-item"
                title={f.path}
                onClick={() => onOpenCommon(f.path)}
              >
                <StickyNote size={14} />
                <span>
                  <Highlight text={f.name} query={query} caseSensitive={caseSensitive} />
                </span>
                <small>{f.path}</small>
              </button>
            ))}
            {commonResults.map((r) =>
              fileBlock("common:" + r.path, StickyNote, r.name, r.path, false, r.matches || [], () =>
                onOpenCommon(r.path),
              ),
            )}
          </>,
        )}
        {query.trim() && !found && <p className="tree-empty">검색 결과가 없습니다.</p>}
      </div>
    </div>
  );
}

