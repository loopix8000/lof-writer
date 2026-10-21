import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Columns2,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  StickyNote,
  BookOpen,
  Trash2,
  X,
} from "lucide-react";
import Writer from "./Writer";
import EditorScroll, { type EditorScrollPositions } from "./EditorScroll";
import RetainedTab from "./RetainedTab";
import { groupIds, groupShortcutIndex, isGroupId, legacyPairedGroup, type GroupId, type SplitDirection } from "./split/layout";
import { groupAttributes, tabAttributes, tabBarAttributes, type SplitDrag, type SplitGroups } from "./split/controller";
import { useSplitGroups } from "./split/useSplitGroups";
import SplitArea from "./split/SplitArea";
import { splitMenuItems } from "./split/menu";
import { copyWorkspaceScroll, readWorkspaceState, saveWorkspaceState, workspaceKey } from "./workspace-state";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import { useConfirm } from "./ConfirmDialog";
import { readFileForClose, useSyncFileUpdates } from "./useSyncFileUpdates";
import { useGitActivity } from "./useGitActivity";
import { call, type AutoSyncStatus, type Doc, type Kind } from "./types";
import SyncStatus from "./SyncStatus";
import { normalizeEditorStyle, resolveKindPrefs } from "../core/typesetting.mjs";
import ResizableSidebar from "./ResizableSidebar";

type Space = { id: string; title: string; root: string };
// 작품 스페이스(doc/)의 파일에는 문서 타입(플롯/메모)과 연결된 회차가 붙어 온다.
type Entry = {
  path: string;
  name: string;
  type: "file" | "folder";
  updatedAt?: string;
  kind?: "plot" | "memo";
  episodeId?: string;
};
type Memo = {
  id?: string;
  space: string;
  path: string;
  title: string;
  body: string;
  revision: string;
  updatedAt: string;
  manualLineBreak?: boolean;
};
// 메모 탭. 다른 스페이스의 메모도 탭으로 계속 열어 둘 수 있다.
// 이전 세션에는 pinned가 없으므로 false인 탭만 미리보기로 취급한다.
type MemoTab = { space: string; path: string; pinned?: boolean };
const COMMON = "common";
const sameTab = (a: MemoTab, b: { space: string; path: string } | null) =>
  !!b && a.space === b.space && a.path === b.path;
function placeMemoTab(list: MemoTab[], tab: MemoTab, pinned: boolean, after: { space: string; path: string } | null) {
  const index = list.findIndex((t) => sameTab(t, tab));
  if (index >= 0)
    return pinned && list[index].pinned === false
      ? list.map((t, i) => i === index ? { ...t, pinned: true } : t)
      : list;
  const nextTab = { ...tab, pinned };
  const previewIndex = pinned ? -1 : list.findIndex((t) => t.pinned === false);
  if (previewIndex >= 0)
    return list.map((t, i) => i === previewIndex ? nextTab : t);
  const at = list.findIndex((t) => sameTab(t, after));
  const next = [...list];
  next.splice(at < 0 ? next.length : at + 1, 0, nextTab);
  return next;
}
// 분할 그룹에서 탭을 구별하는 키. 다른 스페이스의 같은 경로는 다른 탭이다.
const tabKey = (t: { space: string; path: string }) => `${t.space}\n${t.path}`;
type Side = GroupId;
// 메모 화면에서 여는 작품의 에피소드·플롯. 탭 경로를 '@doc:문서 ID'로 둔다.
const DOC = "@doc:";
const isDocPath = (p: string) => p.startsWith(DOC);
// 메모(경로)와 에피소드·플롯(문서 ID)을 같은 모양으로 읽는다.
async function readItem(space: string, path: string): Promise<Memo> {
  if (!isDocPath(path)) return call<Memo>("memoRead", { space, path });
  const d = await call<Doc>("readDocument", { id: path.slice(DOC.length) });
  return {
    space,
    path,
    title: d.title,
    body: d.body,
    revision: d.revision,
    updatedAt: d.updatedAt,
    manualLineBreak: d.manualLineBreak,
  };
}
type Filter = "memo" | "plot" | "episode";
const FILTERS: [Filter, string][] = [
  ["memo", "메모"],
  ["plot", "플롯"],
  ["episode", "에피소드"],
];
const tabName = (path: string) => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
const parentOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")));
// from을 to로 옮겼을 때 p의 새 경로. 영향이 없으면 null.
const movedPath = (p: string, from: string, to: string) =>
  p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : null;
const ancestors = (p: string) => {
  const out: string[] = [];
  for (let f = parentOf(p); f; f = parentOf(f)) out.push(f);
  return out;
};

