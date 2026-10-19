import { labels } from "./document-ui";

import {
  Archive,
  ChevronDown,
  ChevronRight,
  Feather,
  FilePlus,
  FolderOpen,
  FolderPlus,
  Plus,
  Search,
  X
} from "lucide-react";
import type * as React from "react";
import { Fragment } from "react";
import { type MenuItem } from "../ContextMenu";
import CoverImage from "../CoverImage";
import ResizableSidebar from "../ResizableSidebar";
import {
  type Doc,
  type Kind,
  type Library,
  type Project
} from "../types";

// 파일 트리에서 회차가 많으면 이 단위로 묶어 접는다.
export const EPISODE_GROUP = 20;

type Props = {
  prefs: Record<string, any>;
  savePrefs: (p: Record<string, any>) => Promise<void>;
  report: (e: any) => void;
  menu: { x: number; y: number; items: MenuItem[]; target?: string; } | null;
  switchWasOpen: React.RefObject<boolean>;
  setMenu: React.Dispatch<React.SetStateAction<{ x: number; y: number; items: MenuItem[]; target?: string; } | null>>;
  projectMenu: () => MenuItem[];
  project: Project | undefined;
  lib: Library;
  projectId: string;
  treeTab: "episode" | "memo";
  setTreeTab: React.Dispatch<React.SetStateAction<"episode" | "memo">>;
  dragFileDocs: React.RefObject<string[]>;
  count: (kind: Kind) => number;
  docScope: "episode" | "all";
  setDocScope: React.Dispatch<React.SetStateAction<"episode" | "all">>;
  treeQuery: { episode: string; memo: string; };
  setTreeQuery: React.Dispatch<React.SetStateAction<{ episode: string; memo: string; }>>;
  treeDocs: Doc[];
  treeEpisodes: Doc[];
  attempt: (fn: () => Promise<any>) => () => Promise<any>;
  openDoc: (id: string, pinned?: boolean) => Promise<void>;
  archive: boolean;
  openMenu: (e: React.MouseEvent, items: MenuItem[], target?: string) => void;
  docCreateMenu: (folder: string) => MenuItem[];
  addMemoFolder: (parent: string) => Promise<void>;
  createDoc: (kind: Kind, opts?: { title?: string; episodeId?: string; }) => Promise<void>;
  openEpisodeGroups: Set<number>;
  setOpenEpisodeGroups: React.Dispatch<React.SetStateAction<Set<number>>>;
  dragEpisodes: React.RefObject<string[]>;
  treeRow: (d: Doc, marker: React.ReactNode, opts?: { depth?: number; badge?: string; dropFolder?: string; }) => React.JSX.Element;
  numberOf: (d: Doc) => any;
  treeDrop: string | null;
  memoCreateMenu: (folder: string) => MenuItem[];
  folderDropProps: (folder: string) => { onDragOver: (e: React.DragEvent) => void; onDragLeave: (e: React.DragEvent) => void; onDrop: (e: React.DragEvent) => void; };
  memoEntries: { path: string; name: string; type: string; }[];
  setArchive: React.Dispatch<React.SetStateAction<boolean>>;
  folderTree: React.ReactNode;
  episodeDocuments: React.ReactNode;
  brokenFiles: React.ReactNode;
};

