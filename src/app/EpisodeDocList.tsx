import { labels } from "./document-ui";

import {
  ChevronDown,
  ChevronRight
} from "lucide-react";
import { Fragment } from "react";

import { type RenderTreeRow } from "./file-tree-model";
import { documentIcon as docIcon } from "./FileTreeRow";
import type { FileTreeController } from "./useFileTree";

export default function EpisodeDocList({ tree, treeRow }: { tree: FileTreeController; treeRow: RenderTreeRow }) {
  const { numberOf, closedDocGroups, openMenu, attempt, addDocFile } = tree;
  const archive = tree.archive;
  const query = tree.treeQuery.memo;

  const ep = tree.boundEpisode;
  if (!ep) return <div className="tree-empty">에피소드를 열면 연결된 문서가 여기에 보입니다</div>;
  const bound = tree.boundDocuments, shown = tree.treeDocs;
  return (
    <>
      <div className="episode-doc-caption">
        <span title={ep.title}>
          {numberOf(ep)} {ep.title}에 연결된 문서
        </span>
        <small>연결 문서 {bound.length}개</small>
      </div>
      {(["plot", "memo"] as const).map((kind) => {
        const items = shown.filter((d) => d.kind === kind),
          open = !closedDocGroups.has(kind);
        if (query.trim() && !items.length) return null;
        return (
          <Fragment key={kind}>
            <button
              className={`tree-item doc-group ${tree.menuTarget === "group-" + kind ? "context-target" : ""}`}
              aria-expanded={open}
              onClick={() => tree.toggleDocGroup(kind)}
              onContextMenu={(e) =>
                openMenu(
                  e,
                  [{ label: `이 회차에 ${labels[kind]} 만들기`, disabled: archive, action: attempt(() => addDocFile("", kind, ep)) }],
                  "group-" + kind,
                )
              }
            >
              {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <b>{labels[kind]}</b>
              <small>{items.length}</small>
            </button>
            {open && items.map((d) => treeRow(d, docIcon(d), { depth: 1 }))}
          </Fragment>
        );
      })}
      {query.trim() && !shown.length && <div className="tree-empty">검색 결과가 없습니다</div>}
    </>
  );

}
