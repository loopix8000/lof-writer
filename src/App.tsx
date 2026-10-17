import { Fragment, useState, useEffect, useRef, useCallback } from "react";
import CoverImage, { ImageViewer } from "./CoverImage";
import {
  BookOpen,
  FileQuestion,
  FileWarning,
  Library as LibraryIcon,
  FolderOpen,
  Folder,
  FilePlus,
  FolderPlus,
  Settings,
  Search,
  Plus,
  ArrowLeft,
  ArrowRight,
  FileText,
  StickyNote,
  History,
  Download,
  Upload,
  Check,
  Cloud,
  HardDrive,
  RefreshCw,
  Code2,
  Maximize,
  Smartphone,
  ChevronRight,
  ChevronDown,
  MoreHorizontal,
  Archive,
  ArchiveRestore,
  Trash2,
  ArrowUp,
  ArrowDown,
  Sun,
  Moon,
  X,
  Feather,
  Link,
  Copy,
  Pilcrow,
  Sparkles,
  LockKeyhole,
  Bookmark as BookmarkIcon,
} from "lucide-react";
import Writer from "./Writer";
import ResizableSidebar from "./ResizableSidebar";
import { useAppUpdater, UpdateSettings, UpdateNotice, UpdateLock } from "./Updater";
import {
  call,
  type Doc,
  type Library,
  type Kind,
  type Project,
  type WritingRules,
  type AutoSyncStatus,
} from "./types";
import {
  characterCount,
  manuscriptStats,
  countForRule,
  countForWriting,
  requiresSource,
  plainText,
} from "../core/text.mjs";
import {
  DEFAULT_EDITOR_STYLE,
  DEFAULT_NOTE_EDITOR_STYLE,
  TYPESETTING_KINDS,
  FONT_FAMILY_PRESETS,
  WIDTH_PRESETS,
  PLATFORM_STYLE_PRESETS,
  DIVIDER_STYLES,
  resolveKindPrefs,
  normalizeEditorStyle,
  replaceManuscriptSymbols,
} from "../core/typesetting.mjs";
import {
  DEFAULT_TEXT_REPLACEMENTS,
  normalizeTextReplacements,
  migrateTypingPreferences,
} from "../core/typing.mjs";
import { normalizeWriting, writingName } from "../core/platforms.mjs";
import PlatformCount from "./PlatformCount";
import PlatformPicker from "./PlatformPicker";
import TagInput from "./TagInput";
import PropertyPresetSettings from "./PropertyPresetSettings";
import PinSettings from "./PinSettings";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import EpisodeProperties, { statusItems } from "./EpisodeProperties";
import EpisodeBindingPicker from "./EpisodeBindingPicker";
import {
  STATUS_LABELS,
  STATUS_SHORT,
  normalizeStatus,
  episodeNumbers,
  lineBreakDefault,
  lineBreakLabel,
} from "../core/episode.mjs";
import MobilePreview from "./MobilePreview";
import MemoSession from "./MemoSession";
import QuickNote, { quickNoteMarkdown, quickNoteTitle, type QuickNoteSource } from "./QuickNote";
import {
  QuickOpen,
  SearchPanel,
  type QuickItem,
  type SearchMatch,
  type SearchResult,
} from "./SearchViews";
const composingError = "한글 입력 조합이 끝난 뒤 다시 저장해 주세요.";
const autoSyncLabels = { idle: "동기화 완료", pending: "동기화 대기", syncing: "동기화 중", error: "동기화 재시도 대기" };
const labels = { episode: "에피소드", plot: "플롯", memo: "메모" };
const icons = { episode: BookOpen, plot: FileText, memo: StickyNote };
// 파일 트리에서 회차가 이보다 많으면 이 단위로 묶어 접는다.
const EPISODE_GROUP = 20;
const empty: Library = {
  root: "",
  projects: [],
  documents: [],
  warnings: [],
  drafts: [],
  preferences: {},
  version: "",
};
type Dialog = {
  type: string;
  kind?: Kind;
  value?: string;
  description?: string;
  tags?: string[];
  writing?: WritingRules;
  manualLineBreak?: boolean | null;
};
type Destination = {
  view: "library" | "project" | "workspace";
  projectId: string;
  documentId?: string;
  tab?: Kind;
  archive?: boolean;
  pinned?: boolean;
};
type Navigation = { entries: Destination[]; index: number };
// 편집기 탭. VS Code처럼 고정되지 않은 탭(미리보기)은 다음 문서를 열 때 재사용된다.
type EditorTab = { id: string; pinned: boolean };
type EditorGroup = { tabs: EditorTab[]; docId: string };
type Side = "left" | "right";
function withoutTab(group: EditorGroup | null, id: string): EditorGroup | null {
  if (!group) return group;
  const index = group.tabs.findIndex((t) => t.id === id);
  if (index < 0) return group;
  const tabs = group.tabs.filter((t) => t.id !== id);
  if (!tabs.length) return null;
  const docId =
    group.docId === id ? (tabs[index] || tabs[index - 1]).id : group.docId;
  return { tabs, docId };
}
function placeTab(tabs: EditorTab[], id: string, pinned: boolean, after: string) {
  const index = tabs.findIndex((t) => t.id === id);
  if (index >= 0)
    return pinned && !tabs[index].pinned
      ? tabs.map((t, i) => (i === index ? { ...t, pinned: true } : t))
      : tabs;
  const previewIndex = pinned ? -1 : tabs.findIndex((t) => !t.pinned);
  if (previewIndex >= 0)
    return tabs.map((t, i) => (i === previewIndex ? { id, pinned } : t));
  const anchor = tabs.findIndex((t) => t.id === after);
  const next = [...tabs];
  next.splice(anchor < 0 ? next.length : anchor + 1, 0, { id, pinned });
  return next;
}
const initialNavigation = (): Navigation => ({
  entries: [{ view: "library", projectId: "" }], index: 0,
});
const settingPages = [
  { id: "editor", label: "기본 설정", icon: Settings },
  { id: "typesetting", label: "조판 형식", icon: Pilcrow },
  { id: "autocomplete", label: "자동 완성", icon: Sparkles },
  { id: "defaults", label: "작품 기본값", icon: BookOpen },
  { id: "storage", label: "보관 및 이력", icon: HardDrive },
  { id: "connections", label: "외부 저장소", icon: Cloud },
  { id: "api", label: "MCP / API", icon: Code2 },
  { id: "security", label: "앱 잠금", icon: LockKeyhole },
  { id: "updates", label: "앱 업데이트", icon: Download },
] as const;
function SettingsToggle({ label, description, checked, onChange }: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="settings-toggle">
      <span><span>{label}</span><small>{description}</small></span>
      <input type="checkbox" role="switch" aria-label={label} checked={checked}
        onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}
