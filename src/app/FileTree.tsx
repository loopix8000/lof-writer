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
import PillTabs from "../PillTabs";
import ResizableSidebar from "../ResizableSidebar";
import {
  type Kind,
  type Library,
  type Project
} from "../types";

import EpisodeDocList from "./EpisodeDocList";
import { EPISODE_GROUP, type RenderTreeRow } from "./file-tree-model";
import FileTreeRow from "./FileTreeRow";
import MemoFolderTree from "./MemoFolderTree";
import type { FileTreeController } from "./useFileTree";

type Props = {
  tree: FileTreeController;
  prefs: Record<string, any>;
  savePrefs: (patch: Record<string, any>) => Promise<void>;
  report: (error: any) => void;
  menu: { x: number; y: number; items: MenuItem[]; target?: string } | null;
  switchWasOpen: React.RefObject<boolean>;
  setMenu: React.Dispatch<React.SetStateAction<Props["menu"]>>;
  projectMenu: () => MenuItem[];
  project: Project | undefined;
  lib: Library;
  projectId: string;
  archive: boolean;
  setArchive: React.Dispatch<React.SetStateAction<boolean>>;
  createDoc: (kind: Kind, options?: { title?: string; episodeId?: string }) => Promise<void>;
  brokenFiles: React.ReactNode;
};
export default function FileTree({
  tree, prefs, savePrefs, report, menu, switchWasOpen, setMenu, projectMenu,
  project, lib, projectId, archive, setArchive, createDoc, brokenFiles,
}: Props) {
  const {
    treeTab, docScope, treeQuery, treeDocs, treeEpisodes, count, attempt,
    openMenu, docCreateMenu, addMemoFolder, openEpisodeGroups, numberOf,
    treeDrop, memoCreateMenu, folderDropProps, memoEntries,
  } = tree;
  const treeRow: RenderTreeRow = (doc, marker, options) => <FileTreeRow key={doc.id} doc={doc} marker={marker} options={options} tree={tree} />;
  const folderTree = <MemoFolderTree tree={tree} treeRow={treeRow} />;
  const episodeDocuments = <EpisodeDocList tree={tree} treeRow={treeRow} />;

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
      <PillTabs<"episode" | "memo">
        className="tree-tabs"
        value={treeTab}
        label="파일 트리 보기"
        items={[
          {
            value: "episode",
            label: labels.episode,
            count: count("episode"),
            // 문서를 끌어 에피소드 탭에 올리면 탭을 바꿔 회차 위에 놓을 수 있게 한다.
            onDragEnter: () => tree.enterTab("episode"),
          },
          {
            value: "memo",
            label: "문서",
            count: count("plot") + count("memo"),
            onDragEnter: () => tree.enterTab("memo"),
          },
        ]}
        onChange={(tab) => tree.setTab(tab)}
      />
      {treeTab === "memo" && (
        <PillTabs<"all" | "episode">
          className="doc-scope"
          value={docScope}
          label="문서 보기 범위"
          items={[
            { value: "all", label: "전체 문서" },
            { value: "episode", label: "현재 회차만" },
          ]}
          onChange={(scope) => tree.setScope(scope)}
        />
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
              tree.updateQuery(treeTab, value);
            }}
            onKeyDown={tree.searchKey}
          />
          {treeQuery[treeTab] && (
            <button
              aria-label="검색어 지우기"
              title="검색어 지우기"
              onClick={() => tree.updateQuery(treeTab, "")}
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
            openMenu(e, [{ label: "새 회차", disabled: archive, action: attempt(() => createDoc("episode")) }])
          }
        >
          {!treeQuery.episode.trim() && treeEpisodes.length > EPISODE_GROUP
            ? Array.from({ length: Math.ceil(treeEpisodes.length / EPISODE_GROUP) }, (_, g) => {
              const start = g * EPISODE_GROUP,
                items = treeEpisodes.slice(start, start + EPISODE_GROUP),
                open = openEpisodeGroups.has(start);
              const toggle = (next: boolean) => tree.setEpisodeGroup(start, next);
              return (
                <Fragment key={start}>
                  <button
                    className="tree-item episode-group"
                    aria-expanded={open}
                    onClick={() => toggle(!open)}
                    // 문서나 회차를 끌어 접힌 묶음에 올리면 펼쳐서 회차 위에 놓을 수 있게 한다.
                    onDragEnter={() => tree.enterEpisodeGroup(start)}
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
            새 회차
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