export default function FileTree({
  prefs,
  savePrefs,
  report,
  menu,
  switchWasOpen,
  setMenu,
  projectMenu,
  project,
  lib,
  projectId,
  treeTab,
  setTreeTab,
  dragFileDocs,
  count,
  docScope,
  setDocScope,
  treeQuery,
  setTreeQuery,
  treeDocs,
  treeEpisodes,
  attempt,
  openDoc,
  archive,
  openMenu,
  docCreateMenu,
  addMemoFolder,
  createDoc,
  openEpisodeGroups,
  setOpenEpisodeGroups,
  dragEpisodes,
  treeRow,
  numberOf,
  treeDrop,
  memoCreateMenu,
  folderDropProps,
  memoEntries,
  setArchive,
  folderTree,
  episodeDocuments,
  brokenFiles,
}: Props) {

  return (
    <ResizableSidebar label="파일 트리" className="file-tree" width={prefs.leftSidebarWidth}
      onResize={(width) => savePrefs({ leftSidebarWidth: width }).catch(report)}>
      <div className="panel-caption">
        <span>
          <FolderOpen size={15} />
          파일 트리
        </span>
      </div>
      <button
        className={`project-switch ${menu?.target === "project-switch" ? "open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={menu?.target === "project-switch"}
        title="작품 전환"
        onMouseDown={() => {
          // 메뉴는 바깥 mousedown에서 먼저 닫히므로, 열려 있었는지 기억해 토글한다.
          switchWasOpen.current = menu?.target === "project-switch";
        }}
        onClick={(e) => {
          if (switchWasOpen.current) {
            switchWasOpen.current = false;
            return;
          }
          const box = e.currentTarget.getBoundingClientRect();
          setMenu({
            x: box.left,
            y: box.bottom + 4,
            items: projectMenu(),
            target: "project-switch",
          });
        }}
      >
        <div className="mini-cover">
          {project?.coverData && !prefs.hideCovers ? (
            <CoverImage src={project.coverData} alt="작품 표지" />
          ) : (
            <Feather size={23} />
          )}
        </div>
        <span>
          <b>{project?.title}</b>
          <small>
            {
              lib.documents.filter(
                (d) =>
                  d.projectId === projectId &&
                  d.kind === "episode" &&
                  !d.archived,
              ).length
            }
            편
          </small>
        </span>
        <ChevronDown size={15} />
      </button>
      {/* 에피소드와 문서(doc/ 폴더: 플롯·메모)를 탭으로 나눈다. 문서 탭에 'memo' 키를 쓴다. */}
      <div className="tree-tabs" role="tablist" aria-label="파일 트리 보기">
        {(["episode", "memo"] as const).map((tab) => (
          <button
            key={tab}
            role="tab"
            aria-selected={treeTab === tab}
            className={treeTab === tab ? "active" : ""}
            onClick={() => setTreeTab(tab)}
            // 문서를 끌어 에피소드 탭에 올리면 탭을 바꿔 회차 위에 놓을 수 있게 한다.
            onDragEnter={() => {
              if (tab === "episode" && dragFileDocs.current.length) setTreeTab("episode");
            }}
          >
            {tab === "memo" ? "문서" : labels.episode}
            <small>{tab === "memo" ? count("plot") + count("memo") : count("episode")}</small>
          </button>
        ))}
      </div>
      {treeTab === "memo" && (
        <div className="doc-scope" role="radiogroup" aria-label="문서 보기 범위">
          {([["all", "전체 문서"], ["episode", "현재 회차만"]] as const).map(([scope, label]) => (
            <button
              key={scope}
              role="radio"
              aria-checked={docScope === scope}
              className={docScope === scope ? "active" : ""}
              onClick={() => setDocScope(scope)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="tree-search-row">
        <label className="tree-search">
          <Search size={14} />
          <input
            value={treeQuery[treeTab]}
            placeholder={treeTab === "memo" ? "문서 검색" : "에피소드 검색"}
            aria-label={treeTab === "memo" ? "문서 검색" : "에피소드 검색"}
            onChange={(e) => {
              const value = e.target.value;
              setTreeQuery((q) => ({ ...q, [treeTab]: value }));
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && treeQuery[treeTab]) {
                e.stopPropagation();
                setTreeQuery((q) => ({ ...q, [treeTab]: "" }));
              } else if (e.key === "Enter" && treeQuery[treeTab].trim()) {
                const first = (treeTab === "memo" ? treeDocs : treeEpisodes)[0];
                if (first) attempt(() => openDoc(first.id, false))();
              }
            }}
          />
          {treeQuery[treeTab] && (
            <button
              aria-label="검색어 지우기"
              title="검색어 지우기"
              onClick={() => setTreeQuery((q) => ({ ...q, [treeTab]: "" }))}
            >
              <X size={13} />
            </button>
          )}
        </label>
        {treeTab === "memo" && docScope === "all" && (
          // 문서 추가(플롯·메모를 고름)와 폴더 추가는 doc/ 바로 아래에 만든다.
          <>
            <button
              className="tree-search-action"
              aria-label="문서 추가"
              title="문서 추가"
              disabled={archive}
              onClick={(e) => openMenu(e, docCreateMenu(""), "doc-add")}
            >
              <FilePlus size={16} />
            </button>
            <button
              className="tree-search-action"
              aria-label="폴더 추가"
              title="폴더 추가"
              disabled={archive}
              onClick={attempt(() => addMemoFolder(""))}
            >
              <FolderPlus size={16} />
            </button>
          </>
        )}
      </div>
      {/* 탭을 바꿔도 끌던 문서가 이어지도록 두 탭 모두 그려 두고 숨긴다. */}
      <div className="tree-scroll">
        <section
          className="tree-section tree-panel"
          hidden={treeTab !== "episode"}
          onContextMenu={(e) =>
            openMenu(e, [{ label: "새 에피소드", disabled: archive, action: attempt(() => createDoc("episode")) }])
          }
        >
          {!treeQuery.episode.trim() && treeEpisodes.length > EPISODE_GROUP
            ? Array.from({ length: Math.ceil(treeEpisodes.length / EPISODE_GROUP) }, (_, g) => {
              const start = g * EPISODE_GROUP,
                items = treeEpisodes.slice(start, start + EPISODE_GROUP),
                open = openEpisodeGroups.has(start);
              const toggle = (next: boolean) =>
                setOpenEpisodeGroups((old) => {
                  const set = new Set(old);
                  if (next) set.add(start);
                  else set.delete(start);
                  return set;
                });
              return (
                <Fragment key={start}>
                  <button
                    className="tree-item episode-group"
                    aria-expanded={open}
                    onClick={() => toggle(!open)}
                    // 문서나 회차를 끌어 접힌 묶음에 올리면 펼쳐서 회차 위에 놓을 수 있게 한다.
                    onDragEnter={() => {
                      if ((dragFileDocs.current.length || dragEpisodes.current.length) && !open) toggle(true);
                    }}
                  >
                    {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <span>
                      {start + 1} - {start + items.length}화
                    </span>
                  </button>
                  {open &&
                    items.map((d) =>
                      treeRow(d, <span className="episode-number">{numberOf(d)}</span>),
                    )}
                </Fragment>
              );
            })
            : treeEpisodes.map((d) =>
              treeRow(d, <span className="episode-number">{numberOf(d)}</span>),
            )}
          {!treeEpisodes.length && (
            <div className="tree-empty">
              {treeQuery.episode.trim() ? "검색 결과가 없습니다" : "아직 에피소드가 없습니다"}
            </div>
          )}
        </section>
        <section
          className={`tree-section tree-panel ${docScope === "all" && treeDrop === "folder:" ? "drop-target" : ""}`}
          hidden={treeTab !== "memo"}
          onContextMenu={(e) => docScope === "all" && openMenu(e, memoCreateMenu(""))}
          {...(docScope === "all" ? folderDropProps("") : {})}
        >
          {docScope === "all" ? (
            <>
              {folderTree}
              {treeQuery.memo.trim()
                ? !treeDocs.length && <div className="tree-empty">검색 결과가 없습니다</div>
                : count("plot") + count("memo") === 0 &&
                !memoEntries.some((e) => e.type === "folder") && (
                  <div className="tree-empty">아직 문서가 없습니다</div>
                )}
            </>
          ) : (
            episodeDocuments
          )}
        </section>
        {brokenFiles}
      </div>
      <div className="tree-footer">
        {treeTab === "episode" && !archive && (
          <button className="episode-add" onClick={attempt(() => createDoc("episode"))}>
            <Plus size={16} />
            새 에피소드
          </button>
        )}
        <button
          className="archive-toggle"
          onClick={() => setArchive((a) => !a)}
        >
          <Archive size={14} />
          {archive ? "현재 문서 보기" : "보관함 보기"}
        </button>
      </div>
    </ResizableSidebar>
  );
}
