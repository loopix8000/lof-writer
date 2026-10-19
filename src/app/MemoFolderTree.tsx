import {
  ChevronDown,
  ChevronRight,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Trash2
} from "lucide-react";
import { Fragment } from "react";
import { type MenuItem } from "../ContextMenu";
import {
  call,
  type Doc,
  type Library
} from "../types";

import type * as React from "react";

type Props = {
  docs: Doc[];
  treeMatch: (text: string, query: string) => boolean;
  memoEntries: { path: string; name: string; type: string; }[];
  memoOpenFolders: Set<string>;
  folderRenaming: { path: string; value: string; } | null;
  setFolderRenaming: React.Dispatch<React.SetStateAction<{ path: string; value: string; } | null>>;
  attempt: (fn: () => Promise<any>) => () => Promise<any>;
  renameMemoFolder: (path: string, name: string) => Promise<void>;
  menu: { x: number; y: number; items: MenuItem[]; target?: string; } | null;
  treeDrop: string | null;
  dragFolder: React.RefObject<string>;
  setTreeDrop: React.Dispatch<React.SetStateAction<string | null>>;
  folderDropProps: (folder: string) => { onDragOver: (e: React.DragEvent) => void; onDragLeave: (e: React.DragEvent) => void; onDrop: (e: React.DragEvent) => void; };
  setMemoOpenFolders: React.Dispatch<React.SetStateAction<Set<string>>>;
  openMenu: (e: React.MouseEvent, items: MenuItem[], target?: string) => void;
  memoMenuItems: (folder: string) => MenuItem[];
  projectRef: React.RefObject<string>;
  removeMemoFolder: (path: string) => Promise<void>;
  docCreateMenu: (folder: string) => MenuItem[];
  addMemoFolder: (parent: string) => Promise<void>;
  lib: Library;
  treeRow: (d: Doc, marker: React.ReactNode, opts?: { depth?: number; badge?: string; dropFolder?: string; }) => React.JSX.Element;
  docIcon: (d: Doc) => React.JSX.Element;
  episodeNumber: (ep: Doc) => string;
  query: string;
};

export default function MemoFolderTree({
  docs,
  treeMatch,
  memoEntries,
  memoOpenFolders,
  folderRenaming,
  setFolderRenaming,
  attempt,
  renameMemoFolder,
  menu,
  treeDrop,
  dragFolder,
  setTreeDrop,
  folderDropProps,
  setMemoOpenFolders,
  openMenu,
  memoMenuItems,
  projectRef,
  removeMemoFolder,
  docCreateMenu,
  addMemoFolder,
  lib,
  treeRow,
  docIcon,
  episodeNumber,
  query,
}: Props) {


  const files = docs.filter((d) => d.kind !== "episode" && (!query.trim() || treeMatch(d.title, query))),
    folders = memoEntries.filter(
      (e) =>
        e.type === "folder" &&
        (!query.trim() || files.some((d) => (d.relPath || "").startsWith("doc/" + e.path + "/"))),
    );
  const parentOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")));
  const level = (parent: string, depth: number): React.ReactNode => {
    const subFolders = folders
      .filter((f) => parentOf(f.path) === parent)
      .sort((a, b) => a.name.localeCompare(b.name, "ko", { numeric: true }));
    const here = files.filter((d) => parentOf((d.relPath || "").slice(4)) === parent);
    return (
      <>
        {subFolders.map((f) => {
          const open = !!query.trim() || memoOpenFolders.has(f.path),
            style = { paddingLeft: 8 + depth * 16 };
          if (folderRenaming?.path === f.path)
            return (
              <div key={"folder-" + f.path} className="tree-item renaming" style={style}>
                <Folder size={15} />
                <input
                  className="tree-rename"
                  aria-label="새 폴더 이름"
                  autoFocus
                  value={folderRenaming.value}
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => setFolderRenaming({ path: f.path, value: e.target.value })}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") e.currentTarget.blur();
                    else if (e.key === "Escape") setFolderRenaming(null);
                  }}
                  onBlur={(e) => {
                    const value = e.currentTarget.value;
                    setFolderRenaming(null);
                    attempt(() => renameMemoFolder(f.path, value))();
                  }}
                />
              </div>
            );
          return (
            <Fragment key={"folder-" + f.path}>
              <button
                className={`tree-item memo-folder ${menu?.target === "folder-" + f.path ? "context-target" : ""} ${treeDrop === "folder:" + f.path ? "drop-target" : ""}`}
                style={style}
                title={f.path}
                draggable
                onDragStart={(e) => {
                  dragFolder.current = f.path;
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => {
                  dragFolder.current = "";
                  setTreeDrop(null);
                }}
                {...folderDropProps(f.path)}
                onClick={() =>
                  setMemoOpenFolders((old) => {
                    const next = new Set(old);
                    if (next.has(f.path)) next.delete(f.path);
                    else next.add(f.path);
                    return next;
                  })
                }
                onKeyDown={(e) => {
                  if (e.key === "F2") {
                    e.preventDefault();
                    setFolderRenaming({ path: f.path, value: f.name });
                  }
                }}
                onContextMenu={(e) =>
                  openMenu(
                    e,
                    [
                      ...memoMenuItems(f.path),
                      "separator",
                      {
                        label: "이름 바꾸기",
                        shortcut: "F2",
                        action: () => setFolderRenaming({ path: f.path, value: f.name }),
                      },
                      {
                        label: "파일 탐색기에서 표시",
                        action: attempt(() =>
                          call("memoReveal", { space: projectRef.current, path: f.path }),
                        ),
                      },
                      "separator",
                      { label: "폴더 삭제", danger: true, action: attempt(() => removeMemoFolder(f.path)) },
                    ],
                    "folder-" + f.path,
                  )
                }
              >
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {open ? <FolderOpen size={15} /> : <Folder size={15} />}
                <span>{f.name}</span>
                <span className="tree-actions">
                  <span
                    className="tree-action"
                    role="button"
                    tabIndex={-1}
                    title="문서 추가"
                    aria-label={`${f.name} 폴더에 문서 추가`}
                    onClick={(e) => {
                      e.stopPropagation();
                      openMenu(e, docCreateMenu(f.path), "folder-" + f.path);
                    }}
                  >
                    <FilePlus size={14} />
                  </span>
                  <span
                    className="tree-action"
                    role="button"
                    tabIndex={-1}
                    title="폴더 추가"
                    aria-label={`${f.name} 폴더 안에 폴더 추가`}
                    onClick={(e) => {
                      e.stopPropagation();
                      attempt(() => addMemoFolder(f.path))();
                    }}
                  >
                    <FolderPlus size={14} />
                  </span>
                  <span
                    className="tree-action"
                    role="button"
                    tabIndex={-1}
                    title="폴더 삭제"
                    aria-label={`${f.name} 폴더 삭제`}
                    onClick={(e) => {
                      e.stopPropagation();
                      attempt(() => removeMemoFolder(f.path))();
                    }}
                  >
                    <Trash2 size={14} />
                  </span>
                </span>
              </button>
              {open && level(f.path, depth + 1)}
            </Fragment>
          );
        })}
        {here.map((d) => {
          const ep = d.episodeId
            ? lib.documents.find((x) => x.id === d.episodeId && x.kind === "episode")
            : undefined;
          return treeRow(d, docIcon(d), {
            depth,
            badge: ep ? episodeNumber(ep) : undefined,
            dropFolder: parent,
          });
        })}
      </>
    );
  };
  return level("", 0);

}