// VS Code 레이아웃 토글 아이콘: 패널이 열려 있으면 해당 영역을 채운다.
function LayoutIcon({ side, open }: { side: "left" | "right"; open: boolean }) {
  const x = side === "left" ? 2.5 : 10;
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" />
      <rect x={x} y="3" width="3.5" height="10" fill={open ? "currentColor" : "none"} />
      <path d={side === "left" ? "M6 3v10" : "M10 3v10"} stroke="currentColor" />
    </svg>
  );
}
export default function App() {
  const [lib, setLib] = useState<Library>(empty),
    [loaded, setLoaded] = useState(false),
    [view, setView] = useState("library"),
    [projectId, setProjectId] = useState(""),
    [active, setActive] = useState<Doc | null>(null),
    [tab, setTab] = useState<Kind>("episode"),
    [dialog, setDialog] = useState<Dialog | null>(null),
    [settingsPage, setSettingsPage] = useState<(typeof settingPages)[number]["id"]>("editor"),
    [typesettingKind, setTypesettingKind] = useState<"episode" | "document">("episode"),
    [newRepFrom, setNewRepFrom] = useState(""),
    [newRepTo, setNewRepTo] = useState(""),
    [newRepLabel, setNewRepLabel] = useState(""),
    [toast, setToast] = useState(""),
    // 토스트의 버튼(예: 속성 제거의 '실행 취소').
    [toastAction, setToastAction] = useState<{ label: string; run: () => void } | null>(null),
    [error, setError] = useState(""),
    [saveStatus, setSaveStatus] = useState("저장됨"),
    [conflict, setConflict] = useState(false),
    [source, setSource] = useState(false),
    [focus, setFocus] = useState(false),
    // 집중 모드의 파일 트리는 평소 상태와 따로 두고, 집중 모드에 들어갈 때마다 닫힌 채로 시작한다.
    [focusTree, setFocusTree] = useState(false),
    [viewer, setViewer] = useState<{ src: string; alt: string } | null>(null),
    [sidebar, setSidebar] = useState(true),
    [right, setRight] = useState(true),
    // 검색: 빠른 열기(Ctrl+P) 목록, 왼쪽 본문 검색 패널(Ctrl+Shift+F)과 검색 결과로 연 위치.
    [quickOpen, setQuickOpen] = useState(false),
    [quickItems, setQuickItems] = useState<QuickItem[]>([]),
    [searchOpen, setSearchOpen] = useState(false),
    [searchQuery, setSearchQuery] = useState(""),
    [searchCase, setSearchCase] = useState(false),
    [searchFocus, setSearchFocus] = useState(0),
    [reveal, setReveal] = useState<{
      docId: string;
      query: string;
      index: number;
      caseSensitive: boolean;
      seq: number;
    } | null>(null),
    [archive, setArchive] = useState(false),
    [history, setHistory] = useState<{ name: string }[]>([]),
    [preview, setPreview] = useState<any>(null),
    [prefs, setPrefs] = useState<Record<string, any>>({
      ...DEFAULT_EDITOR_STYLE,
      goal: 3000,
      theme: "light",
      colorTheme: "modern",
      autoCloseQuotes: true,
      autoCloseBrackets: true,
      smartBrackets: true,
      autoSymbolReplacement: true,
      autoDividerReplacement: true,
      quoteStyle: "straight",
    }),
    [connections, setConnections] = useState<any[]>([]),
    [autoSync, setAutoSync] = useState<AutoSyncStatus>({ phase: "idle", message: "" }),
    [connectionType, setConnectionType] = useState("folder"),
    [googleDriveEnabled, setGoogleDriveEnabled] = useState(false),
    [googleConnecting, setGoogleConnecting] = useState(false),
    [busy, setBusy] = useState(false),
    [sessionCount, setSessionCount] = useState(0),
    // 메모 세션(레일의 메모 버튼). 열려 있는 동안 집필 화면은 그대로 두고 가린다.
    [memoOpen, setMemoOpen] = useState(false),
    [commonMemoPath, setCommonMemoPath] = useState(""),
    // 본문 우클릭 '메모 추가'로 연 퀵 노트 창.
    [quickNote, setQuickNote] = useState<QuickNoteSource | null>(null),
    // 작품 삭제 확인: 작품 제목을 그대로 입력해야 삭제 버튼이 켜진다.
    [confirmTitle, setConfirmTitle] = useState(""),
    // 플롯 트리에서 접어 둔 회차, 플롯을 끌어 놓을 대상(회차 ID, 연결 해제는 "").
    [plotDrop, setPlotDrop] = useState<string | null>(null),
    // 메모 영역의 memo/ 폴더 목록, 펼친 폴더, 이름을 바꾸는 폴더.
    [memoEntries, setMemoEntries] = useState<{ path: string; name: string; type: string }[]>([]),
    [memoOpenFolders, setMemoOpenFolders] = useState<Set<string>>(new Set()),
    [folderRenaming, setFolderRenaming] = useState<{ path: string; value: string } | null>(null),
    // 파일 트리의 탭(에피소드·문서. 문서 탭에 'memo' 키를 쓴다)과 탭마다의 검색어.
    [treeTab, setTreeTab] = useState<"episode" | "memo">("episode"),
    [treeQuery, setTreeQuery] = useState({ episode: "", memo: "" }),
    // 문서 탭의 보기 범위(전체 문서·현재 회차만), 현재 회차, 현재 회차 보기에서 접어 둔 묶음.
    [docScope, setDocScope] = useState<"all" | "episode">("all"),
    [treeEpisodeId, setTreeEpisodeId] = useState(""),
    [closedDocGroups, setClosedDocGroups] = useState<Set<Kind>>(new Set()),
    // 회차가 많은 작품에서 펼친 회차 묶음(묶음 첫 회차의 목록 위치).
    [openEpisodeGroups, setOpenEpisodeGroups] = useState<Set<number>>(new Set()),
    // 위젯 보드 자리에 북마크 목록을 펼쳤는지, 목록에서 고른 북마크(문단 순서).
    [bookmarksOpen, setBookmarksOpen] = useState(false),
    [bookmarkJump, setBookmarkJump] = useState<{ docId: string; index: number; seq: number } | null>(null);
  const [editorTabs, setEditorTabs] = useState<EditorTab[]>([]),
    [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[]; target?: string } | null>(null),
    // 이름 바꾸기 입력칸. widget이면 위젯 보드의 '이 회차의 플롯' 목록에서, 아니면 파일 트리에서 받는다.
    [renaming, setRenaming] = useState<{ id: string; value: string; widget?: boolean } | null>(null),
    [dragTab, setDragTab] = useState(""),
    [dropZone, setDropZone] = useState<{ left: number; top: number; width: number } | null>(null);
  const editorTabsRef = useRef<EditorTab[]>([]),
    renamingRef = useRef<{ id: string; value: string; widget?: boolean } | null>(null);
  const memoFlush = useRef<(() => Promise<void>) | null>(null);
  // 메모 화면에서 메모를 여는 함수(빠른 열기에서 공용 메모를 고를 때).
  const memoApi = useRef<{ open: (space: string, path: string, pinned?: boolean) => Promise<void> } | null>(null);
  // 전역 단축키에서 늘 최신 검색 함수를 부르도록 한다.
  const searchActions = useRef({ openQuick: () => {}, openSearch: () => {} });
  // 파일 트리에서 끌고 있는 문서 ID(dragPlot)나 doc/ 폴더 경로(dragFolder).
  const dragPlot = useRef("");
  const dragFolder = useRef("");
  // 마지막 화면 복원이 끝나기 전에는 저장하지 않는다(시작 화면으로 덮어쓰지 않도록).
  const sessionRestored = useRef(false);
  const closeMenu = useCallback(() => setMenu(null), []);
  const closeViewer = useCallback(() => setViewer(null), []);
  const switchWasOpen = useRef(false);
  const tabActions = useRef<{
    closeTab: (id: string) => Promise<void>;
    cycleTab: (direction: number) => Promise<void>;
    splitTo: (id: string) => Promise<void>;
    focusSide: (side: Side) => Promise<void>;
    togglePreview: () => void;
    report: (e: any) => void;
  }>(null!);
  const updateTabs = useCallback((fn: (tabs: EditorTab[]) => EditorTab[]) => {
    const next = fn(editorTabsRef.current);
    if (next === editorTabsRef.current) return;
    editorTabsRef.current = next;
    setEditorTabs(next);
  }, []);
  // 분할 보기: 포커스된 그룹은 editorTabs/active가 맡고, 나머지 그룹은 split에 보관한다.
  // 그룹을 오갈 때 두 값을 맞바꾸므로 기존 탭 동작은 포커스된 그룹에만 적용된다.
  const [split, setSplit] = useState<EditorGroup | null>(null),
    [focusedSide, setFocusedSide] = useState<Side>("left"),
    [splitRatio, setSplitRatio] = useState(0.5),
    [sideDoc, setSideDoc] = useState<Doc | null>(null);
  const splitRef = useRef<EditorGroup | null>(null),
    groupsRef = useRef<HTMLDivElement>(null);
  const updateSplit = useCallback(
    (fn: (group: EditorGroup | null) => EditorGroup | null) => {
      const next = fn(splitRef.current);
      if (next === splitRef.current) return;
      splitRef.current = next;
      setSplit(next);
      if (!next) setFocusedSide("left");
    },
    [],
  );
  const [navigation, setNavigation] = useState<Navigation>(initialNavigation);
  const navigationRef = useRef(navigation);
  const libraryRef = useRef(lib);
  const draft = useRef<{ doc: Doc; seq: number; saved: number } | null>(null),
    saveChain = useRef(Promise.resolve()),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    composing = useRef(false),
    conflictRef = useRef(false),
    projectRef = useRef(""),
    activeId = useRef(""),
    sessionStart = useRef(0),
    refreshSeq = useRef(0),
    initialized = useRef(false),
    navigationSeq = useRef(0),
    toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingWriting = useRef(new Map<string, WritingRules>()),
    writingQueue = useRef(Promise.resolve());
  const project = lib.projects.find((p) => p.id === projectId);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const message = useCallback((text: string, action?: { label: string; run: () => void }) => {
    setToast(text);
    setToastAction(action ?? null);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => {
      setToast("");
      setToastAction(null);
    }, 4500);
  }, []);
  const report = useCallback((e: any) => {
    setError(e.message || String(e));
  }, []);
  const refresh = useCallback(async () => {
    const seq = ++refreshSeq.current;
    const data = await call<Library>("bootstrap");
    if (seq !== refreshSeq.current) return;
    data.projects = data.projects.map(p => pendingWriting.current.has(p.id) ? {...p, writing: pendingWriting.current.get(p.id)} : p);
    if(!initialized.current){
      const migratedPrefs = migrateTypingPreferences(data.preferences);
      if (migratedPrefs !== data.preferences) {
        await call("setPreferences", {
          textReplacements: migratedPrefs.textReplacements,
          textReplacementsVersion: migratedPrefs.textReplacementsVersion,
        });
        data.preferences = migratedPrefs;
      }
      initialized.current=true;
      setPrefs(p=>({...p,...data.preferences}));
      if(!data.preferences.setupComplete)setDialog({type:'setup',writing:normalizeWriting(data.preferences.defaultWriting)});
    }
    libraryRef.current = data;
    setLib(data);
    const ids = new Set(data.documents.map((d) => d.id));
    updateTabs((tabs) =>
      tabs.every((t) => ids.has(t.id)) ? tabs : tabs.filter((t) => ids.has(t.id)),
    );
    updateSplit((group) => {
      if (!group || group.tabs.every((t) => ids.has(t.id))) return group;
      const tabs = group.tabs.filter((t) => ids.has(t.id));
      if (!tabs.length) return null;
      return { tabs, docId: ids.has(group.docId) ? group.docId : tabs[0].id };
    });
    setLoaded(true);
    if (!projectRef.current && data.projects.length) {
      projectRef.current = data.projects[0].id;
      setProjectId(projectRef.current);
    }
    const d = draft.current;
    if (d) {
      const meta = data.documents.find((x) => x.id === d.doc.id);
      if (meta && (meta.revision !== d.doc.revision ||
          (meta.fingerprint !== d.doc.fingerprint && d.seq === d.saved))) {
        if (d.seq !== d.saved || composing.current) {
          conflictRef.current = true;
          setConflict(true);
          setSaveStatus("변경 충돌");
        } else {
          const latest = await call<Doc>("readDocument", { id: d.doc.id });
          if (draft.current === d && d.seq === d.saved) {
            draft.current = { doc: latest, seq: 0, saved: 0 };
            setActive(latest);
          }
        }
      } else if (meta && d.seq === d.saved &&
          (meta.title !== d.doc.title || meta.path !== d.doc.path || meta.relPath !== d.doc.relPath)) {
        // 본문은 그대로인데 이름만 바뀐 경우(회차 번호가 바뀌어 '003화 …' 이름이 따라 바뀐 경우 등).
        // 편집 중인 원고에도 반영해야 다음 저장 때 예전 이름으로 되돌리지 않는다.
        d.doc = { ...d.doc, title: meta.title, path: meta.path, relPath: meta.relPath };
        setActive({ ...d.doc });
      }
    }
    return data;
  }, [updateTabs, updateSplit]);
  const flush = useCallback(async ({ auto = false } = {}) => {
    if (!auto) await memoFlush.current?.();
    await writingQueue.current;
    if (timer.current) clearTimeout(timer.current);
    const run = async () => {
      const d = draft.current;
      if (!d || d.seq === d.saved) return;
      const seq = d.seq,
        payload = { ...d.doc, expectedRevision: d.doc.revision };
      await call("saveDraft", payload);
      if (conflictRef.current)
        throw Error(
          "변경 충돌을 해결해 주세요. 입력한 원고는 임시 저장되어 있습니다.",
        );
      if (composing.current) {
        // Autosave waits for compositionend, which schedules the next flush.
        if (auto) return;
        throw Error(composingError);
      }
      setSaveStatus("저장 중");
      try {
        const saved = await call<Doc>("saveDocument", payload);
        if (draft.current === d) {
          d.saved = seq;
          // 메모는 이름이 바뀌면 파일 경로로 만든 ID도 바뀐다.
          if (saved.id !== d.doc.id) replaceDocId(d.doc.id, saved.id);
          d.doc = {
            ...d.doc,
            id: saved.id,
            path: saved.path,
            relPath: saved.relPath,
            revision: saved.revision,
            fingerprint: saved.fingerprint,
            updatedAt: saved.updatedAt,
          };
          setActive({ ...d.doc });
          setError((e) => (e === composingError ? "" : e));
          setSaveStatus(d.seq === seq ? "저장됨" : "편집 중");
          if (d.seq === seq) await call("clearDraft", { id: d.doc.id });
        }
      } catch (e: any) {
        setSaveStatus(e.code === "CONFLICT" ? "변경 충돌" : "저장 실패");
        if (e.code === "CONFLICT") {
          conflictRef.current = true;
          setConflict(true);
        }
        throw e;
      }
    };
    const task = saveChain.current.then(run);
    saveChain.current = task.catch(() => {});
    return task;
  }, []);
  const updater = useAppUpdater({
    loaded,
    autoCheck: prefs.checkUpdatesOnStartup !== false,
    beforeInstall: async () => {
      if (busy) throw Error("진행 중인 작업이 끝난 뒤 다시 시도해 주세요.");
      if (composing.current) throw Error(composingError);
      await flush();
      const pending = draft.current;
      if (composing.current || (pending && pending.seq !== pending.saved))
        throw Error("원고 저장을 완료한 뒤 다시 시도해 주세요.");
      await call("setPreferences", {
        lastSession: {
          view: here.view,
          projectId: here.projectId,
          documentId: here.documentId,
          tabs: editorTabs,
          split,
          focusedSide,
          splitRatio,
          memoOpen,
        },
      });
    },
  });
  useEffect(() => {
    refresh().catch(report);
    const off = window.lof.onChange(() => {
      if (saveChain.current)
        saveChain.current.then(() => refresh()).catch(report);
    });
    const offFlush = window.lof.onFlush(flush);
    const offAutoSync = window.lof.onAutoSync?.(setAutoSync);
    if (window.lof.onAutoSync) call<AutoSyncStatus>("autoSyncStatus").then(setAutoSync).catch(() => {});
    return () => {
      off();
      offFlush();
      offAutoSync?.();
    };
  }, [refresh, flush, report]);
  function edit(patch: Partial<Doc>) {
    const d = draft.current;
    if (!d) return;
    // 수정 시 자동 상태 변경: 집필 예정인 회차에 내용을 쓰기 시작하면 집필 중으로 바꾼다.
    if (
      patch.body !== undefined &&
      patch.status === undefined &&
      d.doc.kind === "episode" &&
      normalizeStatus(d.doc.status) === "planned" &&
      patch.body.trim() &&
      prefsRef.current.autoChangeStatusOnContentEdit !== false
    )
      patch = { ...patch, status: "in_progress" };
    d.doc = { ...d.doc, ...patch };
    d.seq++;
    // VS Code처럼 미리보기 탭을 편집하면 고정 탭이 된다.
    updateTabs((tabs) =>
      tabs.some((t) => t.id === d.doc.id && !t.pinned)
        ? placeTab(tabs, d.doc.id, true, "")
        : tabs,
    );
    setActive({ ...d.doc });
    setSaveStatus("편집 중");
    if (timer.current) clearTimeout(timer.current);
    if (!composing.current)
      timer.current = setTimeout(() => flush({ auto: true }).catch(report), 650);
    if (patch.body !== undefined)
      setSessionCount(
        Math.max(0, characterCount(patch.body) - sessionStart.current),
      );
  }
  function composition(value: boolean) {
    composing.current = value;
    if (timer.current) clearTimeout(timer.current);
    if (!value)
      timer.current = setTimeout(() => flush({ auto: true }).catch(report), 800);
  }
  async function navigate(destination: Destination, historyIndex?: number) {
    const seq = ++navigationSeq.current;
    await flush();
    if (seq !== navigationSeq.current) return;
    const doc = destination.view === "workspace"
      ? await call<Doc>("readDocument", { id: destination.documentId }) : null;
    if (seq !== navigationSeq.current) return;
    const next: Destination = doc
      ? { view: "workspace", projectId: doc.projectId, documentId: doc.id, tab: doc.kind, archive: doc.archived }
      : { ...destination, projectId: destination.view === "library" ? "" : destination.projectId };
    if (next.view !== "library" && !libraryRef.current.projects.some(p => p.id === next.projectId))
      throw Error("작품을 찾을 수 없습니다.");
    // Commit the history cursor only after saving and loading both succeed.
    const previous = navigationRef.current;
    const entries = previous.entries.map((entry, index) => index === previous.index
      ? { ...entry, tab, archive } : entry);
    let updated: Navigation;
    if (historyIndex !== undefined) updated = { entries, index: historyIndex };
    else {
      const current = entries[previous.index];
      const same = current.view === next.view && current.projectId === next.projectId && current.documentId === next.documentId;
      if (same) {
        entries[previous.index] = next;
        updated = { entries, index: previous.index };
      } else {
        const branch = [...entries.slice(0, previous.index + 1), next].slice(-100);
        updated = { entries: branch, index: branch.length - 1 };
      }
    }
    navigationRef.current = updated;
    setNavigation(updated);
    setMemoOpen(false);
    if (doc) {
      if (doc.projectId !== projectRef.current) updateSplit(() => null);
      // 한 번 클릭한 문서는 미리보기 탭을 재사용하고, 명시적으로 열면 고정한다.
      updateTabs((tabs) =>
        placeTab(
          doc.projectId === projectRef.current ? tabs : [],
          doc.id,
          destination.pinned === true,
          activeId.current,
        ),
      );
      draft.current = { doc, seq: 0, saved: 0 };
      activeId.current = doc.id;
      sessionStart.current = characterCount(doc.body);
      setSessionCount(0);
      setActive(doc);
      setSaveStatus("저장됨");
      setConflict(false);
      conflictRef.current = false;
    }
    const id = next.view === "library" ? projectRef.current : next.projectId;
    setProjectId(id);
    projectRef.current = id;
    setView(next.view);
    if (next.tab) setTab(next.tab);
    if (next.archive !== undefined) setArchive(next.archive);
    setDialog(null);
  }
  async function openDoc(id: string, pinned = false) {
    await navigate({ view: "workspace", projectId: "", documentId: id, pinned });
  }
  async function closeTab(id: string) {
    const tabs = editorTabsRef.current,
      index = tabs.findIndex((t) => t.id === id);
    if (index < 0) return;
    if (view === "workspace" && id === activeId.current) {
      const rest = tabs.filter((t) => t.id !== id),
        next = rest[index] || rest[index - 1];
      if (next) await openDoc(next.id, false);
      else if (splitRef.current) return closeGroup();
      else await goView("project");
    }
    updateTabs((current) => current.filter((t) => t.id !== id));
  }
  // 포커스를 다른 그룹으로 옮긴다. openId가 있으면 그 문서를 그 그룹에서 연다.
  async function focusOther(openId?: string, pinned = false) {
    const other = splitRef.current;
    if (!other) return;
    await flush();
    const mine = { tabs: editorTabsRef.current, docId: activeId.current },
      side = focusedSide;
    editorTabsRef.current = other.tabs;
    setEditorTabs(other.tabs);
    splitRef.current = mine;
    setSplit(mine);
    setFocusedSide(side === "left" ? "right" : "left");
    try {
      await openDoc(openId ?? other.docId, pinned);
    } catch (e) {
      editorTabsRef.current = mine.tabs;
      setEditorTabs(mine.tabs);
      splitRef.current = other;
      setSplit(other);
      setFocusedSide(side);
      throw e;
    }
  }
  async function focusSide(side: Side) {
    if (splitRef.current && side !== focusedSide) await focusOther();
  }
  // VS Code의 오른쪽으로 분할(Ctrl+\). 이미 나뉘어 있으면 다른 그룹에서 연다.
  // 탭은 옮겨 가므로 원래 그룹에서 뺀다. 그룹에 탭이 하나뿐이면 그대로 둔다.
  async function splitTo(id: string) {
    if (splitRef.current) {
      await focusOther(id, true);
      updateSplit((group) =>
        group && group.tabs.length > 1 ? withoutTab(group, id) : group,
      );
      return;
    }
    await flush();
    const mine = { tabs: editorTabsRef.current, docId: activeId.current };
    editorTabsRef.current = [];
    setEditorTabs([]);
    updateSplit(() => (mine.tabs.length > 1 ? withoutTab(mine, id) : mine));
    setFocusedSide("right");
    try {
      await openDoc(id, true);
    } catch (e) {
      editorTabsRef.current = mine.tabs;
      setEditorTabs(mine.tabs);
      updateSplit(() => null);
      throw e;
    }
  }
  // 포커스된 그룹을 닫고 남은 그룹 하나로 돌아간다.
  async function closeGroup() {
    if (!splitRef.current) return;
    await focusOther();
    updateSplit(() => null);
  }
  async function moveToOther(id: string) {
    await focusOther(id, true);
    updateSplit((group) => withoutTab(group, id));
  }
  function closeSideTab(id: string) {
    updateSplit((group) => withoutTab(group, id));
  }
  async function closeTabs(keep: (tab: EditorTab, index: number) => boolean, focusId?: string) {
    const kept = editorTabsRef.current.filter(keep);
    if (view === "workspace" && !kept.some((t) => t.id === activeId.current)) {
      if (focusId && kept.some((t) => t.id === focusId)) await openDoc(focusId, false);
      else if (splitRef.current) return closeGroup();
      else await goView("project");
    }
    updateTabs((current) => current.filter((t) => kept.some((k) => k.id === t.id)));
  }
  async function cycleTab(direction: number) {
    const tabs = editorTabsRef.current,
      index = tabs.findIndex((t) => t.id === activeId.current);
    if (tabs.length < 2 || index < 0) return;
    await openDoc(tabs[(index + direction + tabs.length) % tabs.length].id, false);
  }
  function moveTab(from: string, to: string) {
    updateTabs((tabs) => {
      const a = tabs.findIndex((t) => t.id === from),
        b = tabs.findIndex((t) => t.id === to);
      if (a < 0 || b < 0 || a === b) return tabs;
      const next = [...tabs];
      next.splice(b, 0, ...next.splice(a, 1));
      return next;
    });
  }
  // 앱을 다시 열면 마지막으로 보던 화면(작품 페이지, 집필 중이던 문서와 탭·분할, 메모 화면)으로 연다.
  async function restoreSession(saved: any) {
    const data = libraryRef.current,
      ids = new Set(data.documents.map((d) => d.id)),
      hasProject = (id: string) => data.projects.some((p) => p.id === id);
    if (saved?.view === "workspace" && ids.has(saved.documentId)) {
      const doc = data.documents.find((d) => d.id === saved.documentId)!;
      const valid = (t: EditorTab) =>
        ids.has(t.id) && data.documents.find((d) => d.id === t.id)?.projectId === doc.projectId;
      projectRef.current = doc.projectId;
      setProjectId(doc.projectId);
      updateTabs(() => (Array.isArray(saved.tabs) ? saved.tabs.filter(valid) : []));
      const side = Array.isArray(saved.split?.tabs) ? saved.split.tabs.filter(valid) : [];
      if (side.length) {
        updateSplit(() => ({
          tabs: side,
          docId: side.some((t: EditorTab) => t.id === saved.split.docId) ? saved.split.docId : side[0].id,
        }));
        setFocusedSide(saved.focusedSide === "right" ? "right" : "left");
        setSplitRatio(Math.min(0.8, Math.max(0.2, Number(saved.splitRatio) || 0.5)));
      }
      await openDoc(saved.documentId);
    } else if (saved?.view === "project" && hasProject(saved.projectId))
      await goView("project", saved.projectId);
    if (saved?.memoOpen) setMemoOpen(true);
  }
  // 문서 ID가 바뀌었을 때(메모 이름 바꾸기) 탭·분할 보기·이동 기록이 새 ID를 가리키게 한다.
  function replaceDocId(oldId: string, newId: string) {
    const swap = (id: string) => (id === oldId ? newId : id);
    if (activeId.current === oldId) activeId.current = newId;
    updateTabs((tabs) =>
      tabs.some((t) => t.id === oldId) ? tabs.map((t) => ({ ...t, id: swap(t.id) })) : tabs,
    );
    updateSplit((g) =>
      g && (g.docId === oldId || g.tabs.some((t) => t.id === oldId))
        ? { docId: swap(g.docId), tabs: g.tabs.map((t) => ({ ...t, id: swap(t.id) })) }
        : g,
    );
    const nav = navigationRef.current;
    if (nav.entries.some((e) => e.documentId === oldId)) {
      const next = {
        ...nav,
        entries: nav.entries.map((e) =>
          e.documentId === oldId ? { ...e, documentId: newId } : e,
        ),
      };
      navigationRef.current = next;
      setNavigation(next);
    }
  }
  // 열려 있는 문서는 편집 중인 원고에 반영하고, 아니면 파일에 바로 저장한다.
  async function writeMeta(id: string, patch: Partial<Doc>) {
    if (draft.current?.doc.id === id) {
      edit(patch);
      await flush();
    } else {
      await flush();
      const doc = await call<Doc>("readDocument", { id });
      const saved = await call<Doc>("saveDocument", { id, ...patch, expectedRevision: doc.revision });
      if (saved.id !== id) replaceDocId(id, saved.id);
    }
  }
  async function patchDoc(id: string, patch: Partial<Doc>) {
    await writeMeta(id, patch);
    await refresh();
  }
  async function openBinding(id: string) {
    await flush();
    await refresh();
    setDialog({ type: "linkEpisode", value: id });
  }
  async function bindDocument(id: string, episodeId: string | null) {
    await patchDoc(id, { episodeId });
    message(episodeId ? "에피소드에 연결했습니다." : "연결을 해제했습니다. 독립 문서로 보관됩니다.");
  }
  async function commitRename() {
    const r = renamingRef.current;
    if (!r) return;
    renamingRef.current = null;
    setRenaming(null);
    const title = r.value.trim(),
      doc = libraryRef.current.documents.find((d) => d.id === r.id);
    if (!doc || !title || title === doc.title) return;
    await patchDoc(r.id, { title });
  }
  function startRename(doc: Doc, widget = false) {
    renamingRef.current = { id: doc.id, value: doc.title, widget };
    setRenaming(renamingRef.current);
  }
  async function archiveDoc(doc: Doc) {
    const archived = !doc.archived;
    await patchDoc(doc.id, { archived });
    if (archived) {
      await closeTab(doc.id);
      closeSideTab(doc.id);
    }
    message(archived ? "문서를 보관함으로 옮겼습니다." : "문서를 보관함에서 꺼냈습니다.");
  }
  // 영구 삭제: 편집 중인 내용을 먼저 저장하고 탭을 닫은 뒤 지운다.
  // 문서 파일은 Windows 휴지통으로 가고, 로컬 변경 이력은 보존 정책에 따라 남긴다.
  async function deleteDoc(doc: Doc) {
    await flush();
    await closeTab(doc.id);
    closeSideTab(doc.id);
    if (draft.current?.doc.id === doc.id) {
      draft.current = null;
      conflictRef.current = false;
      setConflict(false);
    }
    await call("deleteDocument", { id: doc.id });
    await refresh();
    message(`'${doc.title || "제목 없음"}' 문서를 영구 삭제했습니다.`);
  }
  // 작품 삭제: 작품 폴더 전체를 Windows 휴지통으로 옮긴다. 지금 보고 있는 작품이면 내 서재로 돌아간다.
  async function deleteProject(id: string) {
    const target = libraryRef.current.projects.find((p) => p.id === id);
    if (!target) return;
    await flush();
    if (projectRef.current === id) {
      await goView("library");
      draft.current = null;
      conflictRef.current = false;
      setConflict(false);
      setActive(null);
      updateTabs(() => []);
      updateSplit(() => null);
      projectRef.current = "";
      setProjectId("");
      resetNavigation();
    }
    await call("deleteProject", { id });
    await refresh();
    message(`'${target.title || "제목 없는 작품"}' 작품을 휴지통으로 옮겼습니다.`);
  }
  function askDeleteProject(id: string) {
    setConfirmTitle("");
    setDialog({ type: "deleteProject", value: id });
  }
  async function duplicateDoc(doc: Doc) {
    await flush();
    const source = await call<Doc>("readDocument", { id: doc.id });
    const copy = await call<Doc>("createDocument", {
      projectId: source.projectId,
      kind: source.kind,
      title: source.title + " 사본",
      body: source.body,
      tags: source.tags,
      manualLineBreak: !!source.manualLineBreak,
      episodeId: source.kind !== "episode" ? source.episodeId || undefined : undefined,
      properties: source.properties,
      ...(source.kind === "episode"
        ? {
            episodeType: source.episodeType,
            description: source.description,
            authorComment: source.authorComment,
          }
        : {}),
    });
    await refresh();
    await openDoc(copy.id, true);
  }
  async function copyPath(doc: Doc) {
    const meta = libraryRef.current.documents.find((d) => d.id === doc.id);
    if (!meta?.path) throw Error("파일 경로를 찾을 수 없습니다.");
    await navigator.clipboard.writeText(meta.path);
    message("파일 경로를 복사했습니다.");
  }
  async function copyDocManuscript(targetDoc: Doc, rawMarkdown?: boolean) {
    await flush();
    const latest =
      draft.current?.doc.id === targetDoc.id
        ? draft.current.doc
        : await call<Doc>("readDocument", { id: targetDoc.id });
    const copyAsMarkdown =
      rawMarkdown ??
      (active?.id === latest.id && (source || requiresSource(latest.body)));
    if (copyAsMarkdown) {
      await call("copyManuscript", { id: latest.id, text: latest.body });
      message("Markdown 원문을 복사했습니다.");
      return;
    }
    await call("copyManuscript", { id: latest.id, text: plainText(latest.body) });
    message("본문을 복사했습니다.");
  }
  function replaceActiveSymbols() {
    if (!active || isProtected) return;
    const ellipsisRule = prefs.autoSymbolReplacement !== false
      ? normalizeTextReplacements(prefs.textReplacements).find(
          (rule) => rule.enabled && rule.from === "..." && rule.from !== rule.to,
        )
      : undefined;
    const { body: nextBody, count } = replaceManuscriptSymbols(active.body, {
      doubleQuotes: prefs.quoteStyle === "curly",
      singleQuotes: prefs.quoteStyle === "curly",
      ellipsis: !!ellipsisRule,
      ellipsisChar: ellipsisRule?.to,
    });
    if (!count || nextBody === active.body) {
      message("교정할 직선 따옴표나 마침표 말줄임표가 없습니다.");
      return;
    }
    const prevBody = active.body;
    edit({ body: nextBody });
    message(`기호 일괄 교정 완료 (${count}건 변환)`, {
      label: "실행 취소",
      run: () => edit({ body: prevBody }),
    });
  }
  function openMenu(e: React.MouseEvent, items: MenuItem[], target?: string) {
    e.preventDefault();
    e.stopPropagation();
    let { clientX: x, clientY: y } = e;
    if (!x && !y) {
      // Shift+F10이나 메뉴 키로 열면 좌표가 없으므로 요소 기준으로 띄운다.
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      x = rect.left + 16;
      y = rect.bottom;
    }
    setMenu({ x, y, items, target });
  }
  // 파일 트리 위 작품 카드의 드롭다운: 다른 작품으로 바로 전환한다.
  function projectMenu(): MenuItem[] {
    const projects = [...lib.projects].sort((a, b) =>
      a.title.localeCompare(b.title, "ko"),
    );
    return [
      ...projects.map((p) => ({
        label: p.title || "제목 없는 작품",
        checked: p.id === projectId,
        action: attempt(() => switchProject(p.id)),
      })),
      "separator" as const,
      { label: "작품 페이지로 이동", action: attempt(() => goView("project")) },
      { label: "내 서재로 이동", action: attempt(() => goView("library")) },
    ];
  }
  // 그 작품에서 가장 최근에 수정한 문서를 연다. 문서가 없으면 작품 페이지로 간다.
  async function switchProject(id: string) {
    if (id === projectId) return;
    const recent = libraryRef.current.documents
      .filter((d) => d.projectId === id && !d.archived)
      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))[0];
    if (recent) await openDoc(recent.id);
    else await goView("project", id);
  }
  function docMenu(d: Doc): MenuItem[] {
    const siblings = lib.documents.filter(
        (x) => x.projectId === d.projectId && x.kind === d.kind && !x.archived,
      ),
      index = siblings.findIndex((x) => x.id === d.id),
      // 메모는 memo/ 폴더의 일반 파일이라 순서가 없다(보관 상태는 project.json에 기록된다).
      memo = d.kind === "memo";
    return [
      { label: "열기", action: attempt(() => openDoc(d.id, false)) },
      { label: "측면에서 열기", shortcut: "Ctrl+Enter", action: attempt(() => splitTo(d.id)) },
      "separator",
      { label: "이름 바꾸기", shortcut: "F2", action: () => startRename(d) },
      { label: "복제", action: attempt(() => duplicateDoc(d)) },
      ...(d.kind === "episode"
        ? ([
            "separator",
            ...statusItems(d.status, (status) =>
              attempt(async () => {
                await patchDoc(d.id, { status });
                if (status === "completed")
                  message("원고 보호 모드로 전환되었습니다. 집필 완료된 에피소드는 편집이 제한됩니다.");
              })(),
            ),
            "separator",
            ...plotItems(d),
          ] as MenuItem[])
        : []),
      ...(d.kind !== "episode"
        ? ([
            "separator",
            d.kind === "memo"
              ? { label: "플롯으로 바꾸기", action: attempt(() => patchDoc(d.id, { kind: "plot" })) }
              : { label: "메모로 바꾸기", action: attempt(() => patchDoc(d.id, { kind: "memo" })) },
            { label: d.episodeId ? "연결 회차 변경…" : "회차에 연결…", action: attempt(() => openBinding(d.id)) },
            ...(d.episodeId
              ? [{ label: "연결 해제하여 독립 문서로", action: attempt(() => bindDocument(d.id, null)) }]
              : []),
          ] as MenuItem[])
        : []),
      "separator",
      ...(memo
        ? []
        : ([
            { label: "위로 이동", disabled: d.archived || index <= 0, action: attempt(() => reorder(d.id, -1)) },
            { label: "아래로 이동", disabled: d.archived || index < 0 || index >= siblings.length - 1, action: attempt(() => reorder(d.id, 1)) },
            "separator",
          ] as MenuItem[])),
      { label: "파일 탐색기에서 표시", shortcut: "Shift+Alt+R", action: attempt(() => call("reveal", { id: d.id })) },
      { label: "경로 복사", shortcut: "Shift+Alt+C", action: attempt(() => copyPath(d)) },
      {
        label:
          active?.id === d.id && (source || requiresSource(active.body))
            ? "Markdown 원문 복사"
            : "본문 복사 (조판 적용)",
        action: attempt(() => copyDocManuscript(d)),
      },
      {
        label: "Markdown 내보내기",
        action: attempt(async () => {
          await flush();
          if (await call("exportDocument", { id: d.id })) message("원고를 내보냈습니다.");
        }),
      },
      "separator",
      d.archived
        ? { label: "보관 해제", action: attempt(() => archiveDoc(d)) }
        : { label: "보관함으로 이동", shortcut: "Delete", action: attempt(() => archiveDoc(d)) },
      {
        label: "영구 삭제",
        shortcut: "Shift+Delete",
        danger: true,
        action: () => setDialog({ type: "deleteDoc", value: d.id }),
      },
    ];
  }
  function tabMenu(t: EditorTab, index: number): MenuItem[] {
    const doc = lib.documents.find((d) => d.id === t.id);
    return [
      { label: "닫기", shortcut: "Ctrl+W", action: attempt(() => closeTab(t.id)) },
      { label: "다른 탭 닫기", disabled: editorTabs.length < 2, action: attempt(() => closeTabs((x) => x.id === t.id, t.id)) },
      { label: "오른쪽 탭 닫기", disabled: index >= editorTabs.length - 1, action: attempt(() => closeTabs((_, i) => i <= index, t.id)) },
      { label: "모두 닫기", action: attempt(() => closeTabs(() => false)) },
      "separator",
      { label: "탭 고정", disabled: t.pinned, action: () => updateTabs((tabs) => placeTab(tabs, t.id, true, "")) },
      "separator",
      split
        ? { label: "다른 그룹으로 이동", action: attempt(() => moveToOther(t.id)) }
        : { label: "오른쪽으로 분할", shortcut: "Ctrl+\\", action: attempt(() => splitTo(t.id)) },
      { label: "그룹 닫기", disabled: !split, action: attempt(closeGroup) },
      "separator",
      { label: "파일 탐색기에서 표시", disabled: !doc, action: attempt(() => call("reveal", { id: t.id })) },
      { label: "경로 복사", disabled: !doc, action: attempt(() => copyPath(doc!)) },
    ];
  }
  // 포커스되지 않은 그룹의 탭 메뉴.
  function sideTabMenu(t: EditorTab): MenuItem[] {
    const doc = lib.documents.find((d) => d.id === t.id);
    return [
      { label: "열기", action: attempt(() => focusOther(t.id)) },
      { label: "닫기", action: () => closeSideTab(t.id) },
      { label: "다른 그룹으로 이동", action: attempt(async () => {
        await openDoc(t.id, true);
        closeSideTab(t.id);
      }) },
      { label: "그룹 닫기", action: () => updateSplit(() => null) },
      "separator",
      { label: "파일 탐색기에서 표시", disabled: !doc, action: attempt(() => call("reveal", { id: t.id })) },
      { label: "경로 복사", disabled: !doc, action: attempt(() => copyPath(doc!)) },
    ];
  }
  function treeKey(e: React.KeyboardEvent, d: Doc) {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") attempt(() => splitTo(d.id))();
    else if (e.key === "F2") startRename(d);
    else if (e.key === "Delete" && e.shiftKey)
      setDialog({ type: "deleteDoc", value: d.id });
    else if (e.key === "Delete" && !d.archived) attempt(() => archiveDoc(d))();
    else if (e.shiftKey && e.altKey && e.code === "KeyR") attempt(() => call("reveal", { id: d.id }))();
    else if (e.shiftKey && e.altKey && e.code === "KeyC") attempt(() => copyPath(d))();
    else return;
    e.preventDefault();
  }
  async function goView(next: "library" | "project", id = projectId) {
    const sameProject = id === projectId;
    await navigate({ view: next, projectId: id,
      tab: sameProject ? tab : "episode", archive: sameProject ? archive : false });
  }
  async function travel(direction: number) {
    const current = navigationRef.current;
    const index = current.index + direction;
    if (index < 0 || index >= current.entries.length) return;
    await navigate(current.entries[index], index);
  }
  function resetNavigation() {
    ++navigationSeq.current;
    const next = initialNavigation();
    navigationRef.current = next;
    setNavigation(next);
  }
  // 새 문서는 대화상자 없이 기본 이름으로 바로 만들어 연 뒤, 파일 트리에서 이름을 입력받는다.
  // title을 주면(예: 메인 플롯) 그 이름으로 만들고 이름 입력은 건너뛴다. episodeId는 플롯을 회차에 연결한다.
  async function createDoc(
    kind: Kind,
    opts: { title?: string; episodeId?: string } = {},
  ) {
    await flush();
    const n =
      libraryRef.current.documents.filter(
        (d) => d.projectId === projectRef.current && d.kind === kind && !d.archived,
      ).length + 1;
    const doc = await call<Doc>("createDocument", {
      projectId: projectRef.current,
      kind,
      title: opts.title ?? (kind === "episode" ? `${n}화` : `새 ${labels[kind]}`),
      episodeId: opts.episodeId,
      ...(kind !== "episode"
        ? {
            manualLineBreak: true,
          }
        : {}),
    });
    await refresh();
    await openDoc(doc.id, true);
    if (focusRef.current) setFocusTree(true);
    else setSidebar(true);
    if (!opts.title) startRename(doc);
  }
  // 지금 보고 있는 회차(또는 지금 문서가 연결된 회차).
  function currentEpisode(): Doc | undefined {
    const a = draft.current?.doc;
    if (a?.kind === "episode") return a;
    return a?.episodeId
      ? libraryRef.current.documents.find((d) => d.id === a.episodeId && d.kind === "episode")
      : undefined;
  }
  const episodeNumber = (ep: Doc) => /^episodes\/(\d+)/.exec(ep.relPath || "")?.[1] ?? "";
  // 에피소드 우클릭: 그 회차에 연결된 플롯·메모를 doc/ 바로 아래에 만든다.
  function plotItems(ep: Doc): MenuItem[] {
    return [
      { label: "이 회차에 플롯 만들기", disabled: archive, action: attempt(() => addDocFile("", "plot", ep)) },
      { label: "이 회차에 메모 만들기", disabled: archive, action: attempt(() => addDocFile("", "memo", ep)) },
    ];
  }
  // 문서 추가 메뉴: 플롯·메모. 회차를 보고 있으면 그 회차에 연결해 만드는 항목도 함께 보인다.
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
  // 문서·폴더를 끌어 다른 폴더(빈 곳이면 doc/ 맨 위)에 놓으면 그 폴더로 옮긴다.
  // 같은 폴더로 옮기거나 폴더를 자기 안으로 옮기는 것은 받지 않는다.
  const parentOfRel = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")));
  function folderDropProps(folder: string) {
    const key = "folder:" + folder;
    const canDrop = () => {
      if (dragPlot.current) {
        const d = libraryRef.current.documents.find((x) => x.id === dragPlot.current);
        return !!d && d.kind !== "episode" && parentOfRel((d.relPath || "").slice(4)) !== folder;
      }
      const from = dragFolder.current;
      return !!from && from !== folder && !folder.startsWith(from + "/") && parentOfRel(from) !== folder;
    };
    return {
      onDragOver: (e: React.DragEvent) => {
        if (!canDrop()) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        setPlotDrop(key);
      },
      onDragLeave: (e: React.DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node))
          setPlotDrop((t) => (t === key ? null : t));
      },
      onDrop: (e: React.DragEvent) => {
        if (!canDrop()) return;
        e.preventDefault();
        e.stopPropagation();
        const docId = dragPlot.current,
          from = dragFolder.current;
        dragPlot.current = "";
        dragFolder.current = "";
        setPlotDrop(null);
        const d = docId ? libraryRef.current.documents.find((x) => x.id === docId) : undefined;
        const path = d ? (d.relPath || "").slice(4) : from;
        if (path) attempt(() => moveDocPath(path, folder))();
      },
    };
  }
  // doc/ 안의 문서나 폴더(path)를 다른 폴더(to, 맨 위는 "")로 옮긴다.
  async function moveDocPath(path: string, to: string) {
    await flush();
    const from = "doc/" + path,
      inside = libraryRef.current.documents.filter(
        (d) =>
          d.projectId === projectRef.current &&
          (d.relPath === from || d.relPath?.startsWith(from + "/")),
      );
    const r = await call<{ path: string }>("memoMove", { space: projectRef.current, path, to });
    await remapMovedDocs(inside, from, "doc/" + r.path);
    setMemoOpenFolders(
      (old) =>
        new Set([
          ...[...old].map((p) => (p === path || p.startsWith(path + "/") ? r.path + p.slice(path.length) : p)),
          ...(to ? [to] : []),
        ]),
    );
    await loadMemoFolders();
  }
  // 문서 ID를 유지한 채 파일 경로와 열린 원고의 위치 정보만 갱신한다.
  async function remapMovedDocs(before: Doc[], from: string, to: string) {
    await refresh();
    for (const d of before) {
      const rel = to + d.relPath!.slice(from.length),
        next = libraryRef.current.documents.find(
          (x) => x.projectId === projectRef.current && x.relPath === rel,
        );
      if (!next) continue;
      if (next.id !== d.id) replaceDocId(d.id, next.id);
      if (draft.current?.doc.id === d.id) {
        draft.current.doc = { ...draft.current.doc, id: next.id, path: next.path, relPath: rel };
        setActive({ ...draft.current.doc });
      }
    }
  }
  // 문서를 끌어 에피소드에 놓으면 그 회차에 연결한다.
  function plotDropProps(target: string) {
    return {
      onDragOver: (e: React.DragEvent) => {
        if (!dragPlot.current) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        setPlotDrop(target);
      },
      onDragLeave: (e: React.DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node))
          setPlotDrop((t) => (t === target ? null : t));
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const id = dragPlot.current;
        dragPlot.current = "";
        setPlotDrop(null);
        const d = libraryRef.current.documents.find((x) => x.id === id);
        if (!d || (d.episodeId ?? "") === target) return;
        attempt(() => patchDoc(id, { episodeId: target || null }))();
      },
    };
  }
  useEffect(() => {
    if (!loaded || sessionRestored.current) return;
    restoreSession(libraryRef.current.preferences?.lastSession)
      .catch(report)
      .finally(() => {
        sessionRestored.current = true;
      });
  }, [loaded]);
  useEffect(() => {
    if (view === "workspace" && projectId) loadMemoFolders().catch(() => {});
  }, [view, projectId, lib]);
  const here = navigation.entries[navigation.index];
  useEffect(() => {
    if (!sessionRestored.current) return;
    const t = setTimeout(() => {
      call("setPreferences", {
        lastSession: {
          view: here.view,
          projectId: here.projectId,
          documentId: here.documentId,
          tabs: editorTabs,
          split,
          focusedSide,
          splitRatio,
          memoOpen,
        },
      }).catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [here, editorTabs, split, focusedSide, splitRatio, memoOpen]);
  async function savePrefs(p: Record<string, any>) {
    let payload = p;
    if (
      !p.typesettingByKind &&
      (p.fontSize !== undefined || p.lineHeight !== undefined) &&
      prefsRef.current.typesettingByKind?.episode
    ) {
      const epSync: Record<string, any> = {};
      if (p.fontSize !== undefined) epSync.fontSize = p.fontSize;
      if (p.lineHeight !== undefined) epSync.lineHeight = p.lineHeight;
      payload = {
        ...p,
        typesettingByKind: {
          ...prefsRef.current.typesettingByKind,
          episode: {
            ...prefsRef.current.typesettingByKind.episode,
            ...epSync,
          },
        },
      };
    }
    setPrefs((old) => ({ ...old, ...payload }));
    await call("setPreferences", payload);
  }
  async function saveKindPrefs(kind: Kind | "document", patch: Record<string, any>) {
    const targetKey = kind === "episode" ? "episode" : "document";
    const currentByKind =
      prefsRef.current.typesettingByKind && typeof prefsRef.current.typesettingByKind === "object"
        ? prefsRef.current.typesettingByKind
        : {};
    const prevForKind =
      targetKey === "document"
        ? currentByKind.document && typeof currentByKind.document === "object"
          ? currentByKind.document
          : currentByKind.plot && typeof currentByKind.plot === "object"
            ? currentByKind.plot
            : currentByKind.memo && typeof currentByKind.memo === "object"
              ? currentByKind.memo
              : {}
        : currentByKind.episode && typeof currentByKind.episode === "object"
          ? currentByKind.episode
          : {};
    const nextByKind = {
      ...currentByKind,
      [targetKey]: {
        ...prevForKind,
        ...patch,
      },
    };
    const fullPatch: Record<string, any> =
      targetKey === "episode"
        ? { ...patch, typesettingByKind: nextByKind }
        : { typesettingByKind: nextByKind };
    await savePrefs(fullPatch);
  }
  async function openSettings() {
    await flush();
    const s = await call("settings");
    setConnections(s.connections);
    setGoogleDriveEnabled(s.googleDriveEnabled === true);
    if (!s.googleDriveEnabled && connectionType === "google-drive") setConnectionType("folder");
    if (s.autoSync) setAutoSync(s.autoSync);
    setCommonMemoPath(s.commonMemoPath || "");
    if (active?.kind) setTypesettingKind(active.kind === "episode" ? "episode" : "document");
    setDialog({ type: "settings" });
  }
  async function chooseVault() {
    setBusy(true);
    try {
      await flush();
      if (!await call("chooseVault")) return;
      draft.current = null;
      activeId.current = "";
      setActive(null);
      updateTabs(() => []);
      updateSplit(() => null);
      setMemoOpen(false);
      projectRef.current = "";
      setProjectId("");
      setView("library");
      resetNavigation();
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  async function connectGoogleDrive(args: { id?: string; name?: string }) {
    if (!googleDriveEnabled) return;
    setBusy(true);
    try {
      await flush();
      setGoogleConnecting(true);
      await call("connectGoogleDrive", args);
      setConnections((await call("settings")).connections);
      message("Google 계정을 연결했습니다. 자동 동기화를 시작합니다.");
    } catch (e: any) {
      if (e.code === "CANCELLED") message("Google Drive 연결을 취소했습니다.");
      else report(e);
    } finally {
      setGoogleConnecting(false);
      setBusy(false);
    }
  }
  async function doSync(id: string) {
    setBusy(true);
    try {
      await flush();
      const result = await call("sync", { id });
      await refresh();
      message(
        `동기화 완료 · 받음 ${result.downloaded} · 보냄 ${result.uploaded} · 충돌 사본 ${result.conflicts}${result.removed ? " · 다른 장치에서 삭제 " + result.removed : ""}${result.projectConflicts ? " · 작품 정보 충돌 " + result.projectConflicts + "개 (.lof/project-conflicts에 보관)" : ""}`,
      );
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  async function showHistory() {
    await flush();
    if (!active) return;
    setHistory(await call("history", { id: active.id }));
    setPreview(null);
    setDialog({ type: "history" });
  }
  async function resolveConflict() {
    const d = draft.current;
    if (!d) return;
    const copy = await call<Doc>("createDocument", {
      projectId: d.doc.projectId,
      kind: d.doc.kind,
      title: d.doc.title + " (내 편집 사본)",
      body: d.doc.body,
    });
    await call("clearDraft", { id: d.doc.id });
    draft.current = null;
    conflictRef.current = false;
    setConflict(false);
    await refresh();
    await openDoc(copy.id, true);
    message("내 편집을 새 문서로 보존했습니다. 기존 문서도 유지됩니다.");
  }
  async function reorder(id: string, direction: number) {
    await flush();
    const target = libraryRef.current.documents.find((d) => d.id === id);
    if (!target) return;
    const items = libraryRef.current.documents.filter(
        (d) =>
          d.projectId === target.projectId && d.kind === target.kind && !d.archived,
      ),
      index = items.findIndex((d) => d.id === id);
    if (index < 0 || !items[index + direction]) return;
    // 자리를 바꾼 목록을 한 번에 저장한다. 저장소가 0, 1, 2…로 다시 매기고 파일 이름 번호도 맞춘다.
    const next = [...items];
    next.splice(index + direction, 0, ...next.splice(index, 1));
    await call("reorderDocuments", {
      projectId: target.projectId,
      ids: next.map((d) => d.id),
    });
    await refresh();
  }
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (document.documentElement.dataset.pinLocked === "true") return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        flush()
          .then(() => message("저장했습니다."))
          .catch(report);
      }
      // VS Code와 같은 검색 단축키: Ctrl+P 파일 이름으로 열기, Ctrl+Shift+F 본문 검색.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === "KeyP") {
        e.preventDefault();
        searchActions.current.openQuick();
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyF") {
        e.preventDefault();
        searchActions.current.openSearch();
      }
      if (e.key === "F11") {
        e.preventDefault();
        setFocus((f) => !f);
      }
      if (e.key === "Escape")
        setDialog((d) => (d?.type === "setup" ? d : null));
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [flush, message, report]);
  // 대화상자가 열린 동안 네이티브 창 버튼도 배경막처럼 어둡게 한다.
  const dimmed = !!dialog;
  useEffect(() => {
    call("setTitleBarDimmed", { dimmed }).catch(() => {});
  }, [dimmed]);
  const attempt = (fn: () => Promise<any>) => () => fn().catch(report);
  // ---- 검색 ----
  // 빠른 열기(Ctrl+P): 지금 작품(없으면 모든 작품)의 회차·플롯·메모와 공용 메모를 파일 이름으로 찾는다.
  async function openQuick() {
    const data = libraryRef.current,
      pid = projectRef.current,
      title = (id: string) => data.projects.find((p) => p.id === id)?.title || "제목 없는 작품";
    const docsItems: QuickItem[] = data.documents
      .filter((d) => !pid || d.projectId === pid)
      .map((d) => {
        const rel = d.relPath?.replace(/^(?:assets|doc|episodes|plot|memo)\//i, "");
        return {
          key: "doc:" + d.id,
          label: d.title || "제목 없음",
          detail: `${pid ? "" : title(d.projectId) + " · "}${rel || labels[d.kind]}${d.archived ? " · 보관" : ""}`,
          icon: d.kind,
          updatedAt: d.updatedAt,
        };
      });
    const common = await call<{ entries: { path: string; name: string; type: string; updatedAt?: string }[] }>(
      "memoTree",
      { space: "common" },
    ).catch(() => ({ entries: [] }));
    setQuickItems([
      ...docsItems,
      ...common.entries
        .filter((e) => e.type === "file")
        .map((e) => ({
          key: "common:" + e.path,
          label: e.name,
          detail: "공용 메모 · " + e.path,
          icon: "common" as const,
          updatedAt: e.updatedAt,
        })),
    ]);
    setQuickOpen(true);
  }
  async function pickQuick(item: QuickItem) {
    setQuickOpen(false);
    if (item.key.startsWith("common:")) {
      await flush();
      setMemoOpen(true);
      await memoApi.current?.open("common", item.key.slice(7), true);
    } else {
      setMemoOpen(false);
      await openDoc(item.key.slice(4), true);
    }
  }
  // 본문 검색(Ctrl+Shift+F): 왼쪽에 검색 패널을 연다. 이미 열려 있으면 입력칸에 포커스만 준다.
  function openSearch() {
    flush().catch(report);
    setMemoOpen(false);
    setSearchOpen(true);
    setSearchFocus((n) => n + 1);
  }
  async function openSearchResult(r: SearchResult, m: SearchMatch, pinned = false) {
    setMemoOpen(false);
    await openDoc(r.id, pinned);
    if (activeId.current !== r.id) return;
    setReveal({
      docId: r.id,
      query: searchQuery,
      index: m.index,
      caseSensitive: searchCase,
      seq: Date.now(),
    });
  }
  searchActions.current = { openQuick: () => openQuick().catch(report), openSearch };
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
  const treeMatch = (text: string, query: string) => text.toLowerCase().includes(query.trim().toLowerCase());
  const writingRules = normalizeWriting(project?.writing || prefs.defaultWriting);
  const stats = active ? manuscriptStats(active.body) : null;
  // 원고 보호: 집필 완료인 회차는 제목과 본문을 고칠 수 없다(상태는 바꿀 수 있다).
  const isProtected = active?.kind === "episode" && normalizeStatus(active.status) === "completed";
  const platformChars = stats ? countForWriting(stats, writingRules) : 0;
  // 상태줄의 두 번째 값: 공백 포함·줄바꿈 제외(위젯 보드의 같은 항목과 동일한 계산).
  const charsWithSpaces = stats ? countForRule(stats, "spaces", writingRules.unit) : 0;
  const goal = Number(writingRules.goal) || 0;
  const isWorkspace = view === "workspace" && !!active && !memoOpen;
  // 문서를 연 집중 모드에서만 창을 작게 줄일 수 있다. 끄면 원래 최소 크기로 돌아간다.
  const compactWindow = focus && isWorkspace;
  useEffect(() => {
    call("setCompactWindow", { compact: compactWindow }).catch(() => {});
  }, [compactWindow]);
  const treeOpen = focus ? focusTree : sidebar;
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const toggleTree = useCallback(() => {
    if (focusRef.current) setFocusTree((t) => !t);
    else setSidebar((s) => !s);
  }, []);
  useEffect(() => setFocusTree(false), [focus]);
  // 탭이 많아 스트립이 가로로 넘치면 새로 열린 탭이 화면 밖에 있어 열리지 않은 것처럼 보인다.
  const currentTabId = active?.id;
  useEffect(() => {
    document
      .querySelector<HTMLElement>(".editor-group.focused .editor-tab.current, .editor-groups:not(.split) .editor-tab.current")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [currentTabId, editorTabs.length]);
  // 포커스되지 않은 그룹의 문서는 저장될 때마다(리비전이 바뀔 때) 다시 읽는다.
  const sideId = split?.docId || "",
    sideRevision = lib.documents.find((d) => d.id === sideId)?.revision;
  useEffect(() => {
    if (!sideId || sideId === active?.id) return;
    let canceled = false;
    call<Doc>("readDocument", { id: sideId })
      .then((d) => {
        if (!canceled) setSideDoc(d);
      })
      .catch(report);
    return () => {
      canceled = true;
    };
  }, [sideId, sideRevision, active?.id, report]);
  const shownSide = !split
    ? null
    : split.docId === active?.id
      ? active
      : sideDoc?.id === split.docId
        ? sideDoc
        : null;
  const groupStyle = (side: Side) =>
    split
      ? side === "left"
        ? { flex: `0 0 calc(${splitRatio * 100}% - 2px)` }
        : { flex: "1 1 0" }
      : undefined;
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
  // 탭을 편집기 본문으로 끌어 분할한다. 분할 전에는 오른쪽 절반, 분할 뒤에는 다른 그룹이 놓을 곳이다.
  function dragOverGroups(e: React.DragEvent) {
    if (!dragTab) return;
    const target = e.target as HTMLElement,
      group = target.closest<HTMLElement>(".editor-group"),
      box = groupsRef.current?.getBoundingClientRect();
    let zone: typeof dropZone = null;
    if (group && box && !target.closest(".editor-tabs")) {
      const r = group.getBoundingClientRect(),
        top = r.top - box.top;
      if (group.classList.contains("inactive"))
        zone = { left: r.left - box.left, top, width: r.width };
      else if (!split && e.clientX > r.left + r.width / 2)
        zone = { left: r.left - box.left + r.width / 2, top, width: r.width / 2 };
    }
    if (zone) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
    setDropZone((prev) =>
      prev && zone && prev.left === zone.left && prev.top === zone.top && prev.width === zone.width
        ? prev
        : zone,
    );
  }
  function dropOnGroups(e: React.DragEvent) {
    const id = dragTab;
    if (!dropZone || !id) return;
    e.preventDefault();
    setDropZone(null);
    setDragTab("");
    // 분할된 상태에서 마지막 탭을 옮기면 빈 그룹은 닫힌다.
    attempt(() => (split ? moveToOther(id) : splitTo(id)))();
  }
  function manuscriptBoxForKind(kind: Kind = "episode") {
    const kindPrefs = resolveKindPrefs(prefs, kind);
    const norm = normalizeEditorStyle(prefs, kind);
    return {
      kindPrefs,
      norm,
      className: `manuscript${norm.pageViewEnabled ? " page-view-manuscript" : ""}${norm.textareaBgColor ? " has-sheet-bg" : ""}`,
      style: {
        maxWidth: norm.pageViewEnabled
          ? undefined
          : `${norm.editorMaxWidth}px`,
        paddingLeft: norm.pageViewEnabled
          ? undefined
          : `${norm.editorPaddingX * 0.25}rem`,
        paddingRight: norm.pageViewEnabled
          ? undefined
          : `${norm.editorPaddingX * 0.25}rem`,
        backgroundColor: norm.textareaBgColor || undefined,
        color: norm.editorTextColor || undefined,
        ["--editor-max-width" as any]: `${norm.editorMaxWidth}px`,
        ["--editor-padding-x" as any]: `${norm.editorPaddingX * 0.25}rem`,
        ["--textarea-bg-color" as any]:
          norm.textareaBgColor || "transparent",
        ["--editor-text-color" as any]:
          norm.editorTextColor || "inherit",
      } as React.CSSProperties,
    };
  }
  const activeBox = manuscriptBoxForKind(active?.kind || "episode");
  const manuscriptClassName = activeBox.className;
  const manuscriptStyle = activeBox.style;
  // 포커스되지 않은 그룹: 읽기 전용으로 보여 주고, 클릭하면 그 그룹으로 포커스를 옮긴다.
  function sideGroup() {
    if (!split || !active) return null;
    const doc = shownSide;
    const sideBox = doc ? manuscriptBoxForKind(doc.kind) : null;
    return (
      <section
        key="side"
        className="editor-group inactive"
        style={groupStyle(focusedSide === "left" ? "right" : "left")}
      >
        <div className="editor-tabs" role="tablist" aria-label="다른 그룹의 열린 문서">
          {split.tabs.map((t) => {
            const meta =
              t.id === active.id ? active : lib.documents.find((d) => d.id === t.id);
            if (!meta) return null;
            const current = t.id === split.docId,
              Icon = icons[meta.kind],
              title = meta.title || "제목 없음";
            return (
              <div
                key={t.id}
                role="tab"
                tabIndex={-1}
                aria-selected={current}
                title={t.pinned ? title : `${title} (미리보기)`}
                className={`editor-tab ${current ? "current" : ""} ${t.pinned ? "" : "preview"} ${menu?.target === "side:" + t.id ? "context-target" : ""}`}
                onClick={attempt(() => focusOther(t.id))}
                onDoubleClick={attempt(() => focusOther(t.id, true))}
                onMouseDown={(e) => {
                  if (e.button === 1) e.preventDefault();
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) closeSideTab(t.id);
                }}
                onContextMenu={(e) => openMenu(e, sideTabMenu(t), "side:" + t.id)}
              >
                <Icon size={14} />
                <span>{title}</span>
                <button
                  aria-label={`다른 그룹의 ${title} 닫기`}
                  title="닫기"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeSideTab(t.id);
                  }}
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>
        <div
          className="group-body"
          aria-label="다른 편집기 그룹"
          onMouseDown={(e) => {
            if (e.button === 0) attempt(() => focusOther())();
          }}
        >
          <div className="editor-actions">
            <span className="save-indicator">
              <span />
              클릭하면 이 그룹에서 편집합니다
            </span>
          </div>
          <div className="editor-scroll">
            {doc && sideBox && (
              <article className={sideBox.className} style={sideBox.style}>
                <div className="document-kind">
                  {labels[doc.kind]} · {numberOf(doc)}
                </div>
                <div className="document-title static">{doc.title}</div>
                {doc.kind === "episode" && (
                  <div className="document-details">
                    <span className="status-label">{STATUS_LABELS[normalizeStatus(doc.status)]}</span>
                  </div>
                )}
                <Writer
                  key={"side-" + doc.id}
                  manualLineBreak={!!doc.manualLineBreak}
                  id={doc.id}
                  revision={doc.revision}
                  body={doc.body}
                  tables={doc.kind === "memo" || doc.kind === "plot"}
                  readOnly
                  onChange={() => {}}
                  fontSize={sideBox.norm.fontSize}
                  lineHeight={sideBox.norm.lineHeight}
                  source={source}
                  onComposition={() => {}}
                  typingOptions={{}}
                  editorStyle={sideBox.kindPrefs}
                  bookmarks={doc.bookmarks}
                />
              </article>
            )}
          </div>
        </div>
      </section>
    );
  }
  function startSash(e: React.PointerEvent) {
    e.preventDefault();
    const box = groupsRef.current?.getBoundingClientRect();
    if (!box) return;
    const move = (ev: PointerEvent) =>
      setSplitRatio(
        Math.min(0.8, Math.max(0.2, (ev.clientX - box.left) / box.width)),
      );
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("sash-dragging");
    };
    document.body.classList.add("sash-dragging");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  const [previewOpen, setPreviewOpen] = useState(false);
  const chordAt = useRef(0);
  const togglePreview = () => setPreviewOpen((open) => !open);
  tabActions.current = { closeTab, cycleTab, splitTo, focusSide, togglePreview, report };
  useEffect(() => {
    if (!isWorkspace) return;
    // VS Code 배치: Ctrl+B 기본 사이드바(파일 트리), Ctrl+Alt+B 보조 사이드바(메모 보드).
    // 캡처 단계에서 가로채 에디터의 Ctrl+B(굵게)보다 먼저 처리한다.
    // 탭: Ctrl+W 닫기, Ctrl+PageDown/PageUp·Ctrl+Tab/Ctrl+Shift+Tab 이동.
    // 모바일 미리보기: VS Code의 측면 미리 보기처럼 Ctrl+K 다음 V.
    const handler = (e: KeyboardEvent) => {
      if (document.documentElement.dataset.pinLocked === "true") return;
      if (updater.lockRef.current) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      const { closeTab, cycleTab, splitTo, focusSide, togglePreview, report } =
        tabActions.current;
      const chord = chordAt.current && Date.now() - chordAt.current < 1500;
      chordAt.current = 0;
      if (chord && e.code === "KeyV" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        togglePreview();
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.code === "KeyK" && !e.shiftKey && !e.altKey)
        chordAt.current = Date.now();
      else if (e.code === "Backslash" && !e.shiftKey && !e.altKey)
        splitTo(activeId.current).catch(report);
      else if ((e.code === "Digit1" || e.code === "Digit2") && !e.shiftKey && !e.altKey)
        focusSide(e.code === "Digit1" ? "left" : "right").catch(report);
      else if (e.code === "KeyB" && !e.shiftKey) {
        if (e.altKey) setRight((r) => !r);
        else toggleTree();
      } else if (e.code === "KeyW" && !e.shiftKey && !e.altKey)
        closeTab(activeId.current).catch(report);
      else if (e.key === "PageDown" || (e.key === "Tab" && !e.shiftKey))
        cycleTab(1).catch(report);
      else if (e.key === "PageUp" || (e.key === "Tab" && e.shiftKey))
        cycleTab(-1).catch(report);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [isWorkspace]);
  // 파일 트리의 문서 한 줄. episode면 플롯을 끌어 놓을 수 있고, plot이면 끌 수 있다.
  function treeRow(
    d: Doc,
    marker: React.ReactNode,
    opts: {
      depth?: number;
      episode?: boolean;
      plot?: boolean;
      remove?: boolean;
      badge?: string;
      // 문서 영역에서 이 줄 위에 놓으면 옮길 폴더(이 문서가 있는 폴더).
      dropFolder?: string;
    } = {},
  ) {
    const style = opts.depth ? { paddingLeft: 8 + opts.depth * 16 } : undefined;
    const className = `tree-item ${d.id === active?.id ? "current" : ""} ${menu?.target === d.id ? "context-target" : ""} ${opts.episode && plotDrop === d.id ? "drop-target" : ""}`;
    if (renaming?.id === d.id && !renaming.widget)
      return (
        <div key={d.id} className={`${className} renaming`} style={style}>
          {marker}
          <input
            className="tree-rename"
            aria-label="새 이름"
            autoFocus
            value={renaming.value}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => {
              renamingRef.current = { id: d.id, value: e.target.value };
              setRenaming(renamingRef.current);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") attempt(commitRename)();
              else if (e.key === "Escape") {
                renamingRef.current = null;
                setRenaming(null);
              }
            }}
            onBlur={attempt(commitRename)}
          />
        </div>
      );
    return (
      <button
        key={d.id}
        className={className}
        style={style}
        onClick={attempt(() => openDoc(d.id, false))}
        onDoubleClick={attempt(() => openDoc(d.id, true))}
        onKeyDown={(e) => treeKey(e, d)}
        onContextMenu={(e) => openMenu(e, docMenu(d), d.id)}
        draggable={!!opts.plot}
        onDragStart={
          opts.plot
            ? (e) => {
                dragPlot.current = d.id;
                e.dataTransfer.effectAllowed = "move";
              }
            : undefined
        }
        onDragEnd={
          opts.plot
            ? () => {
                dragPlot.current = "";
                setPlotDrop(null);
              }
            : undefined
        }
        {...(opts.episode ? plotDropProps(d.id) : {})}
        {...(opts.dropFolder !== undefined ? folderDropProps(opts.dropFolder) : {})}
      >
        {marker}
        <span>{d.title}</span>
        {d.kind === "episode" && normalizeStatus(d.status) === "completed" && (
          <Check size={12} aria-label="집필 완료" />
        )}
        {opts.badge && (
          <small className="tree-badge" title={`${opts.badge}화에 연결됨`}>
            {opts.badge}화
          </small>
        )}
        {/* 호버하면 줄 오른쪽 끝에 겹쳐 뜨는 버튼(줄 높이와 글자 위치는 그대로). */}
        <span className="tree-actions">
          <span
            className="tree-action"
            role="button"
            tabIndex={-1}
            title={d.archived ? "보관 해제" : "보관함으로 이동"}
            aria-label={`${d.title} ${d.archived ? "보관 해제" : "보관"}`}
            onClick={(e) => {
              e.stopPropagation();
              attempt(() => archiveDoc(d))();
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {d.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
          </span>
          {/* 플롯·메모 트리에서는 삭제 버튼도 보인다(확인 창을 거쳐 휴지통으로). */}
          {opts.remove && (
            <span
              className="tree-action"
              role="button"
              tabIndex={-1}
              title="삭제"
              aria-label={`${d.title} 삭제`}
              onClick={(e) => {
                e.stopPropagation();
                setDialog({ type: "deleteDoc", value: d.id });
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <Trash2 size={14} />
            </span>
          )}
        </span>
      </button>
    );
  }
  const isPlotMemo = (d: Doc) => d.kind === "memo";
  // 문서 영역(doc/)에 플롯·메모를 만든다. folder가 있으면 그 폴더에, ep가 있으면 그 회차에 연결한다.
  // 보던 화면은 그대로 두고 트리에서 이름을 받는다. widget이면 위젯 보드에서 바로 이름을 받는다.
  async function addDocFile(folder: string, kind: "plot" | "memo", ep?: Doc, widget = false) {
    await flush();
    const doc = await call<Doc>("createDocument", {
      projectId: projectRef.current,
      kind,
      folder: folder || undefined,
      title: kind === "plot" ? "새 플롯" : "새 메모",
      episodeId: ep?.id,
      manualLineBreak: true,
    });
    await refresh();
    await loadMemoFolders();
    if (widget) return startRename(doc, true);
    if (folder) setMemoOpenFolders((old) => new Set([...old, folder]));
    if (focusRef.current) setFocusTree(true);
    else setSidebar(true);
    startRename(doc);
  }
  // 퀵 노트: 고른 문장과 메모를 문서 영역 맨 위에 메모 문서로 만들고 바로 연다.
  async function saveQuickNote(note: QuickNoteSource, memo: string) {
    await flush();
    const doc = await call<Doc>("createDocument", {
      projectId: note.projectId,
      kind: "memo",
      title: quickNoteTitle(note, memo),
      body: quickNoteMarkdown(note, memo),
      episodeId: note.episodeId,
      manualLineBreak: true,
    });
    setQuickNote(null);
    await refresh();
    await loadMemoFolders();
    await openDoc(doc.id, true);
    message("메모가 저장되었습니다");
  }
  // 위젯 보드의 '이 회차의 플롯·메모': 보고 있는 회차(또는 회차에 연결된 플롯)에 연결된 문서를
  // 플롯과 메모로 나눠 보여 준다. 누르면 열고, 더블클릭·우클릭으로 이름을 바꾼다.
  function episodePlotsWidget() {
    if (!active) return null;
    const ep =
      active.kind === "episode"
        ? active
        : active.episodeId
          ? lib.documents.find((d) => d.id === active.episodeId)
          : undefined;
    if (!ep) return null;
    const linked = lib.documents.filter(
      (d) => d.kind !== "episode" && d.episodeId === ep.id && !d.archived,
    );
    const item = (d: Doc) =>
      renaming?.id === d.id && renaming.widget ? (
        <div key={d.id} className="memo-card renaming">
          {isPlotMemo(d) ? <StickyNote size={15} /> : <FileText size={15} />}
          <input
            className="tree-rename"
            aria-label="새 이름"
            autoFocus
            value={renaming.value}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => {
              renamingRef.current = { id: d.id, value: e.target.value, widget: true };
              setRenaming(renamingRef.current);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") attempt(commitRename)();
              else if (e.key === "Escape") {
                renamingRef.current = null;
                setRenaming(null);
              }
            }}
            onBlur={attempt(commitRename)}
          />
        </div>
      ) : (
        <button
          className={`memo-card ${d.id === active.id ? "current" : ""} ${menu?.target === "widget-" + d.id ? "context-target" : ""}`}
          key={d.id}
          title={d.relPath}
          onClick={attempt(() => openDoc(d.id))}
          onDoubleClick={() => startRename(d, true)}
          onContextMenu={(e) =>
            openMenu(
              e,
              [{ label: "이름 바꾸기", action: () => startRename(d, true) }, "separator", ...docMenu(d)],
              "widget-" + d.id,
            )
          }
        >
          {isPlotMemo(d) ? <StickyNote size={15} /> : <FileText size={15} />}
          <span>{d.title}</span>
          <ChevronRight size={12} />
        </button>
      );
    const plots = linked.filter((d) => !isPlotMemo(d)),
      memos = linked.filter(isPlotMemo);
    // 제목 줄의 + 버튼: 이 회차에 연결된 플롯·메모를 만들고 위젯에서 바로 이름을 받는다.
    const add = (kind: "plot" | "memo") => (
      <button
        className="widget-quick-add"
        aria-label={kind === "plot" ? "이 회차에 플롯 만들기" : "이 회차에 메모 만들기"}
        title={kind === "plot" ? "이 회차에 플롯 만들기" : "이 회차에 메모 만들기"}
        disabled={archive}
        onClick={attempt(() => addDocFile("", kind, ep, true))}
      >
        <Plus size={14} />
      </button>
    );
    return (
      <section className="widget episode-plots">
        <div className="widget-title">
          <span>이 회차의 플롯</span>
          <span className="widget-title-tools">
            <small>{plots.length}</small>
            {add("plot")}
          </span>
        </div>
        {plots.map(item)}
        {!plots.length && <p className="widget-empty">연결된 플롯이 없습니다.</p>}
        <div className="widget-title widget-subtitle">
          <span>이 회차의 메모</span>
          <span className="widget-title-tools">
            <small>{memos.length}</small>
            {add("memo")}
          </span>
        </div>
        {memos.map(item)}
        {!memos.length && <p className="widget-empty">연결된 메모가 없습니다.</p>}
      </section>
    );
  }
  // 위젯 보드 자리에 펼치는 북마크 목록. 누르면 그 문단으로 옮겨 간다.
  function bookmarkList() {
    if (!active) return null;
    const list = active.bookmarks || [];
    return (
      <section className="widget bookmark-widget">
        <div className="widget-title">
          <span>이 문서의 북마크</span>
          <small>{list.length}</small>
        </div>
        {list.map((b) => (
          <div className="bookmark-item" key={b.index}>
            <button
              className="bookmark-jump"
              title={b.text}
              onClick={() => setBookmarkJump({ docId: active.id, index: b.index, seq: Date.now() })}
            >
              <BookmarkIcon size={13} />
              <span>{b.text || "빈 문단"}</span>
            </button>
            <button
              className="bookmark-remove"
              aria-label="북마크 지우기"
              title="북마크 지우기"
              onClick={() => edit({ bookmarks: list.filter((x) => x.index !== b.index) })}
            >
              <X size={13} />
            </button>
          </div>
        ))}
        {!list.length && <p className="widget-empty">원고 왼쪽 여백을 누르면 그 문단에 북마크를 붙입니다.</p>}
      </section>
    );
  }
  // 확인이 필요한 파일: 파일이 없어진 문서와, 회차·플롯 폴더에 있지만 연결되지 않은 파일.
  // 자동 복구로 이을 수 없었던 것만 남는다. 무엇을 할지는 사용자가 고른다.
  function brokenFiles() {
    const missing = (lib.missing || []).filter((m) => m.projectId === projectId),
      unlinked = (lib.unlinked || []).filter((u) => u.projectId === projectId);
    if (!missing.length && !unlinked.length) return null;
    const relink = (m: { id: string; title: string }): MenuItem[] => [
      ...(unlinked.length
        ? unlinked.map((u) => ({
            label: `이 파일에 연결: ${u.path}`,
            action: attempt(async () => {
              await call("relinkDocument", { projectId, id: m.id, path: u.path });
              await refresh();
              message(`'${m.title}'을(를) ${u.path}에 다시 연결했습니다.`);
            }),
          }))
        : [{ label: "연결할 수 있는 파일이 없습니다", disabled: true, action: () => {} }]),
      "separator",
      {
        label: "목록에서 빼기 (파일은 건드리지 않음)",
        danger: true,
        action: attempt(async () => {
          await call("forgetDocument", { projectId, id: m.id });
          await refresh();
        }),
      },
    ];
    const adopt = (u: { path: string }): MenuItem[] => [
      ...(["episode"] as const).map((kind) => ({
        label: "에피소드로 등록",
        action: attempt(async () => {
          const doc = await call<Doc>("adoptFile", { projectId, path: u.path, kind });
          await refresh();
          await openDoc(doc.id, true);
        }),
      })),
      "separator",
      {
        label: "파일 탐색기에서 표시",
        action: attempt(() => call("revealFile", { projectId, path: u.path })),
      },
    ];
    return (
      <section className="tree-section broken-files">
        <div className="tree-heading">
          <span>확인이 필요한 파일</span>
          <small>{missing.length + unlinked.length}</small>
        </div>
        {missing.map((m) => (
          <button
            key={"missing-" + m.id}
            className={`tree-item ${menu?.target === "missing-" + m.id ? "context-target" : ""}`}
            title={`${m.path} 파일을 찾을 수 없습니다. 눌러서 다른 파일에 연결하거나 목록에서 뺄 수 있습니다.`}
            onClick={(e) => openMenu(e, relink(m), "missing-" + m.id)}
            onContextMenu={(e) => openMenu(e, relink(m), "missing-" + m.id)}
          >
            <FileWarning size={15} />
            <span>{m.title || "제목 없음"}</span>
            <small className="tree-count">파일 없음</small>
          </button>
        ))}
        {unlinked.map((u) => (
          <button
            key={"unlinked-" + u.path}
            className={`tree-item ${menu?.target === "unlinked-" + u.path ? "context-target" : ""}`}
            title={`${u.path} 파일이 목록에 연결되어 있지 않습니다. 눌러서 회차나 플롯으로 등록할 수 있습니다.`}
            onClick={(e) => openMenu(e, adopt(u), "unlinked-" + u.path)}
            onContextMenu={(e) => openMenu(e, adopt(u), "unlinked-" + u.path)}
          >
            <FileQuestion size={15} />
            <span>{u.path.slice(u.path.lastIndexOf("/") + 1)}</span>
            <small className="tree-count">연결 안 됨</small>
          </button>
        ))}
      </section>
    );
  }
  const docIcon = (d: Doc) =>
    d.kind === "memo" ? <StickyNote size={15} /> : <FileText size={15} />;
  // ---- 문서 영역: doc/ 폴더 트리 ----
  async function loadMemoFolders() {
    const pid = projectRef.current;
    if (!pid) return;
    const r = await call<{ entries: { path: string; name: string; type: string }[] }>("memoTree", {
      space: pid,
    });
    if (projectRef.current === pid) setMemoEntries(r.entries);
  }
  const memoMenuItems = (folder: string): MenuItem[] => [
    ...docCreateMenu(folder),
    "separator",
    { label: "폴더 추가", disabled: archive, action: attempt(() => addMemoFolder(folder)) },
  ];
  const memoCreateMenu = (folder: string): MenuItem[] => memoMenuItems(folder);
  async function addMemoFolder(parent: string) {
    const r = await call<{ path: string }>("memoCreateFolder", {
      space: projectRef.current,
      parent,
      name: "새 폴더",
    });
    await loadMemoFolders();
    if (parent) setMemoOpenFolders((old) => new Set([...old, parent]));
    setFolderRenaming({ path: r.path, value: r.path.slice(r.path.lastIndexOf("/") + 1) });
  }
  // 폴더 이름을 바꾸면 안의 메모 ID(경로로 만든다)가 바뀌므로, 열려 있는 탭과 편집 중인 원고를 새 ID로 옮긴다.
  async function renameMemoFolder(path: string, name: string) {
    const old = path.slice(path.lastIndexOf("/") + 1);
    if (!name.trim() || name.trim() === old) return;
    await flush();
    const prefix = "doc/" + path + "/",
      inside = libraryRef.current.documents.filter(
        (d) => d.projectId === projectRef.current && d.relPath?.startsWith(prefix),
      );
    const r = await call<{ path: string }>("memoRename", {
      space: projectRef.current,
      path,
      name: name.trim(),
    });
    await remapMovedDocs(inside, "doc/" + path, "doc/" + r.path);
    setMemoOpenFolders(
      (old) => new Set([...old].map((p) => (p === path || p.startsWith(path + "/") ? r.path + p.slice(path.length) : p))),
    );
    await loadMemoFolders();
  }
  // 폴더를 지우면 안의 메모까지 휴지통으로 간다. 열려 있던 탭은 먼저 닫는다.
  async function removeMemoFolder(path: string) {
    const prefix = "doc/" + path + "/",
      inside = libraryRef.current.documents.filter(
        (d) => d.projectId === projectRef.current && d.relPath?.startsWith(prefix),
      );
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (
      !window.confirm(
        `'${name}' 폴더${inside.length ? `와 안의 문서 ${inside.length}개` : ""}를 휴지통으로 옮길까요?`,
      )
    )
      return;
    await flush();
    for (const d of inside) await closeTab(d.id);
    for (const d of inside) closeSideTab(d.id);
    await call("memoRemove", { space: projectRef.current, path });
    await refresh();
    await loadMemoFolders();
  }
  // 검색어가 있으면 제목이 맞는 문서와 그 문서를 담은 폴더만 펼쳐서 보여 준다.
  function memoFolderTree(query = "") {
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
                  className={`tree-item memo-folder ${menu?.target === "folder-" + f.path ? "context-target" : ""} ${plotDrop === "folder:" + f.path ? "drop-target" : ""}`}
                  style={style}
                  title={f.path}
                  draggable
                  onDragStart={(e) => {
                    dragFolder.current = f.path;
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => {
                    dragFolder.current = "";
                    setPlotDrop(null);
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
              remove: true,
              plot: true,
              badge: ep ? episodeNumber(ep) : undefined,
              dropFolder: parent,
            });
          })}
        </>
      );
    };
    return level("", 0);
  }
  // 문서 탭의 '현재 회차만' 보기: 현재 회차에 연결된 플롯·메모를 유형별로 묶는다.
  function episodeDocList(query: string) {
    const ep = docs.find((d) => d.id === treeEpisodeId && d.kind === "episode");
    if (!ep) return <div className="tree-empty">에피소드를 열면 연결된 문서가 여기에 보입니다</div>;
    const bound = docs.filter((d) => d.kind !== "episode" && d.episodeId === ep.id),
      shown = bound.filter((d) => !query.trim() || treeMatch(d.title, query));
    return (
      <>
        <div className="episode-doc-caption">
          <span title={ep.title}>
            {numberOf(ep)} {ep.title}에 연결된 문서
          </span>
          <small>연결 문서 {bound.length}개</small>
        </div>
        {(["plot", "memo"] as const).map((kind) => {
          const items = shown.filter((d) => d.kind === kind),
            open = !closedDocGroups.has(kind);
          if (query.trim() && !items.length) return null;
          return (
            <Fragment key={kind}>
              <button
                className={`tree-item doc-group ${menu?.target === "group-" + kind ? "context-target" : ""}`}
                aria-expanded={open}
                onClick={() =>
                  setClosedDocGroups((old) => {
                    const next = new Set(old);
                    if (next.has(kind)) next.delete(kind);
                    else next.add(kind);
                    return next;
                  })
                }
                onContextMenu={(e) =>
                  openMenu(
                    e,
                    [{ label: `이 회차에 ${labels[kind]} 만들기`, disabled: archive, action: attempt(() => addDocFile("", kind, ep)) }],
                    "group-" + kind,
                  )
                }
              >
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <b>{labels[kind]}</b>
                <small>{items.length}</small>
              </button>
              {open && items.map((d) => treeRow(d, docIcon(d), { depth: 1, remove: true, plot: true }))}
            </Fragment>
          );
        })}
        {query.trim() && !shown.length && <div className="tree-empty">검색 결과가 없습니다</div>}
      </>
    );
  }
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
  const [winMaximized, setWinMaximized] = useState(false);
  useEffect(() => {
    const syncMax = () => {
      window.lof.windowIsMaximized?.().then(setWinMaximized).catch(() => {});
    };
    syncMax();
    window.addEventListener("resize", syncMax);
    return () => window.removeEventListener("resize", syncMax);
  }, []);
  return (
    <>
    <div
      className={`app ${prefs.theme === "dark" ? "dark" : ""} ${prefs.colorTheme === "bakery" ? "bakery" : ""} ${focus ? "focus-mode" : ""}`}
      inert={updater.locked}
    >
      <header
        className="titlebar"
        data-tauri-drag-region
        onMouseDown={(e) => {
          if (e.button === 0 && !(e.target as HTMLElement).closest("button")) {
            if (e.detail === 2) {
              window.lof.windowToggleMaximize?.().then(setWinMaximized).catch(() => {});
            } else {
              window.lof.windowStartDragging?.().catch(() => {});
            }
          }
        }}
      >
        <div className="titlebar-content" data-tauri-drag-region>
          <div className="history-navigation" role="group" aria-label="화면 이동">
          <button aria-label="뒤로가기" title="뒤로가기"
            disabled={navigation.index === 0}
            onClick={attempt(() => travel(-1))}>
            <ArrowLeft size={19} />
          </button>
          <button aria-label="앞으로가기" title="앞으로가기"
            disabled={navigation.index === navigation.entries.length - 1}
            onClick={attempt(() => travel(1))}>
            <ArrowRight size={19} />
          </button>
          </div>
          <div className="layout-controls start">
            <button
              aria-label="파일 트리 표시/숨기기"
              title="파일 트리 표시/숨기기 (Ctrl+B)"
              aria-pressed={treeOpen}
              disabled={!isWorkspace}
              onClick={toggleTree}
            >
              <LayoutIcon side="left" open={treeOpen} />
            </button>
          </div>
          <div className="layout-controls end">
            <button
              aria-label="위젯 보드 표시/숨기기"
              title="위젯 보드 표시/숨기기 (Ctrl+Alt+B)"
              aria-pressed={right && !focus}
              disabled={!isWorkspace || focus}
              onClick={() => setRight((r) => !r)}
            >
              <LayoutIcon side="right" open={right && !focus} />
            </button>
          </div>
        </div>
        {window.lof.windowClose && (
          <div className="window-controls" role="group" aria-label="창 제어">
            <button
              type="button"
              className="window-control"
              aria-label="최소화"
              title="최소화"
              onClick={() => window.lof.windowMinimize?.()}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M 1,5.5 L 9,5.5" stroke="currentColor" strokeWidth="1" shapeRendering="crispEdges" />
              </svg>
            </button>
            <button
              type="button"
              className="window-control"
              aria-label={winMaximized ? "이전 크기로 복원" : "최대화"}
              title={winMaximized ? "이전 크기로 복원" : "최대화"}
              onClick={() =>
                window.lof.windowToggleMaximize?.().then(setWinMaximized).catch(() => {})
              }
            >
              {winMaximized ? (
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <path
                    d="M 2.5,2.5 L 2.5,0.5 L 9.5,0.5 L 9.5,7.5 L 7.5,7.5 M 0.5,2.5 L 7.5,2.5 L 7.5,9.5 L 0.5,9.5 Z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1"
                    shapeRendering="crispEdges"
                  />
                </svg>
              ) : (
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <rect
                    x="1.5"
                    y="1.5"
                    width="7"
                    height="7"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1"
                    shapeRendering="crispEdges"
                  />
                </svg>
              )}
            </button>
            <button
              type="button"
              className="window-control close"
              aria-label="닫기"
              title="닫기"
              onClick={() => window.lof.windowClose?.()}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path
                  d="M 1,1 L 9,9 M 9,1 L 1,9"
                  stroke="currentColor"
                  strokeWidth="1.1"
                />
              </svg>
            </button>
          </div>
        )}
      </header>
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button aria-label="오류 닫기" onClick={() => setError("")}>
            <X size={15} />
          </button>
        </div>
      )}
      <div className="shell">
        <nav className="rail">
          <button
            title="내 서재"
            aria-label="내 서재"
            className={view === "library" && !memoOpen ? "selected" : ""}
            onClick={attempt(async () => {
              // 메모 화면에서 누르면 메모를 열기 전에 보던 화면(집필 중이던 문서 등)으로 돌아간다.
              if (memoOpen) {
                await flush();
                setMemoOpen(false);
              } else await goView("library");
            })}
          >
            <LibraryIcon size={21} />
          </button>
          <div className="rail-rule" />
          <button
            title="검색 (Ctrl+Shift+F) · 파일 이름으로 열기는 Ctrl+P"
            aria-label="검색"
            className={searchOpen && !memoOpen ? "selected" : ""}
            onClick={() => {
              if (searchOpen && !memoOpen) setSearchOpen(false);
              else openSearch();
            }}
          >
            <Search size={20} />
          </button>
          <button
            title="메모"
            aria-label="메모"
            className={memoOpen ? "selected" : ""}
            onClick={attempt(async () => {
              if (memoOpen) return setMemoOpen(false);
              await flush();
              setMemoOpen(true);
            })}
          >
            <StickyNote size={20} />
          </button>
          <div className="rail-bottom">
            <button
              title="폴더 열기"
              aria-label="서재 폴더 열기"
              onClick={attempt(() => call("reveal"))}
            >
              <HardDrive size={19} />
            </button>
            <button
              title={prefs.theme === "dark" ? "밝은 화면으로" : "어두운 화면으로"}
              aria-label="테마 변경"
              onClick={() =>
                savePrefs({
                  theme: prefs.theme === "dark" ? "light" : "dark",
                }).catch(report)
              }
            >
              {prefs.theme === "dark" ? <Sun size={20} /> : <Moon size={20} />}
            </button>
            <button
              title="설정 및 외부 연결"
              aria-label="설정"
              onClick={attempt(openSettings)}
            >
              <Settings size={20} />
            </button>
          </div>
        </nav>
        <div className="content-frame">
          {/* 문서 편집 화면에서는 탭이 제목 역할을 하므로 헤더를 숨긴다. */}
          {!isWorkspace && !memoOpen && (
            <header className="workspace-header">
              <strong>Lof Writer</strong>
              <span className="titlebar-path">
                {project?.title && view !== "library"
                  ? project.title
                  : "Local First Writing Tool"}
              </span>
            </header>
          )}
          {/* 닫아도 열린 메모 탭이 남도록 숨기기만 한다. */}
          <MemoSession
            active={memoOpen}
            apiRef={memoApi}
            documents={lib.documents}
            onOpenDoc={(id) =>
              attempt(async () => {
                await flush();
                setMemoOpen(false);
                await openDoc(id);
              })()
            }
            saved={loaded ? (lib.preferences?.memoSession ?? null) : undefined}
            prefs={prefs}
            onSidebarResize={(width) => savePrefs({ leftSidebarWidth: width }).catch(report)}
            flushRef={memoFlush}
            report={report}
          />
          <div
            className="content-shell"
            style={memoOpen ? { display: "none" } : undefined}
          >
        {/* 본문 검색 패널은 집필 화면에서는 파일 트리 자리에, 다른 화면에서는 왼쪽에 연다. */}
        {searchOpen && !memoOpen && (
          <ResizableSidebar className="search-sidebar" label="검색" width={prefs.leftSidebarWidth}
            onResize={(width) => savePrefs({ leftSidebarWidth: width }).catch(report)}>
            <SearchPanel
              projectId={view === "library" ? "" : projectId}
              scope={
                view !== "library" && project
                  ? `'${project.title || "제목 없는 작품"}'에서 찾기`
                  : "모든 작품에서 찾기"
              }
              query={searchQuery}
              setQuery={setSearchQuery}
              caseSensitive={searchCase}
              setCaseSensitive={setSearchCase}
              focus={searchFocus}
              refresh={lib}
              onOpen={(r, m, pinned) => attempt(() => openSearchResult(r, m, pinned))()}
              onOpenFile={(id, pinned) =>
                attempt(async () => {
                  setMemoOpen(false);
                  await openDoc(id, pinned);
                })()
              }
              onOpenProject={(id) =>
                attempt(async () => {
                  setMemoOpen(false);
                  await goView("project", id);
                })()
              }
              onOpenCommon={(path, pinned) =>
                attempt(async () => {
                  await flush();
                  setMemoOpen(true);
                  await memoApi.current?.open("common", path, pinned);
                })()
              }
              onClose={() => setSearchOpen(false)}
              report={report}
            />
          </ResizableSidebar>
        )}
        {isWorkspace && treeOpen && !searchOpen && (
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
                {project?.coverData ? (
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
            <div className="tree-tabs" role="tablist" aria-label="파일 트리 보기">
              {(["episode", "memo"] as const).map((tab) => (
                <button
                  key={tab}
                  role="tab"
                  aria-selected={treeTab === tab}
                  className={treeTab === tab ? "active" : ""}
                  onClick={() => setTreeTab(tab)}
                  // 문서를 끌어 에피소드 탭에 올리면 탭을 바꿔 회차 위에 놓을 수 있게 한다.
                  onDragEnter={() => {
                    if (tab === "episode" && dragPlot.current) setTreeTab("episode");
                  }}
                >
                  {tab === "memo" ? "문서" : labels.episode}
                  <small>{tab === "memo" ? count("plot") + count("memo") : count("episode")}</small>
                </button>
              ))}
            </div>
            {treeTab === "memo" && (
              <div className="doc-scope" role="radiogroup" aria-label="문서 보기 범위">
                {([["all", "전체 문서"], ["episode", "현재 회차만"]] as const).map(([scope, label]) => (
                  <button
                    key={scope}
                    role="radio"
                    aria-checked={docScope === scope}
                    className={docScope === scope ? "active" : ""}
                    onClick={() => setDocScope(scope)}
                  >
                    {label}
                  </button>
                ))}
              </div>
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
                    setTreeQuery((q) => ({ ...q, [treeTab]: value }));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && treeQuery[treeTab]) {
                      e.stopPropagation();
                      setTreeQuery((q) => ({ ...q, [treeTab]: "" }));
                    } else if (e.key === "Enter" && treeQuery[treeTab].trim()) {
                      const first = (treeTab === "memo" ? treeDocs : treeEpisodes)[0];
                      if (first) attempt(() => openDoc(first.id, false))();
                    }
                  }}
                />
                {treeQuery[treeTab] && (
                  <button
                    aria-label="검색어 지우기"
                    title="검색어 지우기"
                    onClick={() => setTreeQuery((q) => ({ ...q, [treeTab]: "" }))}
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
                  openMenu(e, [{ label: "새 에피소드", disabled: archive, action: attempt(() => createDoc("episode")) }])
                }
              >
                {!treeQuery.episode.trim() && treeEpisodes.length > EPISODE_GROUP
                  ? Array.from({ length: Math.ceil(treeEpisodes.length / EPISODE_GROUP) }, (_, g) => {
                      const start = g * EPISODE_GROUP,
                        items = treeEpisodes.slice(start, start + EPISODE_GROUP),
                        open = openEpisodeGroups.has(start);
                      const toggle = (next: boolean) =>
                        setOpenEpisodeGroups((old) => {
                          const set = new Set(old);
                          if (next) set.add(start);
                          else set.delete(start);
                          return set;
                        });
                      return (
                        <Fragment key={start}>
                          <button
                            className="tree-item episode-group"
                            aria-expanded={open}
                            onClick={() => toggle(!open)}
                            // 문서를 끌어 접힌 묶음에 올리면 펼쳐서 회차 위에 놓을 수 있게 한다.
                            onDragEnter={() => {
                              if (dragPlot.current && !open) toggle(true);
                            }}
                          >
                            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            <span>
                              {start + 1} - {start + items.length}화
                            </span>
                          </button>
                          {open &&
                            items.map((d) =>
                              treeRow(d, <span className="episode-number">{numberOf(d)}</span>, { episode: true }),
                            )}
                        </Fragment>
                      );
                    })
                  : treeEpisodes.map((d) =>
                      treeRow(d, <span className="episode-number">{numberOf(d)}</span>, { episode: true }),
                    )}
                {!treeEpisodes.length && (
                  <div className="tree-empty">
                    {treeQuery.episode.trim() ? "검색 결과가 없습니다" : "아직 에피소드가 없습니다"}
                  </div>
                )}
              </section>
              <section
                className={`tree-section tree-panel ${docScope === "all" && plotDrop === "folder:" ? "drop-target" : ""}`}
                hidden={treeTab !== "memo"}
                onContextMenu={(e) => docScope === "all" && openMenu(e, memoCreateMenu(""))}
                {...(docScope === "all" ? folderDropProps("") : {})}
              >
                {docScope === "all" ? (
                  <>
                    {memoFolderTree(treeQuery.memo)}
                    {treeQuery.memo.trim()
                      ? !treeDocs.length && <div className="tree-empty">검색 결과가 없습니다</div>
                      : count("plot") + count("memo") === 0 &&
                        !memoEntries.some((e) => e.type === "folder") && (
                          <div className="tree-empty">아직 문서가 없습니다</div>
                        )}
                  </>
                ) : (
                  episodeDocList(treeQuery.memo)
                )}
              </section>
              {brokenFiles()}
            </div>
            <div className="tree-footer">
              {treeTab === "episode" && !archive && (
                <button className="episode-add" onClick={attempt(() => createDoc("episode"))}>
                  <Plus size={16} />
                  새 에피소드
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
        )}
        <main className={isWorkspace ? "workspace" : "main-page"}>
          {view === "library" && (
            <>
              <div className="page-hero">
                <h1>
                  내 서재 <small>{lib.projects.length}작품</small>
                </h1>
                <p>이야기에 집중하세요.</p>
              </div>
              {!loaded ? (
                <div className="empty-state">내 서재를 여는 중...</div>
              ) : (
                <div className="project-grid">
                  {lib.projects
                    .map((p, i) => (
                      <button
                        className={`project-card ${menu?.target === "project:" + p.id ? "context-target" : ""}`}
                        key={p.id}
                        onClick={attempt(() => goView("project", p.id))}
                        onContextMenu={(e) =>
                          openMenu(
                            e,
                            [
                              { label: "열기", action: attempt(() => goView("project", p.id)) },
                              "separator",
                              {
                                label: "작품 삭제",
                                danger: true,
                                action: () => askDeleteProject(p.id),
                              },
                            ],
                            "project:" + p.id,
                          )
                        }
                      >
                        <div className={`book-cover cover-${i % 4}`}>
                          {p.coverData ? (
                            <CoverImage src={p.coverData} alt={`${p.title} 표지`} />
                          ) : (
                            <>
                              <Feather size={40} />
                              <span>
                                LOF / {String(i + 1).padStart(2, "0")}
                              </span>
                            </>
                          )}
                        </div>
                        <div className="project-info">
                          <h3>{p.title}</h3>
                          <small>
                            {
                              lib.documents.filter(
                                (d) =>
                                  d.projectId === p.id &&
                                  d.kind === "episode" &&
                                  !d.archived,
                              ).length
                            }
                            편
                          </small>
                          <div className="card-tags">
                            {(p.tags || []).map((t) => (
                              <span key={t}>#{t}</span>
                            ))}
                          </div>
                          {p.description && <p>{p.description}</p>}
                        </div>
                      </button>
                    ))}
                  {/* 목록 맨 끝의 새 이야기 카드. 작품이 없으면 가운데의 '첫 이야기 만들기'만 보인다. */}
                  {lib.projects.length > 0 && (
                    <button
                      className="project-card new-project-card"
                      onClick={() => setDialog({ type: "newProject", value: "" })}
                    >
                      <div className="book-cover new-cover">
                        <Plus size={30} />
                      </div>
                      <div className="project-info">
                        <h3>새 이야기</h3>
                        <small>시작하기</small>
                      </div>
                    </button>
                  )}
                  {!lib.projects.length && (
                    <div className="empty-state">
                      <div className="empty-icon">
                        <BookOpen size={38} />
                      </div>
                      <h2>첫 이야기를 시작해 볼까요?</h2>
                      <p>
                        작품을 만들고 회차별로 원고를 정리하세요.
                        <br />
                        계정 없이, 인터넷 없이 사용할 수 있습니다.
                      </p>
                      <button
                        className="primary"
                        onClick={() =>
                          setDialog({ type: "newProject", value: "" })
                        }
                      >
                        <Plus size={16} />첫 이야기 만들기
                      </button>
                    </div>
                  )}
                </div>
              )}
              <div className="library-footer">
                <button
                  disabled={busy}
                  onClick={attempt(chooseVault)}
                >
                  <FolderOpen size={15} />
                  다른 서재 열기
                </button>
                <span title={lib.root}>{lib.root}</span>
                <button onClick={attempt(() => call("reveal"))}>
                  폴더에서 보기 <ChevronRight size={13} />
                </button>
              </div>
            </>
          )}
          {view === "project" && project && (
            <div className="project-page">
              <button
                className="back-link"
                onClick={attempt(() => goView("library"))}
              >
                <ArrowLeft size={16} />
                내 서재
              </button>
              <div className="project-hero">
                <div>
                  <div className="eyebrow">
                    {docs.filter((d) => d.kind === "episode").length}편
                  </div>
                  <h1>{project.title}</h1>
                  {project.description && <p>{project.description}</p>}
                  <div className="project-tags">
                    {(project.tags || []).map((t) => (
                      <span className="tag-chip" key={t}>
                        #{t}
                      </span>
                    ))}
                    <button
                      aria-label="작품 태그 편집"
                      onClick={() =>
                        setDialog({
                          type: "editProject",
                          value: project.title,
                          description: project.description,
                          tags: project.tags || [],
                          manualLineBreak: project.manualLineBreak ?? null,
                          writing: normalizeWriting(
                            project.writing || prefs.defaultWriting,
                          ),
                        })
                      }
                    >
                      <Plus size={13} />
                      태그 추가
                    </button>
                  </div>
                  <div className="row gap">
                    <button
                      onClick={() =>
                        setDialog({
                          type: "editProject",
                          value: project.title,
                          description: project.description,
                          tags: project.tags || [],
                          manualLineBreak: project.manualLineBreak ?? null,
                          writing: normalizeWriting(
                            project.writing || prefs.defaultWriting,
                          ),
                        })
                      }
                    >
                      <Settings size={16} />
                      소설 관리하기
                    </button>
                    <button
                      onClick={attempt(async () => {
                        const result = await call("importFiles", { projectId });
                        if (result) {
                          await refresh();
                          message(
                            `${result.count}편 가져옴${result.warnings.length ? " · " + result.warnings.join(" / ") : ""}`,
                          );
                        }
                      })}
                    >
                      <Upload size={16} />
                      원고 가져오기
                    </button>
                  </div>
                </div>
                <div className="hero-cover">
                  {project.coverData ? (
                    <button
                      className="cover-zoom"
                      title="표지 크게 보기"
                      onClick={() =>
                        setViewer({ src: project.coverData!, alt: `${project.title} 표지` })
                      }
                    >
                      <CoverImage
                        src={project.coverData}
                        alt={`${project.title} 표지`}
                      />
                    </button>
                  ) : (
                    <>
                      <Feather size={62} />
                      <span>YOUR STORY</span>
                    </>
                  )}
                </div>
              </div>
              <div className="project-tabs">
                <div className="row gap">
                  {(["episode", "plot", "memo"] as Kind[]).map((kind) => {
                    const Icon = icons[kind];
                    return (
                      <button
                        key={kind}
                        className={tab === kind ? "selected" : ""}
                        onClick={() => setTab(kind)}
                      >
                        <Icon size={16} />
                        {labels[kind]}
                        <small>{count(kind)}</small>
                      </button>
                    );
                  })}
                </div>
                <div className="row gap">
                  <button
                    title="보관함"
                    aria-label="보관함"
                    className={archive ? "selected" : ""}
                    onClick={() => setArchive((a) => !a)}
                  >
                    <Archive size={16} />
                  </button>
                  <button
                    title="본문 검색 (Ctrl+Shift+F)"
                    aria-label="본문 검색"
                    onClick={openSearch}
                  >
                    <Search size={17} />
                  </button>
                  <button
                    className="primary"
                    onClick={attempt(() => createDoc(tab))}
                  >
                    <Plus size={16} />
                    {tab === "episode" ? "새 편 쓰기" : `${labels[tab]} 추가`}
                  </button>
                </div>
              </div>
              <div className="episode-list">
                {docs
                  .filter((d) => d.kind === tab)
                  .map((d, i) => (
                    <button
                      className="episode-row"
                      key={d.id}
                      onClick={attempt(() => openDoc(d.id))}
                      onDoubleClick={attempt(() => openDoc(d.id, true))}
                    >
                      <span className={`list-number${/^\d/.test(numberOf(d)) ? "" : " named"}`}>
                        {numberOf(d)}
                      </span>
                      <b>{d.title}</b>
                      {(d.archived || d.kind === "episode") && (
                        <span
                          className={`status-chip ${!d.archived && normalizeStatus(d.status) === "completed" ? "complete" : ""}`}
                        >
                          {d.archived ? "보관됨" : STATUS_SHORT[normalizeStatus(d.status)]}
                        </span>
                      )}
                      <span className="episode-meta">
                        {(d.platformCharacters ?? d.characters ?? 0).toLocaleString()}자
                      </span>
                      <time>
                        {new Date(d.updatedAt).toLocaleDateString("ko-KR")}
                      </time>
                      <ChevronRight size={16} />
                    </button>
                  ))}
                {!count(tab) && (
                  <div className="empty-state">
                    <FileText size={32} />
                    <h3>아직 {labels[tab]}가 없습니다</h3>
                    <p>새 문서를 만들거나 기존 원고를 가져오세요.</p>
                  </div>
                )}
              </div>
            </div>
          )}
          {isWorkspace && (
            <>
              <div
                className={`editor-groups ${split ? "split" : ""} ${previewOpen ? "with-preview" : ""}`}
                ref={groupsRef}
                onDragOver={dragOverGroups}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropZone(null);
                }}
                onDrop={dropOnGroups}
              >
              {dropZone && (
                <div
                  className="group-drop-zone"
                  style={{ left: dropZone.left, top: dropZone.top + 39, width: dropZone.width }}
                />
              )}
              {split && focusedSide === "right" && sideGroup()}
              {split && focusedSide === "right" && sash}
              <section
                key="focused"
                className={`editor-group ${split ? "focused" : ""}`}
                style={groupStyle(focusedSide)}
              >
              <div className="editor-tabs" role="tablist" aria-label="열린 문서">
                {editorTabs.map((t, index) => {
                  const doc =
                    t.id === active.id
                      ? active
                      : lib.documents.find((d) => d.id === t.id);
                  if (!doc) return null;
                  const current = t.id === active.id,
                    Icon = icons[doc.kind],
                    title = doc.title || "제목 없음";
                  return (
                    <div
                      key={t.id}
                      role="tab"
                      tabIndex={current ? 0 : -1}
                      aria-selected={current}
                      title={t.pinned ? title : `${title} (미리보기)`}
                      className={`editor-tab ${current ? "current" : ""} ${t.pinned ? "" : "preview"} ${dragTab === t.id ? "dragging" : ""} ${menu?.target === "tab:" + t.id ? "context-target" : ""}`}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = "move";
                        setDragTab(t.id);
                      }}
                      onDragEnd={() => {
                        setDragTab("");
                        setDropZone(null);
                      }}
                      onDragOver={(e) => {
                        if (dragTab) e.preventDefault();
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        moveTab(dragTab, t.id);
                        setDragTab("");
                      }}
                      onClick={attempt(() => openDoc(t.id, false))}
                      onDoubleClick={() =>
                        updateTabs((tabs) => placeTab(tabs, t.id, true, ""))
                      }
                      onMouseDown={(e) => {
                        if (e.button === 1) e.preventDefault();
                      }}
                      onAuxClick={(e) => {
                        if (e.button === 1) attempt(() => closeTab(t.id))();
                      }}
                      onContextMenu={(e) =>
                        openMenu(e, tabMenu(t, index), "tab:" + t.id)
                      }
                    >
                      <Icon size={14} />
                      <span>{title}</span>
                      {current && (
                        <i
                          className={
                            saveStatus === "저장됨" ? "saved-dot" : "dirty-dot"
                          }
                        />
                      )}
                      <button
                        aria-label={`${title} 닫기`}
                        title="닫기 (Ctrl+W)"
                        onClick={(e) => {
                          e.stopPropagation();
                          attempt(() => closeTab(t.id))();
                        }}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
              <div className="editor-actions">
                <span
                  className={`save-indicator ${saveStatus !== "저장됨" ? "pending" : ""}`}
                >
                  <span />
                  {saveStatus}
                </span>
                {autoSync.phase !== "idle" && <span className={`auto-sync-status ${autoSync.phase === "error" ? "error" : ""}`}
                  role="status" title={autoSync.message || "저장한 변경 사항을 외부 저장소에 동기화합니다."}>
                  <Cloud size={13} />{autoSyncLabels[autoSync.phase]}
                </span>}
                <div>
                  <button
                    aria-label="저장"
                    title="저장 (Ctrl+S)"
                    onClick={attempt(flush)}
                  >
                    <Check size={17} />
                  </button>
                  <button
                    aria-label="순서 위로"
                    title="순서 위로"
                    onClick={attempt(() => reorder(active.id, -1))}
                  >
                    <ArrowUp size={16} />
                  </button>
                  <button
                    aria-label="순서 아래로"
                    title="순서 아래로"
                    onClick={attempt(() => reorder(active.id, 1))}
                  >
                    <ArrowDown size={16} />
                  </button>
                  <button
                    aria-label="변경 이력"
                    title="변경 이력"
                    onClick={attempt(showHistory)}
                  >
                    <History size={18} />
                  </button>
                  <button
                    aria-label="내보내기"
                    title="Markdown 내보내기"
                    onClick={attempt(async () => {
                      await flush();
                      if (await call("exportDocument", { id: active.id }))
                        message("원고를 내보냈습니다.");
                    })}
                  >
                    <Download size={18} />
                  </button>
                  <button
                    aria-label="본문 텍스트 복사"
                    title={
                      source || requiresSource(active.body)
                        ? "Markdown 원문 복사"
                        : "본문 복사"
                    }
                    onClick={attempt(() => copyDocManuscript(active))}
                  >
                    <Copy size={18} />
                  </button>
                  <button
                    className={source ? "active" : ""}
                    aria-label="Markdown 모드"
                    title="Markdown 원문 / 편집"
                    onClick={() => setSource((s) => !s)}
                  >
                    <Code2 size={18} />
                  </button>
                  <button
                    className={previewOpen ? "active" : ""}
                    aria-label="모바일 미리보기"
                    title="모바일 미리보기 (Ctrl+K V)"
                    aria-pressed={previewOpen}
                    onClick={togglePreview}
                  >
                    <Smartphone size={17} />
                  </button>
                  <button
                    aria-label="집중 모드"
                    title="집중 모드 (F11)"
                    onClick={() => setFocus((f) => !f)}
                  >
                    <Maximize size={17} />
                  </button>
                  <button
                    aria-label="문서 더보기"
                    title="문서 보관 및 설정"
                    onClick={() => setDialog({ type: "document" })}
                  >
                    <MoreHorizontal size={20} />
                  </button>
                </div>
              </div>
              {conflict && (
                <div className="conflict-banner">
                  <span>
                    다른 편집 내용이 있습니다. 내 원고를 사본으로 보존한 뒤
                    계속할 수 있습니다.
                  </span>
                  <button onClick={attempt(resolveConflict)}>
                    내 편집 사본 만들기
                  </button>
                </div>
              )}
              <div className="editor-scroll">
                <article className={manuscriptClassName} style={manuscriptStyle}>
                  <div className="document-kind">
                    {labels[active.kind]} · {numberOf(active)}
                  </div>
                  <input
                    className="document-title"
                    aria-label="문서 제목"
                    value={active.title}
                    placeholder="제목을 입력해 주세요"
                    readOnly={isProtected}
                    title={isProtected ? "집필 완료된 에피소드는 편집이 제한됩니다." : undefined}
                    onChange={(e) => {
                      if (!isProtected) edit({ title: e.target.value });
                    }}
                  />
                    <EpisodeProperties
                      propertyPresets={prefs.propertyPresets}
                      onSavePresets={(propertyPresets) => savePrefs({ propertyPresets })}
                      favoriteTags={prefs.favoriteTags}
                      key={active.id}
                      doc={active}
                      open={!!prefs.episodeInfoOpen}
                      onToggle={() =>
                        savePrefs({ episodeInfoOpen: !prefs.episodeInfoOpen }).catch(report)
                      }
                      onEdit={edit}
                      onMenu={(rect, items) =>
                        setMenu({ x: rect.left, y: rect.bottom + 4, items })
                      }
                      onNotice={message}
                      boundEpisode={lib.documents.find((d) => d.id === active.episodeId && d.kind === "episode")}
                      onBind={attempt(() => openBinding(active.id))}
                      onUnbind={attempt(() => bindDocument(active.id, null))}
                      onOpenBound={active.episodeId ? attempt(() => openDoc(active.episodeId!)) : undefined}
                    />
                  <Writer
                    readOnly={isProtected}
                    manualLineBreak={!!active.manualLineBreak}
                    id={active.id}
                    revision={active.revision}
                    body={active.body}
                    tables={active.kind === "memo" || active.kind === "plot"}
                    reveal={reveal?.docId === active.id ? reveal : null}
                    onChange={(body) => edit({ body })}
                    fontSize={activeBox.norm.fontSize}
                    lineHeight={activeBox.norm.lineHeight}
                    source={source}
                    onComposition={composition}
                    typingOptions={{
                      autoCloseQuotes: prefs.autoCloseQuotes,
                      autoCloseBrackets: prefs.autoCloseBrackets,
                      smartBrackets: prefs.smartBrackets,
                      autoSymbolReplacement: prefs.autoSymbolReplacement,
                      autoDividerReplacement: prefs.autoDividerReplacement,
                      quoteStyle: prefs.quoteStyle,
                      textReplacements: prefs.textReplacements,
                    }}
                    editorStyle={activeBox.kindPrefs}
                    onReplaceSymbols={replaceActiveSymbols}
                    lineBreak={{
                      // 이 작품의 새 에피소드 줄바꿈 기본값(작품 설정, 없으면 공통 설정). 플롯·메모는 자동 관리가 기본이다.
                      def: active.kind === "episode" ? lineBreakDefault(project, prefs.defaultManualLineBreak) : false,
                      defaultLabel: active.kind === "episode" ? "새 에피소드 기본값" : "기본값",
                      onChange: (manualLineBreak) => edit({ manualLineBreak }),
                    }}
                    bookmarks={active.bookmarks}
                    onBookmarksChange={(bookmarks) => edit({ bookmarks })}
                    jumpToBookmark={bookmarkJump?.docId === active.id ? bookmarkJump : null}
                    onQuickNote={(text, at) =>
                      setQuickNote({
                        projectId: active.projectId,
                        // 회차는 회차 번호를 붙여 출처를 알아보기 쉽게 한다(예: 44. 아이스크림 두 개).
                        title:
                          active.kind === "episode" && numberOf(active)
                            ? `${numberOf(active)}. ${active.title || "제목 없음"}`
                            : active.title,
                        text,
                        episodeId: active.kind === "episode" ? active.id : active.episodeId || undefined,
                        at,
                      })
                    }
                  />
                </article>
                <div className="end-marker">✧</div>
              </div>
              </section>
              {split && focusedSide === "left" && sash}
              {split && focusedSide === "left" && sideGroup()}
              {previewOpen && (
                <MobilePreview
                  title={active.title}
                  label={`${labels[active.kind]} · ${numberOf(active)}`}
                  body={active.body}
                  manualLineBreak={!!active.manualLineBreak}
                  dark={prefs.theme === "dark"}
                  device={prefs.previewDevice || "iphone"}
                  fontSize={Number(prefs.previewFontSize) || 16}
                  onDevice={(previewDevice) =>
                    savePrefs({ previewDevice }).catch(report)
                  }
                  onFontSize={(previewFontSize) =>
                    savePrefs({ previewFontSize }).catch(report)
                  }
                  onClose={() => setPreviewOpen(false)}
                />
              )}
              </div>
              <footer className="editor-footer">
                <span>
                  {writingName(writingRules)} {platformChars.toLocaleString()}자 <i /> 공백 포함 {charsWithSpaces.toLocaleString()}자
                </span>
                {focus && (
                  <button className="footer-exit-focus" onClick={() => setFocus(false)}>
                    집중 모드 종료 · F11
                  </button>
                )}
                <button
                  onClick={attempt(() => call("reveal", { id: active.id }))}
                >
                  <FolderOpen size={12} />
                  파일 위치
                </button>
              </footer>
            </>
          )}
        </main>
        {isWorkspace && right && (
          <aside className="widget-sidebar">
            <div className="panel-caption">
              <span>{bookmarksOpen ? "북마크" : "위젯 보드"}</span>
              <button
                className={`bookmark-toggle ${bookmarksOpen ? "active" : ""}`}
                aria-pressed={bookmarksOpen}
                aria-label="북마크 목록"
                title={bookmarksOpen ? "위젯 보드로 돌아가기" : "북마크 목록 보기"}
                onClick={() => setBookmarksOpen((open) => !open)}
              >
                <BookmarkIcon size={15} />
              </button>
            </div>
            {bookmarksOpen ? bookmarkList() : (
            <>
            <PlatformCount
              body={active.body}
              rules={writingRules}
              onChange={(rules) => {
                const id = projectId;
                pendingWriting.current.set(id, rules);
                setLib(current => ({...current, projects: current.projects.map(p => p.id === id ? {...p, writing: rules} : p)}));
                writingQueue.current = writingQueue.current.catch(() => {}).then(async () => {
                  await call("updateProject", {id, writing: rules});
                  if (pendingWriting.current.get(id) === rules) {
                    pendingWriting.current.delete(id);
                    await refresh();
                  }
                }).catch(async e => {
                  if (pendingWriting.current.get(id) === rules) pendingWriting.current.delete(id);
                  report(e);
                  await refresh();
                  throw e;
                });
                writingQueue.current.catch(() => {});
              }}
            />
            <section className="widget session-widget">
              <span>이번 회차에서 새로 쓴 글</span>
              <strong>
                +{sessionCount.toLocaleString()}
                <small>자</small>
              </strong>
            </section>
            {episodePlotsWidget()}
            </>
            )}
          </aside>
        )}
          </div>
        </div>
      </div>
      {lib.warnings.length > 0 && (
        <div className="warning-strip">
          읽지 못한 파일 {lib.warnings.length}개 · {lib.warnings[0]}
        </div>
      )}
      {!!lib.drafts?.length && (
        <div className="recovery-strip">
          <span>복구 가능한 임시 원고 {lib.drafts.length}개</span>
          <button onClick={() => setDialog({ type: "recovery" })}>
            확인하기
          </button>
        </div>
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />
      )}
      {quickNote && (
        <QuickNote
          source={quickNote}
          onSave={(memo) => saveQuickNote(quickNote, memo).catch(report)}
          onClose={() => setQuickNote(null)}
        />
      )}
      {quickOpen && (
        <QuickOpen
          items={quickItems}
          onPick={(item) => attempt(() => pickQuick(item))()}
          onClose={() => setQuickOpen(false)}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
          {toastAction && (
            <button
              className="toast-action"
              onClick={() => {
                const run = toastAction.run;
                setToast("");
                setToastAction(null);
                run();
              }}
            >
              {toastAction.label}
            </button>
          )}
        </div>
      )}
      {viewer && (
        <ImageViewer src={viewer.src} alt={viewer.alt} onClose={closeViewer} />
      )}
      {focus && !isWorkspace && (
        <button className="exit-focus" onClick={() => setFocus(false)}>
          집중 모드 종료 · F11
        </button>
      )}
      {dialog && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && dialog.type !== "setup")
              setDialog(null);
          }}
        >
          <div
            className={`modal ${["settings", "history"].includes(dialog.type) ? "wide" : ""}${dialog.type === "settings" ? " settings-modal" : ""}`}
            role="dialog"
            aria-modal="true"
          >
            <div className="modal-header">
              <h2>
                {
                  {
                    newProject: "새 이야기",
                    editProject: "소설 관리",
                    settings: "설정 및 연결",
                    history: "변경 이력",
                    document: "문서 관리",
                    deleteDoc: "영구 삭제",
                    deleteProject: "작품 삭제",
                    linkEpisode: "회차에 연결",
                    recovery: "임시 원고 복구",
                    setup: "처음 집필 환경 설정",
                  }[dialog.type]
                }
              </h2>
              {dialog.type !== "setup" && (
                <button aria-label="닫기" onClick={() => setDialog(null)}>
                  <X size={19} />
                </button>
              )}
            </div>
            {dialog.type === "setup" && (
              <div className="setup-content">
                <section className="setup-vault" aria-labelledby="setup-vault-title">
                  <h3 id="setup-vault-title">서재 위치</h3>
                  <p className="muted">작품과 원고를 저장할 폴더입니다. 기본 위치를 그대로 사용하거나 다른 폴더를 선택하세요.</p>
                  <div className="setup-vault-picker">
                    <output aria-label="서재 위치" title={lib.root}>{lib.root}</output>
                    <button type="button" disabled={busy} onClick={attempt(chooseVault)}>
                      <FolderOpen size={15} />폴더 선택
                    </button>
                  </div>
                </section>
                <p>
                  주로 연재할 플랫폼을 선택해 주세요. 사용자 규칙으로 직접 계산
                  방식을 정할 수도 있습니다.
                </p>
                <PlatformPicker
                  value={dialog.writing || normalizeWriting()}
                  onChange={(writing) => setDialog({ ...dialog, writing })}
                />
                <p className="muted">
                  새 작품에 적용할 설정입니다.
                </p>
                <button
                  className="primary"
                  disabled={busy || !lib.root}
                  onClick={attempt(async () => {
                    setBusy(true);
                    try {
                      await savePrefs({
                        setupComplete: true,
                        defaultWriting: dialog.writing || normalizeWriting(),
                      });
                      setDialog(null);
                    } finally {
                      setBusy(false);
                    }
                  })}
                >
                  이 설정으로 시작
                </button>
              </div>
            )}
            {["newProject", "editProject"].includes(dialog.type) && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  (async () => {
                    if (dialog.type === "newProject") {
                      const p = await call<Project>("createProject", {
                        title: dialog.value,
                        description: dialog.description,
                        tags: dialog.tags || [],
                        manualLineBreak: dialog.manualLineBreak ?? null,
                        writing:
                          dialog.writing ||
                          normalizeWriting(prefs.defaultWriting),
                      });
                      await refresh();
                      await navigate({ view: "project", projectId: p.id, tab: "episode", archive: false });
                    } else if (dialog.type === "editProject") {
                      await call("updateProject", {
                        id: projectId,
                        title: dialog.value,
                        description: dialog.description,
                        tags: dialog.tags || [],
                        manualLineBreak: dialog.manualLineBreak ?? null,
                        writing:
                          dialog.writing ||
                          normalizeWriting(
                            project?.writing || prefs.defaultWriting,
                          ),
                      });
                      await refresh();
                      setDialog(null);
                    }
                  })().catch(report);
                }}
              >
                <label>
                  제목
                  <input
                    autoFocus
                    aria-label="새 제목"
                    required
                    maxLength={300}
                    value={dialog.value || ""}
                    onChange={(e) =>
                      setDialog({ ...dialog, value: e.target.value })
                    }
                  />
                </label>
                <label>
                  작품 소개
                  <textarea
                    rows={3}
                    value={dialog.description || ""}
                    onChange={(e) =>
                      setDialog({ ...dialog, description: e.target.value })
                    }
                  />
                </label>
                <div className="form-field">
                  <span>태그</span>
                  <TagInput
                    favorites={prefs.favoriteTags}
                    tags={dialog.tags || []}
                    onChange={(tags) => setDialog({ ...dialog, tags })}
                  />
                </div>
                <PlatformPicker
                  value={
                    dialog.writing ||
                    normalizeWriting(
                      dialog.type === "editProject"
                        ? project?.writing || prefs.defaultWriting
                        : prefs.defaultWriting,
                    )
                  }
                  onChange={(writing) => setDialog({ ...dialog, writing })}
                />
                <label>
                  새 에피소드 줄바꿈 형식
                  <select
                    aria-label="작품의 새 에피소드 줄바꿈 형식"
                    value={dialog.manualLineBreak == null ? "common" : String(dialog.manualLineBreak)}
                    onChange={(e) =>
                      setDialog({
                        ...dialog,
                        manualLineBreak: e.target.value === "common" ? null : e.target.value === "true",
                      })
                    }
                  >
                    <option value="common">공통 설정 따르기 ({lineBreakLabel(prefs.defaultManualLineBreak === true)})</option>
                    <option value="false">자동 관리</option>
                    <option value="true">수동 관리</option>
                  </select>
                </label>
                <p className="muted">
                  새로 만드는 에피소드에 적용합니다. 기존 에피소드는 상세 정보의 줄바꿈 속성에서 변경할 수 있습니다.
                </p>
                {dialog.type === "editProject" && project && (
                  <div className="cover-manager">
                    <div className="cover-preview">
                      {project.coverData ? (
                        <button
                          className="cover-zoom"
                          title="표지 크게 보기"
                          onClick={() => setViewer({ src: project.coverData!, alt: "현재 표지" })}
                        >
                          <CoverImage src={project.coverData} alt="현재 표지" />
                        </button>
                      ) : (
                        <Feather size={30} />
                      )}
                    </div>
                    <div>
                      <p>작품 표지</p>
                      <button
                        type="button"
                        onClick={attempt(async () => {
                          if (await call("chooseCover", { id: projectId })) {
                            await refresh();
                            message("표지를 저장했습니다.");
                          }
                        })}
                      >
                        <Upload size={15} />
                        표지 업로드
                      </button>
                      {project.cover && (
                        <button
                          type="button"
                          onClick={attempt(async () => {
                            await call("removeCover", { id: projectId });
                            await refresh();
                            message("기본 표지로 바꿨습니다.");
                          })}
                        >
                          기본 표지로
                        </button>
                      )}
                      <small>
                        PNG · JPEG · WebP / 원본 20MB 이하
                      </small>
                    </div>
                  </div>
                )}
                <div className="modal-footer">
                  {dialog.type === "editProject" && (
                    <button
                      type="button"
                      className="danger-outline footer-start"
                      onClick={() => askDeleteProject(projectId)}
                    >
                      <Trash2 size={15} />
                      작품 삭제
                    </button>
                  )}
                  <button type="button" onClick={() => setDialog(null)}>
                    취소
                  </button>
                  <button type="submit" className="primary">
                    {dialog.type === "editProject" ? "저장" : "만들기"}
                  </button>
                </div>
              </form>
            )}
            {dialog.type === "history" && (
              <div className="history-layout">
                <div className="history-list">
                  {history.map((h) => (
                    <button
                      className={preview?.name === h.name ? "selected" : ""}
                      key={h.name}
                      onClick={attempt(async () =>
                        setPreview({
                          ...(await call("historyRead", {
                            id: active!.id,
                            name: h.name,
                          })),
                          name: h.name,
                        }),
                      )}
                    >
                      {new Date(Number(h.name.split("-")[0])).toLocaleString(
                        "ko-KR",
                      )}
                    </button>
                  ))}
                  {!history.length && <p>아직 저장 이력이 없습니다.</p>}
                </div>
                <div className="history-preview">
                  {preview ? (
                    <>
                      <b>{preview.title}</b>
                      <pre>{preview.body}</pre>
                      <button
                        className="primary"
                        onClick={attempt(async () => {
                          await flush();
                          const restored = await call<Doc>("restore", {
                            id: active!.id,
                            name: preview.name,
                            expectedRevision: draft.current!.doc.revision,
                          });
                          draft.current = { doc: restored, seq: 0, saved: 0 };
                          setActive(restored);
                          setDialog(null);
                          await refresh();
                          message(
                            "이전 원고를 복원했습니다. 복원 전 내용도 이력에 남습니다.",
                          );
                        })}
                      >
                        이 버전으로 복원
                      </button>
                    </>
                  ) : (
                    <p>왼쪽에서 저장 이력을 선택하세요.</p>
                  )}
                </div>
              </div>
            )}
            {dialog.type === "document" && active && (
              <>
                <p>
                  파일 ID: <code>{active.id}</code>
                </p>
                <p className="muted">
                  보관한 문서는 보관함에서 다시 열 수 있습니다.
                </p>
                <button
                  className="danger-outline"
                  onClick={attempt(async () => {
                    setDialog(null);
                    await archiveDoc(active);
                  })}
                >
                  <Archive size={16} />
                  {active.archived ? "보관 해제" : "보관함으로 옮기기"}
                </button>
                <button
                  className="danger-outline"
                  onClick={() => setDialog({ type: "deleteDoc", value: active.id })}
                >
                  <Trash2 size={16} />
                  영구 삭제
                </button>
              </>
            )}
            {dialog.type === "deleteDoc" &&
              (() => {
                const target = lib.documents.find((d) => d.id === dialog.value);
                if (!target) return <p>이미 삭제된 문서입니다.</p>;
                return (
                  <>
                    <p>
                      <b>{target.title || "제목 없음"}</b> 문서를 영구 삭제할까요?
                    </p>
                    <p className="muted">
                      문서 목록과 임시 원고에서 제거됩니다. 이 PC의 변경 이력은 보존 정책에 따라 남습니다.
                      문서 파일은 Windows 휴지통으로 옮겨집니다. 동기화를 쓰면
                      다른 장치에서도 삭제됩니다.
                    </p>
                    <div className="modal-footer">
                      <button autoFocus onClick={() => setDialog(null)}>
                        취소
                      </button>
                      <button
                        className="danger-solid"
                        onClick={attempt(async () => {
                          setDialog(null);
                          await deleteDoc(target);
                        })}
                      >
                        <Trash2 size={15} />
                        영구 삭제
                      </button>
                    </div>
                  </>
                );
              })()}
            {dialog.type === "linkEpisode" &&
              (() => {
                const target = lib.documents.find((d) => d.id === dialog.value);
                if (!target) return <p>이미 없는 문서입니다.</p>;
                return (
                  <EpisodeBindingPicker key={target.id} doc={target} documents={lib.documents}
                    onSelect={async (episodeId) => {
                      await bindDocument(target.id, episodeId);
                      setDialog(null);
                    }}
                    onCancel={() => setDialog(null)} />
                );
              })()}
            {dialog.type === "deleteProject" &&
              (() => {
                const target = lib.projects.find((p) => p.id === dialog.value);
                if (!target) return <p>이미 삭제된 작품입니다.</p>;
                const name = target.title || "제목 없는 작품";
                const count = lib.documents.filter(
                  (d) => d.projectId === target.id && d.kind === "episode",
                ).length;
                return (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (confirmTitle !== name) return;
                      setDialog(null);
                      attempt(() => deleteProject(target.id))();
                    }}
                  >
                    <p>
                      <b>{name}</b> 작품을 삭제할까요?
                    </p>
                    <p className="muted">
                      작품 폴더 전체(회차 {count}편, 플롯, 작품 메모, 표지)를 Windows
                      휴지통으로 옮깁니다. 이 PC의 변경 이력은 보존 정책에 따라 남고,
                      임시 원고는 지워집니다. 동기화를 쓰면 다른 장치에서도 삭제됩니다.
                    </p>
                    <label className="confirm-title">
                      확인을 위해 작품 제목 <b>{name}</b>을(를) 입력해 주세요.
                      <input
                        autoFocus
                        aria-label="삭제할 작품 제목"
                        value={confirmTitle}
                        onChange={(e) => setConfirmTitle(e.target.value)}
                      />
                    </label>
                    <div className="modal-footer">
                      <button type="button" onClick={() => setDialog(null)}>
                        취소
                      </button>
                      <button
                        type="submit"
                        className="danger-solid"
                        disabled={confirmTitle !== name}
                      >
                        <Trash2 size={15} />
                        작품 삭제
                      </button>
                    </div>
                  </form>
                );
              })()}
            {dialog.type === "recovery" && (
              <div className="recovery-list">
                {lib.drafts.map((d: any) => (
                  <div key={d.id}>
                    <b>{d.title}</b>
                    <p>{String(d.body || "").slice(0, 120)}</p>
                    <button
                      onClick={attempt(async () => {
                        const copy = await call<Doc>("createDocument", {
                          projectId: d.projectId,
                          kind: d.kind,
                          title: d.title + " (복구 사본)",
                          body: d.body,
                        });
                        await call("clearDraft", { id: d.id });
                        await refresh();
                        if (draft.current?.doc.id === d.id) {
                          draft.current = null;
                          conflictRef.current = false;
                          setConflict(false);
                        }
                        await openDoc(copy.id, true);
                        message("임시 원고를 새 문서로 복구했습니다.");
                      })}
                    >
                      사본으로 복구
                    </button>
                  </div>
                ))}
              </div>
            )}
            {dialog.type === "settings" && (
              <>
                <div className="settings-layout">
                  <nav className="settings-nav" aria-label="설정 분류">
                    {settingPages.map(({ id, label, icon: Icon }) => (
                      <button key={id} type="button" aria-pressed={settingsPage === id}
                        aria-controls={`settings-${id}`} onClick={() => setSettingsPage(id)}>
                        <Icon size={16} /><span>{label}</span>
                      </button>
                    ))}
                    <p>변경한 설정은<br />바로 저장됩니다.</p>
                  </nav>
                  <div className="settings-content" key={settingsPage}>
                <section id="settings-updates" className="settings-section" hidden={settingsPage !== "updates"}>
                  <UpdateSettings updater={updater} version={lib.version}
                    autoCheck={prefs.checkUpdatesOnStartup !== false}
                    onAutoCheck={(checked) => savePrefs({ checkUpdatesOnStartup: checked }).catch(report)} />
                </section>
                <section id="settings-security" className="settings-section" hidden={settingsPage !== "security"}>
                  {settingsPage === "security" && <PinSettings />}
                </section>
                <section id="settings-editor" className="settings-section" hidden={settingsPage !== "editor"}>
                  <h3>화면과 글꼴</h3>
                  <p className="settings-description">편하게 읽고 쓸 수 있도록 집필 화면을 조정하세요.</p>
                  <div className="settings-grid">
                    <label>
                      글자 크기
                      <select
                        aria-label="글자 크기"
                        value={prefs.fontSize}
                        onChange={(e) =>
                          savePrefs({ fontSize: Number(e.target.value) }).catch(
                            report,
                          )
                        }
                      >
                        {[14, 16, 18, 20, 22, 24].map((n) => (
                          <option key={n} value={n}>
                            {n}px
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      줄 간격
                      <select
                        aria-label="줄 간격"
                        value={prefs.lineHeight}
                        onChange={(e) =>
                          savePrefs({
                            lineHeight: Number(e.target.value),
                          }).catch(report)
                        }
                      >
                        {[1.5, 1.8, 2, 2.2, 2.5].map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      색 테마
                      <select aria-label="색 테마" value={prefs.colorTheme || "modern"}
                        onChange={e => savePrefs({colorTheme: e.target.value}).catch(report)}>
                        <option value="modern">Light Modern</option>
                        <option value="bakery">Bakery</option>
                      </select>
                    </label>
                    <label>
                      화면
                      <select
                        aria-label="화면"
                        value={prefs.theme}
                        onChange={(e) =>
                          savePrefs({ theme: e.target.value }).catch(report)
                        }
                      >
                        <option value="light">밝게</option>
                        <option value="dark">어둡게</option>
                      </select>
                    </label>
                  </div>
                  <div className="settings-subsection">
                    <h3>집필 도우미</h3>
                    <div className="settings-toggles">
                      <SettingsToggle label="수정 시 자동 상태 변경" description="집필 예정인 에피소드에 글을 쓰면 집필 중으로 바꿉니다."
                        checked={prefs.autoChangeStatusOnContentEdit !== false}
                        onChange={(checked) => savePrefs({ autoChangeStatusOnContentEdit: checked }).catch(report)} />
                    </div>
                  </div>
                  <PropertyPresetSettings presets={prefs.propertyPresets} tags={prefs.favoriteTags} onChange={savePrefs} />
                </section>
                <section id="settings-typesetting" className="settings-section" hidden={settingsPage !== "typesetting"}>
                  {(() => {
                    const targetKind = typesettingKind;
                    const targetKindInfo =
                      TYPESETTING_KINDS.find((k) => k.id === targetKind) || TYPESETTING_KINDS[0];
                    const kindEditorStyle = normalizeEditorStyle(prefs, targetKind);
                    const allWidthItems = WIDTH_PRESETS.flatMap((g) => g.items);
                    const updateTargetPrefs = (patch: Record<string, any>) =>
                      saveKindPrefs(targetKind, patch).catch(report);
                    const resetTargetPrefs = () => {
                      const isNote = targetKind === "document";
                      const defPatch = isNote
                        ? { ...DEFAULT_NOTE_EDITOR_STYLE }
                        : { ...DEFAULT_EDITOR_STYLE };
                      saveKindPrefs(targetKind, defPatch)
                        .then(() =>
                          message(
                            `'${targetKindInfo.label}' 조판을 ${isNote ? "메모장 기본값" : "원고 기본값"}으로 초기화했습니다.`,
                          ),
                        )
                        .catch(report);
                    };
                    const copyFromEpisodePrefs = () => {
                      const epStyle = normalizeEditorStyle(prefs, "episode");
                      saveKindPrefs(targetKind, epStyle)
                        .then(() =>
                          message(`'에피소드 원고'의 조판 설정을 '${targetKindInfo.label}'에 복사했습니다.`),
                        )
                        .catch(report);
                    };
                    return (
                      <>
                        <div className="typesetting-kind-bar">
                          <div className="typesetting-kind-tabs" role="tablist" aria-label="조판 대상 문서 타입">
                            {TYPESETTING_KINDS.map((k) => {
                              const KIcon = k.id === "episode" ? BookOpen : FileText;
                              const selected = targetKind === k.id;
                              return (
                                <button
                                  key={k.id}
                                  type="button"
                                  role="tab"
                                  aria-selected={selected}
                                  className={`typesetting-kind-tab ${selected ? "active" : ""}`}
                                  onClick={() => setTypesettingKind(k.id)}
                                >
                                  <KIcon size={15} />
                                  <span>{k.label}</span>
                                </button>
                              );
                            })}
                          </div>
                          <div className="typesetting-kind-meta">
                            <span>{targetKindInfo.description}</span>
                            <div className="row gap">
                              {targetKind !== "episode" && (
                                <button type="button" onClick={copyFromEpisodePrefs}>
                                  에피소드 조판 복사
                                </button>
                              )}
                              <button type="button" onClick={resetTargetPrefs}>
                                {targetKind === "episode" ? "원고 기본값 초기화" : "메모장 기본값 초기화"}
                              </button>
                            </div>
                          </div>
                        </div>

                        <h3>{targetKindInfo.label} · 플랫폼·환경 조판 프리셋</h3>
                        <p className="settings-description">
                          현재 선택한 <strong>{targetKindInfo.label}</strong> 문서 타입에 조판 프리셋을 한 번에 적용합니다.
                        </p>
                        <div className="preset-grid">
                          {PLATFORM_STYLE_PRESETS.map((preset) => (
                            <button
                              key={preset.id}
                              type="button"
                              className="preset-card"
                              onClick={() => {
                                updateTargetPrefs(preset.style);
                                message(
                                  `'${targetKindInfo.label}'에 '${preset.name} (${preset.environment})' 조판 프리셋을 적용했습니다.`,
                                );
                              }}
                            >
                              <strong>
                                {preset.name} <small>({preset.environment})</small>
                              </strong>
                              <small>{preset.description}</small>
                            </button>
                          ))}
                        </div>

                        <div className="settings-subsection">
                          <h3>{targetKindInfo.label} · 문단·본문 조판 세부 설정</h3>
                          <p className="settings-description">
                            글꼴, 자간, 단락 간격, 첫 줄 들여쓰기, 정렬, 구분선 모양을 세밀하게 조정합니다.
                          </p>
                          <div className="settings-grid">
                            <label>
                              본문 글꼴
                              <select
                                aria-label="본문 글꼴"
                                value={kindEditorStyle.fontFamily}
                                onChange={(e) =>
                                  updateTargetPrefs({ fontFamily: e.target.value })
                                }
                              >
                                {FONT_FAMILY_PRESETS.map((f) => (
                                  <option key={f.id || "default"} value={f.value}>
                                    {f.label}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label>
                              글자 크기 (px)
                              <input
                                type="number"
                                min={12}
                                max={36}
                                step={1}
                                aria-label="조판 글자 크기"
                                value={kindEditorStyle.fontSize}
                                onChange={(e) =>
                                  updateTargetPrefs({
                                    fontSize: Math.min(36, Math.max(12, Number(e.target.value) || 18)),
                                  })
                                }
                              />
                            </label>
                            <label>
                              글자 굵기
                              <select
                                aria-label="글자 굵기"
                                value={kindEditorStyle.fontWeight}
                                onChange={(e) =>
                                  updateTargetPrefs({ fontWeight: Number(e.target.value) })
                                }
                              >
                                {[300, 400, 500, 600, 700].map((w) => (
                                  <option key={w} value={w}>
                                    {w === 300 ? "300 (가는 글씨)" : w === 400 ? "400 (보통)" : w === 500 ? "500 (중간)" : w === 600 ? "600 (약간 굵게)" : "700 (굵게)"}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label>
                              자간 (em)
                              <input
                                type="number"
                                min={-0.1}
                                max={0.25}
                                step={0.01}
                                aria-label="자간"
                                value={kindEditorStyle.letterSpacing}
                                onChange={(e) =>
                                  updateTargetPrefs({
                                    letterSpacing: Number(e.target.value) || 0,
                                  })
                                }
                              />
                            </label>
                            <label>
                              줄 간격 (행간)
                              <input
                                type="number"
                                min={1.2}
                                max={3.5}
                                step={0.05}
                                aria-label="조판 줄 간격"
                                value={kindEditorStyle.lineHeight}
                                onChange={(e) =>
                                  updateTargetPrefs({
                                    lineHeight: Number(e.target.value) || 2,
                                  })
                                }
                              />
                            </label>
                            <label>
                              단락 간격 (em)
                              <input
                                type="number"
                                min={0}
                                max={3.5}
                                step={0.05}
                                aria-label="단락 간격"
                                value={kindEditorStyle.blockGap}
                                onChange={(e) =>
                                  updateTargetPrefs({
                                    blockGap: Math.max(0, Number(e.target.value) || 0),
                                  })
                                }
                              />
                            </label>
                            <label>
                              첫 줄 들여쓰기 (em)
                              <select
                                aria-label="첫 줄 들여쓰기"
                                value={kindEditorStyle.indent}
                                onChange={(e) =>
                                  updateTargetPrefs({ indent: Number(e.target.value) })
                                }
                              >
                                <option value={0}>없음 (0em)</option>
                                <option value={0.5}>반 칸 (0.5em)</option>
                                <option value={1}>한 칸 (1em · 종이책/노벨피아)</option>
                                <option value={1.5}>한 칸 반 (1.5em)</option>
                                <option value={2}>두 칸 (2em)</option>
                              </select>
                            </label>
                            <label>
                              문단 정렬
                              <select
                                aria-label="문단 정렬"
                                value={kindEditorStyle.textAlign}
                                onChange={(e) =>
                                  updateTargetPrefs({ textAlign: e.target.value })
                                }
                              >
                                <option value="left">왼쪽 정렬</option>
                                <option value="justify">양쪽 정렬 (종이책 조판)</option>
                                <option value="center">가운데 정렬</option>
                                <option value="right">오른쪽 정렬</option>
                              </select>
                            </label>
                            <label>
                              구분선 모양
                              <select
                                aria-label="구분선 모양"
                                value={kindEditorStyle.dividerStyle}
                                onChange={(e) =>
                                  updateTargetPrefs({ dividerStyle: e.target.value })
                                }
                              >
                                {DIVIDER_STYLES.map((d) => (
                                  <option key={d.id} value={d.id}>
                                    {d.label} — {d.description}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label>
                              구분선 상하 여백 (em)
                              <input
                                type="number"
                                min={0.25}
                                max={5}
                                step={0.25}
                                aria-label="구분선 상하 여백"
                                value={kindEditorStyle.dividerPaddingY}
                                onChange={(e) =>
                                  updateTargetPrefs({
                                    dividerPaddingY: Math.max(0.25, Number(e.target.value) || 1.5),
                                  })
                                }
                              />
                            </label>
                          </div>
                          <div className="settings-toggles" style={{ marginTop: 16 }}>
                            <SettingsToggle
                              label="강제 줄바꿈(Shift+Enter) 뒤 들여쓰기"
                              description="단락 안에서 강제로 줄을 바꾼 다음 줄에도 첫 줄 들여쓰기 폭을 똑같이 적용합니다."
                              checked={kindEditorStyle.hardBreakIndent}
                              onChange={(checked) =>
                                updateTargetPrefs({ hardBreakIndent: checked })
                              }
                            />
                            <SettingsToggle
                              label="동양식 세리프 문장 부호"
                              description="본문이 고딕 글꼴이어도 곡선 따옴표(“ ” ‘ ’), 낫표(「 」 『 』), 말줄임표(…)를 명조 글리프로 조판합니다."
                              checked={kindEditorStyle.serifSymbols}
                              onChange={(checked) =>
                                updateTargetPrefs({ serifSymbols: checked })
                              }
                            />
                          </div>
                        </div>

                        <div className="settings-subsection">
                          <h3>{targetKindInfo.label} · 원고지 폭 · 용지 · 쪽 보기</h3>
                          <p className="settings-description">
                            원고 영역의 최대 폭을 종이 규격·모바일·태블릿 단말기에 맞추거나 A4 쪽 보기로 전환합니다.
                          </p>
                          <div className="settings-grid">
                            <label>
                              단말기 / 용지 폭 프리셋
                              <select
                                aria-label="단말기 및 용지 폭 프리셋"
                                value={
                                  allWidthItems.some((w) => w.width === kindEditorStyle.editorMaxWidth)
                                    ? String(kindEditorStyle.editorMaxWidth)
                                    : "custom"
                                }
                                onChange={(e) => {
                                  if (e.target.value !== "custom") {
                                    updateTargetPrefs({ editorMaxWidth: Number(e.target.value) });
                                  }
                                }}
                              >
                                <option value="custom">직접 지정 ({kindEditorStyle.editorMaxWidth}px)</option>
                                {WIDTH_PRESETS.map((group) => (
                                  <optgroup key={group.group} label={group.group}>
                                    {group.items.map((w) => (
                                      <option key={w.id} value={w.width}>
                                        {w.label}
                                      </option>
                                    ))}
                                  </optgroup>
                                ))}
                              </select>
                            </label>
                            <label>
                              원고 최대 너비 (px)
                              <input
                                type="number"
                                min={350}
                                max={3000}
                                step={10}
                                aria-label="원고 최대 너비"
                                value={kindEditorStyle.editorMaxWidth}
                                onChange={(e) =>
                                  updateTargetPrefs({
                                    editorMaxWidth: Math.min(3000, Math.max(350, Number(e.target.value) || 760)),
                                  })
                                }
                              />
                            </label>
                            <label>
                              원고 좌우 여백 (단계)
                              <input
                                type="number"
                                min={0}
                                max={10}
                                step={1}
                                aria-label="원고 좌우 여백"
                                value={kindEditorStyle.editorPaddingX}
                                onChange={(e) =>
                                  updateTargetPrefs({
                                    editorPaddingX: Math.min(10, Math.max(0, Number(e.target.value) || 0)),
                                  })
                                }
                              />
                            </label>
                            <label>
                              원고지 배경색 / 글자색
                              <div className="color-pair-row">
                                <input
                                  type="color"
                                  aria-label="원고지 배경색"
                                  title="원고지 배경색"
                                  value={kindEditorStyle.textareaBgColor || "#ffffff"}
                                  onChange={(e) =>
                                    updateTargetPrefs({ textareaBgColor: e.target.value })
                                  }
                                />
                                <input
                                  type="color"
                                  aria-label="본문 글자색"
                                  title="본문 글자색"
                                  value={kindEditorStyle.editorTextColor || "#222222"}
                                  onChange={(e) =>
                                    updateTargetPrefs({ editorTextColor: e.target.value })
                                  }
                                />
                                {(kindEditorStyle.textareaBgColor || kindEditorStyle.editorTextColor) && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      updateTargetPrefs({ textareaBgColor: "", editorTextColor: "" })
                                    }
                                  >
                                    초기화
                                  </button>
                                )}
                              </div>
                            </label>
                          </div>
                          <div className="settings-toggles" style={{ marginTop: 16 }}>
                            <SettingsToggle
                              label="A4 인쇄 규격 쪽 보기 (210mm × 297mm)"
                              description="원고 영역을 실제 A4 인쇄 시트(여백 20mm·15mm)와 페이지 구분선으로 표시합니다."
                              checked={kindEditorStyle.pageViewEnabled}
                              onChange={(checked) =>
                                updateTargetPrefs({ pageViewEnabled: checked })
                              }
                            />
                          </div>
                        </div>
                      </>
                    );
                  })()}
                </section>
                <section id="settings-autocomplete" className="settings-section" hidden={settingsPage !== "autocomplete"}>
                  {(() => {
                    const rules = normalizeTextReplacements(prefs.textReplacements);
                    const updateRules = (nextRules: typeof rules) =>
                      savePrefs({ textReplacements: nextRules }).catch(report);
                    const addRule = () => {
                      const from = newRepFrom;
                      const to = newRepTo;
                      if (!from || !to) return;
                      const next = [
                        ...rules,
                        {
                          id: `custom-${Date.now()}`,
                          from,
                          to,
                          enabled: true,
                          label: newRepLabel.trim(),
                        },
                      ];
                      setNewRepFrom("");
                      setNewRepTo("");
                      setNewRepLabel("");
                      updateRules(next);
                    };
                    return (
                      <>
                        <h3>따옴표 · 괄호 · 말줄임 치환</h3>
                        <p className="settings-description">
                          집필 중 따옴표, 괄호, 말줄임표, 구분선을 입력할 때 자동으로 짝을 맞추거나 출판 부호로 치환합니다.
                        </p>
                        <div className="settings-toggles" style={{ marginTop: 14 }}>
                          <SettingsToggle
                            label="따옴표 자동 닫기"
                            description="여는 따옴표를 입력하면 닫는 따옴표를 함께 넣고, 줄 끝 닫는 따옴표 앞에서 Enter를 누르면 다음 문단으로 빠져나갑니다."
                            checked={prefs.autoCloseQuotes !== false}
                            onChange={(checked) =>
                              savePrefs({ autoCloseQuotes: checked }).catch(report)
                            }
                          />
                          <SettingsToggle
                            label="곡선 따옴표 사용"
                            description="직선 따옴표를 입력하면 곡선 따옴표 “ ” ‘ ’로 바꿉니다. 끄면 직선 따옴표를 사용합니다."
                            checked={prefs.quoteStyle === "curly"}
                            onChange={(checked) =>
                              savePrefs({ quoteStyle: checked ? "curly" : "straight" }).catch(report)
                            }
                          />
                          <SettingsToggle
                            label="괄호 자동 닫기"
                            description="여는 괄호 ( [ { 〈 《 「 『 를 입력하면 짝이 되는 닫는 괄호를 함께 넣습니다."
                            checked={prefs.autoCloseBrackets !== false}
                            onChange={(checked) =>
                              savePrefs({ autoCloseBrackets: checked }).catch(report)
                            }
                          />
                          <SettingsToggle
                            label="괄호 연속 입력 변환"
                            description="빈 괄호 안에서 여는 괄호를 한 번 더 누르면 겹화살괄호·낫표·겹낫표((|) → 《|》, [|] → 「|」 → 『|』, {|} → 〈|〉 → 《|》)로 변환합니다."
                            checked={prefs.smartBrackets !== false}
                            onChange={(checked) =>
                              savePrefs({ smartBrackets: checked }).catch(report)
                            }
                          />
                          <SettingsToggle
                            label="구분선 자동 변환"
                            description="빈 줄에서 --- 또는 *** 를 입력하면 원고 구분선으로 즉시 변환합니다."
                            checked={prefs.autoDividerReplacement !== false}
                            onChange={(checked) =>
                              savePrefs({ autoDividerReplacement: checked }).catch(report)
                            }
                          />
                        </div>
                        <div className="row gap" style={{ marginTop: 14, flexWrap: "wrap" }}>
                          <button
                            type="button"
                            disabled={!active || isProtected}
                            onClick={replaceActiveSymbols}
                          >
                            <Sparkles size={15} />
                            현재 문서 따옴표 · 말줄임표 일괄 교정
                          </button>
                          <small className="muted">
                            {active
                              ? `열린 문서 '${active.title || "제목 없음"}'에 곡선 따옴표 설정과 활성화된 '...' 대치어를 적용합니다.`
                              : "문서를 열면 곡선 따옴표 설정과 활성화된 '...' 대치어를 본문에 한 번에 적용할 수 있습니다."}
                          </small>
                        </div>

                        <div className="settings-subsection">
                          <div className="typesetting-scope-header">
                            <h3>사용자 대치어</h3>
                            <button
                              type="button"
                              onClick={() =>
                                savePrefs({
                                  textReplacements: DEFAULT_TEXT_REPLACEMENTS.map((r) => ({ ...r })),
                                })
                                  .then(() => message("기본 대치어 목록으로 복원했습니다."))
                                  .catch(report)
                              }
                            >
                              <RefreshCw size={14} />
                              기본 대치어 복원
                            </button>
                          </div>
                          <p className="settings-description">
                            자주 쓰는 특수 기호나 상용구를 등록해 두면, 입력어를 치는 즉시 대치어로 자동 변환합니다. 말줄임표도 아래 목록에서 변환 결과를 수정하거나 끌 수 있습니다.
                          </p>
                          <div className="settings-toggles" style={{ marginBottom: 14 }}>
                            <SettingsToggle
                              label="사용자 대치어 사용"
                              description="집필 중 아래 목록에 켜져 있는 입력어가 완성되면 대치어로 즉시 바꿉니다."
                              checked={prefs.autoSymbolReplacement !== false}
                              onChange={(checked) =>
                                savePrefs({ autoSymbolReplacement: checked }).catch(report)
                              }
                            />
                          </div>
                          <div className="replacement-add-row">
                            <input
                              type="text"
                              aria-label="새 대치어 입력어"
                              placeholder="입력어 (예: --, ->, ㅇㅇ)"
                              value={newRepFrom}
                              onChange={(e) => setNewRepFrom(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  addRule();
                                }
                              }}
                            />
                            <span className="replacement-arrow" aria-hidden="true">
                              →
                            </span>
                            <input
                              type="text"
                              aria-label="새 대치어 변환 결과"
                              placeholder="대치어 (예: —, →, 상용구)"
                              value={newRepTo}
                              onChange={(e) => setNewRepTo(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  addRule();
                                }
                              }}
                            />
                            <input
                              type="text"
                              aria-label="새 대치어 설명"
                              placeholder="설명 (선택)"
                              value={newRepLabel}
                              onChange={(e) => setNewRepLabel(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  addRule();
                                }
                              }}
                            />
                            <button
                              type="button"
                              className="primary"
                              disabled={!newRepFrom || !newRepTo}
                              onClick={addRule}
                            >
                              <Plus size={15} />
                              추가
                            </button>
                          </div>
                          <div className="replacement-list" role="list" aria-label="사용자 대치어 목록">
                            {rules.map((rule, idx) => (
                              <div
                                key={rule.id || idx}
                                role="listitem"
                                className={`replacement-row ${rule.enabled ? "" : "disabled"}`}
                              >
                                <input
                                  type="checkbox"
                                  aria-label={`${rule.from} 대치어 사용`}
                                  checked={rule.enabled}
                                  onChange={(e) => {
                                    const next = rules.map((r, i) =>
                                      i === idx ? { ...r, enabled: e.target.checked } : r,
                                    );
                                    updateRules(next);
                                  }}
                                />
                                <input
                                  type="text"
                                  className="replacement-from"
                                  aria-label={`${idx + 1}번 입력어`}
                                  value={rule.from}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    if (!val) return;
                                    const next = rules.map((r, i) =>
                                      i === idx ? { ...r, from: val } : r,
                                    );
                                    updateRules(next);
                                  }}
                                />
                                <span className="replacement-arrow" aria-hidden="true">
                                  →
                                </span>
                                <input
                                  type="text"
                                  className="replacement-to"
                                  aria-label={`${idx + 1}번 대치어`}
                                  value={rule.to}
                                  onChange={(e) => {
                                    const next = rules.map((r, i) =>
                                      i === idx ? { ...r, to: e.target.value } : r,
                                    );
                                    updateRules(next);
                                  }}
                                />
                                <input
                                  type="text"
                                  className="replacement-label"
                                  aria-label={`${idx + 1}번 대치어 설명`}
                                  placeholder="설명"
                                  value={rule.label || ""}
                                  onChange={(e) => {
                                    const next = rules.map((r, i) =>
                                      i === idx ? { ...r, label: e.target.value } : r,
                                    );
                                    updateRules(next);
                                  }}
                                />
                                <button
                                  type="button"
                                  className="replacement-delete"
                                  aria-label={`${rule.from} 대치어 삭제`}
                                  title="삭제"
                                  onClick={() => {
                                    const next = rules.filter((_, i) => i !== idx);
                                    updateRules(next);
                                  }}
                                >
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            ))}
                            {!rules.length && (
                              <p className="muted" style={{ padding: "12px 0", margin: 0 }}>
                                등록된 대치어가 없습니다. 위 입력칸에서 새 대치어를 추가하거나 기본 대치어를 복원하세요.
                              </p>
                            )}
                          </div>
                        </div>
                      </>
                    );
                  })()}
                </section>
                <section id="settings-storage" className="settings-section" hidden={settingsPage !== "storage"}>
                  <h3>
                    <StickyNote size={17} />
                    공용 메모
                  </h3>
                  <div className="connection">
                    <div>
                      <b>공용 메모 폴더</b>
                      <small>{commonMemoPath}</small>
                    </div>
                    <button
                      onClick={attempt(async () => {
                        const next = await call<string | null>("chooseCommonMemo");
                        if (next) {
                          setCommonMemoPath(next);
                          message("공용 메모 폴더를 바꿨습니다.");
                        }
                      })}
                    >
                      <FolderOpen size={15} />
                      위치 변경
                    </button>
                  </div>
                  <p className="muted">
                    여러 작품에서 함께 쓰는 메모를 이 폴더에 Markdown 파일로 보관합니다.
                    기존 폴더를 고르면 안의 파일을 그대로 메모로 보여줍니다.
                  </p>
                </section>
                <section className="settings-section" hidden={settingsPage !== "storage"}>
                  <h3>
                    <History size={17} />
                    변경 이력
                  </h3>
                  <div className="settings-grid">
                    <label>
                      최소 간격(분)
                      <input
                        type="number"
                        min={0}
                        max={1440}
                        aria-label="변경 이력 최소 간격(분)"
                        value={prefs.historyMinMinutes ?? 1}
                        onChange={(e) =>
                          savePrefs({
                            historyMinMinutes: Math.min(
                              1440,
                              Math.max(0, Math.floor(Number(e.target.value) || 0)),
                            ),
                          }).catch(report)
                        }
                      />
                    </label>
                    <label>
                      최소 변경 글자 수
                      <input
                        type="number"
                        min={0}
                        max={100000}
                        step={50}
                        aria-label="변경 이력 최소 변경 글자 수"
                        value={prefs.historyMinChars ?? 200}
                        onChange={(e) =>
                          savePrefs({
                            historyMinChars: Math.min(
                              100000,
                              Math.max(0, Math.floor(Number(e.target.value) || 0)),
                            ),
                          }).catch(report)
                        }
                      />
                    </label>
                  </div>
                  <p className="muted">
                    마지막 이력 이후 두 조건을 모두 넘게 고쳤을 때만 저장 직전 원고를
                    이력으로 남깁니다. 둘 다 0이면 저장할 때마다 남깁니다.
                  </p>
                  <p className="muted">
                    수정 이력은 이 PC에만 보관하며 동기화하지 않습니다. 외부에서 수정되거나
                    동기화로 교체되는 원고도 이전 내용을 남깁니다. 오래된 이력은 하루 한 번 정리하며
                    문서당 최근 100개·30일을 기준으로 최소 10개를 보존합니다.
                  </p>
                  <button disabled={busy} onClick={attempt(async () => {
                    setBusy(true);
                    try {
                      await flush();
                      const result = await call<{ path: string }>("backupStorage");
                      message("로컬 이력 백업을 저장했습니다: " + result.path);
                    } finally {
                      setBusy(false);
                    }
                  })}>
                    <HardDrive size={16} /> 로컬 이력 백업
                  </button>
                </section>
                <section id="settings-defaults" className="settings-section" hidden={settingsPage !== "defaults"}>
                  <h3>새 작품의 기본 설정</h3>
                  <p className="settings-description">새 작품을 만들 때 사용할 플랫폼과 목표 분량입니다.</p>
                  <PlatformPicker
                    value={normalizeWriting(prefs.defaultWriting)}
                    onChange={(writing) =>
                      savePrefs({ defaultWriting: writing }).catch(report)
                    }
                  />
                </section>
                <section className="settings-section" hidden={settingsPage !== "defaults"}>
                  <fieldset className="linebreak-options">
                    <legend>새 에피소드 줄바꿈</legend>
                    <p className="settings-description">작품에서 별도로 지정하지 않으면 이 방식을 사용합니다.</p>
                    <div className="linebreak-choices">
                      {[false, true].map((manual) => (
                        <label key={String(manual)} className={`linebreak-choice${(prefs.defaultManualLineBreak === true) === manual ? " selected" : ""}`}>
                          <input type="radio" name="defaultLineBreak" value={String(manual)}
                            checked={(prefs.defaultManualLineBreak === true) === manual}
                            onChange={() => savePrefs({ defaultManualLineBreak: manual }).catch(report)} />
                          <span>
                            <strong>{lineBreakLabel(manual)}{!manual && <small>기본</small>}</strong>
                            <span>{manual ? "단락 사이에 간격을 두지 않습니다." : "단락 사이에 간격을 둡니다."}</span>
                            <span className="linebreak-keys"><kbd>Enter</kbd> {manual ? "줄바꿈" : "새 단락"}</span>
                            {!manual && <span className="linebreak-keys"><kbd>Shift + Enter</kbd> 단락 안 줄바꿈</span>}
                          </span>
                        </label>
                      ))}
                    </div>
                    <p className="settings-note">새로 만드는 에피소드에 적용됩니다. 기존 회차는 에피소드 속성에서 개별 변경할 수 있습니다.</p>
                  </fieldset>
                </section>
                <section id="settings-connections" className="settings-section" hidden={settingsPage !== "connections"}>
                  <h3>
                    <Cloud size={18} />
                    외부 저장소
                  </h3>
                  <p className="settings-description">자동 저장과 수동 저장이 끝나면 2초 뒤 등록된 저장소에 자동으로 동기화합니다. 연속 수정은 모아서 처리하며, 트레이에서도 계속됩니다.</p>
                  <aside className="sync-notice" aria-label="동기화 이용 안내">
                    <strong>동기화는 아직 불안정할 수 있습니다.</strong>
                    <p>중요한 원고는 별도로 백업해 주세요.</p>
                    <p>동기화하려면 사용하는 모든 기기의 Lof Writer를 최신 버전으로 업데이트해야 합니다. 구버전 앱은 새 동기화 데이터를 받을 수 없습니다.</p>
                    <p>최신 문서만 동기화하며, 수정 이력은 각 기기에 별도로 보관합니다.</p>
                  </aside>
                  {connections.length > 0 && <p role="status" className={autoSync.phase === "error" ? "pin-error" : "muted"}>
                    {autoSyncLabels[autoSync.phase]}{autoSync.message && ` · ${autoSync.message}`}
                  </p>}
                  {googleDriveEnabled && googleConnecting && <div className="connection" role="status">
                    <div><b>Google 계정 연결 중</b><small>브라우저에서 로그인하고 접근을 허용해 주세요.</small></div>
                    <button type="button" onClick={attempt(async () => { await call("cancelGoogleDrive"); })}>취소</button>
                  </div>}
                  {connections.map((c) => (
                    <div className="connection" key={c.id}>
                      <div>
                        <b>{c.name}</b>
                        <small>
                          {c.type === "google-drive" ? `${c.email} · Google Drive / Lof Writer`
                            : c.type === "folder" ? c.folder : c.url || c.host}
                        </small>
                      </div>
                      <button disabled={busy || autoSync.phase === "syncing"} onClick={() => doSync(c.id)}>
                        <RefreshCw size={15} />
                        {busy ? "진행 중" : "동기화"}
                      </button>
                      {googleDriveEnabled && c.type === "google-drive" && <button disabled={busy}
                        onClick={() => void connectGoogleDrive({ id: c.id })}>계정 다시 연결</button>}
                      <button
                        disabled={busy}
                        title="연결 제거 (원격 파일 보존)"
                        aria-label={`${c.name} 연결 제거`}
                        onClick={attempt(async () => {
                          await call("removeConnection", { id: c.id });
                          setConnections((await call("settings")).connections);
                        })}
                      >
                        <X size={15} />
                      </button>
                    </div>
                  ))}
                  <form
                    className="connection-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const data = Object.fromEntries(
                        new FormData(e.currentTarget),
                      );
                      if (connectionType === "google-drive") {
                        void connectGoogleDrive({ name: String(data.name || "") });
                        return;
                      }
                      (async () => {
                        setBusy(true);
                        try {
                          await call("saveConnection", {
                            ...data,
                            type: connectionType,
                            secure: data.secure === "on",
                          });
                          setConnections((await call("settings")).connections);
                          message(
                            "연결을 추가했습니다. 자동 동기화를 시작합니다.",
                          );
                        } finally {
                          setBusy(false);
                        }
                      })().catch(report);
                    }}
                  >
                    <div className="row gap">
                      <select
                        aria-label="연결 방식"
                        disabled={busy}
                        value={connectionType}
                        onChange={(e) => setConnectionType(e.target.value)}
                      >
                        <option value="folder">로컬 폴더</option>
                        {googleDriveEnabled && <option value="google-drive">Google Drive</option>}
                        <option value="webdav">WebDAV</option>
                        <option value="ftp">FTP / FTPS</option>
                      </select>
                      <input
                        name="name"
                        aria-label="연결 이름"
                        placeholder="연결 이름"
                        disabled={busy}
                      />
                    </div>
                    {googleDriveEnabled && connectionType === "google-drive" && <p className="muted">
                      내 Google 계정으로 로그인해 Drive의 Lof Writer 폴더에 동기화합니다.
                      다른 PC에서도 같은 계정을 연결하세요.
                    </p>}
                    {(connectionType === "webdav" || connectionType === "ftp") && (
                      <>
                        <input
                          name={connectionType === "webdav" ? "url" : "host"}
                          aria-label="서버 주소"
                          required
                          placeholder={
                            connectionType === "webdav"
                              ? "https://nas.example.com/dav"
                              : "FTP 호스트"
                          }
                        />
                        <div className="row gap">
                          <input
                            name="username"
                            aria-label="사용자 이름"
                            placeholder="사용자 이름"
                            autoComplete="off"
                          />
                          <input
                            name="password"
                            aria-label="비밀번호"
                            type="password"
                            placeholder="비밀번호"
                            autoComplete="off"
                          />
                        </div>
                        <input
                          name="remotePath"
                          aria-label="원격 폴더"
                          placeholder="원격 폴더 (예: /writing)"
                        />
                        {connectionType === "ftp" && (
                          <div className="row gap">
                            <input
                              name="port"
                              aria-label="FTP 포트"
                              type="number"
                              placeholder="포트 (기본 21)"
                            />
                            <label className="checkbox">
                              <input
                                type="checkbox"
                                name="secure"
                                defaultChecked
                              />
                              FTPS
                            </label>
                          </div>
                        )}
                      </>
                    )}
                    <button disabled={busy} type="submit">
                      <Link size={15} />
                      {connectionType === "folder"
                        ? "동기화 폴더 선택"
                        : connectionType === "google-drive" ? "Google 계정 연결" : "연결 추가"}
                    </button>
                  </form>
                </section>
                <section id="settings-api" className="settings-section" hidden={settingsPage !== "api"}>
                  <h3>
                    <Code2 size={18} />
                    MCP / API
                  </h3>
                  <p className="muted">연결할 때 앱을 켜 두세요.</p>
                  <div className="row gap">
                    <button
                      onClick={attempt(async () => {
                        await call("mcpConfig");
                        message("MCP 설정 JSON을 복사했습니다.");
                      })}
                    >
                      <Copy size={15} />
                      MCP 설정 복사
                    </button>
                    <button
                      onClick={attempt(async () => {
                        await call("copyApi");
                        message("API 주소와 인증 키를 복사했습니다.");
                      })}
                    >
                      <Copy size={15} />
                      API 연결 정보 복사
                    </button>
                  </div>
                </section>
                  </div>
                </div>
                <footer className="settings-footer">
                  <span>Lof Writer {lib.version}</span>
                  <span title={lib.root}>내 서재 · {lib.root}</span>
                </footer>
              </>
            )}
          </div>
        </div>
      )}
      <UpdateNotice updater={updater} onOpen={() => {
        setSettingsPage("updates");
        openSettings().catch(report);
      }} />
    </div>
    <UpdateLock phase={updater.phase} />
    </>
  );
}
