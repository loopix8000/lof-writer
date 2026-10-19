import { labels } from "./document-ui";

import {
  ChevronDown,
  ChevronRight
} from "lucide-react";
import { Fragment } from "react";
import { type MenuItem } from "../ContextMenu";
import {
  type Doc,
  type Kind
} from "../types";

import type * as React from "react";

type Props = {
  docs: Doc[];
  treeEpisodeId: string;
  treeMatch: (text: string, query: string) => boolean;
  numberOf: (d: Doc) => any;
  closedDocGroups: Set<Kind>;
  menu: { x: number; y: number; items: MenuItem[]; target?: string; } | null;
  setClosedDocGroups: React.Dispatch<React.SetStateAction<Set<Kind>>>;
  openMenu: (e: React.MouseEvent, items: MenuItem[], target?: string) => void;
  archive: boolean;
  attempt: (fn: () => Promise<any>) => () => Promise<any>;
  addDocFile: (folder: string, kind: "plot" | "memo", ep?: Doc, widget?: boolean) => Promise<void>;
  treeRow: (d: Doc, marker: React.ReactNode, opts?: { depth?: number; badge?: string; dropFolder?: string; }) => React.JSX.Element;
  docIcon: (d: Doc) => React.JSX.Element;
  query: string;
};

export default function EpisodeDocList({
  docs,
  treeEpisodeId,
  treeMatch,
  numberOf,
  closedDocGroups,
  menu,
  setClosedDocGroups,
  openMenu,
  archive,
  attempt,
  addDocFile,
  treeRow,
  docIcon,
  query,
}: Props) {


  const ep = docs.find((d) => d.id === treeEpisodeId && d.kind === "episode");
  if (!ep) return <div className="tree-empty">에피소드를 열면 연결된 문서가 여기에 보입니다</div>;
  const bound = docs.filter((d) => d.kind !== "episode" && d.episodeId === ep.id),
    shown = bound.filter((d) => !query.trim() || treeMatch(d.title, query));
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
              className={`tree-item doc-group ${menu?.target === "group-" + kind ? "context-target" : ""}`}
              aria-expanded={open}
              onClick={() =>
                setClosedDocGroups((old) => {
                  const next = new Set(old);
                  if (next.has(kind)) next.delete(kind);
                  else next.add(kind);
                  return next;
                })
              }
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
