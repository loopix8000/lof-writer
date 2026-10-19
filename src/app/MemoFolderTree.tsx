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

import type * as React from "react";

import { episodeNumber, type RenderTreeRow } from "./file-tree-model";
import { documentIcon as docIcon } from "./FileTreeRow";
import type { FileTreeController } from "./useFileTree";

export default function MemoFolderTree({ tree, treeRow }: { tree: FileTreeController; treeRow: RenderTreeRow }) {
  const {
    memoOpenFolders, folderRenaming, attempt, renameMemoFolder, treeDrop,
    openMenu, docCreateMenu, addMemoFolder, removeMemoFolder,
  } = tree;
  const query = tree.treeQuery.memo;

  const files = tree.treeDocs, folders = tree.folderEntries;
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
                  onChange={(e) => tree.startFolderRename(f.path, e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") e.currentTarget.blur();
                    else if (e.key === "Escape") tree.cancelFolderRename();
                  }}
                  onBlur={(e) => {
                    const value = e.currentTarget.value;
                    tree.cancelFolderRename();
                    attempt(() => renameMemoFolder(f.path, value))();
                  }}
                />
              </div>
            );
          return (
            <Fragment key={"folder-" + f.path}>
              <button
                className={`tree-item memo-folder ${tree.menuTarget === "folder-" + f.path ? "context-target" : ""} ${treeDrop === "folder:" + f.path ? "drop-target" : ""}`}
                style={style}
                title={f.path}
                {...tree.folderDragProps(f.path)}
                {...tree.folderDropProps(f.path)}
                onClick={() => tree.toggleFolder(f.path)}
                onKeyDown={(e) => {
                  if (e.key === "F2") {
                    e.preventDefault();
                    tree.startFolderRename(f.path, f.name);
                  }
                }}
                onContextMenu={(e) => openMenu(e, tree.folderMenu(f), "folder-" + f.path)}
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
            ? tree.documents.find((x) => x.id === d.episodeId && x.kind === "episode")
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
