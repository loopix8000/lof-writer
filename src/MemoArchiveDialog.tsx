import { ArchiveRestore, ArrowLeft, ChevronDown, ChevronRight, FilePlus, FileText, Folder, FolderOpen, MoreVertical, StickyNote, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import { useConfirm } from "./ConfirmDialog";
import RecoveryCopies from "./RecoveryCopies";
import { memoEntriesInView, type MemoEntry } from "./memo-tree";
import { call } from "./types";
import { MobileActionSheet } from "./mobile/MobileActionSheet";

export default function MemoArchiveDialog({ space, title, mobile = false, onClose, openDoc, openMemo, flush, onRemoved }: {
  space: string;
  title: string;
  mobile?: boolean;
  onClose: () => void;
  openDoc: (id: string) => Promise<void>;
  openMemo: (space: string, path: string) => Promise<void>;
  flush: () => Promise<void>;
  onRemoved: (path: string) => void;
}) {
  const [entries, setEntries] = useState<MemoEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copyCount, setCopyCount] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(new Set<string>());
  const [actionEntry, setActionEntry] = useState<MemoEntry | null>(null);
  const [menu, setMenu] = useState<{ entry: MemoEntry; x: number; y: number } | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const panel = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const loadSeq = useRef(0);
  const running = useRef(false);
  const common = space === "common";
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const result = await call<{ entries: MemoEntry[] }>("memoTree", { space });
      if (seq === loadSeq.current) { setEntries(memoEntriesInView(result.entries, true)); setLoaded(true); }
    } catch (error: any) { if (seq === loadSeq.current) { setError(error.message); setLoaded(true); } }
  }, [space]);
  useEffect(() => {
    setLoaded(false);
    void load();
    const off = window.lof.onChange(() => void load());
    return () => { loadSeq.current++; off(); };
  }, [load]);
  const closeMenu = () => {
    setActionEntry(null);
    setMenu(null);
    menuTrigger.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => { if (previous?.isConnected && previous.getClientRects().length) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    if (!mobile) return;
    const previous = (window as any).__lofOverlayBack;
    const close = () => {
      if (document.querySelector(".confirm-backdrop")) {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
      } else if (actionEntry) closeMenu();
      else onClose();
      return true;
    };
    (window as any).__lofOverlayBack = close;
    return () => { if ((window as any).__lofOverlayBack === close) (window as any).__lofOverlayBack = previous; };
  }, [mobile, onClose, actionEntry]);
  const openDocument = async (id: string) => { await openDoc(id); onClose(); };
  const changeEntry = async (entry: MemoEntry, remove = false) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      if (remove && !await confirm({ title: entry.type === "folder" ? "폴더 삭제" : "메모 삭제",
        message: `'${entry.name}'${entry.type === "folder" ? " 폴더의 보관된 메모와 하위 폴더를" : " 메모를"} 휴지통으로 옮길까요?`,
        detail: entry.type === "folder" ? "일반 목록에 있는 메모는 유지됩니다." : undefined,
        confirmLabel: "삭제", danger: true })) return;
      await flush();
      await call(remove ? "memoRemove" : "memoArchive", { space, path: entry.path, archived: remove });
      if (remove) onRemoved(entry.path);
      await load();
    } catch (error: any) { setError(error.message || "처리하지 못했습니다. 보관함에서 다시 확인해 주세요."); }
    finally { running.current = false; setBusy(false); }
  };
  const toggleFolder = (path: string) => setExpanded(old => {
    const next = new Set(old);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });
  const openEntry = (entry: MemoEntry) => {
    if (entry.type === "folder") toggleFolder(entry.path);
    else void openMemo(space, entry.path).then(onClose).catch(error => setError(error.message));
  };
  const entryItems = (entry: MemoEntry): MenuItem[] => [
    { label: entry.type === "folder" ? expanded.has(entry.path) ? "폴더 접기" : "폴더 펼치기" : "메모 열기",
      icon: entry.type === "folder" ? <FolderOpen size={18} /> : <StickyNote size={18} />, disabled: busy, action: () => openEntry(entry) },
    { label: "보관함에서 꺼내기", icon: <ArchiveRestore size={18} />, disabled: busy, action: () => void changeEntry(entry) },
    "separator",
    { label: entry.type === "folder" ? "폴더 삭제" : "메모 삭제", icon: <Trash2 size={18} />,
      disabled: busy, danger: true, action: () => void changeEntry(entry, true) },
  ];
  const rows = (parent = "", depth = 0): React.ReactNode => entries.filter(entry => {
    const index = entry.path.lastIndexOf("/");
    return (index < 0 ? "" : entry.path.slice(0, index)) === parent;
  }).map(entry => {
    const folder = entry.type === "folder", open = expanded.has(entry.path);
    const icon = folder ? open ? <FolderOpen size={16} /> : <Folder size={16} />
      : entry.kind === "plot" ? mobile ? <FilePlus size={16} /> : <FileText size={15} className="memo-file-icon" />
        : <StickyNote size={16} className={mobile ? undefined : "memo-file-icon"} />;
    return <div key={entry.path} className={mobile ? "m-tree-node" : undefined}>
      <div className={mobile ? `m-tree-row ${folder ? "m-tree-folder" : "m-doc-tree-item"}` : "memo-archive-entry"}
        onContextMenu={mobile ? undefined : event => { event.preventDefault(); setMenu({ entry, x: event.clientX, y: event.clientY }); }}>
        <button type="button" className={mobile ? "m-tree-row-main" : "tree-item memo-row"}
          style={mobile ? undefined : { paddingLeft: 8 + depth * 14 }} disabled={busy}
          aria-expanded={folder ? open : undefined} onClick={() => openEntry(entry)}>
          {folder && (mobile ? <span className="m-tree-chevron">{open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
            : open ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
          {mobile ? <span className={`m-tree-icon ${folder ? "folder" : entry.kind || "memo"}`}>{icon}</span> : icon}
          <span className={mobile ? "m-tree-label" : undefined}>{entry.name}</span>
          {mobile && entry.updatedAt && <span className="m-tree-meta">{new Date(entry.updatedAt).toLocaleDateString("ko-KR")}</span>}
        </button>
        <button type="button" className={mobile ? "m-tree-action-btn" : "memo-archive-menu"} disabled={busy}
          aria-label={`${entry.name} 메뉴`} aria-haspopup={mobile ? "dialog" : "menu"}
          onClick={event => {
            menuTrigger.current = event.currentTarget;
            if (mobile) setActionEntry(entry);
            else { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ entry, x: rect.right, y: rect.bottom }); }
          }}><MoreVertical size={17} /></button>
      </div>
      {folder && open && <div className={mobile ? "m-tree-children" : undefined}>{rows(entry.path, depth + 1)}</div>}
    </div>;
  });
  const content = <>
    {error && <p role="alert">{error}</p>}
    {!loaded && <p role="status">불러오는 중…</p>}
    {rows()}
    <RecoveryCopies projectId={common ? "" : space} common={common} openDoc={openDocument} onCountChange={setCopyCount}
      restore={common ? async copy => {
        const memo = await call<{ space: string; path: string }>("restoreRecoveryCopy", { key: copy.key, space: "common" });
        await openMemo(memo.space, memo.path);
        onClose();
      } : undefined} />
    {loaded && !entries.length && copyCount === 0 && !error && <div className={mobile ? "m-empty-state" : "tree-empty"}>
      <ArchiveRestore size={mobile ? 30 : 20} /><p>보관함이 비어 있습니다.</p>
    </div>}
  </>;
  const heading = `${title} 보관함`;
  const dialog = <div className={mobile ? "m-dialog-page" : "modal wide memo-archive-dialog"}
    ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={heading} onKeyDown={event => {
      if (event.key === "Escape" && !document.querySelector(".confirm-backdrop")) {
        event.stopPropagation();
        if (actionEntry || menu) closeMenu(); else onClose();
      }
    }}>
    <header className={mobile ? "m-topbar m-topbar-centered" : "modal-header"}>
      {mobile && <button type="button" className="m-back-btn" onClick={onClose}><ArrowLeft size={18} /><span>메모</span></button>}
      {mobile ? <div className="m-topbar-title"><h1>{heading}</h1></div> : <h2>{heading}</h2>}
      {!mobile && <button type="button" aria-label="보관함 닫기" onClick={onClose}><X size={18} /></button>}
    </header>
    <div className={mobile ? "m-dialog-body m-tree-scroll" : "memo-archive-body memo-tree"}>
      {mobile ? <div className="m-tree-container">{content}</div> : content}
    </div>
    {mobile && <MobileActionSheet open={!!actionEntry} title={actionEntry?.name || "메모 메뉴"}
      items={actionEntry ? entryItems(actionEntry) : []} onClose={closeMenu} />}
    {menu && <ContextMenu x={menu.x} y={menu.y} align="end" items={entryItems(menu.entry)} onClose={closeMenu} />}
    {confirmDialog}
  </div>;
  return mobile ? dialog : <div className="modal-backdrop" onMouseDown={event => {
    if (event.target === event.currentTarget) onClose();
  }}>{dialog}</div>;
}
