import { ArrowLeft, ArrowDown01, ArrowDown10, BookOpen, ChevronDown, ChevronRight, FileText, Folder, FolderOpen, PanelLeft, Search, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { icons, labels } from "../app/document-ui";
import { EPISODE_GROUP, parentOfRel } from "../app/file-tree-model";
import type { FileTreeController } from "../app/useFileTree";
import type { Doc, Project } from "../types";
import MobilePillTabs from "./MobilePillTabs";
import { useEpisodeGroups } from "./useEpisodeGroups";
import { compareNames, useDocumentSort, useEpisodeSort } from "./useEpisodeSort";

export default function MobileEmptyEditorView({ root, project, tree, openDoc, goProject, report }: {
  root: string;
  project?: Project;
  tree: FileTreeController;
  openDoc: (id: string, pinned?: boolean) => Promise<void>;
  goProject: () => Promise<void>;
  report: (error: unknown) => void;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [tab, setTab] = useState<"episode" | "document">("episode");
  const [query, setQuery] = useState("");
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const { sort: episodeSort, toggleSort: toggleEpisodeSort } = useEpisodeSort();
  const { sort: documentSort, toggleSort: toggleDocumentSort } = useDocumentSort();
  const episodes = tree.docs.filter(doc => doc.kind === "episode");
  const documents = tree.docs.filter(doc => doc.kind !== "episode")
    .sort((a, b) => compareNames(a.title, b.title, documentSort));
  const defaultStart = episodeSort === "desc" ? Math.max(0, Math.ceil(episodes.length / EPISODE_GROUP) - 1) * EPISODE_GROUP : 0;
  const { isGroupOpen, toggleGroup } = useEpisodeGroups(root, project?.id ?? "", defaultStart, tree.archive);
  const search = query.trim().toLowerCase();
  const matches = (doc: Doc) => !search || `${doc.title} ${doc.relPath ?? ""}`.toLowerCase().includes(search);

  useEffect(() => {
    const back = () => {
      if (!drawerOpen) return false;
      setDrawerOpen(false);
      return true;
    };
    (window as any).__lofEditorSubBack = back;
    return () => {
      if ((window as any).__lofEditorSubBack === back) delete (window as any).__lofEditorSubBack;
    };
  }, [drawerOpen]);

  const row = (doc: Doc) => {
    const Icon = icons[doc.kind];
    return <div className={`m-tree-row ${doc.kind === "episode" ? "m-episode-row" : "m-doc-tree-item"}`} key={doc.id}>
      <button type="button" className="m-tree-row-main" onClick={() => {
        void openDoc(doc.id, false).catch(report);
      }}>
        {doc.kind === "episode" ? <span className={`m-ep-pill ${/^\d/.test(String(tree.numberOf(doc))) ? "" : "named"}`}>{tree.numberOf(doc)}</span>
          : <span className={`m-tree-icon ${doc.kind}`}><Icon size={16} /></span>}
        <span className="m-tree-label">{doc.title || "제목 없음"}</span>
        {doc.kind !== "episode" && <span className={`m-tree-kind-tag ${doc.kind}`}>{labels[doc.kind]}</span>}
      </button>
    </div>;
  };
  const folderOf = (doc: Doc) => parentOfRel((doc.relPath ?? "").replace(/^doc\//, ""));
  const folders = new Set<string>();
  for (const doc of documents) {
    let folder = folderOf(doc);
    while (folder) { folders.add(folder); folder = parentOfRel(folder); }
  }
  const folderTree = (parent: string): ReactNode => <>
    {[...folders].filter(path => parentOfRel(path) === parent)
      .sort((a, b) => compareNames(a, b, documentSort)).map(path => {
        const open = !collapsedFolders.has(path);
        return <div className="m-tree-node" key={path}>
          <div className="m-tree-row m-tree-folder">
            <button type="button" className="m-tree-row-main" aria-expanded={open} onClick={() => {
              setCollapsedFolders(previous => {
                const next = new Set(previous);
                if (open) next.add(path); else next.delete(path);
                return next;
              });
            }}>
              <span className="m-tree-chevron">{open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
              <span className="m-tree-icon">{open ? <FolderOpen size={16} /> : <Folder size={16} />}</span>
              <span className="m-tree-label">{path.split("/").at(-1)}</span>
            </button>
          </div>
          {open && <div className="m-tree-children">{folderTree(path)}</div>}
        </div>;
      })}
    {documents.filter(doc => folderOf(doc) === parent).map(row)}
  </>;

  return <div className="m-screen m-editor-screen">
    <header className="m-topbar m-editor-topbar">
      <button type="button" className="m-icon-btn" aria-label="파일 트리 열기" onClick={() => setDrawerOpen(true)}>
        <PanelLeft size={19} />
      </button>
      <button type="button" className="m-icon-btn" aria-label="작품 페이지로 이동" onClick={() => void goProject().catch(report)}>
        <ArrowLeft size={19} />
      </button>
    </header>
    <div className="m-scroll-body m-empty-state">
      <FileText size={32} aria-hidden="true" />
      <p>파일 트리에서 문서를 선택하세요.</p>
    </div>
    {drawerOpen && <div className="m-drawer-backdrop" role="presentation" onClick={() => setDrawerOpen(false)}>
      <aside className="m-slide-drawer left" role="dialog" aria-modal="true" aria-label="파일 트리" onClick={event => event.stopPropagation()}>
        <div className="m-drawer-header">
          <div className="m-drawer-title-group"><strong>{project?.title || "파일 트리"}</strong></div>
          <button type="button" className="m-icon-btn" aria-label="파일 트리 닫기" onClick={() => setDrawerOpen(false)}><X size={18} /></button>
        </div>
        <div className="m-drawer-controls">
          <MobilePillTabs value={tab} onChange={setTab} label="파일 트리 보기" items={[
            { value: "episode", label: "에피소드", icon: <BookOpen size={14} />, count: episodes.length },
            { value: "document", label: "문서", icon: <FileText size={14} />, count: documents.length },
          ]} />
          <div className="m-row-gap">
            <div className="m-soft-search">
              <Search size={14} className="m-filter-icon" />
              <input type="search" className="m-filter-input" aria-label="문서 검색" placeholder="문서 검색..." value={query} onChange={event => setQuery(event.target.value)} />
            </div>
            <button type="button" className="m-sort-btn" aria-label="정렬 순서 변경" onClick={tab === "episode" ? toggleEpisodeSort : toggleDocumentSort}>
              {(tab === "episode" ? episodeSort : documentSort) === "asc" ? <ArrowDown01 size={16} /> : <ArrowDown10 size={16} />}
            </button>
          </div>
        </div>
        <div className="m-drawer-body m-tree-scroll"><div className="m-tree-container">
          {tab === "document" ? (search ? documents.filter(matches).map(row) : folderTree(""))
            : !search && episodes.length > EPISODE_GROUP
              ? Array.from({ length: Math.ceil(episodes.length / EPISODE_GROUP) }, (_, index) => index * EPISODE_GROUP)
                .sort((a, b) => episodeSort === "desc" ? b - a : a - b).map(start => {
                  const group = episodes.slice(start, start + EPISODE_GROUP);
                  const open = isGroupOpen(start);
                  return <div className="m-tree-node" key={start}>
                    <div className="m-tree-row m-tree-folder"><button type="button" className="m-tree-row-main" aria-expanded={open} onClick={() => toggleGroup(start)}>
                      <span className="m-tree-chevron">{open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
                      <span className="m-tree-label">{episodeSort === "desc" ? `${start + group.length} – ${start + 1}화` : `${start + 1} – ${start + group.length}화`}</span>
                      <span className="m-tree-count">{group.length}</span>
                    </button></div>
                    {open && <div className="m-tree-children">{(episodeSort === "desc" ? [...group].reverse() : group).map(row)}</div>}
                  </div>;
                })
              : (episodeSort === "desc" ? [...episodes].reverse() : episodes).filter(matches).map(row)}
        </div></div>
      </aside>
    </div>}
  </div>;
}
