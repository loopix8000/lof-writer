import type * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { episodeNumbers, normalizeStatus } from "../../core/episode.mjs";
import type { ConfirmOptions } from "../ConfirmDialog";
import type { MenuItem } from "../ContextMenu";
import { statusItems } from "../EpisodeProperties";
import { call, type Doc, type Kind, type Library } from "../types";
import { EPISODE_GROUP, episodeNumber, parentOfRel, treeMatch, type FolderEntry } from "./file-tree-model";

type Options = {
  library: Library;
  active: Doc | null;
  projectId: string;
  view: string;
  archive: boolean;
  menuTarget?: string;
  getLibrary: () => Library;
  currentProjectId: () => string;
  currentDocument: () => Doc | null;
  flush: () => Promise<void>;
  refresh: () => Promise<Library | undefined>;
  moveDocuments: (action: () => Promise<void>) => Promise<void>;
  openDoc: (id: string, pinned?: boolean) => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  closeSideTab: (id: string) => void;
  writeMeta: (id: string, patch: Partial<Doc>) => Promise<void>;
  patchDoc: (id: string, patch: Partial<Doc>) => Promise<void>;
  archiveDoc: (doc: Doc) => Promise<void>;
  archiveDocs: (docs: Doc[], archived: boolean) => Promise<void>;
  copyPath: (doc: Doc) => Promise<void>;
  docMenu: (doc: Doc) => MenuItem[];
  openMenu: (event: React.MouseEvent, items: MenuItem[], target?: string) => void;
  onDelete: (ids: string[]) => void;
  remapDocuments: (before: Doc[], from: string, to: string) => void;
  showTree: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  message: (text: string) => void;
  report: (error: unknown) => void;
};

