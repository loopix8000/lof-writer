import {
  BookOpen,
  Bookmark as BookmarkIcon,
  FileText,
  Search,
  StickyNote,
  X
} from "lucide-react";
import type * as React from "react";
import {
  episodeNumbers
} from "../../core/episode.mjs";
import {
  type Doc,
  type Library
} from "../types";

type Props = {
  active: Doc | null;
  bookmarkQuery: string;
  lib: Library;
  attempt: (fn: () => Promise<any>) => () => Promise<any>;
  openDoc: (id: string, pinned?: boolean) => Promise<void>;
  setBookmarkJump: React.Dispatch<React.SetStateAction<{ docId: string; index: number; seq: number; } | null>>;
  setBookmarkQuery: React.Dispatch<React.SetStateAction<string>>;
  patchDoc: (id: string, patch: Partial<Doc>) => Promise<void>;
};

export default function BookmarksPage({ active, bookmarkQuery, lib, attempt, openDoc, setBookmarkJump, setBookmarkQuery, patchDoc }: Props) {
  const docIcon = (d: Doc) => d.kind === "memo" ? <StickyNote size={15} /> : <FileText size={15} />;

  // 열려 있는 문서는 저장 전의 북마크까지 보이도록 편집 중인 원고 쪽을 쓴다.
  const marksOf = (d: Doc) => (d.id === active?.id ? active.bookmarks : d.bookmarks) || [];
  const q = bookmarkQuery.trim().toLowerCase();
  let total = 0;
  const groups = lib.projects
    .map((p) => {
      const pdocs = lib.documents.filter((d) => d.projectId === p.id && !d.archived);
      const numbers = episodeNumbers(pdocs.filter((d) => d.kind === "episode"));
      const docs = pdocs
        .map((d) => {
          const all = marksOf(d),
            label = d.kind === "episode" ? `${numbers.get(d.id) ?? ""} ${d.title}`.trim() : d.title,
            hit = !q || p.title.toLowerCase().includes(q) || label.toLowerCase().includes(q);
          total += all.length;
          return { d, label, all, marks: all.filter((b) => hit || b.text.toLowerCase().includes(q)) };
        })
        .filter((x) => x.marks.length)
        // 회차를 먼저, 그다음 플롯·메모를 둔다(같은 유형 안에서는 서재 순서).
        .sort((a, b) => Number(a.d.kind !== "episode") - Number(b.d.kind !== "episode"));
      return { p, docs, count: docs.reduce((n, x) => n + x.marks.length, 0) };
    })
    .filter((g) => g.docs.length);
  const jump = (d: Doc, index: number) =>
    attempt(async () => {
      await openDoc(d.id, true);
      setBookmarkJump({ docId: d.id, index, seq: Date.now() });
    })();
  return (
    <div className="bookmarks-page">
      <div className="page-hero">
        <h1>
          북마크 <small>{total}개</small>
        </h1>
        <p>모든 작품의 원고에 붙인 북마크를 모아 봅니다.</p>
        {total > 0 && (
          <label className="tree-search bookmarks-search">
            <Search size={14} />
            <input
              value={bookmarkQuery}
              placeholder="작품, 문서 제목, 문단 글로 찾기"
              aria-label="북마크 검색"
              onChange={(e) => setBookmarkQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && bookmarkQuery) {
                  e.stopPropagation();
                  setBookmarkQuery("");
                }
              }}
            />
            {bookmarkQuery && (
              <button aria-label="검색어 지우기" title="검색어 지우기" onClick={() => setBookmarkQuery("")}>
                <X size={13} />
              </button>
            )}
          </label>
        )}
      </div>
      {groups.map(({ p, docs, count }) => (
        <section className="bookmark-project" key={p.id}>
          <h2>
            {p.title || "제목 없는 작품"} <small>{count}</small>
          </h2>
          {docs.map(({ d, label, all, marks }) => (
            <div className="bookmark-doc" key={d.id}>
              <button className="bookmark-doc-title" title={d.relPath} onClick={attempt(() => openDoc(d.id, true))}>
                {d.kind === "episode" ? <BookOpen size={14} /> : docIcon(d)}
                <span>{label}</span>
                <small>{marks.length}</small>
              </button>
              {marks.map((b) => (
                <div className="bookmark-item" key={b.index}>
                  <button className="bookmark-jump" title={b.text} onClick={() => jump(d, b.index)}>
                    <BookmarkIcon size={13} />
                    <span>{b.text || "빈 문단"}</span>
                  </button>
                  <button
                    className="bookmark-remove"
                    aria-label="북마크 지우기"
                    title="북마크 지우기"
                    onClick={attempt(() => patchDoc(d.id, { bookmarks: all.filter((x) => x.index !== b.index) }))}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          ))}
        </section>
      ))}
      {!total && (
        <div className="empty-state">
          <div className="empty-icon">
            <BookmarkIcon size={34} />
          </div>
          <h2>아직 북마크가 없습니다</h2>
          <p>원고 왼쪽 여백을 누르면 그 문단에 북마크를 붙일 수 있습니다.</p>
        </div>
      )}
      {total > 0 && !groups.length && <div className="tree-empty bookmarks-none">검색 결과가 없습니다</div>}
    </div>
  );

}
