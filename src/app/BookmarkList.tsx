import {
  Bookmark as BookmarkIcon,
  X
} from "lucide-react";
import type * as React from "react";
import {
  type Doc
} from "../types";

type Props = {
  active: Doc | null;
  setBookmarkJump: React.Dispatch<React.SetStateAction<{ docId: string; index: number; seq: number; } | null>>;
  edit: (patch: Partial<Doc>, markdownCopy?: boolean) => void;
};

export default function BookmarkList({ active, setBookmarkJump, edit }: Props) {


  if (!active) return null;
  const list = active.bookmarks || [];
  return (
    <section className="widget bookmark-widget">
      <div className="widget-title">
        <span>이 문서의 북마크</span>
        <small>{list.length}</small>
      </div>
      {list.map((b) => (
        <div className="bookmark-item" key={b.index}>
          <button
            className="bookmark-jump"
            title={b.text}
            onClick={() => setBookmarkJump({ docId: active.id, index: b.index, seq: Date.now() })}
          >
            <BookmarkIcon size={13} />
            <span>{b.text || "빈 문단"}</span>
          </button>
          <button
            className="bookmark-remove"
            aria-label="북마크 지우기"
            title="북마크 지우기"
            onClick={() => edit({ bookmarks: list.filter((x) => x.index !== b.index) })}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      {!list.length && <p className="widget-empty">원고 왼쪽 여백을 누르면 그 문단에 북마크를 붙입니다.</p>}
    </section>
  );

}