// 메모 세션: 공용 메모(기본)와 각 작품의 memo/ 폴더를 스페이스로 바꿔 가며 관리한다.
// 왼쪽은 폴더 트리(만들기·이름 바꾸기·끌어서 옮기기·삭제), 오른쪽은 메모 편집기다.
export default function MemoSession({
  active,
  workspaceRoot,
  syncStatus,
  syncChecking,
  syncAvailable,
  saved,
  apiRef,
  documents,
  onOpenDoc,
  prefs,
  onSidebarResize,
  flushRef,
  manualSaveRef,
  report,
  onOpenLink,
}: {
  // 서재의 문서 목록(작품 스페이스에서 플롯·에피소드를 보여 줄 때 쓴다)과, 문서를 집필 창에서 여는 함수.
  documents: Doc[];
  onOpenDoc: (id: string) => void;
  // 바깥(빠른 열기)에서 메모를 열 때 쓰는 함수를 담아 준다.
  apiRef?: React.MutableRefObject<{ open: (space: string, path: string, pinned?: boolean) => Promise<void> } | null>;
  // 메모 화면이 보이는지. 숨겨져 있어도 탭과 편집 상태는 그대로 둔다.
  active: boolean;
  workspaceRoot: string;
  syncStatus: AutoSyncStatus;
  syncChecking: boolean;
  syncAvailable: boolean;
  // 지난번에 앱을 닫을 때의 메모 화면 상태. 서재를 읽기 전에는 undefined, 없으면 null.
  saved: any;
  prefs: Record<string, any>;
  onSidebarResize: (width: number) => void;
  flushRef: React.MutableRefObject<((options?: { closing?: boolean }) => Promise<void>) | null>;
  manualSaveRef: React.MutableRefObject<(() => Promise<void>) | null>;
  report: (e: any) => void;
  // 메모의 문서 링크(퀵 노트 출처)를 누르면 집필 창에서 그 문서를 열고 인용한 문장으로 간다.
  onOpenLink: (href: string, quote: string) => void;
}) {
  const [spaces, setSpaces] = useState<Space[]>([]),
    [space, setSpace] = useState(COMMON),
    [entries, setEntries] = useState<Entry[]>([]),
    [expanded, setExpanded] = useState<Set<string>>(new Set()),
    [memo, setMemo] = useState<Memo | null>(null),
    [title, setTitle] = useState(""),
    [selected, setSelected] = useState(""),
    // Shift·Ctrl+클릭으로 고른 메모·폴더 경로(트리에 보이는 순서). 비어 있으면 한 줄씩 다룬다.
    [picked, setPicked] = useState<string[]>([]),
    [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null),
    [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[]; target: string } | null>(
      null,
    ),
    [status, setStatus] = useState("저장됨"),
    [conflict, setConflict] = useState(false),
    [dropTarget, setDropTarget] = useState<string | null>(null),
    [dragTab, setDragTab] = useState<MemoTab | null>(null),
    // 작품 스페이스에서 트리에 보일 것. 기본은 메모만.
    [filter, setFilter] = useState<Set<Filter>>(new Set<Filter>(["memo"])),
    // 플롯·에피소드 트리에서 접어 둔 폴더('plot:003 회차명' 꼴).
    [docCollapsed, setDocCollapsed] = useState<Set<string>>(new Set()),
    [, renderMemos] = useState(0),
    [sideRev, setSideRev] = useState(0);
  const scrollPositions = useRef<EditorScrollPositions>(new Map());
  const dragSide = useRef<Side>(groupIds[0]);
  const titleRef = useRef(title); titleRef.current = title;
  const checkMemoRef = useRef<(() => Promise<void>) | null>(null);
  const retainedMemos = useRef(new Map<string, Memo>());
  const setSideMemo = useCallback((m: Memo | null) => {
    if (m) retainedMemos.current.set(`${m.space}\n${m.path}`, m);
    renderMemos(value => value + 1);
  }, []);
  const memoRef = useRef<Memo | null>(null),
    spaceRef = useRef(space),
    dirty = useRef({ seq: 0, saved: 0 }),
    conflictRef = useRef(false),
    timer = useRef<number | undefined>(undefined),
    chain = useRef<Promise<void>>(Promise.resolve()),
    openSeq = useRef(0),
    // 트리에서 끌고 있는 경로. 여러 줄을 골랐으면 고른 것을 함께 끈다.
    dragging = useRef<string[]>([]),
    // Shift+클릭 범위 선택의 기준 줄(마지막으로 그냥 누르거나 Ctrl+클릭한 줄).
    pickAnchor = useRef(""),
    dragTreeMemo = useRef<MemoTab | null>(null);
  spaceRef.current = space;
  conflictRef.current = conflict;
  const [confirm, confirmDialog] = useConfirm();
  const setCurrent = (m: Memo | null) => {
    if (m) retainedMemos.current.set(`${m.space}\n${m.path}`, m);
    memoRef.current = m;
    setMemo(m);
  };
  // 분할 그룹(집필 창과 같은 공통 규칙). 포커스된 그룹의 현재 탭은 memo가 정한다.
  const area = useSplitGroups<MemoTab>({
    key: tabKey,
    currentKey: () => memoRef.current ? tabKey(memoRef.current) : "",
    place: (list, tab, pinned, after) => placeMemoTab(list, tab, pinned, list.find((t) => tabKey(t) === after) ?? null),
    // 지금 메모는 다른 그룹에서 계속 보이도록 붙잡아 두고, 읽기가 끝난 뒤 한 번에 바꾼다.
    activate: async (tab, _pinned, commit) => {
      const seq = ++openSeq.current;
      await flush();
      if (seq !== openSeq.current) return;
      const opening = await readForOpening(tab.space, tab.path);
      if (seq !== openSeq.current) return;
      setSideMemo(memoRef.current);
      if (commit()) selectGroupMemo(opening.doc, opening.stale);
    },
    closeLast: async (commit) => { if (commit()) closeCurrent(); },
    flush: () => flush({ closing: true }),
    copyScroll: (from, to, tabs) => {
      for (const space of new Set(tabs.map(tab => tab.space)))
        copyWorkspaceScroll(workspaceKey(workspaceRoot, `memo:${space}`), from, to, tabs.filter(tab => tab.space === space).map(tab => tab.path));
    },
  });
  const { tabs, groups, focused: focusedSide, split, order: sides } = area;
  const focusedTabs = () => area.tabsOf(area.state().focused);
  useEffect(() => {
    const open = new Set(Object.values(groups).flatMap(group => group?.tabs ?? []).map(tabKey));
    for (const key of retainedMemos.current.keys())
      if (!open.has(key)) retainedMemos.current.delete(key);
  }, [groups]);
  const currentTab = () => focusedTabs().find((t) => sameTab(t, memoRef.current)) ?? null;
  function keepTab(t: MemoTab) {
    area.updateTabs((list) => placeMemoTab(list, t, true, null));
  }
  const attempt =
    (fn: (...args: any[]) => Promise<any> | any) =>
    (...args: any[]) => {
      Promise.resolve()
        .then(() => fn(...args))
        .catch(report);
    };

  // 저장은 하나씩 순서대로 한다.
  const save = useCallback((auto = false, closing = false) => {
    const run = async () => {
      const m = memoRef.current;
      if (!m) return;
      const loadExternalOnClose = async (onlyIfChanged = false) => {
        const seq = dirty.current.seq;
        const fresh = await readFileForClose(() => readItem(m.space, m.path));
        if (memoRef.current !== m || dirty.current.seq !== seq)
          throw Error("닫는 동안 메모가 변경되었습니다. 다시 닫아 주세요.");
        if (onlyIfChanged && !conflictRef.current && fresh.revision === m.revision) return false;
        dirty.current = { seq: 0, saved: 0 };
        conflictRef.current = false;
        setConflict(false);
        setStatus("저장됨");
        titleRef.current = fresh.title;
        setTitle(fresh.title);
        setCurrent(fresh);
        return true;
      };
      if (closing && await loadExternalOnClose(true)) return;
      if (dirty.current.seq === dirty.current.saved) return;
      if (auto && conflictRef.current) return;
      const seq = dirty.current.seq;
      setStatus("저장 중");
      try {
        const saved = isDocPath(m.path)
          ? await call<Memo>("saveDocument", {
              id: m.path.slice(DOC.length),
              body: m.body,
              expectedRevision: m.revision, forceHistory: !auto,
            })
          : await call<Memo>("memoSave", {
              space: m.space,
              path: m.path,
              body: m.body,
              expectedRevision: m.revision, forceHistory: !auto,
            });
        dirty.current.saved = seq;
        const now = memoRef.current;
        if (now && now.space === m.space && now.path === m.path)
          setCurrent({ ...now, revision: saved.revision, updatedAt: saved.updatedAt });
        setStatus(dirty.current.seq === dirty.current.saved ? "저장됨" : "저장 대기");
        if (!auto) void call("requestSyncNow").catch(() => {});
      } catch (e: any) {
        if (closing && e.code === "CONFLICT") { await loadExternalOnClose(); return; }
        if (e.code === "CONFLICT") {
          conflictRef.current = true;
          setConflict(true);
        }
        setStatus("저장 안 됨");
        throw e;
      }
    };
    const task = chain.current.then(run);
    chain.current = task.catch(() => {});
    return task;
  }, []);
  const flush = useCallback(async ({ closing = false } = {}) => {
    clearTimeout(timer.current);
    if (!closing && conflictRef.current && dirty.current.seq !== dirty.current.saved)
      throw Error("메모 변경 충돌을 해결해 주세요.");
    await save(false, closing);
  }, [save]);
  const gitActivity = useGitActivity(async () => true, report);
  useEffect(() => {
    flushRef.current = async (options) => {
      await flush(options);
      if (options?.closing) {
        retainedMemos.current.clear();
        if (memoRef.current) setCurrent(memoRef.current);
        setSideMemo(null);
      }
    };
    return () => {
      flushRef.current = null;
    };
  }, [flush, flushRef]);
  useEffect(() => {
    manualSaveRef.current = async () => {
      await flush();
      const memo = memoRef.current;
      if (!memo || memo.space === COMMON) return;
      const document = isDocPath(memo.path) ? memo.path.slice(DOC.length)
        : (await readItem(memo.space, memo.path)).id;
      if (document) await call("checkpointDocument", { id: document, force: true });
    };
    return () => { manualSaveRef.current = null; };
  }, [flush, manualSaveRef]);
  function schedule() {
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => save(true).catch(report), 700);
  }
  function edit(body: string) {
    const m = memoRef.current;
    if (!m || body === m.body) return;
    if (m.space !== COMMON) gitActivity();
    keepTab(m);
    setCurrent({ ...m, body });
    dirty.current.seq++;
    setStatus("저장 대기");
    schedule();
  }

  const loadTree = useCallback(async (id = spaceRef.current) => {
    const r = await call<{ entries: Entry[] }>("memoTree", { space: id });
    if (id === spaceRef.current) setEntries(r.entries);
  }, []);
  const loadSpaces = useCallback(async () => {
    const list = await call<Space[]>("memoSpaces");
    setSpaces(list);
    if (!list.some((s) => s.id === spaceRef.current)) setSpace(COMMON);
    const alive = (t: { space: string }) => list.some((s) => s.id === t.space);
    area.mapTabs((t) => (alive(t) ? t : null));
    if (memoRef.current && !alive(memoRef.current)) setCurrent(null);
  }, []);
  const checkOpenMemo = useSyncFileUpdates({
    fileKey: memo ? `${memo.space}\n${memo.path}` : "",
    enabled: !!memo,
    canCheck: () => active,
    current: () => {
      const m = memoRef.current;
      return m ? { doc: m, version: `${dirty.current.seq}:${m.revision}:${titleRef.current}` } : null;
    },
    beforeRead: () => chain.current,
    read: (m: Memo) => readItem(m.space, m.path),
    pending: () => {
      clearTimeout(timer.current);
      conflictRef.current = true;
      setConflict(true);
      if (dirty.current.seq === dirty.current.saved) dirty.current.seq++;
      setStatus("외부 변경 있음");
    },
    apply: (fresh) => {
      dirty.current = { seq: 0, saved: 0 };
      conflictRef.current = false;
      setConflict(false);
      setStatus("저장됨");
      setTitle(fresh.title);
      setCurrent(fresh);
    },
    report,
  });
  checkMemoRef.current = checkOpenMemo;
  // 바깥에서 파일이 바뀌면 트리는 다시 읽되, 열린 본문은 사용자 확인 후에만 반영한다.
  const reloadOpen = useCallback(async () => {
    const m = memoRef.current;
    if (!m) return;
    try {
      await checkMemoRef.current?.();
    } catch (e: any) {
      if (!["NOT_FOUND", "ENOENT"].includes(e.code)) throw e;
      area.mapTabs((t) => (sameTab(t, m) ? null : t));
      if (memoRef.current?.path === m.path && memoRef.current.space === m.space) setCurrent(null);
    }
  }, []);
  useEffect(() => {
    loadSpaces().catch(report);
    const off = window.lof.onChange(() => {
      chain.current
        .then(() => {
          setSideRev((n) => n + 1);
          return Promise.all([loadSpaces(), loadTree(), reloadOpen()]);
        })
        .catch(report);
    });
    return off;
  }, [loadSpaces, loadTree, reloadOpen, report]);
  useEffect(() => {
    loadTree(space).catch(report);
  }, [space, loadTree, report]);
  useEffect(() => setTitle(memo?.title ?? ""), [memo?.path, memo?.title]);

  // 한 번 클릭하면 미리보기를 재사용하고, 두 번 클릭하거나 편집하면 고정한다.
  async function readForOpening(space: string, path: string) {
    const fresh = await readItem(space, path);
    const retained = retainedMemos.current.get(`${space}\n${path}`);
    const stale = !!retained && retained.revision !== fresh.revision;
    return { doc: stale ? retained! : fresh, stale };
  }
  async function openMemo(path: string, spaceId = spaceRef.current, pinned = false) {
    const seq = ++openSeq.current;
    const prev = memoRef.current;
    if (prev && prev.path === path && prev.space === spaceId) {
      if (pinned) keepTab(prev);
      return;
    }
    await flush();
    if (seq !== openSeq.current) return;
    const opening = await readForOpening(spaceId, path), m = opening.doc;
    if (seq !== openSeq.current) return;
    dirty.current = { seq: opening.stale ? 1 : 0, saved: 0 };
    conflictRef.current = opening.stale;
    setConflict(opening.stale);
    setStatus(opening.stale ? "외부 변경 있음" : "저장됨");
    setCurrent(m);
    area.updateTabs((list) => placeMemoTab(list, { space: spaceId, path }, pinned, prev));
    if (spaceId === spaceRef.current) {
      setSelected(path);
      setExpanded((old) => new Set([...old, ...ancestors(path)]));
    }
  }
  // 다른 스페이스의 탭을 고르면 트리도 그 스페이스로 바꾼다.
  async function activateTab(t: MemoTab, pinned = false) {
    if (t.space !== spaceRef.current) {
      spaceRef.current = t.space;
      setSelected("");
      setExpanded(new Set());
      setEntries([]);
      setSpace(t.space);
    }
    await openMemo(t.path, t.space, pinned);
  }
  function closeCurrent() {
    ++openSeq.current;
    clearTimeout(timer.current);
    dirty.current = { seq: 0, saved: 0 };
    conflictRef.current = false;
    setConflict(false);
    setStatus("저장됨");
    setCurrent(null);
  }
  // ---- 분할 보기 (집필 창과 같은 공통 규칙) ----
  const { focusOther, focusGroup: focusSide, focusGroupAt, focusDirection, openInGroup, closeGroup, closeOtherGroup, moveToOther, moveToDirection: areaMoveToDirection, shiftTab, canSplit } = area;
  const closeTabs = (keep: (t: MemoTab, i: number) => boolean, focusTab?: MemoTab) => area.closeTabs(keep, focusTab ? tabKey(focusTab) : undefined);
  const closeTab = (t: MemoTab) => area.closeTab(tabKey(t));
  const closeSideTab = (t: MemoTab, side?: Side) => area.closeOtherTab(tabKey(t), side);
  const closeSideTabs = (keep: (t: MemoTab, i: number) => boolean, side: Side, focusTab?: MemoTab) =>
    area.closeOtherTabs(keep, side, focusTab ? tabKey(focusTab) : undefined);
  const pinSideTab = (t: MemoTab, side: Side) => area.pinOtherTab(tabKey(t), side);
  const cycleTab = area.cycleTab;
  async function splitTo(t: MemoTab | null = currentTab(), direction?: SplitDirection, fromSide?: Side) {
    if (t) await area.splitTo(t, direction, fromSide);
  }
  async function moveToDirection(step: 1 | -1) {
    const cur = currentTab();
    if (cur) await areaMoveToDirection(cur, step);
  }
  async function openMemoBeside(t: MemoTab) {
    if (!memoRef.current) {
      await activateTab(t, true);
      return;
    }
    await flush();
    const opening = await readForOpening(t.space, t.path);
    setSideMemo(opening.doc);
    area.openBeside({ ...t, pinned: true }, true);
  }
  function selectGroupMemo(next: Memo | null, stale = false) {
    dirty.current = { seq: stale ? 1 : 0, saved: 0 };
    conflictRef.current = stale;
    setConflict(stale);
    setStatus(stale ? "외부 변경 있음" : "저장됨");
    setCurrent(next);
    setTitle(next?.title ?? "");
    if (!next) return;
    if (next.space !== spaceRef.current) {
      spaceRef.current = next.space;
      setEntries([]); setSpace(next.space); setExpanded(new Set(ancestors(next.path)));
    } else setExpanded(old => new Set([...old, ...ancestors(next.path)]));
    setSelected(next.path);
  }
  const [sideSyncKeys, setSideSyncKeys] = useState<Partial<Record<Side, string>>>({});
  // 포커스되지 않은 그룹에 보이는 메모의 외부 변경을 따로 확인한다. 포커스된 그룹은 memo가 맡는다.
  function useSideMemo(side: Side) {
    const group = side === focusedSide ? undefined : groups[side];
    const tab = group?.tabs.find((t) => tabKey(t) === group.current), key = tab ? tabKey(tab) : "";
    const shown = retainedMemos.current.get(key);
    const check = useSyncFileUpdates({
      fileKey: key, enabled: !!shown && !sameTab(shown, memo),
      canCheck: () => active,
      current: () => { const doc = retainedMemos.current.get(key); return doc ? { doc, version: doc.revision } : null; },
      read: (m: Memo) => readItem(m.space, m.path),
      pending: () => setSideSyncKeys(keys => ({ ...keys, [side]: `${key}\n${shown?.revision}` })),
      apply: fresh => { setSideMemo(fresh); setSideSyncKeys(keys => ({ ...keys, [side]: undefined })); },
      report,
    });
    useEffect(() => {
      if (!tab) return;
      if (retainedMemos.current.has(key)) { void check().catch(report); return; }
      let canceled = false;
      readItem(tab.space, tab.path).then(m => { if (!canceled) setSideMemo(m); }).catch(report);
      return () => { canceled = true; };
    }, [key, sideRev, !!shown, check]);
    return check;
  }
  // 그룹 ID 목록은 고정이므로 매 렌더 같은 순서로 훅을 부른다.
  const sideChecks = Object.fromEntries(groupIds.map(side => [side, useSideMemo(side)])) as Record<Side, ReturnType<typeof useSideMemo>>;
  // 앱을 다시 열면 지난번 스페이스·탭·보던 메모·분할을 되살린다. 없어진 메모의 탭은 뺀다.
  const restoreStarted = useRef(false);
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (saved === undefined || restoreStarted.current) return;
    restoreStarted.current = true;
    (async () => {
      const seq = openSeq.current, originalSpace = spaceRef.current;
      const session = readWorkspaceState(workspaceKey(workspaceRoot, "memo-layout")).layout as any ?? saved;
      if (!session) return;
      const isTab = (t: any): t is MemoTab =>
        t && typeof t.space === "string" && typeof t.path === "string";
      const live = async (list: unknown) => {
        const out: MemoTab[] = [];
        for (const t of Array.isArray(list) ? list.filter(isTab) : []) {
          if (out.some(tab => sameTab(tab, t))) continue;
          const exists = await readItem(t.space, t.path).then(() => true, error => {
            if (["NOT_FOUND", "ENOENT"].includes(error.code)) return false;
            throw error;
          });
          if (exists) out.push({ space: t.space, path: t.path, pinned: t.pinned !== false });
        }
        return out;
      };
      let mine = await live(session.tabs);
      const pick = (list: MemoTab[], t: any) => list.find((x) => sameTab(x, t)) ?? list[0] ?? null;
      let side: Side = isGroupId(session.focusedSide) ? session.focusedSide : groupIds[0];
      const restoredGroups: SplitGroups<MemoTab> = {};
      const previousGroups = session.groups ?? (session.split ? { [legacyPairedGroup(side)]: session.split } : {});
      for (const position of groupIds) {
        if (position === side) continue;
        const group = previousGroups[position], tabs = await live(group?.tabs);
        if (tabs.length) restoredGroups[position] = { tabs, current: tabKey(pick(tabs, group?.current)!) };
      }
      if (seq !== openSeq.current || originalSpace !== spaceRef.current) return;
      let current: MemoTab | null = pick(mine, session.current);
      // 마지막으로 보던 그룹이 사라졌다면 빈 창 대신 남아 있는 그룹을 활성화한다.
      const fallback = mine.length ? undefined : groupIds.find(position => restoredGroups[position]);
      if (fallback) {
        const group = restoredGroups[fallback]!;
        side = fallback; mine = group.tabs; current = pick(mine, mine.find((t) => tabKey(t) === group.current));
      }
      if (typeof session.space === "string") { spaceRef.current = session.space; setSpace(session.space); }
      if (Array.isArray(session.filter)) {
        const f = session.filter.filter((x: any) => FILTERS.some(([k]) => k === x));
        if (f.length) setFilter(new Set(f));
      }
      if (mine.length) restoredGroups[side] = { tabs: mine, current: tabKey(current ?? mine[0]) };
      area.reset(restoredGroups, side, session.tree, session.splitRatio, session.rowRatio);
      if (current) await activateTab(current);
    })()
      .then(() => {
        setRestored(true);
      })
      .catch(report);
  }, [saved]);
  useEffect(() => {
    if (!restored) return;
    // 저장 형식은 예전 버전과 같게 포커스된 그룹을 tabs·current로, 나머지를 groups로 둔다.
    const others = Object.fromEntries(Object.entries(groups).filter(([side]) => side !== focusedSide).map(([side, group]) =>
      [side, { tabs: group!.tabs, current: group!.tabs.find((t) => tabKey(t) === group!.current) ?? null }]));
    saveWorkspaceState(workspaceKey(workspaceRoot, "memo-layout"), {
        layout: {
          space,
          tabs,
          current: memo ? { space: memo.space, path: memo.path } : null,
          groups: others,
          focusedSide,
          tree: area.layout,
          filter: [...filter],
        },
      });
  }, [restored, workspaceRoot, space, tabs, memo?.space, memo?.path, groups, focusedSide, area.layout, filter]);
  // 파일 트리와 탭은 같은 놓기 영역을 사용하되, 트리의 파일은 옮기지 않고 연다.
  function draggedToGroups(): SplitDrag<MemoTab> | null {
    if (dragTreeMemo.current) return { tab: dragTreeMemo.current, fromTree: true, source: area.state().focused };
    return dragTab ? { tab: dragTab, fromTree: false, source: dragSide.current } : null;
  }
  function droppedOnGroups(run: () => Promise<unknown>) {
    dragTreeMemo.current = null;
    dragging.current = [];
    setDropTarget(null);
    setDragTab(null);
    attempt(run)();
  }
  // 집필 창과 같은 탭·분할 단축키.
  const chordAt = useRef(0);
  const keys = useRef({ closeTab, cycleTab, shiftTab, splitTo, focusGroupAt, focusDirection, moveToDirection });
  keys.current = { closeTab, cycleTab, shiftTab, splitTo, focusGroupAt, focusDirection, moveToDirection };
  if (apiRef) apiRef.current = { open: (space, path, pinned) => activateTab({ space, path }, pinned) };
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (document.documentElement.dataset.pinLocked === "true") return;
      if (!activeRef.current || ["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      const chord = chordAt.current && Date.now() - chordAt.current < 1500;
      chordAt.current = 0;
      if (chord) {
        if (e.code === "Backslash" && !e.shiftKey && !e.altKey) {
          e.preventDefault(); e.stopPropagation(); keys.current.splitTo(undefined, "down").catch(report); return;
        }
        const dirMap: Record<string, SplitDirection> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
        if (dirMap[e.key] && !e.shiftKey && !e.altKey) {
          e.preventDefault(); e.stopPropagation(); keys.current.focusDirection(dirMap[e.key]).catch(report); return;
        }
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      const current = currentTab();
      let run: (() => Promise<unknown> | void) | null = null;
      if (e.code === "KeyK" && !e.shiftKey && !e.altKey) {
        chordAt.current = Date.now();
        e.preventDefault(); e.stopPropagation(); return;
      } else if (e.altKey && !e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight"))
        run = () => keys.current.moveToDirection(e.key === "ArrowRight" ? 1 : -1);
      else if (e.altKey) return;
      else if (e.code === "KeyW" && !e.shiftKey) run = current ? () => keys.current.closeTab(current) : null;
      else if (e.shiftKey && (e.key === "PageDown" || e.key === "PageUp"))
        run = () => keys.current.shiftTab(e.key === "PageDown" ? 1 : -1);
      else if ((e.key === "PageDown" && !e.shiftKey) || (e.key === "Tab" && !e.shiftKey)) run = () => keys.current.cycleTab(1);
      else if ((e.key === "PageUp" && !e.shiftKey) || (e.key === "Tab" && e.shiftKey)) run = () => keys.current.cycleTab(-1);
      else if (e.code === "Backslash" && !e.shiftKey) run = () => keys.current.splitTo();
      else if (groupShortcutIndex(e.code) >= 0 && !e.shiftKey)
        run = () => keys.current.focusGroupAt(groupShortcutIndex(e.code));
      else return;
      e.preventDefault();
      e.stopPropagation();
      Promise.resolve(run?.()).catch(report);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [report]);
  async function switchSpace(id: string) {
    if (id === space) return;
    setSelected("");
    setPicked([]);
    setExpanded(new Set());
    setEntries([]);
    setSpace(id);
  }
  // 새 메모·폴더를 만들 위치: 마지막으로 고른 폴더, 또는 고른 메모가 있는 폴더.
  function targetFolder() {
    const e = entries.find((x) => x.path === selected);
    return !e ? "" : e.type === "folder" ? e.path : parentOf(e.path);
  }
  async function newMemo(folder = targetFolder()) {
    const m = await call<Memo>("memoCreate", { space, folder, title: "새 메모" });
    await loadTree();
    await openMemo(m.path, space, true);
    setRenaming({ path: m.path, value: m.title });
  }
  async function newFolder(parent = targetFolder()) {
    const r = await call<{ path: string }>("memoCreateFolder", { space, parent, name: "새 폴더" });
    setExpanded((old) => new Set([...old, ...(parent ? [parent, ...ancestors(parent)] : [])]));
    await loadTree();
    setSelected(r.path);
    setRenaming({ path: r.path, value: r.path.slice(r.path.lastIndexOf("/") + 1) });
  }
  // 이름을 바꾸거나 옮긴 뒤 열린 메모·선택·펼침 상태의 경로를 맞춘다.
  function remap(from: string, to: string) {
    const m = memoRef.current;
    const next = m && m.space === spaceRef.current && movedPath(m.path, from, to);
    if (m && next) setCurrent({ ...m, path: next, title: tabName(next) });
    area.mapTabs((t) => {
      const moved = t.space === spaceRef.current && movedPath(t.path, from, to);
      return moved ? { ...t, path: moved } : t;
    });
    setSelected((s) => movedPath(s, from, to) ?? s);
    setExpanded((old) => new Set([...old].map((p) => movedPath(p, from, to) ?? p)));
  }
  const touchesOpen = (path: string) => {
    const m = memoRef.current;
    return !!m && m.space === spaceRef.current && (m.path === path || m.path.startsWith(path + "/"));
  };
  async function rename(path: string, name: string) {
    const entry = entries.find((e) => e.path === path);
    if (!name.trim() || !entry || name.trim() === entry.name) return;
    if (touchesOpen(path)) await flush();
    const r = await call<{ path: string }>("memoRename", { space, path, name: name.trim() });
    remap(path, r.path);
    await loadTree();
  }
  async function commitRename() {
    const r = renaming;
    if (!r) return;
    setRenaming(null);
    await rename(r.path, r.value);
  }
  // 메모·폴더(paths)를 to 폴더로 옮긴다. 여러 개면 파일만 차례로 옮기고 트리는 다 옮긴 뒤 한 번만 다시 읽는다.
  async function move(paths: string[], to: string) {
    const valid = paths.filter((path) => path && path !== to && parentOf(path) !== to && !to.startsWith(path + "/"));
    if (!valid.length) return;
    if (valid.some(touchesOpen)) await flush();
    for (const path of valid) {
      const r = await call<{ path: string }>("memoMove", { space, path, to });
      remap(path, r.path);
    }
    if (to) setExpanded((old) => new Set([...old, to, ...ancestors(to)]));
    await loadTree();
  }
  // 고른 폴더 안에 든 항목은 폴더와 함께 다뤄지므로 빼고, 바깥쪽 항목만 남긴다.
  const outermost = <T extends { path: string }>(list: T[]) =>
    list.filter((x) => !list.some((y) => y !== x && x.path.startsWith(y.path + "/")));
  // 메모·폴더를 휴지통으로 옮긴다. 여러 개면 한 번만 묻고, 고른 폴더 안에 든 것은 폴더와 함께 지운다.
  async function remove(targets: Entry[]) {
    const top = outermost(targets);
    if (!top.length) return;
    const ok = await confirm({
      title: "삭제",
      message:
        top.length > 1
          ? `고른 항목 ${top.length}개를 휴지통으로 옮길까요?`
          : `'${top[0].name}' ${top[0].type === "folder" ? "폴더와 그 안의 메모를" : "메모를"} 휴지통으로 옮길까요?`,
      detail: top.length > 1 && top.some((x) => x.type === "folder") ? "폴더 안의 메모도 함께 옮겨집니다." : undefined,
      confirmLabel: "휴지통으로 옮기기",
      danger: true,
      icon: <Trash2 size={15} />,
    });
    if (!ok) return;
    for (const entry of top) {
      const gone = (t: MemoTab) =>
        t.space === space && (t.path === entry.path || t.path.startsWith(entry.path + "/"));
      if (touchesOpen(entry.path)) {
        clearTimeout(timer.current);
        await chain.current;
        closeCurrent();
      }
      await call("memoRemove", { space, path: entry.path });
      area.mapTabs((t) => (gone(t) ? null : t));
    }
    setSelected("");
    setPicked([]);
    await loadTree();
  }
  async function reloadFromDisk() {
    await checkOpenMemo(true);
  }
  async function keepMine() {
    const m = memoRef.current;
    if (!m) return;
    const fresh = await readItem(m.space, m.path);
    if (dirty.current.seq === dirty.current.saved) dirty.current.seq++;
    setCurrent({ ...memoRef.current!, revision: fresh.revision });
    setConflict(false);
    conflictRef.current = false;
    await save();
  }

  function openMenu(e: React.MouseEvent, items: MenuItem[], target: string) {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items, target });
  }
  function entryMenu(entry: Entry): MenuItem[] {
    const folder = entry.type === "folder";
    return [
      ...(folder
        ? ([
            { label: "새 메모", action: attempt(() => newMemo(entry.path)) },
            { label: "새 폴더", action: attempt(() => newFolder(entry.path)) },
            "separator",
          ] as MenuItem[])
        : ([
            { label: "열기", action: attempt(() => openMemo(entry.path)) },
            { label: "새 탭으로 열기", action: attempt(() => openMemo(entry.path, spaceRef.current, true)) },
            { label: "옆으로 열기", action: attempt(() => openMemoBeside({ space: spaceRef.current, path: entry.path })) },
            "separator",
          ] as MenuItem[])),
      {
        label: "이름 바꾸기",
        shortcut: "F2",
        action: () => setRenaming({ path: entry.path, value: entry.name }),
      },
      {
        label: "최상위로 옮기기",
        disabled: !parentOf(entry.path),
        action: attempt(() => move([entry.path], "")),
      },
      "separator",
      {
        label: "파일 탐색기에서 표시",
        action: attempt(() => call("memoReveal", { space, path: entry.path })),
      },
      "separator",
      { label: "삭제", shortcut: "Delete", danger: true, action: attempt(() => remove([entry])) },
    ];
  }
  // 트리 다중 선택. entry가 고른 줄 가운데 하나이고 둘 이상 골랐으면 고른 항목 전부, 아니면 entry 하나를 다룬다.
  function pickedFor(entry: Entry): Entry[] {
    if (picked.length < 2 || !picked.includes(entry.path)) return [entry];
    return picked.map((p) => entries.find((x) => x.path === p)).filter((x): x is Entry => !!x);
  }
  // 트리에 보이는 줄 순서(접힌 폴더 안은 빼고)로 기준 줄부터 누른 줄까지 고른다.
  function pickRange(row: HTMLElement, path: string) {
    const paths = [...(row.closest(".memo-tree")?.querySelectorAll<HTMLElement>("[data-path]") ?? [])].map(
      (el) => el.dataset.path!,
    );
    let from = paths.indexOf(pickAnchor.current || selected);
    const to = paths.indexOf(path);
    if (to < 0) return;
    if (from < 0) {
      from = to;
      pickAnchor.current = path;
    }
    setPicked(paths.slice(Math.min(from, to), Math.max(from, to) + 1));
  }
  function togglePick(path: string) {
    setPicked((old) => {
      const base = old.length ? old : pickAnchor.current ? [pickAnchor.current] : [];
      return base.includes(path) ? base.filter((x) => x !== path) : [...base, path];
    });
    pickAnchor.current = path;
  }
  // 여러 줄을 고르고 우클릭한 메뉴.
  function pickedMenu(list: Entry[]): MenuItem[] {
    return [
      { label: `항목 ${list.length}개 선택됨`, disabled: true, action: () => {} },
      "separator",
      {
        label: "최상위로 옮기기",
        disabled: list.every((x) => !parentOf(x.path)),
        action: attempt(async () => {
          setPicked([]);
          await move(outermost(list).map((x) => x.path), "");
        }),
      },
      "separator",
      { label: "삭제", shortcut: "Delete", danger: true, action: attempt(() => remove(list)) },
    ];
  }
  const rootMenu = (): MenuItem[] => [
    { label: "새 메모", action: attempt(() => newMemo("")) },
    { label: "새 폴더", action: attempt(() => newFolder("")) },
    "separator",
    { label: "파일 탐색기에서 열기", action: attempt(() => call("memoReveal", { space })) },
  ];

  const children = useMemo(() => {
    const map = new Map<string, Entry[]>();
    for (const e of entries) {
      const p = parentOf(e.path);
      if (!map.has(p)) map.set(p, []);
      map.get(p)!.push(e);
    }
    return map;
  }, [entries]);
  // 끈 항목 가운데 folder로 옮길 수 있는 것(이미 거기 있거나 자기 안으로 들어가는 것은 뺀다).
  const movable = (folder: string) =>
    outermost(dragging.current.map((path) => ({ path }))).filter(
      ({ path }) => path !== folder && !folder.startsWith(path + "/") && parentOf(path) !== folder,
    );
  function dragOver(e: React.DragEvent, folder: string) {
    if (!movable(folder).length) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setDropTarget(folder);
  }
  function drop(e: React.DragEvent, folder: string) {
    e.preventDefault();
    e.stopPropagation();
    const moving = movable(folder);
    dragging.current = [];
    setDropTarget(null);
    setPicked([]);
    attempt(() => move(moving.map(({ path }) => path), folder))();
  }
  const openHere = (path: string) => memo?.space === space && memo.path === path;
  function tabMenu(t: MemoTab, index: number): MenuItem[] {
    const root = spaces.find((x) => x.id === t.space)?.root;
    return [
      { label: "닫기", shortcut: "Ctrl+W", action: attempt(() => closeTab(t)) },
      { label: "다른 탭 닫기", disabled: tabs.length < 2, action: attempt(() => closeTabs((x) => sameTab(x, t), t)) },
      {
        label: "오른쪽 탭 닫기",
        disabled: index >= tabs.length - 1,
        action: attempt(() => closeTabs((_, i) => i <= index, t)),
      },
      { label: "모두 닫기", action: attempt(() => closeTabs(() => false)) },
      "separator",
      { label: "탭 고정", disabled: t.pinned !== false, action: () => keepTab(t) },
      "separator",
      ...splitMenuItems({
        focused: true, split, canSplit: (direction) => canSplit(focusedSide, direction),
        splitTo: (direction) => attempt(() => splitTo(t, direction))(),
        moveToOther: attempt(() => moveToOther(t)), closeGroup: attempt(closeGroup),
      }),
      "separator",
      {
        label: "파일 탐색기에서 표시",
        action: attempt(() =>
          isDocPath(t.path)
            ? call("reveal", { id: t.path.slice(DOC.length) })
            : call("memoReveal", { space: t.space, path: t.path }),
        ),
      },
      {
        label: "경로 복사",
        disabled: isDocPath(t.path) ? !docOf(t)?.path : !root,
        action: attempt(() =>
          navigator.clipboard.writeText(
            isDocPath(t.path)
              ? docOf(t)?.path || ""
              : `${root}\\${t.path.replace(/\//g, "\\")}`,
          ),
        ),
      },
      ...(isDocPath(t.path)
        ? ([
            "separator",
            { label: "집필 창에서 열기", action: () => onOpenDoc(t.path.slice(DOC.length)) },
          ] as MenuItem[])
        : []),
    ];
  }
  function sideTabMenu(t: MemoTab, side: Side, index: number): MenuItem[] {
    const sideTabs = groups[side]?.tabs ?? [];
    return [
      { label: "열기", action: attempt(() => focusOther(t, false, side)) },
      { label: "닫기", action: () => closeSideTab(t, side) },
      { label: "다른 탭 닫기", disabled: sideTabs.length < 2, action: () => closeSideTabs((x) => sameTab(x, t), side, t) },
      { label: "오른쪽 탭 닫기", disabled: index >= sideTabs.length - 1, action: () => closeSideTabs((_, i) => i <= index, side, t) },
      { label: "모두 닫기", action: () => closeOtherGroup(side) },
      "separator",
      { label: "탭 고정", disabled: t.pinned !== false, action: () => pinSideTab(t, side) },
      "separator",
      ...splitMenuItems({
        focused: false, split: true, canSplit: (direction) => canSplit(side, direction),
        splitTo: (direction) => attempt(() => splitTo(t, direction, side))(),
        moveToOther: attempt(() => openInGroup(t, focusedSide, true, side)), closeGroup: () => closeOtherGroup(side),
      }),
      "separator",
      {
        label: "파일 탐색기에서 표시",
        action: attempt(() =>
          isDocPath(t.path)
            ? call("reveal", { id: t.path.slice(DOC.length) })
            : call("memoReveal", { space: t.space, path: t.path }),
        ),
      },
    ];
  }
  const groupStyle = area.groupStyle;
  const nameOf = (t: { path: string }) =>
    isDocPath(t.path)
      ? documents.find((d) => d.id === t.path.slice(DOC.length))?.title || "제목 없음"
      : tabName(t.path);
  const docOf = (t: { path: string }) =>
    isDocPath(t.path) ? documents.find((d) => d.id === t.path.slice(DOC.length)) : undefined;
  const kindOf = (m: Memo): Kind => {
    const d = docOf(m);
    if (d) return d.kind;
    if (m.space !== COMMON) {
      const byRel = documents.find(
        (doc) => doc.projectId === m.space && doc.relPath === `doc/${m.path}`,
      );
      if (byRel) return byRel.kind;
    }
    return "memo";
  };
  const manuscriptBoxOf = (kind: Kind) => {
    const kindPrefs = resolveKindPrefs(prefs, kind);
    const norm = normalizeEditorStyle(kindPrefs);
    return {
      norm,
      kindPrefs,
      className: `manuscript${norm.pageViewEnabled ? " page-view-manuscript" : ""}${norm.textareaBgColor ? " has-sheet-bg" : ""}`,
      style: {
        maxWidth: norm.pageViewEnabled ? undefined : `${norm.editorMaxWidth}px`,
        paddingLeft: norm.pageViewEnabled ? undefined : `${norm.editorPaddingX * 0.25}rem`,
        paddingRight: norm.pageViewEnabled ? undefined : `${norm.editorPaddingX * 0.25}rem`,
        backgroundColor: norm.textareaBgColor || undefined,
        color: norm.editorTextColor || undefined,
        ["--editor-max-width" as any]: `${norm.editorMaxWidth}px`,
        ["--editor-padding-x" as any]: `${norm.editorPaddingX * 0.25}rem`,
        ["--textarea-bg-color" as any]: norm.textareaBgColor || "var(--surface)",
        ["--editor-text-color" as any]: norm.editorTextColor || "inherit",
      } as React.CSSProperties,
    };
  };
  const spaceName = (id: string) => spaces.find((x) => x.id === id)?.title ?? "공용 메모";
  const crumbs = (m: Memo) => {
    const d = docOf(m);
    return [
      spaceName(m.space),
      ...(d ? parentOf(d.relPath || "") : parentOf(m.path)).split("/").filter(Boolean),
    ].join(" / ");
  };
  // 두 그룹은 같은 요소를 사용해 포커스만 바뀔 때 본문을 다시 만들지 않는다.
  function memoBody(memo: Memo, focused: boolean, visible = true, side: Side = focusedSide) {
    const groupStatus = focused ? status : "저장됨";
    return (
      <div
        className="group-body"
        onMouseDownCapture={(e) => {
          if (!focused && e.button === 0 && !(e.target as Element).closest("[data-sync-actions]")) {
            e.stopPropagation();
            attempt(() => focusSide(side))();
          }
        }}
        onClickCapture={(e) => {
          if (!focused && !(e.target as Element).closest("[data-sync-actions]")) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
        onContextMenuCapture={(e) => {
          if (!focused) {
            e.preventDefault();
            e.stopPropagation();
            attempt(() => focusSide(side))();
          }
        }}
        onKeyDownCapture={(e) => {
          if (!focused && e.key !== "Tab" && !(e.target as Element).closest("[data-sync-actions]")) {
            e.preventDefault();
            e.stopPropagation();
            attempt(() => focusSide(side))();
          }
        }}
      >
        <div className="memo-head">
          <span className="memo-crumbs" title={memo.path}>
            {crumbs(memo)}
          </span>
          <div className="save-status-group">
            <span className={`memo-status ${groupStatus === "저장됨" ? "" : "pending"}`}>{groupStatus}</span>
            <SyncStatus status={syncStatus} checking={syncChecking} available={syncAvailable} editing={groupStatus !== "저장됨"} />
          </div>
        </div>
        {focused && conflict && (
          <div className="memo-conflict" role="alert">
            <span>다른 곳에서 이 메모가 바뀌었습니다. 선택하지 않고 닫으면 바뀐 내용을 사용합니다.</span>
            <div className="conflict-actions">
              <button onClick={attempt(reloadFromDisk)}>바뀐 내용 불러오기</button>
              <button onClick={attempt(keepMine)}>내 내용으로 덮어쓰기</button>
            </div>
          </div>
        )}
        {!focused && sideSyncKeys[side] === `${memo.space}\n${memo.path}\n${memo.revision}` && (
          <div className="memo-conflict" data-sync-actions>
            <span>다른 곳에서 이 메모가 바뀌었습니다. 현재 내용은 유지됩니다.</span>
            <div className="conflict-actions">
              <button onClick={attempt(() => sideChecks[side](true))}>바뀐 내용 불러오기</button>
            </div>
          </div>
        )}
        <EditorScroll key={`${memo.space}\n${memo.path}`} documentId={`${side}\n${memo.path}`} scope={workspaceKey(workspaceRoot, `memo:${memo.space}`)} positions={scrollPositions.current} visible={visible}>
          {(() => {
            const mainBox = manuscriptBoxOf(kindOf(memo));
            return (
              <article className={mainBox.className} style={mainBox.style}>
                <input
                  className="document-title"
                  aria-label="메모 제목"
                  spellCheck={false}
                  readOnly={!focused}
                  value={focused ? title : memo.title}
                  placeholder="제목"
                  onChange={(e) => {
                    keepTab(memo);
                    setTitle(e.target.value);
                  }}
                  onBlur={attempt(async () => {
                    if (!focused) return;
                    if (conflictRef.current) return;
                    if (!title.trim() || title.trim() === memo.title) return setTitle(memo.title);
                    if (!isDocPath(memo.path)) return rename(memo.path, title);
                    await flush();
                    await call("saveDocument", {
                      id: memo.path.slice(DOC.length),
                      title: title.trim(),
                      expectedRevision: memoRef.current!.revision,
                    });
                    if (memoRef.current?.path === memo.path)
                      setCurrent({ ...memoRef.current, title: title.trim() });
                  })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") {
                      setTitle(memo.title);
                      e.currentTarget.blur();
                    }
                  }}
                />
                <Writer
                  key="writer"
                  id={`memo-${memo.space}\n${memo.path}`}
                  inactive={!focused}
                  visible={visible}
                  revision={memo.revision}
                  body={memo.body}
                  tables={kindOf(memo) !== "episode"}
                  manualLineBreak={!!memo.manualLineBreak}
                  copyWithBlankLines={prefs.copyWithBlankLines === true}
                  onChange={(body) => { if (focused) edit(body); }}
                  fontSize={mainBox.norm.fontSize}
                  lineHeight={mainBox.norm.lineHeight}
                  source={false}
                  typingOptions={{
                    autoCloseQuotes: prefs.autoCloseQuotes,
                    autoCloseBrackets: prefs.autoCloseBrackets,
                    smartBrackets: prefs.smartBrackets,
                    autoSymbolReplacement: prefs.autoSymbolReplacement,
                    autoDividerReplacement: prefs.autoDividerReplacement,
                    quoteStyle: prefs.quoteStyle,
                    textReplacements: prefs.textReplacements,
                  }}
                  editorStyle={mainBox.kindPrefs}
                  links={kindOf(memo) !== "episode"}
                  onOpenLink={onOpenLink}
                />
              </article>
            );
          })()}
        </EditorScroll>
      </div>
    );
  }
  // 한 번 연 메모는 탭별로 유지하며, 실제 선택된 탭만 표시하고 편집한다.
  function memoTabs(list: MemoTab[], current: MemoTab | Memo | null, groupFocused: boolean, side: Side = focusedSide) {
    return list.map((tab) => {
      const key = `${tab.space}\n${tab.path}`;
      const shown = sameTab(tab, memo) ? memo
        : retainedMemos.current.get(key);
      if (!shown) return null;
      const visible = active && sameTab(tab, current);
      return <RetainedTab key={key} visible={visible}>
        {memoBody(shown, visible && groupFocused, visible, side)}
      </RetainedTab>;
    });
  }
  // 포커스되지 않은 그룹: 읽기 전용으로 보여 주고, 클릭하면 그 그룹으로 포커스를 옮긴다.
  function sideGroup(side: Side) {
    const group = groups[side];
    if (!group) return null;
    const cur = group.tabs.find((t) => tabKey(t) === group.current) ?? null;
    return (
      <section
        key={side}
        {...groupAttributes(side)}
        className="editor-group inactive"
        style={groupStyle(side)}
      >
        <div className="editor-tabs" {...tabBarAttributes} role="tablist" aria-label="다른 그룹의 열린 메모">
          {group.tabs.map((t, index) => {
            const current = !!cur && sameTab(t, cur),
              name = nameOf(t),
              key = `${t.space}\n${t.path}`;
            return (
              <div
                key={key}
                {...tabAttributes(key)}
                role="tab"
                tabIndex={-1}
                aria-selected={current}
                title={`${spaceName(t.space)} / ${t.path}${t.pinned === false ? " (미리보기)" : ""}`}
                className={`editor-tab ${current ? "current" : ""} ${t.pinned === false ? "preview" : ""} ${
                  menu?.target === "side:" + key ? "context-target" : ""
                }`}
                onClick={attempt(() => focusOther(t, false, side))}
                onDoubleClick={attempt(() => focusOther(t, true, side))}
                draggable
                onDragStart={(event) => { event.dataTransfer.effectAllowed = "copyMove"; dragSide.current = side; setDragTab(t); }}
                onDragEnd={() => { setDragTab(null); area.clearDropZone(); }}
                onMouseDown={(e) => {
                  if (e.button === 1) e.preventDefault();
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) closeSideTab(t, side);
                }}
                onContextMenu={(e) => openMenu(e, sideTabMenu(t, side, index), "side:" + key)}
              >
                <FileText size={14} />
                <span>{name}</span>
                {current && <i className="saved-dot" />}
                <button
                  aria-label={`다른 그룹의 ${name} 닫기`}
                  title="닫기 (Alt+클릭: 다른 탭 닫기)"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (e.altKey) closeSideTabs((x) => sameTab(x, t), side, t);
                    else closeSideTab(t, side);
                  }}
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
          {cur && (
            <div className="editor-tabs-actions">
              <button
                type="button"
                className="tab-split-button"
                aria-label="편집기 분할"
                title="오른쪽으로 분할 (Alt+클릭: 아래로 분할)"
                onClick={attempt((e) => splitTo(cur, e.altKey ? "down" : "right", side))}
              >
                <Columns2 size={14} />
              </button>
            </div>
          )}
        </div>
        {memoTabs(group.tabs, cur, false, side)}
      </section>
    );
  }
  // 작품의 플롯·에피소드를 실제 폴더 구조(plot/003 회차명/…, episodes/…) 그대로 보여 준다.
  // 누르면 메모 화면의 탭으로 열고, 우클릭으로 집필 창에서 열 수 있다.
  function docSection(kind: "plot" | "episode") {
    const list = documents
      .filter((d) => d.projectId === space && d.kind === kind && !d.archived)
      .sort((a, b) => (a.relPath || "").localeCompare(b.relPath || "", "ko", { numeric: true }));
    const inner = (d: Doc) => (d.relPath || "").split("/").slice(1);
    const folders = [...new Set(list.map((d) => inner(d).slice(0, -1).join("/")).filter(Boolean))];
    const item = (d: Doc, depth: number) => {
      const t = { space, path: DOC + d.id },
        memoLike = d.kind === "memo";
      return (
        <button
          key={d.id}
          className={`tree-item memo-row ${openHere(t.path) ? "current" : ""} ${
            menu?.target === "doc:" + d.id ? "context-target" : ""
          }`}
          style={{ paddingLeft: 8 + depth * 14 }}
          title={d.relPath}
          draggable
          onDragStart={(e) => {
            dragTreeMemo.current = t;
            dragging.current = [];
            setDragTab(null);
            e.dataTransfer.effectAllowed = "copyMove";
            e.dataTransfer.setData("application/x-lof-memo", JSON.stringify(t));
          }}
          onDragEnd={() => {
            dragTreeMemo.current = null;
            area.clearDropZone();
          }}
          onClick={attempt(() => activateTab(t))}
          onDoubleClick={attempt(() => activateTab(t, true))}
          onContextMenu={(e) =>
            openMenu(
              e,
              [
                { label: "열기", action: attempt(() => activateTab(t)) },
                { label: "옆으로 열기", action: attempt(() => openMemoBeside(t)) },
                "separator",
                { label: "집필 창에서 열기", action: () => onOpenDoc(d.id) },
              ],
              "doc:" + d.id,
            )
          }
        >
          {kind === "episode" ? (
            <BookOpen size={15} className="memo-file-icon" />
          ) : memoLike ? (
            <StickyNote size={15} className="memo-file-icon" />
          ) : (
            <FileText size={15} className="memo-file-icon" />
          )}
          <span>{d.title || "제목 없음"}</span>
        </button>
      );
    };
    return (
      <>
        <div className="memo-tree-heading">{kind === "plot" ? "플롯" : "에피소드"}</div>
        {list.filter((d) => inner(d).length === 1).map((d) => item(d, 0))}
        {folders.map((f) => {
          const key = kind + ":" + f,
            open = !docCollapsed.has(key);
          return (
            <Fragment key={key}>
              <button
                className="tree-item memo-row"
                title={f}
                onClick={() =>
                  setDocCollapsed((old) => {
                    const next = new Set(old);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  })
                }
              >
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {open ? <FolderOpen size={15} /> : <Folder size={15} />}
                <span>{f}</span>
              </button>
              {open &&
                list.filter((d) => inner(d).slice(0, -1).join("/") === f).map((d) => item(d, 1))}
            </Fragment>
          );
        })}
        {!list.length && (
          <div className="tree-empty">{kind === "plot" ? "플롯이 없습니다." : "에피소드가 없습니다."}</div>
        )}
      </>
    );
  }
  function row(entry: Entry, depth: number) {
    const folder = entry.type === "folder",
      open = expanded.has(entry.path),
      multi = picked.length > 1 && picked.includes(entry.path),
      style = { paddingLeft: 8 + depth * 14 };
    if (renaming?.path === entry.path)
      return (
        <div className="tree-item renaming memo-row" style={style}>
          {folder ? <Folder size={15} /> : <FileText size={15} />}
          <input
            className="tree-rename"
            autoFocus
            aria-label="새 이름"
            value={renaming.value}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setRenaming({ path: entry.path, value: e.target.value })}
            onBlur={attempt(commitRename)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setRenaming(null);
            }}
          />
        </div>
      );
    return (
      <button
        className={`tree-item memo-row ${openHere(entry.path) ? "current" : ""} ${
          selected === entry.path && !openHere(entry.path) && !multi ? "selected" : ""
        } ${multi ? "multi-selected" : ""} ${dropTarget === entry.path ? "drop-target" : ""} ${
          menu?.target === entry.path ? "context-target" : ""
        }`}
        style={style}
        title={entry.path}
        data-path={entry.path}
        aria-selected={multi || undefined}
        draggable
        onDragStart={(e) => {
          const list = pickedFor(entry);
          if (list.length < 2) setPicked([]);
          dragging.current = list.map((x) => x.path);
          dragTreeMemo.current = folder ? null : { space, path: entry.path };
          setDragTab(null);
          e.dataTransfer.effectAllowed = folder ? "move" : "copyMove";
          e.dataTransfer.setData("text/plain", entry.path);
        }}
        onDragEnd={() => {
          dragging.current = [];
          dragTreeMemo.current = null;
          setDropTarget(null);
          area.clearDropZone();
        }}
        onDragOver={folder ? (e) => dragOver(e, entry.path) : undefined}
        onDragLeave={() => setDropTarget((t) => (t === entry.path ? null : t))}
        onDrop={folder ? (e) => drop(e, entry.path) : undefined}
        // Shift+클릭은 범위를 고르고, Ctrl+클릭은 한 줄씩 넣고 뺀다. 그냥 누르면 고른 것을 풀고 연다.
        onMouseDown={(e) => {
          if (e.shiftKey) e.preventDefault();
        }}
        onClick={(e) => {
          e.stopPropagation();
          if (e.shiftKey) return pickRange(e.currentTarget, entry.path);
          if (e.ctrlKey || e.metaKey) return togglePick(entry.path);
          pickAnchor.current = entry.path;
          setPicked([]);
          setSelected(entry.path);
          if (folder)
            setExpanded((old) => {
              const next = new Set(old);
              if (next.has(entry.path)) next.delete(entry.path);
              else next.add(entry.path);
              return next;
            });
          else attempt(() => openMemo(entry.path))();
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          if (!folder && !e.shiftKey && !e.ctrlKey && !e.metaKey) attempt(() => openMemo(entry.path, space, true))();
        }}
        onContextMenu={(e) => {
          const list = pickedFor(entry);
          // 고른 줄 전체가 메뉴 대상이므로 우클릭한 줄 하나를 따로 표시하지 않는다.
          if (list.length > 1) return openMenu(e, pickedMenu(list), ":picked");
          setPicked([]);
          setSelected(entry.path);
          openMenu(e, entryMenu(entry), entry.path);
        }}
        onKeyDown={(e) => {
          const list = pickedFor(entry);
          if (e.key === "Escape" && picked.length) {
            e.preventDefault();
            setPicked([]);
          } else if (e.key === "F2" && list.length === 1) {
            e.preventDefault();
            setRenaming({ path: entry.path, value: entry.name });
          } else if (e.key === "Delete") {
            e.preventDefault();
            attempt(() => remove(list))();
          }
        }}
      >
        {folder ? (
          <>
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {open ? <FolderOpen size={15} /> : <Folder size={15} />}
          </>
        ) : entry.kind === "plot" ? (
          <FileText size={15} className="memo-file-icon" />
        ) : (
          <StickyNote size={15} className="memo-file-icon" />
        )}
        <span>{entry.name}</span>
      </button>
    );
  }
  // 작품 스페이스에서는 필터로 고른 타입(플롯·메모)의 문서만 보인다. 폴더는 늘 보인다.
  const shownEntry = (e: Entry) =>
    space === COMMON || e.type === "folder" || filter.has(e.kind === "plot" ? "plot" : "memo");
  function level(parent: string, depth: number): React.ReactNode {
    return (children.get(parent) || []).filter(shownEntry).map((entry) => (
      <Fragment key={entry.path}>
        {row(entry, depth)}
        {entry.type === "folder" && expanded.has(entry.path) && level(entry.path, depth + 1)}
      </Fragment>
    ));
  }
  const spaceTitle = spaces.find((s) => s.id === space)?.title ?? "공용 메모";
  const projectSpaces = spaces.filter((s) => s.id !== COMMON);
  return (
    <div className="memo-session" style={active ? undefined : { display: "none" }}>
      {confirmDialog}
      <ResizableSidebar className="memo-sidebar" label="메모" width={prefs.leftSidebarWidth}
        onResize={onSidebarResize} active={active}>
        <div className="panel-caption">
          <span>
            <StickyNote size={15} />
            메모
          </span>
          <span className="caption-actions">
            <button title="새 메모" aria-label="새 메모" onClick={attempt(() => newMemo())}>
              <FilePlus size={15} />
            </button>
            <button title="새 폴더" aria-label="새 폴더" onClick={attempt(() => newFolder())}>
              <FolderPlus size={15} />
            </button>
            <button
              title="파일 탐색기에서 열기"
              aria-label="메모 폴더 열기"
              onClick={attempt(() => call("memoReveal", { space }))}
            >
              <HardDrive size={15} />
            </button>
          </span>
        </div>
        <label className="memo-space">
          <span>스페이스</span>
          <select
            aria-label="메모 스페이스"
            value={space}
            onChange={(e) => {
              // 값은 바로 읽어 둔다. 비동기로 읽으면 React가 선택 상자를 예전 값으로 되돌린 뒤라 바뀌지 않는다.
              const id = e.target.value;
              attempt(() => switchSpace(id))();
            }}
          >
            <option value={COMMON}>공용 메모</option>
            {projectSpaces.length > 0 && (
              <optgroup label="작품 문서">
                {projectSpaces.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title || "제목 없는 작품"}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        {space !== COMMON && (
          <div className="memo-filter" role="group" aria-label="트리에 보일 항목">
            {FILTERS.map(([key, label]) => (
              <button
                key={key}
                className={filter.has(key) ? "active" : ""}
                aria-pressed={filter.has(key)}
                onClick={() =>
                  setFilter((old) => {
                    const next = new Set(old);
                    if (next.has(key)) {
                      // 하나는 늘 켜 둔다.
                      if (next.size > 1) next.delete(key);
                    } else next.add(key);
                    return next;
                  })
                }
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <div
          className={`memo-tree ${dropTarget === "" ? "drop-target" : ""}`}
          role="tree"
          aria-label={`${spaceTitle} 메모 목록`}
          onClick={() => {
            setSelected("");
            setPicked([]);
          }}
          onContextMenu={(e) => openMenu(e, rootMenu(), "")}
          onDragOver={(e) => dragOver(e, "")}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target) setDropTarget((t) => (t === "" ? null : t));
          }}
          onDrop={(e) => drop(e, "")}
        >
          {(space === COMMON || filter.has("memo") || filter.has("plot")) && (
            <>
              {space !== COMMON && filter.has("episode") && <div className="memo-tree-heading">문서</div>}
              {level("", 0)}
              {!entries.length && (
                <div className="tree-empty">
                  아직 문서가 없습니다. 위의 버튼이나 우클릭으로 문서와 폴더를 만들 수 있습니다.
                </div>
              )}
            </>
          )}
          {space !== COMMON && filter.has("episode") && docSection("episode")}
        </div>
      </ResizableSidebar>
      <main className="workspace memo-main">
        <SplitArea split={area} drag={draggedToGroups} onDrop={droppedOnGroups}>
        {sides.map(side => side !== focusedSide ? sideGroup(side) : (
        <section
          key={focusedSide}
          {...groupAttributes(focusedSide)}
          className={`editor-group ${split ? "focused" : ""}`}
          style={groupStyle(focusedSide)}
        >
        {tabs.length > 0 && (
          <div className="editor-tabs" {...tabBarAttributes} role="tablist" aria-label="열린 메모">
            {tabs.map((t, index) => {
              const current = sameTab(t, memo),
                name = nameOf(t),
                where = spaces.find((x) => x.id === t.space)?.title ?? "공용 메모",
                key = `${t.space}\n${t.path}`;
              return (
                <div
                  key={key}
                  {...tabAttributes(key)}
                  role="tab"
                  tabIndex={current ? 0 : -1}
                  aria-selected={current}
                  title={`${where} / ${t.path}${t.pinned === false ? " (미리보기)" : ""}`}
                  className={`editor-tab ${current ? "current" : ""} ${t.pinned === false ? "preview" : ""} ${
                    dragTab === t ? "dragging" : ""
                  } ${menu?.target === "tab:" + key ? "context-target" : ""}`}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "copyMove";
                    dragSide.current = focusedSide;
                    setDragTab(t);
                  }}
                  onDragEnd={() => {
                    setDragTab(null);
                    area.clearDropZone();
                  }}
                  onClick={attempt(() => activateTab(t))}
                  onDoubleClick={() => keepTab(t)}
                  onMouseDown={(e) => {
                    if (e.button === 1) e.preventDefault();
                  }}
                  onAuxClick={(e) => {
                    if (e.button === 1) attempt(() => closeTab(t))();
                  }}
                  onContextMenu={(e) => openMenu(e, tabMenu(t, index), "tab:" + key)}
                >
                  <FileText size={14} />
                  <span>{name}</span>
                  {current && <i className={status === "저장됨" ? "saved-dot" : "dirty-dot"} />}
                  <button
                    aria-label={`${name} 닫기`}
                    title="닫기 (Ctrl+W, Alt+클릭: 다른 탭 닫기)"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (e.altKey) attempt(() => closeTabs((x) => sameTab(x, t), t))();
                      else attempt(() => closeTab(t))();
                    }}
                  >
                    <X size={14} />
                  </button>
                </div>
              );
            })}
            {memo && (
              <div className="editor-tabs-actions">
                <button
                  type="button"
                  className="tab-split-button"
                  aria-label="편집기 분할"
                  title="오른쪽으로 분할 (Ctrl+\, Alt+클릭: 아래로 분할)"
                  onClick={attempt((e) => splitTo(memo, e.altKey ? "down" : "right"))}
                >
                  <Columns2 size={14} />
                </button>
              </div>
            )}
          </div>
        )}
        {memoTabs(tabs, memo, true)}
        {!memo && (
          <div className="memo-blank">
            <StickyNote size={30} />
            <p>
              {spaceTitle}
              <br />
              왼쪽에서 메모를 고르거나 새 메모를 만들어 보세요.
            </p>
            <button className="primary" onClick={attempt(() => newMemo())}>
              <FilePlus size={16} />새 메모
            </button>
          </div>
        )}
        </section>
        ))}
        </SplitArea>
      </main>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
