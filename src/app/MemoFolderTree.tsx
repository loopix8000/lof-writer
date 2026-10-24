import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
} from "lucide-react";
import { Fragment } from "react";

import type * as React from "react";

import { episodeNumber, type RenderTreeRow } from "./file-tree-model";
import { documentIcon as docIcon } from "./FileTreeRow";
import type { FileTreeController } from "./useFileTree";
import TreeRow, { TreeRowAction, treeRowStyle } from "./TreeRow";

export default function MemoFolderTree({ tree, treeRow }: { tree: FileTreeController; treeRow: RenderTreeRow }) {
  const {
    memoOpenFolders, folderRenaming, attempt, renameMemoFolder, treeDrop,
    openMenu, docCreateMenu, addMemoFolder, archiveMemoFolder, removeMemoFolder,
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
            style = treeRowStyle(depth);
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
              <TreeRow
                className={`${tree.menuTarget === "folder-" + f.path ? "context-target" : ""} ${treeDrop === "folder:" + f.path ? "drop-target" : ""}`}
                depth={depth} folder aria-expanded={open}
                title={f.path}
                {...tree.folderDragProps(f.path)}
                {...tree.folderDropProps(f.path)}
                onClick={() => tree.toggleFolder(f.path)}
                onKeyDown={(e) => {
                  if (e.key === "F2") {
                    e.preventDefault();
                    tree.startFolderRename(f.path, f.name);
                  } else if (e.key === "Delete") {
                    e.preventDefault();
                    if (e.shiftKey) attempt(() => removeMemoFolder(f.path))();
                    else if (!tree.archive) attempt(() => archiveMemoFolder(f.path, true))();
                  }
                }}
                onContextMenu={(e) => openMenu(e, tree.folderMenu(f), "folder-" + f.path)}
                marker={<>
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {open ? <FolderOpen size={15} /> : <Folder size={15} />}
                </>} label={f.name} actions={<>
                  {!tree.archive && <>
                  <TreeRowAction
                    title="문서 추가"
                    label={`${f.name} 폴더에 문서 추가`}
                    onAction={(e) => openMenu(e, docCreateMenu(f.path), "folder-" + f.path)}
                  >
                    <FilePlus size={14} />
                  </TreeRowAction>
                  <TreeRowAction
                    title="폴더 추가"
                    label={`${f.name} 폴더 안에 폴더 추가`}
                    onAction={() => attempt(() => addMemoFolder(f.path))()}
                  >
                    <FolderPlus size={14} />
                  </TreeRowAction>
                  </>}
                  <TreeRowAction
                    title={tree.archive ? "보관 해제" : "보관함으로 이동"}
                    label={`${f.name} 폴더 ${tree.archive ? "보관 해제" : "보관함으로 이동"}`}
                    onAction={() => attempt(() => archiveMemoFolder(f.path, !tree.archive))()}
                  >
                    {tree.archive ? <ArchiveRestore size={14} /> : <Archive size={14} />}
                  </TreeRowAction>
                </>} />
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
