import {
  BookOpen,
  ChevronRight,
  FileText,
  Plus,
  StickyNote
} from "lucide-react";
import { type MenuItem } from "../ContextMenu";
import {
  type Doc,
  type Library
} from "../types";
import type { FileTreeController } from "./useFileTree";

import type * as React from "react";

type Props = {
  active: Doc | null;
  lib: Library;
  tree: Pick<FileTreeController, "renaming" | "startRename" | "commitRename" | "changeRename" | "cancelRename">;
  attempt: (fn: () => Promise<any>) => () => Promise<any>;
  menu: { x: number; y: number; items: MenuItem[]; target?: string; } | null;
  openDoc: (id: string, pinned?: boolean) => Promise<void>;
  openMenu: (e: React.MouseEvent, items: MenuItem[], target?: string) => void;
  docMenu: (d: Doc) => MenuItem[];
  archive: boolean;
  addDocFile: (folder: string, kind: "plot" | "memo", ep?: Doc, widget?: boolean) => Promise<void>;
};

export default function DocumentLinksWidget({
  active,
  lib,
  tree,
  attempt,
  menu,
  openDoc,
  openMenu,
  docMenu,
  archive,
  addDocFile,
}: Props) {
  const { renaming, commitRename, startRename } = tree;
  const isPlotMemo = (d: Doc) => d.kind === "memo";

  if (!active) return null;
  const ep =
    active.kind === "episode"
      ? active
      : active.episodeId
        ? lib.documents.find(
          (d) => d.id === active.episodeId && d.kind === "episode" && d.projectId === active.projectId,
        )
        : undefined;
  const icon = (d: Doc) =>
    d.kind === "episode" ? <BookOpen size={15} /> : isPlotMemo(d) ? <StickyNote size={15} /> : <FileText size={15} />;
  const item = (d: Doc) =>
    renaming?.id === d.id && renaming.widget ? (
      <div key={d.id} className="memo-card renaming">
        {icon(d)}
        <input
          className="tree-rename"
          aria-label="새 이름"
          autoFocus
          value={renaming.value}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            tree.changeRename(e.target.value);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") attempt(commitRename)();
            else if (e.key === "Escape") {
              tree.cancelRename();
            }
          }}
          onBlur={attempt(commitRename)}
        />
      </div>
    ) : (
      <button
        className={`memo-card ${d.id === active.id ? "current" : ""} ${menu?.target === "widget-" + d.id ? "context-target" : ""}`}
        key={d.id}
        title={d.relPath}
        onClick={attempt(() => openDoc(d.id))}
        onDoubleClick={attempt(() => openDoc(d.id, true))}
        onContextMenu={(e) =>
          openMenu(
            e,
            [{ label: "이름 바꾸기", action: () => startRename(d, true) }, "separator", ...docMenu(d)],
            "widget-" + d.id,
          )
        }
      >
        {icon(d)}
        <span>{d.title}</span>
        <ChevronRight size={12} />
      </button>
    );
  if (active.kind !== "episode") {
    return (
      <section className="widget episode-plots">
        <div className="widget-title">
          <span>연결된 문서</span>
          <small>{ep ? 1 : 0}</small>
        </div>
        {ep ? item(ep) : <p className="widget-empty">연결된 문서가 없습니다.</p>}
      </section>
    );
  }
  const linked = lib.documents.filter(
    (d) => d.kind !== "episode" && d.projectId === active.projectId && d.episodeId === active.id && !d.archived,
  );
  const plots = linked.filter((d) => !isPlotMemo(d)),
    memos = linked.filter(isPlotMemo);
  // 제목 줄의 + 버튼: 이 회차에 연결된 플롯·메모를 만들고 위젯에서 바로 이름을 받는다.
  const add = (kind: "plot" | "memo") => (
    <button
      className="widget-quick-add"
      aria-label={kind === "plot" ? "이 회차에 플롯 만들기" : "이 회차에 메모 만들기"}
      title={kind === "plot" ? "이 회차에 플롯 만들기" : "이 회차에 메모 만들기"}
      disabled={archive}
      onClick={attempt(() => addDocFile("", kind, active, true))}
    >
      <Plus size={14} />
    </button>
  );
  return (
    <section className="widget episode-plots">
      <div className="widget-title">
        <span>이 회차의 플롯</span>
        <span className="widget-title-tools">
          <small>{plots.length}</small>
          {add("plot")}
        </span>
      </div>
      {plots.map(item)}
      {!plots.length && <p className="widget-empty">연결된 플롯이 없습니다.</p>}
      <div className="widget-title widget-subtitle">
        <span>이 회차의 메모</span>
        <span className="widget-title-tools">
          <small>{memos.length}</small>
          {add("memo")}
        </span>
      </div>
      {memos.map(item)}
      {!memos.length && <p className="widget-empty">연결된 메모가 없습니다.</p>}
    </section>
  );

}