export function useFileTree(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const { library: lib, active, projectId, view, archive } = options;
  const renamingRef = useRef<{ id: string; value: string; widget?: boolean } | null>(null);
  const selectionAnchor = useRef("");
  const dragTreeDoc = useRef("");
  const dragEpisodes = useRef<string[]>([]);
  const dragFileDocs = useRef<string[]>([]);
  const dragFolder = useRef("");
  // 저장과 문서 이동은 앱의 동작을 사용하고, 트리 상태는 이 훅에서만 변경한다.
  const flush = () => latest.current.flush();
  const refresh = () => latest.current.refresh();
  // 변경 알림의 갱신과 겹치더라도 ID 교체에 쓸 최신 목록을 확보한다.
  const refreshAfterMove = async () => { while (!await refresh()) { /* 뒤에 시작된 갱신이 앞선 결과를 대체했다. */ } };
  const openDoc = (id: string, pinned?: boolean) => latest.current.openDoc(id, pinned);
  const closeTab = (id: string) => latest.current.closeTab(id);
  const closeSideTab = (id: string) => latest.current.closeSideTab(id);
  const writeMeta = (id: string, patch: Partial<Doc>) => latest.current.writeMeta(id, patch);
  const patchDoc = (id: string, patch: Partial<Doc>) => latest.current.patchDoc(id, patch);
  const archiveDocs = (docs: Doc[], archived: boolean) => latest.current.archiveDocs(docs, archived);
  const archiveDoc = (doc: Doc) => latest.current.archiveDoc(doc);
  const copyPath = (doc: Doc) => latest.current.copyPath(doc);
  const message = (text: string) => latest.current.message(text);
  const confirm = (options: ConfirmOptions) => latest.current.confirm(options);
  const remapDocs = (before: Doc[], from: string, to: string) => latest.current.remapDocuments(before, from, to);
  const openMenu = (event: React.MouseEvent, items: MenuItem[], target?: string) => latest.current.openMenu(event, items, target);
  const attempt = (action: () => Promise<unknown>) => () => action().catch(error => latest.current.report(error));

  const [treeDrop, setTreeDrop] = useState<string | null>(null);
  const [episodeDrop, setEpisodeDrop] = useState<{ id: string; after: boolean } | null>(null);
  const [treeSelection, setTreeSelection] = useState<string[]>([]);
  const [memoEntries, setMemoEntries] = useState<{ path: string; name: string; type: string }[]>([]);
  const [memoOpenFolders, setMemoOpenFolders] = useState<Set<string>>(new Set());
  const [folderRenaming, setFolderRenaming] = useState<{ path: string; value: string } | null>(null);
  const [treeTab, setTreeTab] = useState<"episode" | "memo">("episode");
  const [treeQuery, setTreeQuery] = useState({ episode: "", memo: "" });
  const [docScope, setDocScope] = useState<"all" | "episode">("all");
  const [treeEpisodeId, setTreeEpisodeId] = useState("");
  const [closedDocGroups, setClosedDocGroups] = useState<Set<Kind>>(new Set());
  const [openEpisodeGroups, setOpenEpisodeGroups] = useState<Set<number>>(new Set());
  const [renaming, setRenaming] = useState<{ id: string; value: string; widget?: boolean } | null>(null);
  const docs = lib.documents.filter(
    (d) => d.projectId === projectId && d.archived === archive,
  ),
    count = (kind: Kind) => docs.filter((d) => d.kind === kind).length;
  // 목록과 원고 머리의 번호. 회차는 일반 에피소드만 001부터 세고, 프롤로그 등은 유형 이름을 쓴다.
  const episodeNo = episodeNumbers(
    docs.filter((d) => d.kind === "episode").map((d) => (d.id === active?.id ? active : d)),
  );
  const numberOf = (d: Doc) =>
    d.kind === "episode"
      ? (episodeNo.get(d.id) ?? "")
      : String(docs.filter((x) => x.kind === d.kind).findIndex((x) => x.id === d.id) + 1).padStart(3, "0");

  async function commitRename() {
    const r = renamingRef.current;
    if (!r) return;
    renamingRef.current = null;
    setRenaming(null);
    const title = r.value.trim(),
      doc = latest.current.getLibrary().documents.find((d) => d.id === r.id);
    if (!doc || !title || title === doc.title) return;
    await patchDoc(r.id, { title });
  }

  function startRename(doc: Doc, widget = false) {
    renamingRef.current = { id: doc.id, value: doc.title, widget };
    setRenaming(renamingRef.current);
  }

  function selectionFor(d: Doc): Doc[] {
    if (treeSelection.length < 2 || !treeSelection.includes(d.id)) return [d];
    return treeSelection
      .map((id) => lib.documents.find((x) => x.id === id))
      .filter((x): x is Doc => !!x);
  }

  function selectTreeRange(row: HTMLElement, id: string) {
    const ids = [...(row.closest(".tree-panel")?.querySelectorAll<HTMLElement>("[data-doc-id]") ?? [])].map(
      (el) => el.dataset.docId!,
    );
    let from = ids.indexOf(selectionAnchor.current || active?.id || "");
    const to = ids.indexOf(id);
    if (to < 0) return;
    if (from < 0) {
      from = to;
      selectionAnchor.current = id;
    }
    setTreeSelection(ids.slice(Math.min(from, to), Math.max(from, to) + 1));
  }

  function toggleTreeSelection(id: string) {
    setTreeSelection((sel) => {
      const base = sel.length ? sel : selectionAnchor.current ? [selectionAnchor.current] : [];
      return base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    });
    selectionAnchor.current = id;
  }

  function selectionMenu(docs: Doc[]): MenuItem[] {
    const episodes = docs.every((d) => d.kind === "episode"),
      archived = docs.every((d) => d.archived),
      status = new Set(docs.map((d) => normalizeStatus(d.status))),
      done = () => setTreeSelection([]);
    return [
      { label: `문서 ${docs.length}개 선택됨`, disabled: true, action: () => { } },
      ...(episodes
        ? ([
          "separator",
          // 상태가 섞여 있으면 어느 항목도 막지 않는다.
          ...statusItems([...status][0], (next) =>
            attempt(async () => {
              for (const d of docs)
                if (normalizeStatus(d.status) !== next) await writeMeta(d.id, { status: next });
              await refresh();
              done();
              if (next === "completed")
                message("원고 보호 모드로 전환되었습니다. 집필 완료된 에피소드는 편집이 제한됩니다.");
            })(),
          ).map((item) => (item === "separator" || status.size === 1 ? item : { ...item, disabled: false })),
        ] as MenuItem[])
        : []),
      "separator",
      archived
        ? { label: "보관 해제", action: attempt(async () => { done(); await archiveDocs(docs, false); }) }
        : { label: "보관함으로 이동", shortcut: "Delete", action: attempt(async () => { done(); await archiveDocs(docs, true); }) },
      {
        label: "영구 삭제",
        shortcut: "Shift+Delete",
        danger: true,
        action: () => latest.current.onDelete(docs.map((d) => d.id)),
      },
    ];
  }

  function treeKey(e: React.KeyboardEvent, d: Doc) {
    const docs = selectionFor(d);
    if (e.key === "Escape" && treeSelection.length) setTreeSelection([]);
    else if (e.key === "F2" && docs.length === 1) startRename(d);
    else if (e.key === "Delete" && e.shiftKey)
      latest.current.onDelete(docs.map((x) => x.id));
    else if (e.key === "Delete" && docs.some((x) => !x.archived))
      attempt(async () => {
        setTreeSelection([]);
        await archiveDocs(docs, true);
      })();
    else if (e.shiftKey && e.altKey && e.code === "KeyR") attempt(() => call("reveal", { id: d.id }))();
    else if (e.shiftKey && e.altKey && e.code === "KeyC") attempt(() => copyPath(d))();
    else return;
    e.preventDefault();
  }

  function currentEpisode(): Doc | undefined {
    const a = latest.current.currentDocument();
    if (a?.kind === "episode") return a;
    return a?.episodeId
      ? latest.current.getLibrary().documents.find((d) => d.id === a.episodeId && d.kind === "episode")
      : undefined;
  }

  function plotItems(ep: Doc): MenuItem[] {
    return [
      { label: "이 회차에 플롯 만들기", disabled: archive, action: attempt(() => addDocFile("", "plot", ep)) },
      { label: "이 회차에 메모 만들기", disabled: archive, action: attempt(() => addDocFile("", "memo", ep)) },
    ];
  }

  function docCreateMenu(folder: string): MenuItem[] {
    const ep = currentEpisode();
    return [
      { label: "플롯", disabled: archive, action: attempt(() => addDocFile(folder, "plot")) },
      { label: "메모", disabled: archive, action: attempt(() => addDocFile(folder, "memo")) },
      ...(ep
        ? ([
          "separator",
          {
            label: `플롯 (${episodeNumber(ep)}화에 연결)`,
            disabled: archive,
            action: attempt(() => addDocFile(folder, "plot", ep)),
          },
          {
            label: `메모 (${episodeNumber(ep)}화에 연결)`,
            disabled: archive,
            action: attempt(() => addDocFile(folder, "memo", ep)),
          },
        ] as MenuItem[])
        : []),
    ];
  }

  function folderDropProps(folder: string) {
    const key = "folder:" + folder;
    // 옮길 경로: 끈 파일(여러 개면 이미 그 폴더에 있는 것은 빼고)이나 끈 폴더.
    const paths = () => {
      if (dragFileDocs.current.length)
        return dragFileDocs.current
          .map((id) => latest.current.getLibrary().documents.find((x) => x.id === id)?.relPath?.slice(4) ?? "")
          .filter((p) => p && parentOfRel(p) !== folder);
      const from = dragFolder.current;
      return from && from !== folder && !folder.startsWith(from + "/") && parentOfRel(from) !== folder ? [from] : [];
    };
    const canDrop = () => paths().length > 0;
    return {
      onDragOver: (e: React.DragEvent) => {
        if (!canDrop()) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        setTreeDrop(key);
      },
      onDragLeave: (e: React.DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node))
          setTreeDrop((t) => (t === key ? null : t));
      },
      onDrop: (e: React.DragEvent) => {
        if (!canDrop()) return;
        e.preventDefault();
        e.stopPropagation();
        const moving = paths();
        dragFileDocs.current = [];
        dragFolder.current = "";
        setTreeDrop(null);
        setTreeSelection([]);
        attempt(() => moveDocPaths(moving, folder))();
      },
    };
  }

  async function moveDocPaths(paths: string[], to: string) {
    if (!paths.length) return;
    await flush();
    await latest.current.moveDocuments(async () => {
      const moved: { path: string; next: string; inside: Doc[] }[] = [];
      try {
        for (const path of paths) {
          const from = "doc/" + path,
            inside = latest.current.getLibrary().documents.filter(
              (d) =>
                d.projectId === latest.current.currentProjectId() &&
                (d.relPath === from || d.relPath?.startsWith(from + "/")),
            );
          const r = await call<{ path: string }>("memoMove", { space: latest.current.currentProjectId(), path, to });
          moved.push({ path, next: r.path, inside });
        }
      } finally {
        if (moved.length) {
          await refreshAfterMove();
          for (const m of moved) remapDocs(m.inside, "doc/" + m.path, "doc/" + m.next);
        }
      }
      const rename = (p: string) => {
        const m = moved.find((x) => p === x.path || p.startsWith(x.path + "/"));
        return m ? m.next + p.slice(m.path.length) : p;
      };
      setMemoOpenFolders((old) => new Set([...[...old].map(rename), ...(to ? [to] : [])]));
      await loadMemoFolders();
    });
  }

  async function remapMovedDocs(before: Doc[], from: string, to: string) {
    await refreshAfterMove();
    remapDocs(before, from, to);
  }

  function episodeDropProps(ep: Doc) {
    const reordering = () =>
      dragEpisodes.current.length > 0 && !dragEpisodes.current.includes(ep.id) && !ep.archived;
    const after = (e: React.DragEvent) => {
      const r = e.currentTarget.getBoundingClientRect();
      return e.clientY > r.top + r.height / 2;
    };
    return {
      onDragOver: (e: React.DragEvent) => {
        const reorder = reordering();
        if (!reorder && !dragFileDocs.current.length) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        if (!reorder) return setTreeDrop(ep.id);
        const a = after(e);
        setEpisodeDrop((o) => (o?.id === ep.id && o.after === a ? o : { id: ep.id, after: a }));
      },
      onDragLeave: (e: React.DragEvent) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setTreeDrop((t) => (t === ep.id ? null : t));
        setEpisodeDrop((o) => (o?.id === ep.id ? null : o));
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const reorder = reordering(),
          episodeIds = dragEpisodes.current,
          fileIds = dragFileDocs.current,
          a = after(e);
        dragEpisodes.current = [];
        dragFileDocs.current = [];
        setTreeDrop(null);
        setEpisodeDrop(null);
        setTreeSelection([]);
        if (reorder) return attempt(() => moveEpisodes(episodeIds, ep.id, a))();
        const binding = latest.current.getLibrary().documents.filter((d) => fileIds.includes(d.id) && d.episodeId !== ep.id);
        if (!binding.length) return;
        attempt(async () => {
          for (const d of binding) await writeMeta(d.id, { episodeId: ep.id });
          await refresh();
          message(binding.length > 1 ? `문서 ${binding.length}개를 에피소드에 연결했습니다.` : "에피소드에 연결했습니다.");
        })();
      },
    };
  }

  async function moveEpisodes(ids: string[], targetId: string, after: boolean) {
    await flush();
    const target = latest.current.getLibrary().documents.find((d) => d.id === targetId && d.kind === "episode");
    if (!target || ids.includes(targetId)) return;
    const items = latest.current.getLibrary().documents.filter(
      (d) => d.projectId === target.projectId && d.kind === "episode" && !d.archived,
    ),
      moving = items.filter((d) => ids.includes(d.id)),
      next = items.filter((d) => !ids.includes(d.id)),
      at = next.findIndex((d) => d.id === targetId);
    if (at < 0 || !moving.length) return;
    next.splice(at + (after ? 1 : 0), 0, ...moving);
    if (next.every((d, i) => d.id === items[i].id)) return;
    await call("reorderDocuments", {
      projectId: target.projectId,
      ids: next.map((d) => d.id),
    });
    await refresh();
  }

  async function addDocFile(folder: string, kind: "plot" | "memo", ep?: Doc, widget = false) {
    await flush();
    const doc = await call<Doc>("createDocument", {
      projectId: latest.current.currentProjectId(),
      kind,
      folder: folder || undefined,
      title: kind === "plot" ? "새 플롯" : "새 메모",
      episodeId: ep?.id,
      manualLineBreak: false,
    });
    await refresh();
    await loadMemoFolders();
    if (widget) return startRename(doc, true);
    if (folder) setMemoOpenFolders((old) => new Set([...old, folder]));
    latest.current.showTree();
    startRename(doc);
  }

  async function loadMemoFolders() {
    const pid = latest.current.currentProjectId();
    if (!pid) return;
    const r = await call<{ entries: { path: string; name: string; type: string }[] }>("memoTree", {
      space: pid,
    });
    if (latest.current.currentProjectId() === pid) setMemoEntries(r.entries);
  }

  async function addMemoFolder(parent: string) {
    const r = await call<{ path: string }>("memoCreateFolder", {
      space: latest.current.currentProjectId(),
      parent,
      name: "새 폴더",
    });
    await loadMemoFolders();
    if (parent) setMemoOpenFolders((old) => new Set([...old, parent]));
    setFolderRenaming({ path: r.path, value: r.path.slice(r.path.lastIndexOf("/") + 1) });
  }

  async function renameMemoFolder(path: string, name: string) {
    const old = path.slice(path.lastIndexOf("/") + 1);
    if (!name.trim() || name.trim() === old) return;
    await flush();
    await latest.current.moveDocuments(async () => {
      const prefix = "doc/" + path + "/",
        inside = latest.current.getLibrary().documents.filter(
          (d) => d.projectId === latest.current.currentProjectId() && d.relPath?.startsWith(prefix),
        );
      const r = await call<{ path: string }>("memoRename", {
        space: latest.current.currentProjectId(),
        path,
        name: name.trim(),
      });
      await remapMovedDocs(inside, "doc/" + path, "doc/" + r.path);
      setMemoOpenFolders(
        (old) => new Set([...old].map((p) => (p === path || p.startsWith(path + "/") ? r.path + p.slice(path.length) : p))),
      );
      await loadMemoFolders();
    });
  }

  async function removeMemoFolder(path: string) {
    const prefix = "doc/" + path + "/",
      inside = latest.current.getLibrary().documents.filter(
        (d) => d.projectId === latest.current.currentProjectId() && d.relPath?.startsWith(prefix),
      );
    const name = path.slice(path.lastIndexOf("/") + 1);
    const ok = await confirm({
      title: "폴더 삭제",
      message: `'${name}' 폴더${inside.length ? `와 안의 문서 ${inside.length}개` : ""}를 휴지통으로 옮길까요?`,
      confirmLabel: "휴지통으로 옮기기",
      danger: true,
    });
    if (!ok) return;
    await flush();
    for (const d of inside) await closeTab(d.id);
    for (const d of inside) closeSideTab(d.id);
    await call("memoRemove", { space: latest.current.currentProjectId(), path });
    await refresh();
    await loadMemoFolders();
  }
  // 다른 곳(검색, 탭, 회차 우클릭으로 만든 플롯 등)에서 문서를 열면 그 문서가 있는 탭으로 옮긴다.
  // 현재 회차는 마지막으로 연 회차이거나, 연 문서가 연결된 회차다.
  useEffect(() => {
    if (!active) return;
    setTreeTab(active.kind === "episode" ? "episode" : "memo");
    const episodeId = active.kind === "episode" ? active.id : active.episodeId;
    if (episodeId) setTreeEpisodeId(episodeId);
    // 연 회차가 접힌 묶음 안에 있으면 그 묶음을 펼친다.
    const at = docs.filter((d) => d.kind === "episode").findIndex((d) => d.id === active.id);
    if (at >= 0) {
      const start = at - (at % EPISODE_GROUP);
      setOpenEpisodeGroups((old) => (old.has(start) ? old : new Set([...old, start])));
    }
  }, [active?.id, active?.kind, active?.episodeId]);

  // 작품·트리 탭·보관함·문서 범위가 바뀌면 고른 줄이 화면에서 사라지므로 선택을 푼다.
  useEffect(() => {
    setTreeSelection([]);
  }, [projectId, treeTab, archive, docScope]);
  // 파일 트리 검색어에 맞는 에피소드(번호나 제목)와 문서(제목). Enter를 누르면 첫 번째 것을 연다.
  const treeEpisodes = docs.filter(
    (d) => d.kind === "episode" && (!treeQuery.episode.trim() || treeMatch(`${numberOf(d)} ${d.title}`, treeQuery.episode)),
  ),
    treeDocs = docs.filter(
      (d) =>
        d.kind !== "episode" &&
        (docScope === "all" || d.episodeId === treeEpisodeId) &&
        (!treeQuery.memo.trim() || treeMatch(d.title, treeQuery.memo)),
    );
  const folderEntries = memoEntries.filter(entry => entry.type === "folder" &&
    (!treeQuery.memo.trim() || treeDocs.some(doc => (doc.relPath || "").startsWith("doc/" + entry.path + "/"))));
  const boundEpisode = docs.find(doc => doc.id === treeEpisodeId && doc.kind === "episode");
  const boundDocuments = boundEpisode ? docs.filter(doc => doc.kind !== "episode" && doc.episodeId === boundEpisode.id) : [];

  useEffect(() => { if (view === "workspace" && projectId) loadMemoFolders().catch(() => { }); }, [view, projectId, lib]);
  const clearSelection = useCallback(() => setTreeSelection([]), []);
  function changeRename(value: string) {
    if (!renamingRef.current) return;
    renamingRef.current = { ...renamingRef.current, value };
    setRenaming(renamingRef.current);
  }
  function cancelRename() { renamingRef.current = null; setRenaming(null); }
  const memoMenuItems = (folder: string): MenuItem[] => [
    ...docCreateMenu(folder), "separator",
    { label: "폴더 추가", disabled: archive, action: attempt(() => addMemoFolder(folder)) },
  ];
  const memoCreateMenu = memoMenuItems;
  function toggleFolder(path: string) {
    setMemoOpenFolders(old => {
      const next = new Set(old);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }
  function startFolderRename(path: string, value: string) { setFolderRenaming({ path, value }); }
  function cancelFolderRename() { setFolderRenaming(null); }
  function revealFolder(path: string) { return call("memoReveal", { space: latest.current.currentProjectId(), path }); }
  function folderMenu(folder: FolderEntry): MenuItem[] {
    return [
      ...memoMenuItems(folder.path), "separator",
      { label: "이름 바꾸기", shortcut: "F2", action: () => startFolderRename(folder.path, folder.name) },
      { label: "파일 탐색기에서 표시", action: attempt(() => revealFolder(folder.path)) }, "separator",
      { label: "폴더 삭제", danger: true, action: attempt(() => removeMemoFolder(folder.path)) },
    ];
  }
  function folderDragProps(path: string) {
    return {
      draggable: true,
      onDragStart: (event: React.DragEvent) => { dragFolder.current = path; event.dataTransfer.effectAllowed = "move"; },
      onDragEnd: () => { dragFolder.current = ""; setTreeDrop(null); },
    };
  }
  function setTab(tab: "episode" | "memo") { setTreeTab(tab); }
  function setScope(scope: "all" | "episode") { setDocScope(scope); }
  function updateQuery(tab: "episode" | "memo", value: string) { setTreeQuery(old => ({ ...old, [tab]: value })); }
  function searchKey(event: React.KeyboardEvent) {
    if (event.key === "Escape" && treeQuery[treeTab]) {
      event.stopPropagation(); updateQuery(treeTab, "");
    } else if (event.key === "Enter" && treeQuery[treeTab].trim()) {
      const first = (treeTab === "memo" ? treeDocs : treeEpisodes)[0];
      if (first) attempt(() => openDoc(first.id, false))();
    }
  }
  function toggleDocGroup(kind: Kind) {
    setClosedDocGroups(old => {
      const next = new Set(old);
      if (next.has(kind)) next.delete(kind); else next.add(kind);
      return next;
    });
  }
  function setEpisodeGroup(start: number, open: boolean) {
    setOpenEpisodeGroups(old => { const next = new Set(old); if (open) next.add(start); else next.delete(start); return next; });
  }
  function enterTab(tab: "episode" | "memo") { if (tab === "episode" && dragFileDocs.current.length) setTreeTab("episode"); }
  function enterEpisodeGroup(start: number) {
    if ((dragFileDocs.current.length || dragEpisodes.current.length) && !openEpisodeGroups.has(start)) setEpisodeGroup(start, true);
  }
  function rowProps(doc: Doc, dropFolder?: string) {
    return {
      onMouseDown: (event: React.MouseEvent) => { if (event.shiftKey) event.preventDefault(); },
      onClick: (event: React.MouseEvent<HTMLElement>) => {
        if (event.shiftKey) return selectTreeRange(event.currentTarget, doc.id);
        if (event.ctrlKey || event.metaKey) return toggleTreeSelection(doc.id);
        selectionAnchor.current = doc.id;
        setTreeSelection([]);
        attempt(() => openDoc(doc.id, false))();
      },
      onDoubleClick: (event: React.MouseEvent) => {
        if (!event.shiftKey && !event.ctrlKey && !event.metaKey) attempt(() => openDoc(doc.id, true))();
      },
      onKeyDown: (event: React.KeyboardEvent) => treeKey(event, doc),
      onContextMenu: (event: React.MouseEvent) => {
        const docs = selectionFor(doc);
        if (docs.length > 1) return openMenu(event, selectionMenu(docs), ":selection");
        setTreeSelection([]);
        openMenu(event, latest.current.docMenu(doc), doc.id);
      },
      draggable: true,
      onDragStart: (event: React.DragEvent) => {
        const docs = selectionFor(doc);
        if (docs.length < 2) setTreeSelection([]);
        dragTreeDoc.current = doc.id;
        dragFileDocs.current = docs.filter(d => d.kind !== "episode").map(d => d.id);
        dragEpisodes.current = docs.filter(d => d.kind === "episode" && !d.archived).map(d => d.id);
        latest.current.onDragStart();
        event.dataTransfer.effectAllowed = "copyMove";
        event.dataTransfer.setData("application/x-lof-document", doc.id);
      },
      onDragEnd: () => {
        dragTreeDoc.current = ""; dragFileDocs.current = []; dragEpisodes.current = [];
        setTreeDrop(null); setEpisodeDrop(null);
        latest.current.onDragEnd();
      },
      ...(doc.kind === "episode" ? episodeDropProps(doc) : {}),
      ...(dropFolder !== undefined ? folderDropProps(dropFolder) : {}),
    };
  }
  const draggedDocument = useCallback(() => dragTreeDoc.current, []);
  const finishEditorDrop = useCallback(() => {
    dragTreeDoc.current = ""; dragFileDocs.current = []; dragEpisodes.current = []; setTreeDrop(null);
  }, []);
  return {
    docs, documents: lib.documents, archive, count, numberOf, currentId: active?.id, menuTarget: options.menuTarget,
    treeTab, treeQuery, docScope, treeEpisodeId, treeEpisodes, treeDocs,
    memoEntries, folderEntries, boundEpisode, boundDocuments, memoOpenFolders, folderRenaming, closedDocGroups, openEpisodeGroups,
    treeDrop, episodeDrop, treeSelection, renaming,
    setTab, setScope, updateQuery, searchKey, clearSelection,
    enterTab, enterEpisodeGroup, setEpisodeGroup, toggleDocGroup, toggleFolder,
    startRename, changeRename, cancelRename, commitRename,
    startFolderRename, cancelFolderRename, folderMenu, folderDragProps,
    docCreateMenu, memoCreateMenu, plotItems, addDocFile, loadMemoFolders, addMemoFolder, renameMemoFolder, removeMemoFolder,
    rowProps, folderDropProps, draggedDocument, finishEditorDrop,
    openDoc, openMenu, attempt, archiveDoc,
  };
}

export type FileTreeController = ReturnType<typeof useFileTree>;
