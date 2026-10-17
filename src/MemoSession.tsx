import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
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
import { editorDropZone, type EditorDropZone } from "./editor-groups";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import { useConfirm } from "./ConfirmDialog";
import { call, type Doc, type Kind } from "./types";
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
function placeMemoTab(list: MemoTab[], tab: MemoTab, pinned: boolean, after: Memo | null) {
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
// 분할 보기에서 포커스되지 않은 그룹. 포커스된 그룹은 tabs와 memo가 맡는다(집필 창과 같은 방식).
type MemoGroup = { tabs: MemoTab[]; current: MemoTab | null };
type Side = "left" | "right";
function withoutMemoTab(group: MemoGroup | null, t: MemoTab): MemoGroup | null {
  if (!group) return group;
  const index = group.tabs.findIndex((x) => sameTab(x, t));
  if (index < 0) return group;
  const tabs = group.tabs.filter((_, i) => i !== index);
  if (!tabs.length) return null;
  const current =
    group.current && sameTab(group.current, t) ? tabs[index] || tabs[index - 1] : group.current;
  return { tabs, current };
}
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
  saved,
  apiRef,
  documents,
  onOpenDoc,
  prefs,
  onSidebarResize,
  flushRef,
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
  // 지난번에 앱을 닫을 때의 메모 화면 상태. 서재를 읽기 전에는 undefined, 없으면 null.
  saved: any;
  prefs: Record<string, any>;
  onSidebarResize: (width: number) => void;
  flushRef: React.MutableRefObject<(() => Promise<void>) | null>;
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
    [tabs, setTabsState] = useState<MemoTab[]>([]),
    [dragTab, setDragTab] = useState<MemoTab | null>(null),
    // 작품 스페이스에서 트리에 보일 것. 기본은 메모만.
    [filter, setFilter] = useState<Set<Filter>>(new Set<Filter>(["memo"])),
    // 플롯·에피소드 트리에서 접어 둔 폴더('plot:003 회차명' 꼴).
    [docCollapsed, setDocCollapsed] = useState<Set<string>>(new Set()),
    [split, setSplitState] = useState<MemoGroup | null>(null),
    [focusedSide, setFocusedSideState] = useState<Side>("left"),
    [splitRatio, setSplitRatio] = useState(0.5),
    [sideMemo, setSideMemoState] = useState<Memo | null>(null),
    [sideRev, setSideRev] = useState(0),
    [dropZone, setDropZone] = useState<EditorDropZone | null>(null);
  const scrollPositions = useRef<EditorScrollPositions>(new Map());
  const retainedMemos = useRef(new Map<string, Memo>());
  const setSideMemo = useCallback((m: Memo | null) => {
    if (m) retainedMemos.current.set(`${m.space}\n${m.path}`, m);
    setSideMemoState(m);
  }, []);
  useEffect(() => {
    const open = new Set([...tabs, ...(split?.tabs ?? [])].map((tab) => `${tab.space}\n${tab.path}`));
    for (const key of retainedMemos.current.keys())
      if (!open.has(key)) retainedMemos.current.delete(key);
  }, [tabs, split]);
  const memoRef = useRef<Memo | null>(null),
    spaceRef = useRef(space),
    dirty = useRef({ seq: 0, saved: 0 }),
    composing = useRef(false),
    conflictRef = useRef(false),
    timer = useRef<number | undefined>(undefined),
    chain = useRef<Promise<void>>(Promise.resolve()),
    openSeq = useRef(0),
    // 트리에서 끌고 있는 경로. 여러 줄을 골랐으면 고른 것을 함께 끈다.
    dragging = useRef<string[]>([]),
    // Shift+클릭 범위 선택의 기준 줄(마지막으로 그냥 누르거나 Ctrl+클릭한 줄).
    pickAnchor = useRef(""),
    dragTreeMemo = useRef<MemoTab | null>(null),
    tabsRef = useRef<MemoTab[]>([]),
    splitRef = useRef<MemoGroup | null>(null),
    focusedSideRef = useRef<Side>("left"),
    groupsRef = useRef<HTMLDivElement>(null);
  spaceRef.current = space;
  conflictRef.current = conflict;
  const [confirm, confirmDialog] = useConfirm();
  const setCurrent = (m: Memo | null) => {
    if (m) retainedMemos.current.set(`${m.space}\n${m.path}`, m);
    memoRef.current = m;
    setMemo(m);
  };
  const setTabs = (fn: (tabs: MemoTab[]) => MemoTab[]) => {
    tabsRef.current = fn(tabsRef.current);
    setTabsState(tabsRef.current);
  };
  const setSplit = (fn: (group: MemoGroup | null) => MemoGroup | null) => {
    splitRef.current = fn(splitRef.current);
    setSplitState(splitRef.current);
  };
  const setFocusedSide = (side: Side) => {
    focusedSideRef.current = side;
    setFocusedSideState(side);
  };
  // 두 그룹의 탭을 함께 고친다. fn이 null을 돌려주면 그 탭을 닫는다.
  function mapGroups(fn: (t: MemoTab) => MemoTab | null) {
    setTabs((list) => list.map(fn).filter((t): t is MemoTab => !!t));
    setSplit((g) => {
      if (!g) return g;
      const tabs = g.tabs.map(fn).filter((t): t is MemoTab => !!t);
      if (!tabs.length) return null;
      const cur = g.current && fn(g.current);
      return { tabs, current: (cur && tabs.find((t) => sameTab(t, cur))) || tabs[0] };
    });
  }
  const currentTab = () => tabsRef.current.find((t) => sameTab(t, memoRef.current)) ?? null;
  function keepTab(t: MemoTab) {
    setTabs((list) => placeMemoTab(list, t, true, null));
  }
  const attempt =
    (fn: (...args: any[]) => Promise<any> | any) =>
    (...args: any[]) => {
      Promise.resolve()
        .then(() => fn(...args))
        .catch(report);
    };

  // 저장은 하나씩 순서대로 한다. auto면 한글 조합 중에는 미뤘다가 조합이 끝나면 저장한다.
  const save = useCallback((auto = false) => {
    const run = async () => {
      const m = memoRef.current;
      if (!m || dirty.current.seq === dirty.current.saved) return;
      if (auto && (composing.current || conflictRef.current)) return;
      const seq = dirty.current.seq;
      setStatus("저장 중");
      try {
        const saved = isDocPath(m.path)
          ? await call<Memo>("saveDocument", {
              id: m.path.slice(DOC.length),
              body: m.body,
              expectedRevision: m.revision,
            })
          : await call<Memo>("memoSave", {
              space: m.space,
              path: m.path,
              body: m.body,
              expectedRevision: m.revision,
            });
        dirty.current.saved = seq;
        const now = memoRef.current;
        if (now && now.space === m.space && now.path === m.path)
          setCurrent({ ...now, revision: saved.revision, updatedAt: saved.updatedAt });
        setStatus(dirty.current.seq === dirty.current.saved ? "저장됨" : "저장 대기");
      } catch (e: any) {
        if (e.code === "CONFLICT") setConflict(true);
        setStatus("저장 안 됨");
        throw e;
      }
    };
    const task = chain.current.then(run);
    chain.current = task.catch(() => {});
    return task;
  }, []);
  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    if (conflictRef.current && dirty.current.seq !== dirty.current.saved)
      throw Error("메모 변경 충돌을 해결해 주세요.");
    await save();
  }, [save]);
  useEffect(() => {
    flushRef.current = flush;
    return () => {
      flushRef.current = null;
    };
  }, [flush, flushRef]);
  function schedule() {
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => save(true).catch(report), 700);
  }
  function edit(body: string) {
    const m = memoRef.current;
    if (!m || body === m.body) return;
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
    if ([...tabsRef.current, ...(splitRef.current?.tabs ?? [])].some((t) => !alive(t)))
      mapGroups((t) => (alive(t) ? t : null));
    if (memoRef.current && !alive(memoRef.current)) setCurrent(null);
  }, []);
  // 바깥에서 파일이 바뀌면 트리를 다시 읽고, 고치지 않은 메모는 새 내용으로 바꾼다.
  const reloadOpen = useCallback(async () => {
    const m = memoRef.current;
    if (!m || dirty.current.seq !== dirty.current.saved || conflictRef.current) return;
    try {
      const fresh = await readItem(m.space, m.path);
      const now = memoRef.current;
      if (now && now.path === m.path && now.space === m.space && fresh.revision !== now.revision)
        setCurrent(fresh);
    } catch (e: any) {
      if (e.code !== "NOT_FOUND") throw e;
      mapGroups((t) => (sameTab(t, m) ? null : t));
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
  async function openMemo(path: string, spaceId = spaceRef.current, pinned = false) {
    const seq = ++openSeq.current;
    const prev = memoRef.current;
    if (prev && prev.path === path && prev.space === spaceId) {
      if (pinned) keepTab(prev);
      return;
    }
    await flush();
    if (seq !== openSeq.current) return;
    const m = await readItem(spaceId, path);
    if (seq !== openSeq.current) return;
    dirty.current = { seq: 0, saved: 0 };
    setConflict(false);
    setStatus("저장됨");
    setCurrent(m);
    setTabs((list) => placeMemoTab(list, { space: spaceId, path }, pinned, prev));
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
    setConflict(false);
    setStatus("저장됨");
    setCurrent(null);
  }
  // keep에 해당하지 않는 탭을 닫는다. 지금 메모의 탭이 닫히면 가까운 탭을 연다.
  async function closeTabs(keep: (t: MemoTab, i: number) => boolean) {
    const list = tabsRef.current,
      currentIndex = list.findIndex((t) => sameTab(t, memoRef.current)),
      rest = list.filter(keep);
    if (rest.length === list.length) return;
    const closingCurrent = currentIndex >= 0 && !keep(list[currentIndex], currentIndex);
    if (closingCurrent) await flush();
    setTabs(() => rest);
    if (!closingCurrent) return;
    const next =
      list.slice(currentIndex + 1).find((t) => rest.includes(t)) ??
      [...list.slice(0, currentIndex)].reverse().find((t) => rest.includes(t));
    if (next) await activateTab(next);
    else {
      closeCurrent();
      // 분할된 상태에서 그룹의 마지막 탭을 닫으면 그 그룹을 닫는다.
      if (splitRef.current) {
        await focusOther();
        setSplit(() => null);
      }
    }
  }
  // ---- 분할 보기 (집필 창과 같은 방식) ----
  // 다른 그룹으로 포커스를 옮긴다. open을 주면 그 그룹에서 그 메모를 연다.
  async function focusOther(open?: MemoTab, pinned = false) {
    const other = splitRef.current;
    if (!other) return;
    await flush();
    const seq = ++openSeq.current;
    const target = open ?? other.current;
    // 읽기를 마친 뒤 두 그룹을 함께 바꿔 빈 화면이 끼어들지 않게 한다.
    const next = target ? await readItem(target.space, target.path) : null;
    if (seq !== openSeq.current || splitRef.current !== other) return;
    const mine: MemoGroup = { tabs: tabsRef.current, current: currentTab() };
    setSideMemo(memoRef.current);
    setTabs(() => target ? placeMemoTab(other.tabs, target, pinned, null) : other.tabs);
    setSplit(() => (mine.tabs.length ? mine : null));
    setFocusedSide(focusedSideRef.current === "left" ? "right" : "left");
    selectGroupMemo(next);
  }
  // 그룹 전환에서는 편집기를 비우지 않고 새 메모와 트리 상태를 한 번에 반영한다.
  function selectGroupMemo(next: Memo | null) {
    dirty.current = { seq: 0, saved: 0 };
    setConflict(false);
    setStatus("저장됨");
    setCurrent(next);
    setTitle(next?.title ?? "");
    if (!next) return;
    if (next.space !== spaceRef.current) {
      spaceRef.current = next.space;
      setEntries([]);
      setSpace(next.space);
      setExpanded(new Set(ancestors(next.path)));
    } else {
      setExpanded((old) => new Set([...old, ...ancestors(next.path)]));
    }
    setSelected(next.path);
  }

  async function focusSide(side: Side) {
    if (splitRef.current && side !== focusedSideRef.current) await focusOther();
  }
  // 트리에서 열 때는 원래 탭을 유지하고, 탭을 끌어 놓을 때만 그룹 사이에서 옮긴다.
  async function openInGroup(t: MemoTab, side: Side, moveTab = false) {
    if (splitRef.current) {
      if (side === focusedSideRef.current) {
        await activateTab(t, true);
      } else {
        await focusOther(t, true);
        if (moveTab) setSplit((g) => withoutMemoTab(g, t));
      }
      return;
    }
    if (!memoRef.current) {
      await activateTab(t, true);
      return;
    }
    await flush();
    const seq = ++openSeq.current;
    const next = await readItem(t.space, t.path);
    if (seq !== openSeq.current) return;
    const mine: MemoGroup = { tabs: tabsRef.current, current: currentTab() };
    setSideMemo(memoRef.current);
    setTabs(() => placeMemoTab([], t, true, null));
    setSplit(() => (moveTab && mine.tabs.length > 1 ? withoutMemoTab(mine, t) : mine));
    setFocusedSide(side);
    selectGroupMemo(next);
  }
  // 오른쪽 그룹이 이미 있으면 그 자리에 열고, 없으면 새로 나눈다.
  async function splitTo(t: MemoTab | null = currentTab()) {
    if (t) await openInGroup(t, "right", true);
  }

  async function closeGroup() {
    if (!splitRef.current) return;
    await focusOther();
    setSplit(() => null);
  }
  async function moveToOther(t: MemoTab) {
    await focusOther(t, true);
    setSplit((g) => withoutMemoTab(g, t));
  }
  const closeSideTab = (t: MemoTab) => setSplit((g) => withoutMemoTab(g, t));
  // 포커스되지 않은 그룹의 메모는 읽기 전용으로 보여 준다. 파일이 바뀌면 다시 읽는다.
  const sideKey = split?.current ? `${split.current.space}\n${split.current.path}` : "";
  useEffect(() => {
    const t = splitRef.current?.current;
    if (!t) return setSideMemo(null);
    let canceled = false;
    readItem(t.space, t.path)
      .then((m) => !canceled && setSideMemo(m))
      .catch(() => !canceled && setSideMemo(null));
    return () => {
      canceled = true;
    };
  }, [sideKey, sideRev]);
  // 앱을 다시 열면 지난번 스페이스·탭·보던 메모·분할을 되살린다. 없어진 메모의 탭은 뺀다.
  const restored = useRef(false);
  useEffect(() => {
    if (saved === undefined || restored.current) return;
    (async () => {
      if (!saved) return;
      const isTab = (t: any): t is MemoTab =>
        t && typeof t.space === "string" && typeof t.path === "string";
      const live = async (list: unknown) => {
        const out: MemoTab[] = [];
        for (const t of Array.isArray(list) ? list.filter(isTab) : [])
          if (await readItem(t.space, t.path).then(() => true, () => false))
            out.push({ space: t.space, path: t.path, pinned: t.pinned !== false });
        return out;
      };
      const mine = await live(saved.tabs),
        other = await live(saved.split?.tabs);
      const pick = (list: MemoTab[], t: any) => list.find((x) => sameTab(x, t)) ?? list[0] ?? null;
      if (typeof saved.space === "string") {
        spaceRef.current = saved.space;
        setSpace(saved.space);
      }
      if (Array.isArray(saved.filter)) {
        const f = saved.filter.filter((x: any) => FILTERS.some(([k]) => k === x));
        if (f.length) setFilter(new Set(f));
      }
      setTabs(() => mine);
      if (other.length) {
        setSplit(() => ({ tabs: other, current: pick(other, saved.split?.current) }));
        setFocusedSide(saved.focusedSide === "right" ? "right" : "left");
        setSplitRatio(Math.min(0.8, Math.max(0.2, Number(saved.splitRatio) || 0.5)));
      }
      const current = pick(mine, saved.current);
      if (current) await activateTab(current);
    })()
      .catch(report)
      .finally(() => {
        restored.current = true;
      });
  }, [saved]);
  useEffect(() => {
    if (!restored.current) return;
    const t = setTimeout(() => {
      call("setPreferences", {
        memoSession: {
          space,
          tabs,
          current: memo ? { space: memo.space, path: memo.path } : null,
          split,
          focusedSide,
          splitRatio,
          filter: [...filter],
        },
      }).catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [space, tabs, memo?.space, memo?.path, split, focusedSide, splitRatio, filter]);
  function startSash(e: React.PointerEvent) {
    e.preventDefault();
    const box = groupsRef.current?.getBoundingClientRect();
    if (!box) return;
    const move = (ev: PointerEvent) =>
      setSplitRatio(Math.min(0.8, Math.max(0.2, (ev.clientX - box.left) / box.width)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("sash-dragging");
    };
    document.body.classList.add("sash-dragging");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  // 파일 트리와 탭은 같은 놓기 영역을 사용하되, 트리의 파일은 옮기지 않고 연다.
  function dragOverGroups(e: React.DragEvent) {
    const fromTree = !!dragTreeMemo.current;
    const zone = dragTab || fromTree
      ? editorDropZone(e.target, e.clientX, groupsRef.current, !!splitRef.current, fromTree)
      : null;
    if (zone) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = fromTree ? "copy" : "move";
    }
    setDropZone((prev) =>
      prev && zone && prev.side === zone.side && prev.tabs === zone.tabs && prev.left === zone.left &&
      prev.top === zone.top && prev.width === zone.width && prev.height === zone.height
        ? prev
        : zone,
    );
  }
  function dropOnGroups(e: React.DragEvent) {
    const fromTree = !!dragTreeMemo.current;
    const t = dragTreeMemo.current || dragTab;
    const zone = t ? editorDropZone(e.target, e.clientX, groupsRef.current, !!splitRef.current, fromTree) : null;
    if (!zone || !t) return;
    e.preventDefault();
    e.stopPropagation();
    dragTreeMemo.current = null;
    dragging.current = [];
    setDropTarget(null);
    setDropZone(null);
    setDragTab(null);
    attempt(() => (zone.tabs ? openInTabs(t, zone.side) : openInGroup(t, zone.side, !fromTree)))();
  }
  // 트리에서 끌어 그룹의 탭 막대에 놓으면 화면을 나누지 않고 그 그룹에 고정 탭으로 연다.
  async function openInTabs(t: MemoTab, side: Side) {
    if (splitRef.current) await openInGroup(t, side);
    else await activateTab(t, true);
  }
  const closeTab = (t: MemoTab) => closeTabs((x) => !sameTab(x, t));
  async function cycleTab(direction: number) {
    const list = tabsRef.current;
    if (list.length < 2) return;
    const i = list.findIndex((t) => sameTab(t, memoRef.current));
    await activateTab(list[(i + direction + list.length) % list.length]);
  }
  function moveTab(from: MemoTab, to: MemoTab) {
    setTabs((list) => {
      const a = list.indexOf(from),
        b = list.indexOf(to);
      if (a < 0 || b < 0 || a === b) return list;
      const next = [...list];
      next.splice(b, 0, ...next.splice(a, 1));
      return next;
    });
  }
  // 집필 창과 같은 탭 단축키: Ctrl+W 닫기, Ctrl+Tab·Ctrl+PageDown 다음, Ctrl+Shift+Tab·Ctrl+PageUp 이전.
  const keys = useRef({ closeTab, cycleTab, splitTo, focusSide });
  keys.current = { closeTab, cycleTab, splitTo, focusSide };
  if (apiRef) apiRef.current = { open: (space, path, pinned) => activateTab({ space, path }, pinned) };
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (document.documentElement.dataset.pinLocked === "true") return;
      if (!activeRef.current || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      const current = tabsRef.current.find((t) => sameTab(t, memoRef.current));
      let run: (() => Promise<void>) | null = null;
      if (e.code === "KeyW" && !e.shiftKey) run = current ? () => keys.current.closeTab(current) : null;
      else if (e.key === "PageDown" || (e.key === "Tab" && !e.shiftKey)) run = () => keys.current.cycleTab(1);
      else if (e.key === "PageUp" || (e.key === "Tab" && e.shiftKey)) run = () => keys.current.cycleTab(-1);
      else if (e.code === "Backslash" && !e.shiftKey) run = () => keys.current.splitTo();
      else if ((e.code === "Digit1" || e.code === "Digit2") && !e.shiftKey)
        run = () => keys.current.focusSide(e.code === "Digit1" ? "left" : "right");
      else return;
      e.preventDefault();
      e.stopPropagation();
      run?.().catch(report);
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
    mapGroups((t) => {
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
  async function move(path: string, to: string) {
    if (!path || path === to || parentOf(path) === to || to.startsWith(path + "/")) return;
    if (touchesOpen(path)) await flush();
    const r = await call<{ path: string }>("memoMove", { space, path, to });
    remap(path, r.path);
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
      mapGroups((t) => (gone(t) ? null : t));
    }
    setSelected("");
    setPicked([]);
    await loadTree();
  }
  async function reloadFromDisk() {
    const m = memoRef.current;
    if (!m) return;
    clearTimeout(timer.current);
    await chain.current;
    const fresh = await readItem(m.space, m.path);
    dirty.current = { seq: 0, saved: 0 };
    setConflict(false);
    setStatus("저장됨");
    setCurrent(fresh);
  }
  async function keepMine() {
    const m = memoRef.current;
    if (!m) return;
    const fresh = await readItem(m.space, m.path);
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
        action: attempt(() => move(entry.path, "")),
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
          for (const x of outermost(list)) await move(x.path, "");
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
    attempt(async () => {
      for (const { path } of moving) await move(path, folder);
    })();
  }
  const openHere = (path: string) => memo?.space === space && memo.path === path;
  function tabMenu(t: MemoTab, index: number): MenuItem[] {
    const root = spaces.find((x) => x.id === t.space)?.root;
    return [
      { label: "닫기", shortcut: "Ctrl+W", action: attempt(() => closeTab(t)) },
      { label: "다른 탭 닫기", disabled: tabs.length < 2, action: attempt(() => closeTabs((x) => sameTab(x, t))) },
      {
        label: "오른쪽 탭 닫기",
        disabled: index >= tabs.length - 1,
        action: attempt(() => closeTabs((_, i) => i <= index)),
      },
      { label: "모두 닫기", action: attempt(() => closeTabs(() => false)) },
      "separator",
      { label: "탭 고정", disabled: t.pinned !== false, action: () => keepTab(t) },
      "separator",
      split
        ? { label: "다른 그룹으로 이동", action: attempt(() => moveToOther(t)) }
        : { label: "오른쪽으로 분할", shortcut: "Ctrl+\\", action: attempt(() => splitTo(t)) },
      { label: "그룹 닫기", disabled: !split, action: attempt(closeGroup) },
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
  function sideTabMenu(t: MemoTab): MenuItem[] {
    return [
      { label: "열기", action: attempt(() => focusOther(t)) },
      { label: "닫기", action: () => closeSideTab(t) },
      {
        label: "다른 그룹으로 이동",
        action: attempt(async () => {
          await activateTab(t, true);
          closeSideTab(t);
        }),
      },
      { label: "그룹 닫기", action: () => setSplit(() => null) },
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
  const groupStyle = (side: Side) =>
    split
      ? side === "left"
        ? { flex: `0 0 calc(${splitRatio * 100}% - 2px)` }
        : { flex: "1 1 0" }
      : undefined;
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
  const sash = (
    <div
      key="sash"
      className="group-sash"
      role="separator"
      aria-orientation="vertical"
      aria-label="편집기 그룹 크기 조절"
      onPointerDown={startSash}
      onDoubleClick={() => setSplitRatio(0.5)}
    />
  );
  // 두 그룹은 같은 요소를 사용해 포커스만 바뀔 때 본문을 다시 만들지 않는다.
  function memoBody(memo: Memo, focused: boolean, visible = true) {
    const groupStatus = focused ? status : "저장됨";
    return (
      <div
        className="group-body"
        onMouseDownCapture={(e) => {
          if (!focused && e.button === 0) {
            e.stopPropagation();
            attempt(() => focusOther())();
          }
        }}
        onClickCapture={(e) => {
          if (!focused) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
        onContextMenuCapture={(e) => {
          if (!focused) {
            e.preventDefault();
            e.stopPropagation();
            attempt(() => focusOther())();
          }
        }}
        onKeyDownCapture={(e) => {
          if (!focused && e.key !== "Tab") {
            e.preventDefault();
            e.stopPropagation();
            attempt(() => focusOther())();
          }
        }}
      >
        <div className="memo-head">
          <span className="memo-crumbs" title={memo.path}>
            {crumbs(memo)}
          </span>
          <span className={`memo-status ${groupStatus === "저장됨" ? "" : "pending"}`}>{groupStatus}</span>
        </div>
        {focused && conflict && (
          <div className="memo-conflict" role="alert">
            <span>다른 곳에서 이 메모가 바뀌었습니다.</span>
            <button onClick={attempt(reloadFromDisk)}>바뀐 내용 불러오기</button>
            <button onClick={attempt(keepMine)}>내 내용으로 덮어쓰기</button>
          </div>
        )}
        <EditorScroll key={`${memo.space}\n${memo.path}`} documentId={`${memo.space}\n${memo.path}`} positions={scrollPositions.current} visible={visible}>
          {(() => {
            const mainBox = manuscriptBoxOf(kindOf(memo));
            return (
              <article className={mainBox.className} style={mainBox.style}>
                <input
                  className="document-title"
                  aria-label="메모 제목"
                  readOnly={!focused}
                  value={focused ? title : memo.title}
                  placeholder="제목"
                  onChange={(e) => {
                    keepTab(memo);
                    setTitle(e.target.value);
                  }}
                  onBlur={attempt(async () => {
                    if (!focused) return;
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
                  onComposition={(value) => {
                    if (!focused) return;
                    composing.current = value;
                    if (!value && dirty.current.seq !== dirty.current.saved) schedule();
                  }}
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
  function memoTabs(list: MemoTab[], current: MemoTab | Memo | null, groupFocused: boolean) {
    return list.map((tab) => {
      const key = `${tab.space}\n${tab.path}`;
      const shown = sameTab(tab, memo) ? memo
        : sameTab(tab, sideMemo) ? sideMemo : retainedMemos.current.get(key);
      if (!shown) return null;
      const visible = active && sameTab(tab, current);
      return <RetainedTab key={key} visible={visible}>
        {memoBody(shown, visible && groupFocused, visible)}
      </RetainedTab>;
    });
  }
  // 포커스되지 않은 그룹: 읽기 전용으로 보여 주고, 클릭하면 그 그룹으로 포커스를 옮긴다.
  function sideGroup() {
    if (!split) return null;
    const cur = split.current;
    return (
      <section
        key={focusedSide === "left" ? "right" : "left"}
        data-side={focusedSide === "left" ? "right" : "left"}
        className="editor-group inactive"
        style={groupStyle(focusedSide === "left" ? "right" : "left")}
      >
        <div className="editor-tabs" role="tablist" aria-label="다른 그룹의 열린 메모">
          {split.tabs.map((t) => {
            const current = !!cur && sameTab(t, cur),
              name = nameOf(t),
              key = `${t.space}\n${t.path}`;
            return (
              <div
                key={key}
                role="tab"
                tabIndex={-1}
                aria-selected={current}
                title={`${spaceName(t.space)} / ${t.path}${t.pinned === false ? " (미리보기)" : ""}`}
                className={`editor-tab ${current ? "current" : ""} ${t.pinned === false ? "preview" : ""} ${
                  menu?.target === "side:" + key ? "context-target" : ""
                }`}
                onClick={attempt(() => focusOther(t))}
                onDoubleClick={attempt(() => focusOther(t, true))}
                onMouseDown={(e) => {
                  if (e.button === 1) e.preventDefault();
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) closeSideTab(t);
                }}
                onContextMenu={(e) => openMenu(e, sideTabMenu(t), "side:" + key)}
              >
                <FileText size={14} />
                <span>{name}</span>
                {current && <i className="saved-dot" />}
                <button
                  aria-label={`다른 그룹의 ${name} 닫기`}
                  title="닫기"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeSideTab(t);
                  }}
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>
        {memoTabs(split.tabs, cur, false)}
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
            setDropZone(null);
          }}
          onClick={attempt(() => activateTab(t))}
          onDoubleClick={attempt(() => activateTab(t, true))}
          onContextMenu={(e) =>
            openMenu(
              e,
              [
                { label: "열기", action: attempt(() => activateTab(t)) },
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
          setDropZone(null);
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
        <div
          className={`editor-groups ${split ? "split" : ""}`}
          ref={groupsRef}
          onDragOverCapture={dragOverGroups}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropZone(null);
          }}
          onDropCapture={dropOnGroups}
        >
        {dropZone && (
          <div
            className="group-drop-zone"
            style={{
              left: dropZone.left,
              top: dropZone.top,
              width: dropZone.width,
              ...(dropZone.height !== undefined && { height: dropZone.height, bottom: "auto" }),
            }}
          />
        )}
        {split && focusedSide === "right" && sideGroup()}
        {split && focusedSide === "right" && sash}
        <section
          key={focusedSide}
          data-side={focusedSide}
          className={`editor-group ${split ? "focused" : ""}`}
          style={groupStyle(focusedSide)}
        >
        {tabs.length > 0 && (
          <div className="editor-tabs" role="tablist" aria-label="열린 메모">
            {tabs.map((t, index) => {
              const current = sameTab(t, memo),
                name = nameOf(t),
                where = spaces.find((x) => x.id === t.space)?.title ?? "공용 메모",
                key = `${t.space}\n${t.path}`;
              return (
                <div
                  key={key}
                  role="tab"
                  tabIndex={current ? 0 : -1}
                  aria-selected={current}
                  title={`${where} / ${t.path}${t.pinned === false ? " (미리보기)" : ""}`}
                  className={`editor-tab ${current ? "current" : ""} ${t.pinned === false ? "preview" : ""} ${
                    dragTab === t ? "dragging" : ""
                  } ${menu?.target === "tab:" + key ? "context-target" : ""}`}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    setDragTab(t);
                  }}
                  onDragEnd={() => {
                    setDragTab(null);
                    setDropZone(null);
                  }}
                  onDragOver={(e) => {
                    if (dragTab) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragTab) moveTab(dragTab, t);
                    setDragTab(null);
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
                    title="닫기 (Ctrl+W)"
                    onClick={(e) => {
                      e.stopPropagation();
                      attempt(() => closeTab(t))();
                    }}
                  >
                    <X size={14} />
                  </button>
                </div>
              );
            })}
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
        {split && focusedSide === "left" && sash}
        {split && focusedSide === "left" && sideGroup()}
        </div>
      </main>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
