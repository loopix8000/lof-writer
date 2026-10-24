import RecoveryCopies from "./RecoveryCopies";
import BookmarkList from "./app/BookmarkList";
import BookmarksPage from "./app/BookmarksPage";
import BrokenFiles from "./app/BrokenFiles";
import { icons, labels } from "./app/document-ui";
import DocumentLinksWidget from "./app/DocumentLinksWidget";
import ExportDialog from "./app/ExportDialog";
import FileTree from "./app/FileTree";
import LibraryPage from "./app/LibraryPage";
import ProjectForm from "./app/ProjectForm";
import ProjectPage from "./app/ProjectPage";
import { type SettingsPage } from "./app/settings-pages";
import SettingsContent from "./app/SettingsContent";
import TitleBar from "./app/TitleBar";
import TypesettingSettings from "./app/TypesettingSettings";
import { useDocumentImages } from "./app/useDocumentImages";
import { useDocumentNotes } from "./app/useDocumentNotes";
import { useDocumentSession } from "./app/useDocumentSession";
import { useEditorGroups } from "./app/useEditorGroups";
import { useFileTree } from "./app/useFileTree";
import {
  insertDocument,
  patchDocuments,
  patchProject,
  removeDocuments,
  removeProject,
  type LibraryChange,
} from "./app/library-changes";
import { usePreferences } from "./app/usePreferences";
import { prepareEditorFonts } from "./font-loader";

import {
  Archive,
  ArrowLeft,
  Bookmark as BookmarkIcon,
  BookOpen,
  Check,
  Cloud,
  Columns2,
  Copy,
  Download,
  FileText,
  FolderOpen,
  HardDrive,
  History,
  Library as LibraryIcon,
  Maximize,
  Moon,
  MoreHorizontal,
  PanelLeft,
  Pilcrow,
  Search,
  Settings,
  Smartphone,
  StickyNote,
  Sun,
  Trash2,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  lineBreakDefault,
  normalizeStatus
} from "../core/episode.mjs";
import { normalizeWriting, writingName } from "../core/platforms.mjs";
import {
  countForRule,
  plainText,
  requiresSource,
  stripJsdocComments,
} from "../core/text.mjs";
import {
  normalizeEditorStyle,
  replaceManuscriptSymbols,
  resolveKindPrefs
} from "../core/typesetting.mjs";
import {
  migrateTypingPreferences,
  normalizeTextReplacements
} from "../core/typing.mjs";
import { globalView, initialNavigation, requiresDocumentSource, sameDocumentContent, withDocumentDraft, type Destination, type Dialog, type EditorTab, type Navigation, type Side } from "./app/model";
import { useConfirm } from "./ConfirmDialog";
import { useLargeDocumentMode } from "./app/useLargeDocumentMode";
import { useDaemonUpdateNotice } from "./app/useDaemonUpdateNotice";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import { ImageViewer } from "./CoverImage";
import EditorScroll from "./EditorScroll";
import EpisodeBindingPicker from "./EpisodeBindingPicker";
import EpisodeProperties, { statusItems } from "./EpisodeProperties";
import SyncIssueBanner from "./SyncIssueBanner";
import HistoryDialog from "./HistoryDialog";
import DocumentExportDialog from "./DocumentExportDialog";
import MemoSession from "./MemoSession";
import MobilePreview from "./MobilePreview";
import type { NoteMark } from "./note-links";
import { resolveDocumentLink, type DocumentLinkSource } from "./document-links";
import PlatformCount from "./PlatformCount";
import PlatformPicker from "./PlatformPicker";
import QuickNote, { quickNoteMarkdown, quickNoteTitle, type QuickNoteSource } from "./QuickNote";
import RealtimeSync from "./RealtimeSync";
import { ReleaseNotesDialog, ReleaseNotice, useReleaseNotice } from "./ReleaseNotes";
import ResizableSidebar from "./ResizableSidebar";
import { initializeWorkspaceState, flushWorkspaceState, workspaceKey } from "./workspace-state";
import { groupShortcutIndex, type SplitDirection } from "./split/layout";
import { splitMenuItems } from "./split/menu";
import { groupAttributes, tabAttributes, tabBarAttributes, type SplitDrag } from "./split/controller";
import SplitArea from "./split/SplitArea";
import RetainedTab from "./RetainedTab";
import {
  QuickOpen,
  SearchPanel,
  type QuickItem,
  type SearchMatch,
  type SearchResult,
} from "./SearchViews";
import SyncConnections from "./SyncConnections";
import { externalScreenOpen, isAndroidApp } from "./tauri-bridge";
import SyncStatus from "./SyncStatus";
import {
  call,
  type AutoSyncStatus,
  type Doc,
  type Kind,
  type Library,
  type SyncConnection,
  type WritingRules
} from "./types";
import { UpdateLock, UpdateNotice, useAppUpdater, updateChannel } from "./Updater";
import { useManuscriptCounts } from "./useManuscriptCounts";
import { useProjectReorder } from "./useProjectReorder";
import { useProjectSyncUpdates } from "./useSyncFileUpdates";
import Writer from "./Writer";
import MobileShell from "./mobile/MobileShell";
// 저장할 때마다 임시 원고를 먼저 쓰고 저장이 끝나면 지운다. 그 사이에 목록을 새로 읽으면
// 편집 중인 원고의 임시본이 잡히므로, 앱을 연 뒤 지금 편집 중인 원고에 쓴 임시본은 복구 대상에서 뺀다.
const appStartedAt = Date.now();
const empty: Library = {
  root: "",
  projects: [],
  documents: [],
  warnings: [],
  drafts: [],
  preferences: {},
  version: "",
};

