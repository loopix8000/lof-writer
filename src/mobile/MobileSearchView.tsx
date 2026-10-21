import {
  BookOpen,
  CaseSensitive,
  Clock,
  FileText,
  Search,
  StickyNote,
  X,
} from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { labels } from "../app/document-ui";
import type { SearchMatch, SearchResult } from "../SearchViews";
import { call, type Library, type Project } from "../types";

type ProjectHit = {
  id: string;
  title: string;
  tags: string[];
  fields: string[];
  description: string;
};
type FileHit = Omit<SearchResult, "matches"> & { tags?: string[] };
type CommonHit = {
  space: string;
  path: string;
  name: string;
  matches?: SearchMatch[];
};
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

const kindIcons = {
  episode: BookOpen,
  plot: FileText,
  memo: StickyNote,
};

function HighlightText({
  text,
  query,
  caseSensitive,
}: {
  text: string;
  query: string;
  caseSensitive: boolean;
}) {
  const q = query.replace(/^#+/, "").trim();
  if (!q) return <>{text}</>;
  const hay = caseSensitive ? text : text.toLocaleLowerCase();
  const needle = caseSensitive ? q : q.toLocaleLowerCase();
  const at = hay.indexOf(needle);
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  );
}

export default function MobileSearchView({
  lib,
  project,
  query,
  setQuery,
  caseSensitive,
  setCaseSensitive,
  onOpenMatch,
  onOpenFile,
  onOpenProject,
  onOpenCommon,
  report,
}: {
  lib: Library;
  project?: Project;
  query: string;
  setQuery: (q: string) => void;
  caseSensitive: boolean;
  setCaseSensitive: (v: boolean) => void;
  onOpenMatch: (result: SearchResult, match: SearchMatch) => void;
  onOpenFile: (id: string) => void;
  onOpenProject: (id: string) => void;
  onOpenCommon: (path: string) => void;
  report: (e: any) => void;
}) {
  const [scopeMode, setScopeMode] = useState<"all" | "project">(
    project ? "project" : "all",
  );
  const [category, setCategory] = useState<
    "all" | "content" | "files" | "projects" | "common"
  >("all");
  const [data, setData] = useState<SearchData>(emptyData);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!project && scopeMode === "project") {
      setScopeMode("all");
    }
  }, [project, scopeMode]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setData(emptyData);
      setSearching(false);
      return;
    }
    let canceled = false;
    setSearching(true);
    const t = setTimeout(() => {
      call<SearchData>("searchText", {
        query: q,
        projectId: scopeMode === "project" && project ? project.id : undefined,
        caseSensitive,
      })
        .then((r) => {
          if (!canceled) {
            setData({ ...emptyData, ...r });
            setSearching(false);
          }
        })
        .catch((err) => {
          if (!canceled) setSearching(false);
          report(err);
        });
    }, 180);
    return () => {
      canceled = true;
      clearTimeout(t);
    };
  }, [query, scopeMode, project, caseSensitive, lib, report]);

  const recentDocs = useMemo(() => {
    const pool =
      scopeMode === "project" && project
        ? lib.documents.filter((d) => d.projectId === project.id && !d.archived)
        : lib.documents.filter((d) => !d.archived);
    return [...pool]
      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
      .slice(0, 20);
  }, [lib.documents, scopeMode, project]);

  const getProjectTitle = (pid: string) =>
    lib.projects.find((p) => p.id === pid)?.title || "제목 없는 작품";

  const commonCount =
    data.common.files.length +
    data.common.results.reduce((acc, r) => acc + (r.matches?.length || 0), 0);
  const totalFound =
    data.projects.length + data.files.length + data.total + commonCount;

  return (
    <div className="m-screen m-search-screen">
      {/* 상단 전체 화면 검색 헤더 */}
      <header className="m-search-header">
        <div className="m-search-bar-row">
          <div className="m-search-input-box">
            <Search size={18} className="m-search-icon" />
            <input
              ref={inputRef}
              type="search"
              className="m-search-input"
              placeholder="파일 이름, 본문 대사, #태그 검색..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                type="button"
                className="m-filter-clear"
                aria-label="검색어 지우기"
                onClick={() => {
                  setQuery("");
                  inputRef.current?.focus();
                }}
              >
                <X size={16} />
              </button>
            )}
            <button
              type="button"
              className={`m-case-btn ${caseSensitive ? "active" : ""}`}
              aria-label="대/소문자 구분"
              aria-pressed={caseSensitive}
              onClick={() => setCaseSensitive(!caseSensitive)}
            >
              <CaseSensitive size={18} />
            </button>
          </div>
        </div>

        {/* 검색 범위 및 카테고리 필터 칩 */}
        <div className="m-search-filters">
          {project && (
            <div className="m-scope-pills">
              <button
                type="button"
                className={`m-scope-pill ${scopeMode === "project" ? "active" : ""}`}
                onClick={() => setScopeMode("project")}
              >
                현 작품 ({project.title})
              </button>
              <button
                type="button"
                className={`m-scope-pill ${scopeMode === "all" ? "active" : ""}`}
                onClick={() => setScopeMode("all")}
              >
                모든 작품
              </button>
            </div>
          )}

          {query.trim() && (
            <div className="m-category-chips">
              {(
                [
                  ["all", `전체 (${totalFound})`],
                  ["content", `본문 (${data.total})`],
                  ["files", `제목/태그 (${data.files.length})`],
                  ["projects", `작품 (${data.projects.length})`],
                  ["common", `공용 메모 (${commonCount})`],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={`m-cat-chip ${category === key ? "active" : ""}`}
                  onClick={() => setCategory(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      </header>

      {/* 검색 결과 또는 최근 문서 목록 (100% 전체 화면) */}
      <div className="m-scroll-body">
        {!query.trim() ? (
          <div className="m-search-recent">
            <div className="m-section-head">
              <Clock size={15} />
              <span>최근 작업한 문서 빠른 열기</span>
            </div>
            {recentDocs.length === 0 ? (
              <div className="m-empty-state">
                <Search size={32} />
                <h3>통합 검색</h3>
                <p>원고 본문, 문서 제목, 작품 소개, #태그를 한 번에 검색합니다.</p>
              </div>
            ) : (
              <div className="m-doc-list">
                {recentDocs.map((d) => {
                  const Icon = kindIcons[d.kind];
                  return (
                    <button
                      key={d.id}
                      type="button"
                      className="m-search-card"
                      onClick={() => onOpenFile(d.id)}
                    >
                      <div className="m-search-card-head">
                        <Icon size={16} />
                        <strong>{d.title || "제목 없음"}</strong>
                        <span className="m-search-badge">{labels[d.kind]}</span>
                      </div>
                      <div className="m-search-card-sub">
                        <span>{getProjectTitle(d.projectId)}</span>
                        <i>·</i>
                        <span>
                          {(d.platformCharacters ?? d.characters ?? 0).toLocaleString()}자
                        </span>
                        <i>·</i>
                        <time>{new Date(d.updatedAt).toLocaleDateString("ko-KR")}</time>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        ) : searching && totalFound === 0 ? (
          <div className="m-empty-state">
            <p>검색 중...</p>
          </div>
        ) : totalFound === 0 ? (
          <div className="m-empty-state">
            <Search size={34} />
            <h3>일치하는 결과가 없습니다</h3>
            <p>
              다른 검색어를 입력하거나{" "}
              {scopeMode === "project"
                ? "'모든 작품' 범위로 넓혀서 검색해 보세요."
                : "철자를 확인해 보세요."}
            </p>
            {scopeMode === "project" && (
              <button
                type="button"
                className="m-btn-secondary"
                onClick={() => setScopeMode("all")}
              >
                모든 작품에서 검색하기
              </button>
            )}
          </div>
        ) : (
          <div className="m-search-results">
            {/* 1. 본문 일치 결과 */}
            {(category === "all" || category === "content") &&
              data.results.length > 0 && (
                <section className="m-search-section">
                  <div className="m-section-head">
                    <span>본문 내용 일치</span>
                    <small>{data.total}건</small>
                  </div>
                  {data.results.map((r) => {
                    const Icon = kindIcons[r.kind];
                    return (
                      <div key={r.id} className="m-search-file-group">
                        <button
                          type="button"
                          className="m-search-file-title"
                          onClick={() => onOpenFile(r.id)}
                        >
                          <Icon size={16} />
                          <strong>{r.title || "제목 없음"}</strong>
                          <span className="m-search-badge">
                            {getProjectTitle(r.projectId)} · {labels[r.kind]}
                          </span>
                        </button>
                        <div className="m-search-match-list">
                          {r.matches.map((m) => (
                            <button
                              key={m.index}
                              type="button"
                              className="m-search-match-row"
                              onClick={() => onOpenMatch(r, m)}
                            >
                              <span className="m-match-line-no">{m.line}줄</span>
                              <span className="m-match-snippet">
                                {m.text.slice(0, m.start)}
                                <mark>{m.text.slice(m.start, m.start + m.length)}</mark>
                                {m.text.slice(m.start + m.length)}
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </section>
              )}

            {/* 2. 문서 제목/태그 일치 */}
            {(category === "all" || category === "files") &&
              data.files.length > 0 && (
                <section className="m-search-section">
                  <div className="m-section-head">
                    <span>문서 제목 및 #태그</span>
                    <small>{data.files.length}건</small>
                  </div>
                  {data.files.map((f) => {
                    const Icon = kindIcons[f.kind];
                    return (
                      <button
                        key={f.id}
                        type="button"
                        className="m-search-card"
                        onClick={() => onOpenFile(f.id)}
                      >
                        <div className="m-search-card-head">
                          <Icon size={16} />
                          <strong>
                            <HighlightText
                              text={f.title || "제목 없음"}
                              query={query}
                              caseSensitive={caseSensitive}
                            />
                          </strong>
                          <span className="m-search-badge">{labels[f.kind]}</span>
                        </div>
                        <div className="m-search-card-sub">
                          <span>{getProjectTitle(f.projectId)}</span>
                          {f.tags && f.tags.length > 0 && (
                            <>
                              <i>·</i>
                              <span>
                                {f.tags.map((t) => `#${t.replace(/^#+/, "")}`).join(" ")}
                              </span>
                            </>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </section>
              )}

            {/* 3. 작품 일치 */}
            {(category === "all" || category === "projects") &&
              data.projects.length > 0 && (
                <section className="m-search-section">
                  <div className="m-section-head">
                    <span>작품</span>
                    <small>{data.projects.length}건</small>
                  </div>
                  {data.projects.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="m-search-card"
                      onClick={() => onOpenProject(p.id)}
                    >
                      <div className="m-search-card-head">
                        <BookOpen size={16} />
                        <strong>
                          <HighlightText
                            text={p.title || "제목 없는 작품"}
                            query={query}
                            caseSensitive={caseSensitive}
                          />
                        </strong>
                      </div>
                      {p.description && (
                        <p className="m-search-card-desc">{p.description}</p>
                      )}
                    </button>
                  ))}
                </section>
              )}

            {/* 4. 공용 메모 일치 */}
            {(category === "all" || category === "common") &&
              commonCount > 0 && (
                <section className="m-search-section">
                  <div className="m-section-head">
                    <span>공용 메모</span>
                    <small>{commonCount}건</small>
                  </div>
                  {data.common.files.map((f) => (
                    <button
                      key={`cf:${f.path}`}
                      type="button"
                      className="m-search-card"
                      onClick={() => onOpenCommon(f.path)}
                    >
                      <div className="m-search-card-head">
                        <StickyNote size={16} />
                        <strong>
                          <HighlightText
                            text={f.name}
                            query={query}
                            caseSensitive={caseSensitive}
                          />
                        </strong>
                        <span className="m-search-badge">공용 메모</span>
                      </div>
                    </button>
                  ))}
                  {data.common.results.map((r) => (
                    <div key={`cr:${r.path}`} className="m-search-file-group">
                      <button
                        type="button"
                        className="m-search-file-title"
                        onClick={() => onOpenCommon(r.path)}
                      >
                        <StickyNote size={16} />
                        <strong>{r.name}</strong>
                        <span className="m-search-badge">공용 메모</span>
                      </button>
                      <div className="m-search-match-list">
                        {(r.matches || []).map((m) => (
                          <button
                            key={m.index}
                            type="button"
                            className="m-search-match-row"
                            onClick={() => onOpenCommon(r.path)}
                          >
                            <span className="m-match-line-no">{m.line}줄</span>
                            <span className="m-match-snippet">
                              {m.text.slice(0, m.start)}
                              <mark>{m.text.slice(m.start, m.start + m.length)}</mark>
                              {m.text.slice(m.start + m.length)}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </section>
              )}
          </div>
        )}
      </div>
    </div>
  );
}
