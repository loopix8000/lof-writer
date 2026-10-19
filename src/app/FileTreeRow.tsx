import { Archive, ArchiveRestore, Check, FileText, StickyNote } from "lucide-react";
import type { ReactNode } from "react";
import { normalizeStatus } from "../../core/episode.mjs";
import type { Doc } from "../types";
import type { TreeRowOptions } from "./file-tree-model";
import type { FileTreeController } from "./useFileTree";

export const documentIcon = (doc: Doc) => doc.kind === "memo" ? <StickyNote size={15} /> : <FileText size={15} />;

export default function FileTreeRow({ doc, marker, options = {}, tree }: {
  doc: Doc;
  marker: ReactNode;
  options?: TreeRowOptions;
  tree: FileTreeController;
}) {
  const style = options.depth ? { paddingLeft: 8 + options.depth * 16 } : undefined;
  const dropMark = tree.episodeDrop?.id === doc.id
    ? tree.episodeDrop.after ? "drop-after" : "drop-before"
    : doc.kind === "episode" && tree.treeDrop === doc.id ? "drop-target" : "";
  const selected = tree.treeSelection.length > 1 && tree.treeSelection.includes(doc.id);
  const className = `tree-item ${doc.id === tree.currentId ? "current" : ""} ${selected ? "multi-selected" : ""} ${tree.menuTarget === doc.id ? "context-target" : ""} ${dropMark}`;
  if (tree.renaming?.id === doc.id && !tree.renaming.widget) return (
    <div className={`${className} renaming`} style={style}>
      {marker}
      <input className="tree-rename" aria-label="새 이름" autoFocus value={tree.renaming.value}
        onFocus={event => event.currentTarget.select()}
        onChange={event => tree.changeRename(event.target.value)}
        onKeyDown={event => {
          event.stopPropagation();
          if (event.key === "Enter") tree.attempt(tree.commitRename)();
          else if (event.key === "Escape") tree.cancelRename();
        }}
        onBlur={tree.attempt(tree.commitRename)} />
    </div>
  );
  return (
    <button className={className} style={style} data-doc-id={doc.id} aria-selected={selected || undefined}
      {...tree.rowProps(doc, options.dropFolder)}>
      {marker}
      <span>{doc.title}</span>
      {doc.kind === "episode" && normalizeStatus(doc.status) === "completed" && <Check size={12} aria-label="집필 완료" />}
      {options.badge && <small className="tree-badge" title={`${options.badge}화에 연결됨`}>{options.badge}화</small>}
      <span className="tree-actions">
        <span className="tree-action" role="button" tabIndex={-1}
          title={doc.archived ? "보관 해제" : "보관함으로 이동"}
          aria-label={`${doc.title} ${doc.archived ? "보관 해제" : "보관"}`}
          onClick={event => { event.stopPropagation(); tree.attempt(() => tree.archiveDoc(doc))(); }}
          onDoubleClick={event => event.stopPropagation()}>
          {doc.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
        </span>
      </span>
    </button>
  );
}