export default function App() {
  const { prefs, setPrefs, prefsRef, savePrefs, saveKindPrefs } = usePreferences();
  const [lib, setLib] = useState<Library>(empty),
    [loaded, setLoaded] = useState(false),
    [view, setView] = useState("library"),
    [projectId, setProjectId] = useState(""),
    [tab, setTab] = useState<Kind>("episode"),
    [dialog, setDialog] = useState<Dialog | null>(null),
    [settingsPage, setSettingsPage] = useState<SettingsPage>("editor"),
    [typesettingKind, setTypesettingKind] = useState<"episode" | "document">("episode"),
    [newRepFrom, setNewRepFrom] = useState(""),
    [newRepTo, setNewRepTo] = useState(""),
    [newRepLabel, setNewRepLabel] = useState(""),
    [toast, setToast] = useState(""),
    // 토스트의 버튼(예: 속성 제거의 '실행 취소').
    [toastAction, setToastAction] = useState<{ label: string; run: () => void } | null>(null),
    [error, setError] = useState(""),
    [source, setSource] = useState(false),
    // 편집 중인 원고에서 커서가 있는 줄 번호(상태줄에 보인다).
    [cursorLine, setCursorLine] = useState<number | null>(null),
    [focus, setFocus] = useState(false),
    // 집중 모드의 파일 트리는 평소 상태와 따로 두고, 집중 모드에 들어갈 때마다 닫힌 채로 시작한다.
    [focusTree, setFocusTree] = useState(false),
    [viewer, setViewer] = useState<{ src: string; alt: string } | null>(null),
    [isMobile, setIsMobile] = useState(
      () =>
        typeof window !== "undefined" &&
        (window.innerWidth <= 768 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)),
    ),
    [sidebar, setSidebar] = useState(
      () =>
        !(
          typeof window !== "undefined" &&
          (window.innerWidth <= 768 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent))
        ),
    ),
    [right, setRight] = useState(
      () =>
        !(
          typeof window !== "undefined" &&
          (window.innerWidth <= 768 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent))
        ),
    ),
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
    [connections, setConnections] = useState<SyncConnection[]>([]),
    [settingsDataState, setSettingsDataState] = useState<"loading" | "ready" | "error">("loading"),
    [autoSync, setAutoSync] = useState<AutoSyncStatus>({ phase: "idle", message: "" }),
    [syncChecking, setSyncChecking] = useState(false),
    [syncAvailable, setSyncAvailable] = useState(false),
    [skillDownloading, setSkillDownloading] = useState(false),
    [busy, setBusy] = useState(false),
    // 메모 세션(레일의 메모 버튼). 열려 있는 동안 집필 화면은 그대로 두고 가린다.
    [memoOpen, setMemoOpen] = useState(false),
    // 모바일에서 문서를 닫는 동안 저장이 끝나기 전에도 편집 화면을 먼저 내린다.
    [mobileClosing, setMobileClosing] = useState(false),
    [commonMemoPath, setCommonMemoPath] = useState(""),
    // 본문 우클릭 '메모 추가'로 연 퀵 노트 창.
    [quickNote, setQuickNote] = useState<QuickNoteSource | null>(null),
    // 작품 삭제 확인: 작품 제목을 그대로 입력해야 삭제 버튼이 켜진다.
    [confirmTitle, setConfirmTitle] = useState(""),
    // 위젯 보드 자리에 펼친 목록(위젯·북마크·조판 설정), 목록에서 고른 북마크(문단 순서).
    [rightView, setRightView] = useState<"widgets" | "bookmarks" | "typesetting">("widgets"),
    [bookmarkJump, setBookmarkJump] = useState<{ docId: string; index: number; seq: number } | null>(null),
    // 레일의 전체 북마크 화면 검색어.
    [bookmarkQuery, setBookmarkQuery] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; align?: "start" | "end"; items: MenuItem[]; target?: string } | null>(null),
    [dragTab, setDragTab] = useState(""),
    [emptyDrop, setEmptyDrop] = useState(false);
  const memoFlush = useRef<((options?: { closing?: boolean }) => Promise<void>) | null>(null);
  const memoManualSave = useRef<(() => Promise<void>) | null>(null);
  const imageCache = useRef(new Map<string, Promise<string | null>>());
  // 메모 화면에서 메모를 여는 함수(빠른 열기에서 공용 메모를 고를 때).
  const memoApi = useRef<{ open: (space: string, path: string, pinned?: boolean) => Promise<void> } | null>(null);
  // 전역 단축키에서 늘 최신 검색 함수를 부르도록 한다.
  const searchActions = useRef({ openQuick: () => {}, openSearch: () => {} });
  const closeMenu = useCallback(() => setMenu(null), []);
  const closeViewer = useCallback(() => setViewer(null), []);
  const switchWasOpen = useRef(false);
  const tabActions = useRef<{
    closeTab: (id: string) => Promise<void>;
    cycleTab: (direction: number) => Promise<void>;
    shiftTab: (step: 1 | -1) => void;
    splitTo: (id: string, direction?: SplitDirection) => Promise<unknown>;
    focusGroupAt: (index: number) => Promise<void>;
    focusDirection: (direction: SplitDirection) => Promise<void>;
    moveToDirection: (id: string, step: 1 | -1) => Promise<void>;
    togglePreview: () => void;
    report: (e: any) => void;
  }>(null!);
  const [navigation, setNavigation] = useState<Navigation>(initialNavigation);
  const navigationRef = useRef(navigation);
  const libraryRef = useRef(lib);
  const projectRef = useRef("");
  const documentMove = useRef<Promise<void> | null>(null);
  const refreshSeq = useRef(0),
    settingsRequest = useRef(0),
    initialized = useRef(false),
    navigationSeq = useRef(0),
    toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingWriting = useRef(new Map<string, WritingRules>()),
    writingQueue = useRef(Promise.resolve()),
    // 백엔드 처리가 끝나기 전 화면에 먼저 반영한 서재 변경과 그 처리 순서.
    pendingChanges = useRef(new Map<number, LibraryChange>()),
    changeSeq = useRef(0),
    changeQueue = useRef<Promise<unknown>>(Promise.resolve()),
    // 조판 설정을 열 때 우측 사이드바가 닫혀 있었으면, 조판 설정을 닫을 때 사이드바도 다시 닫는다.
    typesettingOpenedRight = useRef(false);
  const project = lib.projects.find((p) => p.id === projectId);
  const message = useCallback((text: string, action?: { label: string; run: () => void }, duration = 4500) => {
    setToast(text);
    setToastAction(action ?? null);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => {
      setToast("");
      setToastAction(null);
    }, duration);
  }, []);
  const report = useCallback((e: any) => {
    setError(e.message || String(e));
  }, []);
  const session = useDocumentSession({
    loaded, visible: view === "workspace" && !memoOpen, memoOpen, prefs,
    flushMemo: (options) => memoFlush.current?.(options),
    waitForWriting: () => writingQueue.current,
    pendingDocumentMove: () => documentMove.current,
    saveMemoManually: () => memoManualSave.current?.(),
    retainDocument: (doc) => retainDocument(doc),
    clearRetainedDocuments: () => clearRetainedDocuments(),
    pinTab: (id) => pinTab(id),
    onDocumentIdChanged: handleDocumentIdChange,
    message, report,
  });
  const { active, saveStatus, conflict, flush, flushForClose, waitForSave, reconcileDocuments,
    manualSave, edit, writeMeta } = session;
  const {
    area, tabs: editorTabs, split, groups, sides, focusedSide,
    retainDocument, getRetainedDocument, clearRetainedDocuments,
    pruneDocuments, resetGroups, commitOpenDocument, replaceDocumentId: replaceGroupDocumentId, getProjectDocument,
    openDoc, openLinked, pinTab, pinSideTab, closeTab, closeTabs, cycleTab, shiftTab, moveTab,
    focusOther, focusSide, focusGroupAt, focusDirection, openInGroup, splitTo, canSplit, closeGroup, closeOtherGroup, moveToOther, moveToDirection, closeSideTab, closeSideTabs,
    groupStyle,
  } = useEditorGroups({
    active,
    documents: lib.documents,
    root: lib.root,
    workspaceOpen: view === "workspace",
    visible: view === "workspace" && !memoOpen,
    currentId: session.currentId,
    currentDocument: session.currentDocument,
    pendingDocumentMove: () => documentMove.current,
    flush: (options) => flush(options),
    navigate: (id, pinned, beforeCommit) =>
      navigate({ view: "workspace", projectId: "", documentId: id, pinned }, undefined, beforeCommit),
    closeLastDocument,
    message,
    report,
  });
  const dragSide = useRef<Side>("left");
  const shownLibrary = useMemo(() => withDocumentDraft(lib, active), [lib, active]);
  const fileTree = useFileTree({
    library: shownLibrary, active, projectId, view, archive, menuTarget: menu?.target,
    getLibrary: () => libraryRef.current,
    currentProjectId: () => projectRef.current,
    currentDocument: session.currentDocument,
    flush: () => flush(), refresh: () => refresh(),
    changeLibrary: optimistic, showCreatedDocument,
    moveDocuments,
    openDoc, closeTab, closeSideTab,
    writeMeta, patchDoc, archiveDoc, archiveDocs, copyPath, docMenu, openMenu,
    onDelete: (ids) => setDialog({ type: "deleteDoc", ids }),
    remapDocuments: (before, from, to) => remapDocs(before, from, to),
    showTree: () => { if (focusRef.current) setFocusTree(true); else setSidebar(true); },
    onDragStart: () => setDragTab(""), onDragEnd: () => area.clearDropZone(),
    confirm: (options) => confirm({ ...options, icon: <Trash2 size={15} /> }),
    message, report,
  });
  const { docs, count, numberOf, startRename, plotItems, addDocFile, loadMemoFolders } = fileTree;
  useProjectSyncUpdates(loaded && projectId && (view === "project" || view === "workspace") ? `${projectId}:${view}` : "", report,
    (checking, available) => {
      setSyncChecking(checking);
      if (available !== undefined) setSyncAvailable(available);
    });
  const refresh = useCallback(async () => {
    const seq = ++refreshSeq.current;
    const data = await call<Library>("bootstrap");
    if (seq !== refreshSeq.current) return;
    data.projects = data.projects.map(p => pendingWriting.current.has(p.id) ? {...p, writing: pendingWriting.current.get(p.id)} : p);
    if(!initialized.current){
      prepareEditorFonts(data.preferences);
      const migratedPrefs = migrateTypingPreferences(data.preferences);
      if (migratedPrefs !== data.preferences) {
        await call("setPreferences", {
          textReplacements: migratedPrefs.textReplacements,
          textReplacementsVersion: migratedPrefs.textReplacementsVersion,
        });
        data.preferences = migratedPrefs;
      }
      initialized.current=true;
      initializeWorkspaceState(data.preferences.workspaceSessions, report);
      setPrefs(p=>({...p,...data.preferences}));
      if(!data.preferences.setupComplete)setDialog({type:'setup',writing:normalizeWriting(data.preferences.defaultWriting)});
    }
    // 아직 처리 중인 변경은 다시 읽은 서재에도 덧씌워 화면이 예전 상태로 돌아가지 않게 한다.
    let shown = data;
    for (const change of pendingChanges.current.values()) shown = change(shown);
    libraryRef.current = shown;
    setLib(shown);
    // 폴더 이동이 새 ID를 탭·세션에 반영할 때까지 기존 탭을 정리하지 않는다.
    if (!documentMove.current) pruneDocuments(new Set(data.documents.map((doc) => doc.id)));
    setLoaded(true);
    if (!projectRef.current && shown.projects.length) {
      projectRef.current = shown.projects[0].id;
      setProjectId(projectRef.current);
    }
    reconcileDocuments(data.documents);
    return shown;
  }, [pruneDocuments, reconcileDocuments]);
  function updateLibrary(change: LibraryChange) {
    libraryRef.current = change(libraryRef.current);
    setLib(libraryRef.current);
  }
  // 화면을 먼저 바꾸고 백엔드 작업은 들어온 순서대로 처리한다. 실패하면 서재를 다시 읽어 되돌린다.
  function optimistic<T>(change: LibraryChange, run: () => Promise<T>): Promise<T> {
    const key = ++changeSeq.current;
    pendingChanges.current.set(key, change);
    updateLibrary(change);
    const task = changeQueue.current.then(run);
    changeQueue.current = task.catch(() => {});
    return task.then(
      (result) => {
        // 처리 결과를 담은 서재를 받을 때까지 변경을 유지해, 먼저 시작한 갱신이 화면을 되돌리지 않게 한다.
        refresh().catch(report).finally(() => pendingChanges.current.delete(key));
        return result;
      },
      async (error) => {
        pendingChanges.current.delete(key);
        await refresh().catch(report);
        throw error;
      },
    );
  }
  // 백엔드가 만든 문서를 서재를 다시 읽기 전에 목록에 넣는다.
  function showCreatedDocument(doc: Doc) {
    updateLibrary(insertDocument(doc));
    void refresh().catch(report);
  }
  const projectReorder = useProjectReorder(libraryRef, lib.root, loaded && view === "library", busy, optimistic, report);
  const updater = useAppUpdater({
    loaded,
    channel: updateChannel(prefs.updateChannel),
    autoCheck: prefs.checkUpdatesOnStartup !== false,
    beforeInstall: async () => {
      if (busy) throw Error("진행 중인 작업이 끝난 뒤 다시 시도해 주세요.");
      await session.prepareForInstall();
    },
  });
  const releaseNotice = useReleaseNotice(lib.version, loaded, prefs.setupComplete === true);
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  useDaemonUpdateNotice(loaded, autoSync.channels?.realtime?.daemonUpdates, confirm, () => openSettings("serverSync"), report);
  const largeDocument = useLargeDocumentMode(active, confirm);
  // 원문 편집 전환과 10만 자가 넘는 문서에서 고른 모드를 함께 본다.
  const sourceFor = (doc: Doc) => source || largeDocument.sourceFor(doc);
  // 실시간 동기화가 그룹 방식으로 바뀌며 이전 장치 연결을 초기화했다면 서재를 연 뒤 한 번 안내한다.
  const resetNoticeShown = useRef(false);
  useEffect(() => {
    if (!loaded || resetNoticeShown.current) return;
    resetNoticeShown.current = true;
    void call<boolean>("realtimeResetNotice").then(async notice => {
      if (!notice) return;
      const reconnect = await confirm({
        title: "장치 연결이 초기화되었습니다",
        message: "실시간 동기화가 동기화 그룹 방식으로 바뀌어 이전 장치 연결을 한 번 초기화했습니다. 서재와 원고는 그대로 있습니다.",
        detail: "모든 장치의 Lof Writer와 Lof Library를 최신 버전으로 업데이트한 뒤, 한 장치에서 초대 코드를 만들어 나머지 장치를 같은 그룹에 다시 가입시켜 주세요. 이후 새 장치는 페어링 코드 한 번으로 그룹의 모든 장치와 연결됩니다.",
        confirmLabel: "동기화 그룹 열기",
        cancelLabel: "나중에",
      });
      await call("realtimeDismissReset");
      if (reconnect) await openSettings("serverSync");
    }).catch(report);
  }, [loaded]);
  useEffect(() => {
    refresh().catch(report);
    const off = window.lof.onChange(() => {
      waitForSave().then(() => refresh()).catch(report);
    });
    const offFlush = window.lof.onFlush(async () => {
      await flushForClose();
      await flushWorkspaceState();
    });
    const updateAutoSync = (status: AutoSyncStatus) => {
      setAutoSync(previous => previous.phase === status.phase && previous.message === status.message &&
        previous.hasConnections === status.hasConnections &&
        JSON.stringify(previous.channels) === JSON.stringify(status.channels) ? previous : status);
      if (status.hasConnections !== undefined) setSyncAvailable(status.hasConnections);
    };
    const offAutoSync = window.lof.onAutoSync?.(updateAutoSync);
    if (window.lof.onAutoSync) call<AutoSyncStatus>("autoSyncStatus").then(updateAutoSync).catch(() => {});

    const onResize = () => {
      const mobileNow =
        window.innerWidth <= 768 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      setIsMobile((prev) => {
        if (!prev && mobileNow) {
          setSidebar(false);
          setRight(false);
        }
        return mobileNow;
      });
    };
    window.addEventListener("resize", onResize);

    // Android에서 앱을 벗어나면 바로 잠가, 다시 열 때 PIN을 묻고 최근 앱 화면에도 원고가 보이지 않게 한다.
    const lockOnLeave = () => isAndroidApp() && !externalScreenOpen();
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        const lock = lockOnLeave();
        if (lock) void call("appLifecycle", { foreground: false, lock }).catch(() => {});
        void flush()
          .catch(() => {})
          .finally(() => {
            void flushWorkspaceState().catch(() => {});
            void call("appLifecycle", { foreground: false }).catch(() => {});
          });
      } else if (document.visibilityState === "visible") {
        void call("appLifecycle", { foreground: true }).catch(() => {});
        waitForSave().then(() => refresh()).catch(report);
      }
    };
    const handlePageHide = () => {
      void flush().catch(() => {});
      void flushWorkspaceState().catch(() => {});
      void call("appLifecycle", { foreground: false, lock: lockOnLeave() }).catch(() => {});
    };
    const handleNetworkOnline = () => {
      void call("realtimeSync").catch(() => {});
    };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("online", handleNetworkOnline);

    return () => {
      off();
      offFlush();
      offAutoSync?.();
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("online", handleNetworkOnline);
    };
  }, [refresh, flush, flushForClose, waitForSave, report]);
  // beforeCommit은 문서를 읽은 뒤 화면 상태를 바꾸기 직전에 부른다. 같은 렌더에 묶여 중간 상태가 그려지지 않는다.
  async function navigate(destination: Destination, historyIndex?: number, beforeCommit?: () => boolean | void) {
    const seq = navigationSeq.current + 1;
    try { await navigateNow(destination, historyIndex, beforeCommit); }
    // 닫는 중에 다른 문서로 이동했다면 이동이 끝난 뒤 가려 둔 화면을 푼다.
    finally { if (seq === navigationSeq.current) setMobileClosing(false); }
  }
  async function navigateNow(destination: Destination, historyIndex?: number, beforeCommit?: () => boolean | void) {
    const seq = ++navigationSeq.current;
    // 다른 문서로 갈 때는 지금 문서의 저장을 기다리지 않고 바로 읽기 시작한다.
    // 같은 문서를 다시 열 때는 저장된 뒤의 내용을 읽어야 하므로 저장을 마친 뒤 읽는다.
    const early = destination.view === "workspace" && destination.documentId !== session.currentId()
      ? call<Doc>("readDocument", { id: destination.documentId }) : null;
    early?.catch(() => {});
    await flush();
    if (seq !== navigationSeq.current) return;
    const fresh = destination.view === "workspace"
      ? await (early ?? call<Doc>("readDocument", { id: destination.documentId })) : null;
    if (seq !== navigationSeq.current) return;
    const retained = fresh ? getRetainedDocument(fresh.id) : undefined;
    // 이미 열어 둔 탭의 본문은 유지하고, 안내줄에서 새 내용을 불러온다.
    const keepOlder = !!(fresh && retained && retained.revision !== fresh.revision && !sameDocumentContent(retained, fresh));
    const doc = keepOlder ? retained! : fresh;
    const next: Destination = doc
      ? { view: "workspace", projectId: doc.projectId, documentId: doc.id, tab: doc.kind, archive: doc.archived,
          linkedDocument: destination.linkedDocument }
      : { ...destination, projectId: globalView(destination.view) ? "" : destination.projectId };
    if (!globalView(next.view) && !libraryRef.current.projects.some(p => p.id === next.projectId))
      throw Error("작품을 찾을 수 없습니다.");
    if (beforeCommit?.() === false) return;
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
    if (isMobile) {
      setSidebar(false);
      setFocusTree(false);
      setSearchOpen(false);
      setRight(false);
    }
    if (doc) {
      commitOpenDocument(doc, {
        sameProject: doc.projectId === projectRef.current,
        pinned: destination.pinned === true,
        after: session.currentId(),
      });
      session.commitDocument(doc, keepOlder);
    }
    const id = globalView(next.view) ? projectRef.current : next.projectId;
    setProjectId(id);
    projectRef.current = id;
    setView(next.view);
    if (next.tab) setTab(next.tab);
    if (next.archive !== undefined) setArchive(next.archive);
    setDialog(null);
  }
  // 마지막 탭을 닫아도 파일 트리가 있는 집필 화면을 유지한다.
  async function closeLastDocument(commit: () => boolean | void) {
    const seq = ++navigationSeq.current;
    await flush();
    if (seq !== navigationSeq.current) return;
    if (commit() === false) return;
    session.closeDocument();
  }
  async function closeMobileDocument() {
    if (!session.currentId()) return;
    const seq = ++navigationSeq.current;
    // 화면은 바로 닫고 저장은 뒤에서 마친다. 저장에 실패하면 문서를 다시 보여 준다.
    setMobileClosing(true);
    try {
      await flush({ closing: true, skipMemo: true });
      if (seq !== navigationSeq.current) return;
      // 저장하면서 메모 제목이 바뀌면 파일 경로에서 만든 문서 ID도 바뀔 수 있다.
      const id = session.currentId();
      // 다른 탭이나 분할 그룹으로 이동하지 않고 현재 문서만 닫는다.
      area.updateTabs(tabs => tabs.filter(tab => tab.id !== id));
      session.closeDocument();
    } finally {
      if (seq === navigationSeq.current) setMobileClosing(false);
    }
  }
  // 문서 ID가 바뀌었을 때(메모 이름 바꾸기) 탭·분할 보기·이동 기록이 새 ID를 가리키게 한다.
  function handleDocumentIdChange(oldId: string, newId: string, location?: Doc) {
    replaceGroupDocumentId(oldId, newId, location);
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
  async function patchDoc(id: string, patch: Partial<Doc>) {
    await optimistic(patchDocuments([id], patch), () => writeMeta(id, patch));
  }
  async function openBinding(id: string) {
    setDialog({ type: "linkEpisode", value: id });
    await flush();
    await refresh();
  }
  async function bindDocument(id: string, episodeId: string | null) {
    const saving = patchDoc(id, { episodeId });
    message(episodeId ? "에피소드에 연결했습니다." : "연결을 해제했습니다. 독립 문서로 보관됩니다.");
    await saving;
  }
  async function archiveDoc(doc: Doc) {
    await archiveDocs([doc], !doc.archived);
  }
  // 보관(archived)하거나 보관 해제한다. 이미 그 상태인 문서는 건너뛴다.
  async function archiveDocs(docs: Doc[], archived: boolean) {
    const targets = docs.filter((d) => !!d.archived !== archived);
    if (!targets.length) return;
    const what = targets.length > 1 ? `문서 ${targets.length}개를` : "문서를";
    // 목록에서 먼저 옮기고 파일 저장은 이어서 처리한다. 서재는 다 바꾼 뒤 한 번만 다시 읽는다.
    const saving = optimistic(patchDocuments(targets.map((d) => d.id), { archived }), async () => {
      for (const doc of targets) await writeMeta(doc.id, { archived });
    });
    message(archived ? `${what} 보관함으로 옮겼습니다.` : `${what} 보관함에서 꺼냈습니다.`);
    await saving;
    if (archived)
      for (const doc of targets) {
        await closeTab(doc.id);
        closeSideTab(doc.id);
      }
  }
  // 영구 삭제: 편집 중인 내용을 먼저 저장하고 탭을 닫은 뒤 지운다.
  // 문서 파일은 Windows 휴지통으로 가고, 로컬 변경 이력은 보존 정책에 따라 남긴다.
  async function deleteDocs(docs: Doc[]) {
    if (!docs.length) return;
    const deleting = optimistic(removeDocuments(docs.map((d) => d.id)), async () => {
      await flush();
      for (const doc of docs) {
        await closeTab(doc.id);
        closeSideTab(doc.id);
        session.discardDraft(doc.id);
        await call("deleteDocument", { id: doc.id });
      }
    });
    message(
      docs.length > 1
        ? `문서 ${docs.length}개를 영구 삭제했습니다.`
        : `'${docs[0].title || "제목 없음"}' 문서를 영구 삭제했습니다.`,
    );
    await deleting;
  }
  // 작품 삭제: 작품 폴더 전체를 Windows 휴지통으로 옮긴다. 지금 보고 있는 작품이면 내 서재로 돌아간다.
  async function deleteProject(id: string) {
    const target = libraryRef.current.projects.find((p) => p.id === id);
    if (!target) return;
    await flush();
    if (projectRef.current === id) {
      await goView("library");
      session.detachDocument();
      resetGroups();
      projectRef.current = "";
      setProjectId("");
      resetNavigation();
    }
    const deleting = optimistic(removeProject(id), () => call("deleteProject", { id }));
    message(`'${target.title || "제목 없는 작품"}' 작품을 휴지통으로 옮겼습니다.`);
    await deleting;
  }
  function askDeleteProject(id: string) {
    setConfirmTitle("");
    setDialog({ type: "deleteProject", value: id });
  }
  async function duplicateDoc(doc: Doc) {
    await flush();
    const source = await call<Doc>("readDocument", { id: doc.id });
    const copy = await createCopy(source, source.title + " 사본", source.body);
    showCreatedDocument(copy);
    await openDoc(copy.id, true);
  }
  // 이력의 제목과 본문으로 새 문서를 만들고, 나머지 설정은 지금 문서를 따른다.
  async function saveHistoryCopy(id: string, version: { title?: string; body: string; savedAt: string }) {
    const source = await call<Doc>("readDocument", { id });
    const saved = new Date(version.savedAt);
    const pad = (value: number) => String(value).padStart(2, "0");
    const stamp = `${saved.getFullYear()}.${pad(saved.getMonth() + 1)}.${pad(saved.getDate())} ${pad(saved.getHours())}시 ${pad(saved.getMinutes())}분`;
    const copy = await createCopy(source, `${version.title || source.title} 사본 (${stamp})`, version.body);
    showCreatedDocument(copy);
    message("이전 원고를 사본으로 저장했습니다.", {
      label: "열기",
      run: () => {
        setDialog(null);
        void openDoc(copy.id, true).catch(report);
      },
    });
  }
  function createCopy(source: Doc, title: string, body: string) {
    return call<Doc>("createDocument", {
      projectId: source.projectId,
      kind: source.kind,
      title,
      body,
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
  }
  async function copyPath(doc: Doc) {
    const meta = libraryRef.current.documents.find((d) => d.id === doc.id);
    if (!meta?.path) throw Error("파일 경로를 찾을 수 없습니다.");
    await navigator.clipboard.writeText(meta.path);
    message("파일 경로를 복사했습니다.");
  }
  async function copyDocManuscript(targetDoc: Doc, rawMarkdown?: boolean, notify = true) {
    await flush();
    const current = session.currentDocument();
    const latest =
      current?.id === targetDoc.id
        ? current
        : await call<Doc>("readDocument", { id: targetDoc.id });
    const copyAsMarkdown =
      rawMarkdown ??
      (active?.id === latest.id && (sourceFor(latest) || requiresSource(latest.body)));
    if (copyAsMarkdown) {
      await call("copyManuscript", { id: latest.id, text: stripJsdocComments(latest.body) });
      if (notify) message("Markdown 원문을 복사했습니다.");
      return;
    }
    await call("copyManuscript", {
      id: latest.id,
      text: plainText(latest.body, {
        preserveParagraphBreaks: !latest.manualLineBreak && prefs.copyWithBlankLines === true,
        dividerText: normalizeEditorStyle(prefs, latest.kind).dividerText,
      }),
    });
    if (notify) message("본문을 복사했습니다.");
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
    return [
      ...lib.projects.map((p) => ({
        label: p.title || "제목 없는 작품",
        checked: p.id === projectId,
        action: attempt(() => switchProject(p.id)),
      })),
      "separator" as const,
      { label: "작품 페이지로 이동", action: attempt(() => goView("project")) },
      { label: "내 서재로 이동", action: attempt(() => goView("library")) },
    ];
  }
  // 작품에서 마지막으로 보던 문서를 연다. 저장된 화면이 없으면 최근 수정한 문서를 고른다.
  async function switchProject(id: string) {
    if (id === projectId) return;
    const previous = getProjectDocument(id);
    if (previous) {
      await openDoc(previous);
      return;
    }
    const recent = libraryRef.current.documents
      .filter((d) => d.projectId === id && !d.archived)
      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))[0];
    if (recent) await openDoc(recent.id);
    else await goView("project", id);
  }
  function docMenu(d: Doc): MenuItem[] {
    const rawCopy = active?.id === d.id && (sourceFor(active) || requiresDocumentSource(active));
    return [
      { label: "열기", action: attempt(() => openDoc(d.id, false)) },
      // 미리보기 탭을 바꾸지 않고 고정 탭으로 연다(더블클릭과 같다).
      { label: "새 탭으로 열기", action: attempt(() => openDoc(d.id, true)) },
      { label: "옆으로 열기", action: attempt(() => (view === "workspace" && active ? openLinked(d.id, true) : openDoc(d.id, true))) },
      "separator",
      { label: "이름 바꾸기", shortcut: "F2", action: () => startRename(d) },
      { label: "복제", action: attempt(() => duplicateDoc(d)) },
      ...(d.kind === "episode"
        ? ([
            "separator",
            ...statusItems(d.status, (status) =>
              attempt(async () => {
                const saving = patchDoc(d.id, { status });
                if (status === "completed")
                  message("원고 보호 모드로 전환되었습니다. 집필 완료된 에피소드는 편집이 제한됩니다.");
                await saving;
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
      { label: "파일 탐색기에서 표시", shortcut: "Shift+Alt+R", action: attempt(() => call("reveal", { id: d.id })) },
      { label: "경로 복사", shortcut: "Shift+Alt+C", action: attempt(() => copyPath(d)) },
      {
        label: rawCopy ? "Markdown 원문 복사" : "본문 복사",
        action: attempt(() => copyDocManuscript(d, rawCopy)),
      },
      {
        label: "내보내기",
        action: () => setDialog({ type: "exportDocument", value: d.id }),
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
      { label: "탭 고정", disabled: t.pinned, action: () => pinTab(t.id) },
      "separator",
      ...splitMenuItems({
        focused: true, split, canSplit: (direction) => canSplit(focusedSide, direction),
        splitTo: (direction) => attempt(() => splitTo(t.id, direction))(),
        moveToOther: attempt(() => moveToOther(t.id)), closeGroup: attempt(closeGroup),
      }),
      "separator",
      { label: "파일 탐색기에서 표시", disabled: !doc, action: attempt(() => call("reveal", { id: t.id })) },
      { label: "경로 복사", disabled: !doc, action: attempt(() => copyPath(doc!)) },
    ];
  }
  // 포커스되지 않은 그룹의 탭 메뉴.
  function sideTabMenu(t: EditorTab, side: Side, index: number): MenuItem[] {
    const doc = lib.documents.find((d) => d.id === t.id);
    const sideTabs = groups[side]?.tabs ?? [];
    return [
      { label: "열기", action: attempt(() => focusOther(t.id, false, side)) },
      { label: "닫기", action: () => closeSideTab(t.id, side) },
      { label: "다른 탭 닫기", disabled: sideTabs.length < 2, action: () => closeSideTabs((x) => x.id === t.id, side, t.id) },
      { label: "오른쪽 탭 닫기", disabled: index >= sideTabs.length - 1, action: () => closeSideTabs((_, i) => i <= index, side, t.id) },
      { label: "모두 닫기", action: () => closeOtherGroup(side) },
      "separator",
      { label: "탭 고정", disabled: t.pinned, action: () => pinSideTab(t.id, side) },
      "separator",
      ...splitMenuItems({
        focused: false, split: true, canSplit: (direction) => canSplit(side, direction),
        splitTo: (direction) => attempt(() => splitTo(t.id, direction, side))(),
        moveToOther: attempt(() => openInGroup(t.id, focusedSide, true, side)), closeGroup: () => closeOtherGroup(side),
      }),
      "separator",
      { label: "파일 탐색기에서 표시", disabled: !doc, action: attempt(() => call("reveal", { id: t.id })) },
      { label: "경로 복사", disabled: !doc, action: attempt(() => copyPath(doc!)) },
    ];
  }
  // 작품 페이지로 새로 들어올 때는 항상 에피소드 목록에서 시작한다.
  // 뒤로/앞으로 이동은 navigate에 저장된 탭을 그대로 넘긴다.
  async function goView(next: "library" | "project" | "bookmarks", id = projectId) {
    const keep = next !== "project" && id === projectId;
    await navigate({ view: next, projectId: id,
      tab: keep ? tab : "episode", archive: keep ? archive : false });
  }
  async function openLibraryProject(
    id: string,
    target: "workspace" | "project" = prefsRef.current.libraryProjectOpenTarget === "project" ? "project" : "workspace",
  ) {
    const documentId = target === "workspace" ? getProjectDocument(id) : undefined;
    if (documentId) await openDoc(documentId);
    else await goView("project", id);
  }
  async function travel(direction: number) {
    const current = navigationRef.current;
    const index = current.index + direction;
    if (index < 0 || index >= current.entries.length) return;
    await navigate(current.entries[index], index);
  }
  async function openMobileLinkedDocument(id: string) {
    if (id === session.currentId()) return;
    await navigate({ view: "workspace", projectId: "", documentId: id, linkedDocument: true });
  }
  async function backFromLinkedDocument(): Promise<boolean> {
    const nav = navigationRef.current;
    const current = nav.entries[nav.index];
    const previous = nav.entries[nav.index - 1];
    if (!current.linkedDocument || current.view !== "workspace" ||
        current.documentId !== session.currentId() || previous?.view !== "workspace" ||
        previous.projectId !== current.projectId ||
        !libraryRef.current.documents.some((doc) => doc.id === previous.documentId)) return false;
    await navigate(previous, nav.index - 1);
    return true;
  }
  function resetNavigation() {
    ++navigationSeq.current;
    setMobileClosing(false);
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
            manualLineBreak: false,
          }
        : {}),
    });
    showCreatedDocument(doc);
    await openDoc(doc.id, true);
    if (focusRef.current) setFocusTree(true);
    else setSidebar(true);
    if (!opts.title) startRename(doc);
  }
  // 트리가 파일을 옮기고 서재를 다시 읽은 뒤 열린 원고의 위치 정보를 갱신한다.
  async function moveDocuments(action: () => Promise<void>) {
    while (documentMove.current) await documentMove.current;
    let finish!: () => void;
    documentMove.current = new Promise<void>(resolve => { finish = resolve; });
    try {
      await action();
    } finally {
      documentMove.current = null;
      finish();
      await refresh();
    }
  }
  function remapDocs(before: Doc[], from: string, to: string) {
    session.remapDocuments(before, from, to, libraryRef.current.documents, projectRef.current);
  }

  async function loadSettingsData() {
    const request = ++settingsRequest.current;
    setSettingsDataState("loading");
    if (active?.kind) setTypesettingKind(active.kind === "episode" ? "episode" : "document");
    try {
      const s = await call("settings");
      if (request !== settingsRequest.current) return;
      setConnections(s.connections);
      if (s.autoSync) {
        setAutoSync(s.autoSync);
        if (s.autoSync.hasConnections !== undefined) setSyncAvailable(s.autoSync.hasConnections);
      }
      setCommonMemoPath(s.commonMemoPath || "");
      setSettingsDataState("ready");
    } catch (error) {
      if (request !== settingsRequest.current) return;
      setSettingsDataState("error");
      throw error;
    }
  }
  async function openSettings(type: "settings" | "serverSync" = "settings") {
    setDialog({ type });
    // 창을 먼저 열어 저장이나 정보 조회가 끝나기를 기다리지 않게 한다.
    if (type === "settings") await Promise.all([flush(), loadSettingsData()]);
    else await flush();
  }
  function updateProjectWriting(rules: WritingRules) {
    const id = projectId;
    pendingWriting.current.set(id, rules);
    updateLibrary(patchProject(id, { writing: rules }));
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
  }
  function renderSyncConnections() {
    if (settingsDataState === "loading") return <p role="status">설정 정보를 불러오는 중입니다.</p>;
    if (settingsDataState === "error") return <div>
      <p role="alert">파일 저장소 설정을 불러오지 못했습니다.</p>
      <button onClick={attempt(loadSettingsData)}>다시 불러오기</button>
    </div>;
    return <SyncConnections connections={connections} setConnections={setConnections}
      autoSync={autoSync} intervalSeconds={prefs.syncIntervalSeconds ?? 300}
      onIntervalChange={(seconds) => savePrefs({ syncIntervalSeconds: seconds })}
      backgroundEnabled={prefs.backgroundSyncEnabled === true}
      backgroundIntervalSeconds={prefs.backgroundSyncIntervalSeconds ?? 1800}
      onBackgroundSyncChange={(patch) => savePrefs(patch)}
      busy={busy} setBusy={setBusy} onSync={doSync} message={message} report={report} />;
  }
  async function chooseVault(options?: { internal?: boolean }) {
    setBusy(true);
    try {
      await flush();
      if (!await call("chooseVault", options?.internal ? { internal: true } : undefined)) return;
      clearRetainedDocuments();
      session.resetVault();
      resetGroups();
      setMemoOpen(false);
      projectRef.current = "";
      setProjectId("");
      setView("library");
      resetNavigation();
      await refresh();
      await loadSettingsData();
      if (options?.internal) {
        message("내부 저장소의 서재를 열었습니다.");
      }
    } finally {
      setBusy(false);
    }
  }
  async function moveVault(options?: { internal?: boolean }) {
    if (busy) return;
    setBusy(true);
    try {
      await flush();
      await writingQueue.current;
      const toInternal = Boolean(options?.internal);
      const destination = toInternal ? (lib.internalRoot || "앱 내부 저장소") : await call<string | null>("pickVaultDestination");
      if (!destination) return;
      if (!await confirm(toInternal ? {
        title: "내부 저장소로 전환",
        message: <>
          지금 서재를 앱 내부 저장소로 옮깁니다. 작품·메모·변경 이력·동기화 연결은 그대로 유지됩니다. 공유 저장소의 원래 폴더는 지우지 않고 남겨 두지만, 이후로는 갱신되지 않으니 필요 없으면 직접 지워도 됩니다.
          <br /><br />
          내부 저장소는 파일 관리자나 다른 앱에서 보이지 않고, 앱을 삭제하면 서재도 함께 삭제됩니다. 동기화 연결이나 내보내기로 백업해 두세요.
        </>,
        detail: `현재 위치: ${lib.root}`,
        confirmLabel: "내부 저장소로 전환",
      } : {
        title: "서재 옮기기",
        message: "지금 서재를 선택한 폴더로 옮깁니다. 작품·메모·변경 이력·동기화 연결은 그대로 유지되고, 옮긴 뒤 원래 폴더는 정리됩니다.",
        detail: `옮길 위치: ${destination}`,
        confirmLabel: "옮기기",
      })) return;
      let result: { root: string; source: string; sourceRetained: boolean; sourceKept?: boolean };
      try {
        result = await call("moveVault", toInternal ? {
          internal: true,
          expectedRoot: lib.root,
        } : {
          path: destination,
          expectedRoot: lib.root,
        });
      } catch (error: any) {
        // 내부 저장소에 예전 서재가 남아 있으면 합치지 않고 그 서재를 열지 묻는다.
        if (!toInternal || error?.code !== "INTERNAL_LIBRARY_EXISTS") throw error;
        if (!await confirm({
          title: "내부 저장소에 서재가 있습니다",
          message: "내부 저장소에 이전에 쓰던 서재가 있어 지금 서재를 옮겨 합칠 수 없습니다. 지금 서재는 그대로 두고 내부 저장소의 서재를 열까요?",
          detail: `지금 서재는 ${lib.root}에 그대로 남으며, '다른 서재 열기'로 다시 열 수 있습니다.`,
          confirmLabel: "내부 저장소 서재 열기",
        })) return;
        await chooseVault({ internal: true });
        return;
      }
      const data = await refresh();
      if (data) {
        setPrefs((current) => ({ ...current, ...data.preferences }));
        for (const doc of data.documents) {
          const retained = getRetainedDocument(doc.id);
          if (retained) retainDocument({ ...retained, path: doc.path, relPath: doc.relPath });
        }
      }
      await loadSettingsData();
      message(result.sourceKept
        ? `서재를 내부 저장소로 옮겼습니다. 원래 폴더 '${result.source}'는 그대로 남겨 두었습니다.`
        : result.sourceRetained
          ? `서재를 옮겼습니다. 정리하지 못한 원본 파일은 '${result.source}'에 남겨 두었습니다.`
          : "서재를 옮겼습니다.");
    } finally {
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
        `동기화 완료 · 받음 ${result.downloaded} · 보냄 ${result.uploaded} · 충돌 사본 ${result.conflicts}${result.fileConflicts ? " (.lof/file-conflicts에 보관)" : ""}${result.removed ? " · 다른 장치에서 삭제 " + result.removed : ""}${result.projectConflicts ? " · 작품 정보 충돌 " + result.projectConflicts + "개 (.lof/project-conflicts에 보관)" : ""}`,
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
    setDialog({ type: "history" });
  }
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (document.documentElement.dataset.pinLocked === "true") return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        manualSave()
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
  }, [manualSave, message, report]);
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
    if (session.currentId() !== r.id) return;
    setReveal({
      docId: r.id,
      query: searchQuery,
      index: m.index,
      caseSensitive: searchCase,
      seq: Date.now(),
    });
  }
  searchActions.current = { openQuick: () => openQuick().catch(report), openSearch };
  // 상대 경로는 링크가 있는 문서의 폴더를 기준으로 찾는다.
  async function openNoteLink(href: string, quote: string, source: DocumentLinkSource): Promise<"document" | "memo" | null> {
    const target = resolveDocumentLink(href, source, libraryRef.current);
    if (!target) {
      message("연결된 문서를 찾을 수 없습니다.");
      return null;
    }
    await flush();
    if (target.kind === "memo") {
      if (!memoApi.current) return null;
      await memoApi.current.open(target.space, target.path, true);
      setMemoOpen(true);
      return "memo";
    }
    const id = target.id;
    await openDoc(id, true);
    if (quote && session.currentId() === id)
      setReveal({ docId: id, query: quote, index: 0, caseSensitive: true, seq: Date.now() });
    return "document";
  }
  // 원고 이미지: 작품의 assets/에 저장하고, 원고에는 원고 파일 기준 상대 경로(예: ../assets/그림.png)로 쓴다.
  // 화면에 그릴 data URL은 경로마다 한 번만 읽고, 찾지 못한 경로는 다음에 다시 찾는다.
  const docImages = useDocumentImages(libraryRef, report);
  // 원고 여백의 메모 아이콘: 메모가 하나면 바로 열고, 여럿이면 고를 수 있게 메뉴를 띄운다.
  function openNotes(list: NoteMark[], at: { x: number; y: number }) {
    if (list.length === 1) return attempt(() => openDoc(list[0].id, true))();
    setMenu({
      x: at.x,
      y: at.y,
      items: list.map((n) => ({
        label: n.title || "제목 없는 메모",
        icon: <StickyNote size={15} />,
        action: attempt(() => openDoc(n.id, true)),
      })),
    });
  }
  const noteMarks = useDocumentNotes(active, lib);
  const writingRules = useMemo(() => normalizeWriting(project?.writing || prefs.defaultWriting), [project?.writing, prefs.defaultWriting]);
  const counter = useManuscriptCounts({
    scope: lib.root, id: active?.id, body: active?.body ?? null, rules: writingRules, onError: report,
    onBaseline: (scope, id, count) => {
      if (libraryRef.current.root === scope) session.recordBaseline(id, count);
    },
  });
  const stats = counter.stats;
  const sessionCount = active && stats
    ? session.sessionDelta(active.id, stats.utf16WithoutSpaces)
    : 0;
  // 원고 보호: 집필 완료인 회차는 제목과 본문을 고칠 수 없다(상태는 바꿀 수 있다).
  const isProtected = active?.kind === "episode" && normalizeStatus(active.status) === "completed";
  const platformChars = stats?.platformCharacters ?? 0;
  const countUnit = active?.kind === "episode" ? writingRules.unit : "utf16";
  const charsWithoutSpaces = stats ? countForRule(stats, "noSpace", countUnit) : 0;
  // 상태줄의 두 번째 값: 공백 포함·줄바꿈 제외(위젯 보드의 같은 항목과 동일한 계산).
  const charsWithSpaces = stats ? countForRule(stats, "spaces", countUnit) : 0;
  const goal = Number(writingRules.goal) || 0;
  const isWorkspace = view === "workspace" && !!active && !memoOpen;
  // 모든 탭을 닫은 집필 화면. 파일 트리는 그대로 두고 편집 영역만 비운다.
  const emptyWorkspace = view === "workspace" && !active && !memoOpen;
  // 빈 화면 위에서 끌기를 취소하거나 다른 곳에 놓아도 놓기 표시를 지운다.
  useEffect(() => {
    if (!emptyDrop) return;
    const clear = () => setEmptyDrop(false);
    window.addEventListener("dragend", clear); window.addEventListener("drop", clear);
    return () => { window.removeEventListener("dragend", clear); window.removeEventListener("drop", clear); };
  }, [emptyDrop]);
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
  // 파일 트리는 놓은 그룹에 열고, 열린 탭은 그 그룹으로 옮긴다.
  function draggedToGroups(): SplitDrag<EditorTab> | null {
    const treeId = fileTree.draggedDocument();
    if (treeId) return { tab: { id: treeId, pinned: true }, fromTree: true, source: focusedSide };
    return dragTab ? { tab: { id: dragTab, pinned: true }, fromTree: false, source: dragSide.current } : null;
  }
  // 편집기 본문이 드래그한 파일을 텍스트로 삽입하기 전에 처리한다.
  function droppedOnGroups(run: () => Promise<unknown>) {
    fileTree.finishEditorDrop();
    setDragTab("");
    attempt(run)();
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
  // 모든 그룹은 같은 구성으로 그려 포커스가 바뀌어도 원고와 도구의 위치를 유지한다.
  function documentBody(active: Doc, focused: boolean, visible = true, side: Side = focusedSide) {
    const activeBox = manuscriptBoxForKind(active.kind);
    const manuscriptClassName = activeBox.className;
    const manuscriptStyle = activeBox.style;
    const isProtected = active.kind === "episode" && normalizeStatus(active.status) === "completed";
    const groupSaveStatus = focused ? saveStatus : "저장됨";
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
        <div className="editor-actions">
          <div className="save-status-group">
            {isMobile && (
              <>
                <button
                  type="button"
                  className="mobile-editor-nav-btn"
                  aria-label="작품 화면으로"
                  title="작품 화면으로"
                  onClick={attempt(() => goView("project", active.projectId))}
                >
                  <ArrowLeft size={16} />
                </button>
                <button
                  type="button"
                  className={`mobile-editor-nav-btn ${treeOpen ? "active" : ""}`}
                  aria-label="문서 목록 열기"
                  title="문서 목록"
                  onClick={toggleTree}
                >
                  <PanelLeft size={16} />
                </button>
              </>
            )}
          <span
            className={`save-indicator ${groupSaveStatus !== "저장됨" ? "pending" : ""}`}
          >
            <span />
            {groupSaveStatus}
          </span>
          <SyncStatus status={autoSync} checking={syncChecking} available={syncAvailable} editing={groupSaveStatus !== "저장됨"} />
          {isMobile && (
            <button
              type="button"
              className="mobile-char-pill"
              aria-label="글자 수 및 위젯 보드 열기"
              onClick={() => {
                setRightView("widgets");
                setRight((r) => !r);
              }}
            >
              {active.kind === "episode"
                ? `${stats ? platformChars.toLocaleString() : "…"}자`
                : `${stats ? charsWithoutSpaces.toLocaleString() : "…"}자`}
            </button>
          )}
          </div>
          <div className="editor-action-buttons" aria-hidden={!focused}>
            <button
              type="button"
              aria-label="문자 검색 및 치환"
              title="문자 검색 및 치환 (F3)"
              onClick={() => window.dispatchEvent(new CustomEvent("lof:editor-find", { detail: { replace: true } }))}
            >
              <Search size={18} />
            </button>
            <button
              aria-label="변경 이력"
              title="변경 이력"
              onClick={attempt(showHistory)}
            >
              <History size={18} />
            </button>
            <button
              aria-label="본문 텍스트 복사"
              title={
                sourceFor(active) || requiresDocumentSource(active)
                  ? "Markdown 원문 복사"
                  : "본문 복사"
              }
              // 분할 화면에서는 이 칸의 문서가 전체 활성 문서와 다를 수 있으므로 표시한 방식 그대로 복사한다.
              onClick={attempt(() => copyDocManuscript(active, sourceFor(active) || requiresDocumentSource(active)))}
            >
              <Copy size={18} />
            </button>
            {isMobile && (
              <button
                className={right && rightView === "typesetting" ? "active" : ""}
                aria-label="조판 설정"
                title="조판 설정"
                onClick={toggleTypesettingPanel}
              >
                <Pilcrow size={17} />
              </button>
            )}
            <button
              className={`desktop-only-btn ${previewOpen ? "active" : ""}`}
              aria-label="모바일 미리보기"
              title="모바일 미리보기 (Ctrl+K V)"
              aria-pressed={previewOpen}
              onClick={togglePreview}
            >
              <Smartphone size={17} />
            </button>
            <button
              className="desktop-only-btn"
              aria-label="집중 모드"
              title="집중 모드 (F11)"
              onClick={() => setFocus((f) => !f)}
            >
              <Maximize size={17} />
            </button>
            <button
              type="button"
              aria-label="문서 더보기"
              title="문서 더보기"
              aria-haspopup="menu"
              aria-expanded={menu?.target === `document-actions:${active.id}`}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setMenu({ x: rect.right, y: rect.bottom + 4, align: "end", target: `document-actions:${active.id}`, items: [
                  { label: "내보내기", icon: <Download size={15} />,
                    action: () => setDialog({ type: "exportDocument", value: active.id }) },
                  "separator",
                  { label: active.archived ? "보관 해제" : "보관함으로 이동", icon: <Archive size={15} />,
                    action: attempt(() => archiveDoc(active)) },
                  { label: "영구 삭제", icon: <Trash2 size={15} />, danger: true,
                    action: () => setDialog({ type: "deleteDoc", value: active.id }) },
                ] });
              }}
            >
              <MoreHorizontal size={20} />
            </button>
          </div>
        </div>
        {focused && (session.syncIssue || conflict) && <SyncIssueBanner issue={session.syncIssue || "다른 곳에서 바뀐 원고와 이 기기의 임시본을 정리합니다."} retry={session.retrySync} />}
        <EditorScroll key={active.id} documentId={`${side}\n${active.id}`} scope={workspaceKey(lib.root, active.projectId)} positions={session.scrollPositions} visible={visible}>
          <article className={manuscriptClassName} style={manuscriptStyle}>
            <div className="document-kind">
              {labels[active.kind]} · {numberOf(active)}
            </div>
            <input
              className="document-title"
              aria-label="문서 제목"
              spellCheck={false}
              value={active.title}
              placeholder="제목을 입력해 주세요"
              readOnly={isProtected || !focused}
              title={isProtected ? "집필 완료된 에피소드는 편집이 제한됩니다." : undefined}
              onChange={(e) => {
                if (focused && !isProtected) edit({ title: e.target.value });
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
                onEdit={(patch) => { if (focused) edit(patch); }}
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
              key="writer"
              readOnly={isProtected}
              allowReadOnlyAnnotations={!isMobile}
              inactive={!focused}
              visible={visible}
              manualLineBreak={!!active.manualLineBreak}
              copyWithBlankLines={prefs.copyWithBlankLines === true}
              id={active.id}
              revision={active.revision}
              body={active.body}
              tables={active.kind === "memo" || active.kind === "plot"}
              reveal={focused && reveal?.docId === active.id ? reveal : null}
              countingRules={writingRules}
              onChange={(body, delta, markdownCopy) => { if (focused) { counter.update(body, delta); edit({ body }, markdownCopy); } }}
              fontSize={activeBox.norm.fontSize}
              lineHeight={activeBox.norm.lineHeight}
              source={sourceFor(active)}
              onToggleSource={() => {
                if (!sourceFor(active)) setSource(true);
                else { setSource(false); largeDocument.choose(active.id, false); }
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
              editorStyle={activeBox.kindPrefs}
              onReplaceSymbols={replaceActiveSymbols}
              lineBreak={{
                // 이 작품의 새 에피소드 줄바꿈 기본값(작품 설정, 없으면 공통 설정). 플롯·메모는 자동 관리가 기본이다.
                def: active.kind === "episode" ? lineBreakDefault(project, prefs.defaultManualLineBreak) : false,
                defaultLabel: active.kind === "episode" ? "새 에피소드 기본값" : "기본값",
                onChange: (manualLineBreak) => edit({ manualLineBreak }),
              }}
              bookmarks={isMobile ? undefined : active.bookmarks}
              onBookmarksChange={isMobile ? undefined : (bookmarks) => { if (focused) edit({ bookmarks }); }}
              jumpToBookmark={isMobile ? null : (focused && bookmarkJump?.docId === active.id ? bookmarkJump : null)}
              onQuickNote={
                isMobile
                  ? undefined
                  : (text, at) =>
                      setQuickNote({
                        projectId: active.projectId,
                        docId: active.id,
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
              links={active.kind === "memo" || active.kind === "plot"}
              onOpenLink={(href, quote) => attempt(() => openNoteLink(href, quote, { projectId: active.projectId, docPath: active.relPath || "" }))()}
              notes={isMobile ? undefined : noteMarks[active.id]}
              onOpenNotes={isMobile ? undefined : openNotes}
              contextMenu={!isMobile}
              onCursorLine={focused ? setCursorLine : undefined}
              images={docImages(active, !isProtected)}
            />
          </article>
          <div className="end-marker">✧</div>
        </EditorScroll>
      </div>
    );
  }
  // 먼저 선택해 읽은 문서만 만들고, 같은 그룹 안에서는 탭을 닫을 때까지 편집기를 유지한다.
  function documentTabs(tabs: EditorTab[], currentId: string, groupFocused: boolean, side: Side = focusedSide) {
    return tabs.map((tab) => {
      const doc = tab.id === active?.id ? active
        : getRetainedDocument(tab.id);
      if (!doc) return null;
      const visible = isWorkspace && tab.id === currentId;
      return <RetainedTab key={tab.id} visible={visible}>
        {documentBody(doc, visible && groupFocused, visible, side)}
      </RetainedTab>;
    });
  }
  // 포커스되지 않은 그룹: 읽기 전용으로 보여 주고, 클릭하면 그 그룹으로 포커스를 옮긴다.
  // 그룹은 포커스와 상관없이 자리를 key로 쓰고, 각 탭의 본문과 편집기를 유지한다.
  // 그룹을 오갈 때 같은 원고의 편집기와 스크롤 영역은 그대로 두고 읽기 전용 여부만 바꾼다.
  function sideGroup(side: Side) {
    const group = groups[side];
    if (!group || !active) return null;
    const canSplitSide = canSplit(side, "right") || canSplit(side, "down");
    return (
      <section
        key={side}
        {...groupAttributes(side)}
        className="editor-group inactive"
        style={groupStyle(side)}
      >
        <div className="editor-tabs" {...tabBarAttributes} role="tablist" aria-label="다른 그룹의 열린 문서">
          {group.tabs.map((t, index) => {
            const meta =
              t.id === active.id ? active : lib.documents.find((d) => d.id === t.id);
            if (!meta) return null;
            const current = t.id === group.current,
              Icon = icons[meta.kind],
              title = meta.title || "제목 없음";
            return (
              <div
                key={t.id}
                {...tabAttributes(t.id)}
                role="tab"
                tabIndex={-1}
                aria-selected={current}
                title={t.pinned ? title : `${title} (미리보기)`}
                className={`editor-tab ${current ? "current" : ""} ${t.pinned ? "" : "preview"} ${menu?.target === "side:" + t.id ? "context-target" : ""}`}
                onClick={attempt(() => focusOther(t.id, false, side))}
                onDoubleClick={attempt(() => focusOther(t.id, true, side))}
                draggable
                onDragStart={(event) => { event.dataTransfer.effectAllowed = "copyMove"; dragSide.current = side; setDragTab(t.id); }}
                onDragEnd={() => { setDragTab(""); area.clearDropZone(); }}
                onMouseDown={(e) => {
                  if (e.button === 1) e.preventDefault();
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) closeSideTab(t.id, side);
                }}
                onContextMenu={(e) => openMenu(e, sideTabMenu(t, side, index), "side:" + t.id)}
              >
                <Icon size={14} />
                <span>{title}</span>
                {current && <i className="saved-dot" />}
                <button
                  aria-label={`다른 그룹의 ${title} 닫기`}
                  title="닫기 (Alt+클릭: 다른 탭 닫기)"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (e.altKey) closeSideTabs((x) => x.id === t.id, side, t.id);
                    else closeSideTab(t.id, side);
                  }}
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
          {canSplitSide && (
            <div className="editor-tabs-actions">
              <button
                type="button"
                className="tab-split-button"
                aria-label="편집기 분할"
                title="오른쪽으로 분할 (Alt+클릭: 아래로 분할)"
                onClick={(e) => {
                  e.stopPropagation();
                  const dir = e.altKey
                    ? (canSplit(side, "down") ? "down" : "right")
                    : (canSplit(side, "right") ? "right" : "down");
                  attempt(() => splitTo(group.current, dir, side))();
                }}
              >
                <Columns2 size={14} />
              </button>
            </div>
          )}
        </div>
        {documentTabs(group.tabs, group.current, false, side)}
      </section>
    );
  }
  const [previewOpen, setPreviewOpen] = useState(false);
  const chordAt = useRef(0);
  const togglePreview = () => setPreviewOpen((open) => !open);
  tabActions.current = { closeTab, cycleTab, shiftTab, splitTo, focusGroupAt, focusDirection, moveToDirection, togglePreview, report };
  useEffect(() => {
    if (!isWorkspace) return;
    // VS Code 배치: Ctrl+B 기본 사이드바(파일 트리), Ctrl+Alt+B 보조 사이드바(메모 보드).
    // 캡처 단계에서 가로채 에디터의 Ctrl+B(굵게)보다 먼저 처리한다.
    // 탭: Ctrl+W 닫기, Ctrl+PageDown/PageUp·Ctrl+Tab/Ctrl+Shift+Tab 이동, Ctrl+Shift+PageUp/PageDown 순서 변경.
    // 창 분할: Ctrl+\ 우측 분할, Ctrl+K Ctrl+\ 하단 분할, Ctrl+1~4 그룹 포커스, Ctrl+K 방향키 인접 그룹 포커스, Ctrl+Alt+좌/우 탭 그룹 이동.
    const handler = (e: KeyboardEvent) => {
      if (document.documentElement.dataset.pinLocked === "true") return;
      if (updater.lockRef.current) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      const { closeTab, cycleTab, shiftTab, splitTo, focusGroupAt, focusDirection, moveToDirection, togglePreview, report } =
        tabActions.current;
      const chord = chordAt.current && Date.now() - chordAt.current < 1500;
      chordAt.current = 0;
      if (chord) {
        if (e.code === "KeyV" && !e.shiftKey && !e.altKey) {
          e.preventDefault(); e.stopPropagation(); togglePreview(); return;
        }
        if (e.code === "Backslash" && !e.shiftKey && !e.altKey) {
          e.preventDefault(); e.stopPropagation(); splitTo(session.currentId(), "down").catch(report); return;
        }
        const dirMap: Record<string, SplitDirection> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
        if (dirMap[e.key] && !e.shiftKey && !e.altKey) {
          e.preventDefault(); e.stopPropagation(); focusDirection(dirMap[e.key]).catch(report); return;
        }
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.code === "KeyK" && !e.shiftKey && !e.altKey)
        chordAt.current = Date.now();
      else if (e.code === "Backslash" && !e.shiftKey && !e.altKey)
        splitTo(session.currentId()).catch(report);
      else if (groupShortcutIndex(e.code) >= 0 && !e.shiftKey && !e.altKey)
        focusGroupAt(groupShortcutIndex(e.code)).catch(report);
      else if (e.altKey && !e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight"))
        moveToDirection(session.currentId(), e.key === "ArrowRight" ? 1 : -1).catch(report);
      else if (e.code === "KeyB" && !e.shiftKey) {
        if (e.altKey) setRight((r) => !r);
        else toggleTree();
      } else if (e.code === "KeyW" && !e.shiftKey && !e.altKey)
        closeTab(session.currentId()).catch(report);
      else if (e.shiftKey && !e.altKey && (e.key === "PageDown" || e.key === "PageUp"))
        shiftTab(e.key === "PageDown" ? 1 : -1);
      else if ((e.key === "PageDown" && !e.shiftKey) || (e.key === "Tab" && !e.shiftKey))
        cycleTab(1).catch(report);
      else if ((e.key === "PageUp" && !e.shiftKey) || (e.key === "Tab" && e.shiftKey))
        cycleTab(-1).catch(report);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [isWorkspace]);
  // 퀵 노트: 고른 문장과 메모를 문서 영역 맨 위에 메모 문서로 만든다. 쓰던 원고에서 벗어나지 않도록 메모는 열지 않고,
  // 알림의 '열기'로 열 수 있게 한다.
  async function saveQuickNote(note: QuickNoteSource, memo: string, title: string) {
    await flush();
    const doc = await call<Doc>("createDocument", {
      projectId: note.projectId,
      kind: "memo",
      title: quickNoteTitle(note, memo, title),
      body: quickNoteMarkdown(note, memo),
      episodeId: note.episodeId,
      manualLineBreak: false,
    });
    setQuickNote(null);
    showCreatedDocument(doc);
    message("메모가 저장되었습니다", {
      label: "열기",
      run: attempt(() => (isMobile ? openMobileLinkedDocument(doc.id) : openDoc(doc.id, true))),
    });
    await loadMemoFolders();
  }

  // 조판 버튼: 위젯 보드 자리에 조판 설정을 펼치거나 접는다.
  function toggleTypesettingPanel() {
    if (right && rightView === "typesetting") {
      setRightView("widgets");
      if (typesettingOpenedRight.current) setRight(false);
      typesettingOpenedRight.current = false;
      return;
    }
    typesettingOpenedRight.current = !right;
    setRight(true);
    setRightView("typesetting");
  }

  // 충돌이나 저장 실패로 남은 임시본은 그대로 알린다.
  const saving = !conflict && !session.syncIssue && saveStatus !== "저장 실패",
    isRecoverableDraft = (d: any) =>
      !(saving && d.id === active?.id && Date.parse(d.savedAt) >= appStartedAt),
    recoverableDrafts = (lib.drafts || []).filter(isRecoverableDraft),
    recoverable = recoverableDrafts.length;
  async function deleteDraft(d: Partial<Doc>) {
    if (!d.id) return;
    if (
      !(await confirm({
        title: "임시 원고 삭제",
        message: (
          <>
            <b>{d.title || "제목 없음"}</b> 임시 원고를 삭제할까요?
          </>
        ),
        detail: "삭제한 임시 원고는 다시 복구할 수 없습니다. 저장된 원고는 유지됩니다.",
        confirmLabel: "삭제",
        danger: true,
        icon: <Trash2 size={15} />,
      }))
    )
      return;
    await call("clearDraft", { id: d.id });
    const nextDrafts = libraryRef.current.drafts.filter((x) => x.id !== d.id);
    updateLibrary((data) => ({
      ...data,
      drafts: data.drafts.filter((x) => x.id !== d.id),
    }));
    void refresh().catch(report);
    session.discardDraft(d.id);
    if (!nextDrafts.some(isRecoverableDraft)) setDialog(null);
    message("임시 원고를 삭제했습니다.");
  }
  if (isMobile) {
    return (
      <MobileShell
        lib={shownLibrary}
        loaded={loaded}
        view={view}
        projectId={projectId}
        project={project}
        tab={tab}
        setTab={setTab}
        archive={archive}
        setArchive={setArchive}
        active={mobileClosing ? null : active}
        saveStatus={saveStatus}
        conflict={conflict}
        autoSync={autoSync}
        syncChecking={syncChecking}
        syncAvailable={syncAvailable}
        prefs={prefs}
        savePrefs={savePrefs}
        saveKindPrefs={saveKindPrefs}
        writingRules={writingRules}
        stats={stats}
        platformChars={platformChars}
        charsWithoutSpaces={charsWithoutSpaces}
        charsWithSpaces={charsWithSpaces}
        sessionCount={sessionCount}
        source={source}
        setSource={setSource}
        largeDocument={largeDocument}
        reveal={reveal}
        scrollPositions={session.scrollPositions}
        tree={fileTree}
        docImages={docImages}
        dialog={dialog}
        setDialog={setDialog}
        settingsPage={settingsPage}
        setSettingsPage={setSettingsPage}
        typesettingKind={typesettingKind}
        setTypesettingKind={setTypesettingKind}
        newRepFrom={newRepFrom}
        newRepTo={newRepTo}
        newRepLabel={newRepLabel}
        setNewRepFrom={setNewRepFrom}
        setNewRepTo={setNewRepTo}
        setNewRepLabel={setNewRepLabel}
        commonMemoPath={commonMemoPath}
        setCommonMemoPath={setCommonMemoPath}
        skillDownloading={skillDownloading}
        setSkillDownloading={setSkillDownloading}
        busy={busy}
        setBusy={setBusy}
        toast={toast}
        toastAction={toastAction}
        clearToast={() => {
          setToast("");
          setToastAction(null);
        }}
        error={error}
        setError={setError}
        viewer={viewer}
        setViewer={setViewer}
        closeViewer={closeViewer}
        confirmTitle={confirmTitle}
        setConfirmTitle={setConfirmTitle}
        confirmDialog={confirmDialog}
        recoverable={recoverable}
        recoverableDrafts={recoverableDrafts}
        deleteDraft={deleteDraft}
        updater={updater}
        releaseNotice={releaseNotice}
        releaseNotesOpen={releaseNotesOpen}
        setReleaseNotesOpen={setReleaseNotesOpen}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        searchCase={searchCase}
        setSearchCase={setSearchCase}
        bookmarkQuery={bookmarkQuery}
        setBookmarkQuery={setBookmarkQuery}
        bookmarkJump={bookmarkJump}
        setBookmarkJump={setBookmarkJump}
        memoApi={memoApi}
        memoFlush={memoFlush}
        attempt={attempt}
        navigate={navigate}
        goView={goView}
        openLibraryProject={openLibraryProject}
        projectMenu={projectMenu}
        openDoc={openDoc}
        openLinkedDocument={openMobileLinkedDocument}
        backFromLinkedDocument={backFromLinkedDocument}
        closeDocument={closeMobileDocument}
        createDoc={createDoc}
        patchDoc={patchDoc}
        archiveDoc={archiveDoc}
        deleteDocs={deleteDocs}
        deleteProject={deleteProject}
        askDeleteProject={askDeleteProject}
        duplicateDoc={duplicateDoc}
        saveHistoryCopy={saveHistoryCopy}
        copyDocManuscript={copyDocManuscript}
        openBinding={openBinding}
        bindDocument={bindDocument}
        openNoteLink={openNoteLink}
        openSearchResult={openSearchResult}
        replaceActiveSymbols={replaceActiveSymbols}
        showHistory={showHistory}
        chooseVault={chooseVault}
        moveVault={moveVault}
        projectReorder={projectReorder}
        openSettingsData={loadSettingsData}
        renderSyncConnections={renderSyncConnections}
        onUpdateProjectWriting={updateProjectWriting}
        edit={edit}
        counterUpdate={(body, delta) => counter.update(body, delta)}
        manualSave={manualSave}
        flush={flush}
        syncIssue={session.syncIssue}
        retrySync={session.retrySync}
        restoreHistory={(id, name, onDone) => session.restoreHistory(id, name, onDone)}
        discardDraft={(id) => session.discardDraft(id)}
        refresh={refresh}
        changeLibrary={optimistic}
        showCreatedDocument={showCreatedDocument}
        quickNote={quickNote}
        setQuickNote={setQuickNote}
        saveQuickNote={saveQuickNote}
        message={message}
        report={report}
      />
    );
  }
  return (
    <>
    <div
      className={`app ${prefs.theme === "dark" ? "dark" : ""} ${prefs.colorTheme === "bakery" ? "bakery" : ""} ${focus ? "focus-mode" : ""}`}
      inert={updater.locked}
    >
      <TitleBar
        navigation={navigation}
        attempt={attempt}
        travel={travel}
        treeOpen={treeOpen}
        isWorkspace={isWorkspace}
        toggleTree={toggleTree}
        right={right}
        focus={focus}
        setRight={setRight}
      />
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
              if (memoOpen) {
                await flush();
                setMemoOpen(false);
                return;
              }
              await flush();
              setMemoOpen(true);
            })}
          >
            <StickyNote size={20} />
          </button>
          <button
            title="북마크"
            aria-label="북마크"
            className={view === "bookmarks" && !memoOpen ? "selected" : ""}
            onClick={attempt(async () => {
              if (view === "bookmarks" && !memoOpen) return;
              await goView("bookmarks");
            })}
          >
            <BookmarkIcon size={20} />
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
              title="실시간 동기화"
              aria-label="실시간 동기화"
              aria-haspopup="dialog"
              aria-expanded={dialog?.type === "serverSync"}
              className={dialog?.type === "serverSync" ? "selected" : ""}
              onClick={attempt(() => openSettings("serverSync"))}
            >
              <Cloud size={20} />
            </button>
            <button
              title="설정"
              aria-label="설정"
              onClick={attempt(() => openSettings())}
            >
              <Settings size={20} />
            </button>
          </div>
        </nav>
        <div className="content-frame">
          {/* 집필 화면에서는 문서 탭이 제목 역할을 하고, 메모 화면에는 공통 헤더를 표시한다. */}
          {!isWorkspace && !emptyWorkspace && (
            <header className="workspace-header">
              <strong>Lof Writer</strong>
              <span className="titlebar-path">
                {memoOpen ? "메모" : project?.title && !globalView(view)
                  ? project.title
                  : "Local First Writing Tool"}
              </span>
            </header>
          )}
          {/* 닫아도 열린 메모 탭이 남도록 숨기기만 한다. */}
          <MemoSession
            active={memoOpen}
            workspaceRoot={lib.root}
            syncStatus={autoSync}
            syncChecking={syncChecking}
            syncAvailable={syncAvailable}
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
            manualSaveRef={memoManualSave}
            message={message}
            report={report}
            onOpenLink={(href, quote, source) => attempt(() => openNoteLink(href, quote, source))()}
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
              projectId={globalView(view) ? "" : projectId}
              scope={
                !globalView(view) && project
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
        {(isWorkspace || emptyWorkspace) && treeOpen && !searchOpen && (<FileTree
          tree={fileTree}
          prefs={prefs}
          savePrefs={savePrefs}
          report={report}
          menu={menu}
          switchWasOpen={switchWasOpen}
          setMenu={setMenu}
          projectMenu={projectMenu}
          project={project}
          lib={shownLibrary}
          projectId={projectId}
          archive={archive}
          setArchive={setArchive}
          createDoc={createDoc}
          brokenFiles={<>{archive && <RecoveryCopies key={lib.root} projectId={projectId} openDoc={openDoc} />}<BrokenFiles
            lib={lib}
            projectId={projectId}
            attempt={attempt}
            message={message}
            openDoc={openDoc}
            menu={menu}
            openMenu={openMenu}
            refresh={refresh}
          /></>}
        />)}
        <main className={isWorkspace || emptyWorkspace ? "workspace" : "main-page"}>
          {emptyWorkspace && (
            // 열린 문서가 없을 때도 파일 트리의 문서를 끌어 놓으면 바로 연다.
            <div
              className="workspace-empty"
              onDragOver={(e) => {
                if (!fileTree.draggedDocument()) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                setEmptyDrop(true);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setEmptyDrop(false);
              }}
              onDrop={(e) => {
                const id = fileTree.draggedDocument();
                setEmptyDrop(false);
                if (!id) return;
                e.preventDefault();
                fileTree.finishEditorDrop();
                attempt(() => openDoc(id, true))();
              }}
            >
              {emptyDrop && <div className="group-drop-zone" style={{ left: 0, top: 0, width: "100%" }} />}
              <div className="empty-state">
                <FileText size={32} />
                <h3>열린 문서가 없습니다</h3>
                <p>파일 트리에서 문서를 선택하세요.</p>
              </div>
            </div>
          )}
          {view === "bookmarks" && <BookmarksPage
            active={active}
            bookmarkQuery={bookmarkQuery}
            lib={lib}
            attempt={attempt}
            openDoc={openDoc}
            setBookmarkJump={setBookmarkJump}
            setBookmarkQuery={setBookmarkQuery}
            patchDoc={patchDoc}
          />}
          {view === "library" && (<LibraryPage
            lib={lib}
            loaded={loaded}
            projectReorder={projectReorder}
            prefs={prefs}
            menu={menu}
            attempt={attempt}
            openProject={openLibraryProject}
            openMenu={openMenu}
            askDeleteProject={askDeleteProject}
            setDialog={setDialog}
          />)}
          {view === "project" && project && (<ProjectPage
            attempt={attempt}
            goView={goView}
            docs={docs}
            project={project}
            setDialog={setDialog}
            prefs={prefs}
            refresh={refresh}
            changeLibrary={optimistic}
            message={message}
            setViewer={setViewer}
            tab={tab}
            setTab={setTab}
            count={count}
            archive={archive}
            setArchive={setArchive}
            openSearch={openSearch}
            createDoc={createDoc}
            openDoc={openDoc}
            numberOf={numberOf}
          />)}
          {active && (
            <>
              <SplitArea
                split={area}
                drag={draggedToGroups}
                onDrop={droppedOnGroups}
                className={previewOpen ? "with-preview" : ""}
                hidden={!isWorkspace}
                after={previewOpen && (
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
              >
              {sides.map(side => side !== focusedSide ? sideGroup(side) : (
              <section
                key={focusedSide}
                {...groupAttributes(focusedSide)}
                className={`editor-group ${split ? "focused" : ""}`}
                style={groupStyle(focusedSide)}
              >
              <div className="editor-tabs" {...tabBarAttributes} role="tablist" aria-label="열린 문서">
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
                      {...tabAttributes(t.id)}
                      role="tab"
                      tabIndex={current ? 0 : -1}
                      aria-selected={current}
                      title={t.pinned ? title : `${title} (미리보기)`}
                      className={`editor-tab ${current ? "current" : ""} ${t.pinned ? "" : "preview"} ${dragTab === t.id ? "dragging" : ""} ${menu?.target === "tab:" + t.id ? "context-target" : ""}`}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = "copyMove";
                        dragSide.current = focusedSide;
                        setDragTab(t.id);
                      }}
                      onDragEnd={() => {
                        setDragTab("");
                        area.clearDropZone();
                      }}
                      onClick={attempt(() => openDoc(t.id, false))}
                      onDoubleClick={() =>
                        pinTab(t.id)
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
                        title="닫기 (Ctrl+W, Alt+클릭: 다른 탭 닫기)"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (e.altKey) attempt(() => closeTabs((x) => x.id === t.id, t.id))();
                          else attempt(() => closeTab(t.id))();
                        }}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  );
                })}
                {(canSplit(focusedSide, "right") || canSplit(focusedSide, "down")) && (
                  <div className="editor-tabs-actions">
                    <button
                      type="button"
                      className="tab-split-button"
                      aria-label="편집기 분할"
                      title="오른쪽으로 분할 (Ctrl+\, Alt+클릭: 아래로 분할)"
                      onClick={(e) => {
                        e.stopPropagation();
                        const dir = e.altKey
                          ? (canSplit(focusedSide, "down") ? "down" : "right")
                          : (canSplit(focusedSide, "right") ? "right" : "down");
                        attempt(() => splitTo(active.id, dir, focusedSide))();
                      }}
                    >
                      <Columns2 size={14} />
                    </button>
                  </div>
                )}
              </div>
              {documentTabs(editorTabs, active.id, true)}
              </section>
              ))}
              </SplitArea>
              <footer className="editor-footer" hidden={!isWorkspace}>
                <span>
                  {active.kind === "episode"
                    ? <>{writingName(writingRules)} {stats ? platformChars.toLocaleString() : "…"}자</>
                    : <>공백 제외 {stats ? charsWithoutSpaces.toLocaleString() : "…"}자</>}
                  <i /> 공백 포함 {stats ? charsWithSpaces.toLocaleString() : "…"}자
                  {cursorLine !== null && <><i /> {cursorLine.toLocaleString()}번째 줄</>}
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
          <aside className={`widget-sidebar${rightView === "typesetting" ? " typesetting-open" : ""}`}>
            <div className="panel-caption">
              <span>{rightView === "bookmarks" ? "북마크" : rightView === "typesetting" ? "조판 설정" : "위젯 보드"}</span>
              <div className="panel-caption-actions">
                {/* 조판 설정과 북마크 목록에서는 닫기 버튼만 둔다. */}
                {rightView === "typesetting" ? (
                  <button aria-label="조판 설정 닫기" title="조판 설정 닫기" onClick={toggleTypesettingPanel}>
                    <X size={15} />
                  </button>
                ) : rightView === "bookmarks" ? (
                  <button aria-label="북마크 목록 닫기" title="북마크 목록 닫기" onClick={() => setRightView("widgets")}>
                    <X size={15} />
                  </button>
                ) : (
                  <>
                    <button
                      aria-label="조판 설정"
                      title="조판 설정 열기"
                      onClick={toggleTypesettingPanel}
                    >
                      <Pilcrow size={15} />
                    </button>
                    {!isMobile && (
                      <button
                        className="bookmark-toggle"
                        aria-label="북마크 목록"
                        title="북마크 목록 보기"
                        onClick={() => setRightView("bookmarks")}
                      >
                        <BookmarkIcon size={15} />
                      </button>
                    )}
                    {isMobile && (
                      <button
                        aria-label="위젯 보드 닫기"
                        title="위젯 보드 닫기"
                        onClick={() => setRight(false)}
                      >
                        <X size={15} />
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
            {rightView === "typesetting" ? (
              <div className="typesetting-panel">
                {<TypesettingSettings
                  prefs={prefs}
                  savePrefs={savePrefs}
                  saveKindPrefs={saveKindPrefs}
                  report={report}
                  message={message}
                  setTypesettingKind={setTypesettingKind}
                  targetKind={active.kind === "episode" ? "episode" : "document"}
                  inPanel={true}
                />}
              </div>
            ) : rightView === "bookmarks" ? <BookmarkList active={active} setBookmarkJump={setBookmarkJump} edit={edit} /> : (
            <>
            <PlatformCount
              stats={stats}
              rules={writingRules}
              documentOnly={active.kind !== "episode"}
              onChange={updateProjectWriting}
            />
            <section className="widget session-widget">
              <span>{active.kind === "episode" ? "이번 회차에서 새로 쓴 글" : "이번 문서에서 새로 쓴 글"}</span>
              <strong>
                +{sessionCount.toLocaleString()}
                <small>자</small>
              </strong>
            </section>
            {<DocumentLinksWidget
              active={active}
              lib={shownLibrary}
              tree={fileTree}
              attempt={attempt}
              menu={menu}
              openDoc={openLinked}
              openMenu={openMenu}
              docMenu={docMenu}
              archive={archive}
              addDocFile={addDocFile}
            />}
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
      {lib.localGit?.message && (
        <div className="warning-strip" role="status">로컬 원고 기록 대기 · {lib.localGit.message}</div>
      )}
      {recoverable > 0 && (
        <div className="recovery-toast" role="status">
          <span>복구 가능한 임시 원고 {recoverable}개</span>
          <button onClick={() => setDialog({ type: "recovery" })}>
            확인하기
          </button>
        </div>
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} align={menu.align} items={menu.items} onClose={closeMenu} />
      )}
      {quickNote && (
        <QuickNote
          source={quickNote}
          onSave={(memo, title) => saveQuickNote(quickNote, memo, title).catch(report)}
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
      {confirmDialog}
      {dialog?.type === "exportDocument" && dialog.value && <DocumentExportDialog documentId={dialog.value}
        flush={flush} onClose={() => setDialog(null)} message={message} report={report} />}
      {dialog && dialog.type !== "exportDocument" && (
        <div
          // 삭제를 묻는 창은 배경을 어둡게 하지 않는다.
          className={`modal-backdrop${["deleteDoc", "deleteProject"].includes(dialog.type) ? " plain-backdrop" : ""}`}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && dialog.type !== "setup")
              setDialog(null);
          }}
        >
          <div
            className={`modal ${["settings", "history"].includes(dialog.type) ? "wide" : ""}${dialog.type === "settings" ? " settings-modal" : ""}${dialog.type === "serverSync" ? " server-sync-modal" : ""}`}
            role="dialog"
            aria-modal="true"
          >
            <div className="modal-header">
              <h2>
                {
                  {
                    newProject: "새 이야기",
                    editProject: "소설 관리",
                    settings: "설정",
                    serverSync: "실시간 동기화",
                    history: "변경 이력",
                    deleteDoc: "영구 삭제",
                    deleteProject: "작품 삭제",
                    linkEpisode: "회차에 연결",
                    recovery: "임시 원고 복구",
                    setup: "처음 집필 환경 설정",
                    export: dialog.value ? "작품 내보내기" : "서재 내보내기",
                  }[dialog.type]
                }
              </h2>
              {dialog.type !== "setup" && (
                <button
                  aria-label="닫기"
                  onClick={() =>
                    setDialog(dialog.returnToSettings ? { type: "settings" } : null)
                  }
                >
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
                    <button type="button" disabled={busy} onClick={attempt(() => chooseVault())}>
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
            {["newProject", "editProject"].includes(dialog.type) && (<ProjectForm
              changeLibrary={optimistic}
              dialog={dialog}
              prefs={prefs}
              refresh={refresh}
              navigate={navigate}
              projectId={projectId}
              project={project}
              setDialog={setDialog}
              report={report}
              setViewer={setViewer}
              attempt={attempt}
              message={message}
              askDeleteProject={askDeleteProject}
            />)}
            {dialog.type === "history" && active && (
              <HistoryDialog documentId={active.id} report={report} onRestore={async (id, name) => {
                const restored = await session.restoreHistory(id, name, () => setDialog(null));
                message(restored.historyWarning ?? "이전 원고를 복원했습니다. 복원 전 원고와 복원 결과를 모두 이력에 남겼습니다.");
                void refresh().catch(report);
              }} onSaveCopy={saveHistoryCopy} />
            )}
            {dialog.type === "deleteDoc" &&
              (() => {
                const ids = dialog.ids ?? [dialog.value],
                  targets = lib.documents.filter((d) => ids.includes(d.id));
                if (!targets.length) return <p>이미 삭제된 문서입니다.</p>;
                return (
                  <>
                    <p>
                      {targets.length > 1
                        ? <><b>문서 {targets.length}개</b>를 영구 삭제할까요?</>
                        : <><b>{targets[0].title || "제목 없음"}</b> 문서를 영구 삭제할까요?</>}
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
                          fileTree.clearSelection();
                          await deleteDocs(targets);
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
                      setDialog(null);
                      await bindDocument(target.id, episodeId).catch(report);
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
                {recoverableDrafts.map((d: any) => (
                  <div key={d.id}>
                    <b>{d.title}</b>
                    <p>{String(d.body || "").slice(0, 120)}</p>
                    <div className="recovery-actions">
                      <button
                        onClick={attempt(async () => {
                          const copy = await call<Doc>("createDocument", {
                            projectId: d.projectId,
                            kind: d.kind,
                            title: d.title + " (복구 사본)",
                            body: d.body,
                          });
                          await call("clearDraft", { id: d.id });
                          updateLibrary((data) => ({
                            ...insertDocument(copy)(data),
                            drafts: data.drafts.filter((x) => x.id !== d.id),
                          }));
                          void refresh().catch(report);
                          session.discardDraft(d.id);
                          await openDoc(copy.id, true);
                          message("임시 원고를 새 문서로 복구했습니다.");
                        })}
                      >
                        사본으로 복구
                      </button>
                      <button
                        className="danger-outline"
                        onClick={attempt(() => deleteDraft(d))}
                      >
                        <Trash2 size={15} />
                        삭제
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {dialog.type === "serverSync" && (
              <div className="server-sync-content">
                <RealtimeSync onClose={() => setDialog(null)} prefs={prefs} savePrefs={savePrefs} report={report} />
              </div>
            )}
            {dialog.type === "export" && (
              <ExportDialog
                lib={lib}
                projectId={dialog.value}
                defaultPreserveBreaks={prefs.copyWithBlankLines === true}
                busy={busy}
                setBusy={setBusy}
                flush={flush}
                report={report}
                onCancel={() =>
                  setDialog(dialog.returnToSettings ? { type: "settings" } : null)
                }
                onSuccess={(res) => {
                  setDialog(dialog.returnToSettings ? { type: "settings" } : null);
                  const targetLabel = dialog.value ? "작품을" : "서재를";
                  message(
                    `${targetLabel} 내보냈습니다 (파일 ${res.fileCount}개)`,
                    {
                      label: "폴더 열기",
                      run: () => {
                        call("openExportFolder", { path: res.path }).catch(report);
                      },
                    },
                  );
                }}
              />
            )}
            {dialog.type === "settings" && (<SettingsContent
              settingsPage={settingsPage}
              setSettingsPage={setSettingsPage}
              updater={updater}
              lib={lib}
              prefs={prefs}
              savePrefs={savePrefs}
              report={report}
              saveKindPrefs={saveKindPrefs}
              message={message}
              setTypesettingKind={setTypesettingKind}
              typesettingKind={typesettingKind}
              newRepFrom={newRepFrom}
              newRepTo={newRepTo}
              newRepLabel={newRepLabel}
              setNewRepFrom={setNewRepFrom}
              setNewRepTo={setNewRepTo}
              setNewRepLabel={setNewRepLabel}
              active={active}
              isProtected={isProtected}
              replaceActiveSymbols={replaceActiveSymbols}
              commonMemoPath={commonMemoPath}
              attempt={attempt}
              setCommonMemoPath={setCommonMemoPath}
              busy={busy}
              setBusy={setBusy}
              flush={flush}
              renderSyncConnections={renderSyncConnections}
              skillDownloading={skillDownloading}
              setSkillDownloading={setSkillDownloading}
              chooseVault={chooseVault}
              moveVault={moveVault}
              onOpenExport={() =>
                setDialog({ type: "export", returnToSettings: true })
              }
            />)}
          </div>
        </div>
      )}
      <UpdateNotice updater={updater} onOpen={() => {
        setSettingsPage("updates");
        openSettings().catch(report);
      }} />
      {releaseNotice.visible && <ReleaseNotice version={lib.version}
        onOpen={() => setReleaseNotesOpen(true)} onClose={releaseNotice.dismiss} />}
      {releaseNotesOpen && <ReleaseNotesDialog version={lib.version} onClose={() => setReleaseNotesOpen(false)} />}
    </div>
    <UpdateLock phase={updater.phase} />
    </>
  );
}
