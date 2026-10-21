import {
  Archive,
  Bookmark as BookmarkIcon,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  Download,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  History,
  LayoutGrid,
  Link2,
  Lock,
  MoreVertical,
  PanelLeft,
  Pencil,
  PenLine,
  Pilcrow,
  Plus,
  Search,
  SlidersHorizontal,
  StickyNote,
  Trash2,
  X,
} from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  lineBreakDefault,
  normalizeStatus,
  STATUS_LABELS,
  STATUS_SHORT,
} from "../../core/episode.mjs";
import { requiresSource } from "../../core/text.mjs";
import {
  normalizeEditorStyle,
  resolveKindPrefs,
} from "../../core/typesetting.mjs";
import BookmarkList from "../app/BookmarkList";
import { icons, labels } from "../app/document-ui";
import { parentOfRel } from "../app/file-tree-model";
import { type Dialog } from "../app/model";
import TypesettingSettings from "../app/TypesettingSettings";
import type { FileTreeController } from "../app/useFileTree";
import EditorScroll, { type EditorScrollPositions } from "../EditorScroll";
import EpisodeProperties from "../EpisodeProperties";
import PlatformCount from "../PlatformCount";
import SyncStatus from "../SyncStatus";
import {
  call,
  type AutoSyncStatus,
  type Doc,
  type Kind,
  type Library,
  type Project,
  type WritingRules,
} from "../types";
import { workspaceKey } from "../workspace-state";
import Writer from "../Writer";
import MobileEditorToolbar, { MobileEditorMenuActions } from "./MobileEditorToolbar";
import {
  MobileActionSheet,
  MobilePromptSheet,
  type MobileActionItem,
} from "./MobileActionSheet";

type TreeTab = "episode" | "document";
type RightWidgetTab = "widgets" | "typesetting" | "bookmarks";

export default function MobileEditorView({
  lib,
  project,
  active,
  saveStatus,
  conflict,
  autoSync,
  syncChecking,
  syncAvailable,
  prefs,
  savePrefs,
  saveKindPrefs,
  writingRules,
  stats,
  platformChars,
  charsWithoutSpaces,
  charsWithSpaces,
  sessionCount,
  source,
  setSource,
  reveal,
  scrollPositions,
  tree,
  docImages,
  attempt,
  edit,
  counterUpdate,
  manualSave,
  flush,
  resolveConflict,
  checkOpenDocument,
  replaceActiveSymbols,
  openDoc,
  createDoc,
  patchDoc,
  archiveDoc,
  duplicateDoc,
  copyDocManuscript,
  openBinding,
  bindDocument,
  openNoteLink,
  showHistory,
  goProject,
  onUpdateProjectWriting,
  setDialog,
  message,
  report,
  numberOf,
  bookmarkJump,
  setBookmarkJump,
}: {
  lib: Library;
  project?: Project;
  active: Doc;
  saveStatus: string;
  conflict: boolean;
  autoSync: AutoSyncStatus;
  syncChecking: boolean;
  syncAvailable: boolean;
  prefs: Record<string, any>;
  savePrefs: (patch: Record<string, any>) => Promise<void>;
  saveKindPrefs: (
    kind: Kind | "document",
    patch: Record<string, any>,
  ) => Promise<void>;
  writingRules: WritingRules;
  stats: any;
  platformChars: number;
  charsWithoutSpaces: number;
  charsWithSpaces: number;
  sessionCount: number;
  source: boolean;
  setSource: React.Dispatch<React.SetStateAction<boolean>>;
  reveal: any;
  scrollPositions: EditorScrollPositions;
  tree: FileTreeController;
  docImages: (
    doc: Doc,
    editable: boolean,
  ) => {
    resolve: (src: string) => Promise<string | null>;
    save?: (
      file?: { name: string; data: string },
    ) => Promise<{ src: string; alt: string } | null>;
  };
  attempt: (fn: () => Promise<any>) => () => Promise<any>;
  edit: (patch: Partial<Doc>, markdownCopy?: boolean) => void;
  counterUpdate: (body: string, delta: any) => void;
  manualSave: () => Promise<void>;
  flush: () => Promise<void>;
  resolveConflict: () => Promise<void>;
  checkOpenDocument: (apply?: boolean) => Promise<void>;
  replaceActiveSymbols: () => void;
  openDoc: (id: string, pinned?: boolean) => Promise<void>;
  createDoc: (
    kind: Kind,
    opts?: { title?: string; episodeId?: string },
  ) => Promise<void>;
  patchDoc: (id: string, patch: Partial<Doc>) => Promise<void>;
  archiveDoc: (doc: Doc) => Promise<void>;
  duplicateDoc: (doc: Doc) => Promise<void>;
  copyDocManuscript: (doc: Doc, rawMarkdown?: boolean) => Promise<void>;
  openBinding: (id: string) => Promise<void>;
  bindDocument: (id: string, episodeId: string | null) => Promise<void>;
  openNoteLink: (href: string, quote: string) => Promise<void>;
  showHistory: () => Promise<void>;
  goProject: () => Promise<void>;
  onUpdateProjectWriting: (rules: WritingRules) => void;
  setDialog: React.Dispatch<React.SetStateAction<Dialog | null>>;
  message: (text: string) => void;
  report: (e: any) => void;
  numberOf: (d: Doc) => any;
  bookmarkJump?: { docId: string; index: number; seq: number } | null;
  setBookmarkJump?: React.Dispatch<
    React.SetStateAction<{ docId: string; index: number; seq: number } | null>
  >;
}) {
  // 왼쪽 파일트리 드로어 / 오른쪽 위젯 드로어 상태
  const [leftDrawerOpen, setLeftDrawerOpen] = useState(false);
  const [rightDrawerOpen, setRightDrawerOpen] = useState(false);
  const [rightTab, setRightTab] = useState<RightWidgetTab>("widgets");
  const [treeTab, setTreeTab] = useState<TreeTab>(
    active.kind === "episode" ? "episode" : "document",
  );
  const [treeFilter, setTreeFilter] = useState("");
  const [collapsedPaths, setCollapsedPaths] = useState<Record<string, boolean>>({});
  const [createMenuFolder, setCreateMenuFolder] = useState<string | null>(null);
  const [newFolderParent, setNewFolderParent] = useState<string | null>(null);

  // 하단 플로팅 필 툴바 우측 더보기 플로팅 팝업 & 상단 속성 작은 플로팅 팝업 상태
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [propPopup, setPropPopup] = useState<{
    x: number;
    y: number;
    align?: "left" | "center";
    items: Array<
      | "separator"
      | {
          label: string;
          icon?: React.ReactNode;
          badge?: string;
          checked?: boolean;
          danger?: boolean;
          disabled?: boolean;
          action: () => void;
        }
    >;
  } | null>(null);
  const [, setTypesettingKind] = useState<"episode" | "document">(
    active.kind === "episode" ? "episode" : "document",
  );

  // 스와이프 제스처 추적 (왼쪽 슬라이드 -> 파일트리, 오른쪽 슬라이드 -> 위젯 영역)
  const touchRef = useRef<{
    x: number;
    y: number;
    time: number;
    ignore: boolean;
  } | null>(null);

  const isProtected =
    active.kind === "episode" && normalizeStatus(active.status) === "completed";
  const kindPrefs = resolveKindPrefs(prefs, active.kind);

  // 동기화 아이콘은 실시간·폴더 동기화가 진행 중일 때 보이고, 끝나면 완료 상태를 잠깐 보여 준 뒤 숨긴다
  const syncBusy =
    syncChecking ||
    autoSync.phase === "syncing" ||
    autoSync.channels?.realtime?.phase === "syncing" ||
    autoSync.channels?.files?.phase === "syncing";
  const [syncShown, setSyncShown] = useState(syncBusy);
  useEffect(() => {
    if (syncBusy) {
      setSyncShown(true);
      return;
    }
    const timer = window.setTimeout(() => setSyncShown(false), 1800);
    return () => window.clearTimeout(timer);
  }, [syncBusy]);

  // 회차의 집필 상태를 고르는 플로팅 메뉴. 열려 있는 회차는 편집 중인 원고와 함께 저장한다.
  const showStatusMenu = (doc: Doc, x: number, y: number) => {
    const current = normalizeStatus(doc.status);
    const pick = (status: string) => () => {
      if (status === current) return;
      const done = () => {
        if (status === "completed")
          message("원고 보호 모드로 전환되었습니다. 집필 완료된 에피소드는 편집이 제한됩니다.");
      };
      if (doc.id === active.id) {
        edit({ status });
        done();
      } else {
        attempt(async () => {
          await patchDoc(doc.id, { status });
          done();
        })();
      }
    };
    setPropPopup({
      x,
      y,
      align: "center",
      items: [
        {
          label: STATUS_LABELS.in_progress,
          icon: <PenLine size={16} />,
          checked: current === "in_progress",
          action: pick("in_progress"),
        },
        {
          label: STATUS_LABELS.revision,
          icon: <Pencil size={16} />,
          checked: current === "revision",
          action: pick("revision"),
        },
        {
          label: STATUS_LABELS.completed,
          icon: <CheckCircle2 size={16} />,
          badge: "원고 보호",
          checked: current === "completed",
          action: pick("completed"),
        },
      ],
    });
  };

  // 회차 제목을 누르면 제목 아래에 집필 상태 메뉴를 띄운다
  const openStatusMenu = (e: React.MouseEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    showStatusMenu(active, rect.left + rect.width / 2, rect.bottom + 6);
  };

  // 드로어 회차 목록은 꾹 누르면 누른 자리 아래에 집필 상태 메뉴를 띄운다
  const longPressRef = useRef<{
    timer: number;
    x: number;
    y: number;
    fired: boolean;
  } | null>(null);
  const cancelLongPress = () => {
    if (longPressRef.current) window.clearTimeout(longPressRef.current.timer);
  };
  const statusLongPress = (doc: Doc) => ({
    onTouchStart: (e: React.TouchEvent) => {
      cancelLongPress();
      if (e.touches.length !== 1) {
        longPressRef.current = null;
        return;
      }
      const t = e.touches[0];
      const press = { timer: 0, x: t.clientX, y: t.clientY, fired: false };
      press.timer = window.setTimeout(() => {
        press.fired = true;
        navigator.vibrate?.(12);
        showStatusMenu(doc, press.x, press.y + 12);
      }, 450);
      longPressRef.current = press;
    },
    onTouchMove: (e: React.TouchEvent) => {
      const press = longPressRef.current;
      const t = e.touches[0];
      if (press && !press.fired && Math.hypot(t.clientX - press.x, t.clientY - press.y) > 10) {
        cancelLongPress();
        longPressRef.current = null;
      }
    },
    onTouchEnd: cancelLongPress,
    onTouchCancel: cancelLongPress,
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  });
  // 꾹 눌러 메뉴를 띄운 뒤 따라오는 클릭으로 회차가 열리지 않게 한다
  const consumeLongPress = () => {
    const fired = !!longPressRef.current?.fired;
    longPressRef.current = null;
    return fired;
  };
  const norm = normalizeEditorStyle(prefs, active.kind);
  const num = numberOf(active);

  // 안드로이드 뒤로가기 시 열려 있는 드로어나 팝업/시트를 먼저 닫음
  useEffect(() => {
    (window as any).__lofEditorSubBack = () => {
      if (propPopup) {
        setPropPopup(null);
        return true;
      }
      if (newFolderParent !== null) {
        setNewFolderParent(null);
        return true;
      }
      if (createMenuFolder !== null) {
        setCreateMenuFolder(null);
        return true;
      }
      if (moreMenuOpen) {
        setMoreMenuOpen(false);
        return true;
      }
      if (leftDrawerOpen) {
        setLeftDrawerOpen(false);
        return true;
      }
      if (rightDrawerOpen) {
        setRightDrawerOpen(false);
        return true;
      }
      return false;
    };
    return () => {
      delete (window as any).__lofEditorSubBack;
    };
  }, [
    propPopup,
    newFolderParent,
    createMenuFolder,
    moreMenuOpen,
    leftDrawerOpen,
    rightDrawerOpen,
  ]);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    const target = e.target as HTMLElement | null;
    // 하단 툴바 슬라이드나 팝업 메뉴 터치 시에는 사이드바 제스처 제외
    const ignore = Boolean(
      target?.closest(
        'input[type="range"], .tableWrapper, .m-editor-title-nav, .m-doc-scope-bar, .m-pill-tabs, .m-floating-pill-bar, .m-floating-popup-menu, .m-floating-anchor-popup',
      ),
    );
    const t = e.touches[0];
    touchRef.current = {
      x: t.clientX,
      y: t.clientY,
      time: Date.now(),
      ignore,
    };
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    const start = touchRef.current;
    touchRef.current = null;
    if (!start || start.ignore || e.changedTouches.length !== 1) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    const dt = Date.now() - start.time;

    // 빠르고 명확한 수평 슬라이드 제스처 판별
    if (dt > 650) return;
    if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.65) return;

    if (dx > 0) {
      // 왼쪽에서 오른쪽으로 슬라이드 -> 오른쪽 위젯 드로어가 열려 있으면 닫고, 아니면 왼쪽 파일트리 열기
      if (rightDrawerOpen) {
        setRightDrawerOpen(false);
      } else if (!leftDrawerOpen) {
        setTreeTab(active.kind === "episode" ? "episode" : "document");
        setLeftDrawerOpen(true);
      }
    } else {
      // 오른쪽에서 왼쪽으로 슬라이드 -> 왼쪽 파일트리가 열려 있으면 닫고, 아니면 오른쪽 위젯 영역 열기
      if (leftDrawerOpen) {
        setLeftDrawerOpen(false);
      } else if (!rightDrawerOpen) {
        setRightDrawerOpen(true);
      }
    }
  };

  // 프로젝트 내 문서 분류 (왼쪽 파일트리 & 오른쪽 위젯 공용)
  const projectDocs = useMemo(
    () =>
      lib.documents.filter(
        (d) => d.projectId === active.projectId && !d.archived,
      ),
    [lib.documents, active.projectId],
  );

  const episodes = useMemo(
    () => projectDocs.filter((d) => d.kind === "episode"),
    [projectDocs],
  );
  const docItems = useMemo(
    () => projectDocs.filter((d) => d.kind === "plot" || d.kind === "memo"),
    [projectDocs],
  );

  // 상단 제목 표시줄의 < > 버튼과 좌우 슬라이드로 이전·다음 회차를 연다.
  const episodeIndex = episodes.findIndex((ep) => ep.id === active.id);
  const prevEpisode = episodeIndex > 0 ? episodes[episodeIndex - 1] : undefined;
  const nextEpisode =
    episodeIndex >= 0 ? episodes[episodeIndex + 1] : undefined;
  const openSibling = (doc?: Doc) => {
    if (doc) attempt(() => openDoc(doc.id, false))();
  };
  const titleTouchRef = useRef<{ x: number; y: number } | null>(null);
  const handleTitleTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    titleTouchRef.current =
      e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null;
  };
  const handleTitleTouchEnd = (e: React.TouchEvent) => {
    const start = titleTouchRef.current;
    titleTouchRef.current = null;
    if (!start || active.kind !== "episode" || e.changedTouches.length !== 1) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    // 왼쪽으로 밀면 다음 회차, 오른쪽으로 밀면 이전 회차
    openSibling(dx < 0 ? nextEpisode : prevEpisode);
  };

  // 문서 폴더 경로는 doc/ 아래 기준이라 문서 경로에서도 doc/를 떼고 비교한다.
  const docFolderOf = (d: Doc) =>
    parentOfRel((d.relPath || "").replace(/^doc\//, ""));

  const allFolders = useMemo(() => {
    const set = new Set<string>(
      tree.memoEntries
        .filter((e) => e.type === "folder" && !e.archived)
        .map((e) => e.path),
    );
    for (const d of docItems) {
      const f = docFolderOf(d);
      if (f) {
        const parts = f.split("/");
        let acc = "";
        for (const p of parts) {
          acc = acc ? `${acc}/${p}` : p;
          set.add(acc);
        }
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, "ko"));
  }, [tree.memoEntries, docItems]);

  const toggleFolder = (path: string) => {
    setCollapsedPaths((prev) => ({ ...prev, [path]: !prev[path] }));
  };

  // 현재 회차에 연결된 플롯/메모 (오른쪽 위젯 보드용)
  const boundEpisode = useMemo(
    () =>
      active.kind === "episode"
        ? active
        : active.episodeId
          ? episodes.find((ep) => ep.id === active.episodeId)
          : undefined,
    [active, episodes],
  );

  const linkedPlots = useMemo(
    () =>
      active.kind === "episode"
        ? docItems.filter(
            (d) => d.kind === "plot" && d.episodeId === active.id,
          )
        : [],
    [active, docItems],
  );

  const linkedMemos = useMemo(
    () =>
      active.kind === "episode"
        ? docItems.filter(
            (d) => d.kind === "memo" && d.episodeId === active.id,
          )
        : [],
    [active, docItems],
  );

  const createMenuItems: MobileActionItem[] =
    createMenuFolder !== null
      ? [
          {
            label: "새 플롯 문서",
            icon: <FileText size={18} />,
            action: attempt(async () => {
              const target = createMenuFolder;
              setCreateMenuFolder(null);
              setLeftDrawerOpen(false);
              await tree.addDocFile(target, "plot");
            }),
          },
          {
            label: "새 메모 문서",
            icon: <StickyNote size={18} />,
            action: attempt(async () => {
              const target = createMenuFolder;
              setCreateMenuFolder(null);
              setLeftDrawerOpen(false);
              await tree.addDocFile(target, "memo");
            }),
          },
          "separator",
          {
            label: "새 폴더 만들기",
            icon: <FolderPlus size={18} />,
            action: () => {
              const target = createMenuFolder;
              setCreateMenuFolder(null);
              setNewFolderParent(target);
            },
          },
        ]
      : [];

  // 왼쪽 드로어 내부 문서 트리 재귀 렌더링
  const renderDrawerDocTree = (
    parentPath: string,
    depth: number,
  ): React.ReactNode => {
    const childFolders = allFolders.filter((f) => {
      const idx = f.lastIndexOf("/");
      const parent = idx >= 0 ? f.slice(0, idx) : "";
      return parent === parentPath;
    });

    const childDocs = docItems.filter((d) => docFolderOf(d) === parentPath);

    return (
      <>
        {childFolders.map((folderPath) => {
          const name = folderPath.split("/").pop() || folderPath;
          const isCollapsed = Boolean(collapsedPaths[folderPath]);
          const countInFolder = docItems.filter((d) => {
            const f = docFolderOf(d);
            return f === folderPath || f.startsWith(`${folderPath}/`);
          }).length;

          return (
            <div key={`folder:${folderPath}`} className="m-tree-node">
              <div className="m-tree-row m-tree-folder">
                <button
                  type="button"
                  className="m-tree-row-main"
                  onClick={() => toggleFolder(folderPath)}
                >
                  <span className="m-tree-chevron">
                    {isCollapsed ? (
                      <ChevronRight size={15} />
                    ) : (
                      <ChevronDown size={15} />
                    )}
                  </span>
                  <span className="m-tree-icon folder">
                    {isCollapsed ? (
                      <Folder size={16} />
                    ) : (
                      <FolderOpen size={16} />
                    )}
                  </span>
                  <span className="m-tree-label">{name}</span>
                  {countInFolder > 0 && (
                    <span className="m-tree-count">{countInFolder}</span>
                  )}
                </button>
                <button
                  type="button"
                  className="m-tree-action-btn"
                  aria-label={`${name} 폴더에 추가`}
                  onClick={() => setCreateMenuFolder(folderPath)}
                >
                  <Plus size={15} />
                </button>
              </div>
              {!isCollapsed && (
                <div className="m-tree-children">
                  {renderDrawerDocTree(folderPath, depth + 1)}
                </div>
              )}
            </div>
          );
        })}

        {childDocs.map((d) => {
          const isCur = d.id === active.id;
          const isPlot = d.kind === "plot";
          const Icon = icons[d.kind];
          return (
            <div
              key={d.id}
              className={`m-tree-row m-doc-tree-item ${isCur ? "active" : ""}`}
            >
              <button
                type="button"
                className="m-tree-row-main"
                onClick={() => {
                  setLeftDrawerOpen(false);
                  if (!isCur) attempt(() => openDoc(d.id, false))();
                }}
              >
                <span className={`m-tree-icon ${isPlot ? "plot" : "memo"}`}>
                  <Icon size={16} />
                </span>
                <span className="m-tree-label">{d.title || "제목 없음"}</span>
                <span className={`m-tree-kind-tag ${isPlot ? "plot" : "memo"}`}>
                  {isPlot ? "플롯" : "메모"}
                </span>
              </button>
            </div>
          );
        })}
      </>
    );
  };

  const charCountLabel =
    active.kind === "episode"
      ? `${stats ? platformChars.toLocaleString() : "…"}자`
      : `${stats ? charsWithoutSpaces.toLocaleString() : "…"}자`;

  return (
    <div
      className="m-screen m-editor-screen"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* 심플하고 깔끔한 상단 헤더 */}
      <header className="m-topbar m-editor-topbar">
        <div className="m-editor-topbar-left">
          <button
            type="button"
            className="m-icon-btn"
            aria-label="파일 트리 열기 (왼쪽에서 슬라이드)"
            title="파일 트리"
            onClick={() => {
              setTreeTab(active.kind === "episode" ? "episode" : "document");
              setLeftDrawerOpen(true);
            }}
          >
            <PanelLeft size={19} />
          </button>
        </div>

        <div
          className="m-editor-title-nav"
          onTouchStart={handleTitleTouchStart}
          onTouchEnd={handleTitleTouchEnd}
        >
          {active.kind === "episode" && (
            <button
              type="button"
              className="m-title-nav-btn"
              aria-label="이전 회차"
              disabled={!prevEpisode}
              onClick={() => openSibling(prevEpisode)}
            >
              <ChevronLeft size={18} />
            </button>
          )}
          {active.kind === "episode" ? (
            <button
              type="button"
              className="m-editor-title-label m-editor-title-status-btn"
              aria-label={`집필 상태 변경 (현재 ${STATUS_LABELS[normalizeStatus(active.status)]})`}
              onClick={openStatusMenu}
            >
              <span
                className={`m-save-dot ${saveStatus === "저장됨" ? "saved" : "pending"}`}
                title={saveStatus}
              />
              <span className="m-editor-doc-title">
                {active.title || "제목 없음"}
              </span>
              {isProtected && (
                <Lock size={13} className="m-editor-title-lock" aria-hidden />
              )}
            </button>
          ) : (
            <span className="m-editor-title-label">
              <span
                className={`m-save-dot ${saveStatus === "저장됨" ? "saved" : "pending"}`}
                title={saveStatus}
              />
              <span className="m-editor-doc-title">
                {active.title || "제목 없음"}
              </span>
            </span>
          )}
          {active.kind === "episode" && (
            <button
              type="button"
              className="m-title-nav-btn"
              aria-label="다음 회차"
              disabled={!nextEpisode}
              onClick={() => openSibling(nextEpisode)}
            >
              <ChevronRight size={18} />
            </button>
          )}
        </div>

        <div className="m-topbar-actions">
          <button
            type="button"
            className="m-char-badge-btn"
            aria-label="글자 수 및 원고 정보 보기"
            onClick={() => {
              setRightTab("widgets");
              setRightDrawerOpen(true);
            }}
          >
            {charCountLabel}
          </button>
          <button
            type="button"
            className="m-icon-btn"
            aria-label="위젯 보드 열기 (오른쪽에서 슬라이드)"
            title="위젯 보드"
            onClick={() => {
              setRightTab("widgets");
              setRightDrawerOpen(true);
            }}
          >
            <LayoutGrid size={19} />
          </button>
        </div>
      </header>

      {/* 충돌 배너 */}
      {conflict && (
        <div className="m-conflict-banner">
          <span>다른 기기에서 변경된 원고가 있습니다.</span>
          <div className="m-conflict-actions">
            <button type="button" onClick={attempt(resolveConflict)}>
              사본 저장
            </button>
            <button
              type="button"
              onClick={attempt(() => checkOpenDocument(true))}
            >
              새 내용 불러오기
            </button>
          </div>
        </div>
      )}

      <div className="m-editor-sync-anchor">
        <div
          className={`m-editor-sync-status ${syncShown ? "" : "quiet"}`}
          aria-hidden={!syncShown}
        >
          <SyncStatus
            status={autoSync}
            checking={syncChecking}
            available={syncAvailable}
            editing={saveStatus !== "저장됨"}
          />
        </div>
      </div>

      {/* 본문 에디터 스크롤 영역 */}
      <EditorScroll
        key={active.id}
        documentId={`mobile\n${active.id}`}
        scope={workspaceKey(lib.root, active.projectId)}
        positions={scrollPositions}
        visible={true}
      >
        <article
          className="m-manuscript-sheet"
          style={{
            backgroundColor: norm.textareaBgColor || undefined,
            color: norm.editorTextColor || undefined,
          }}
        >
          <div className="m-manuscript-head-meta">
            <span className="m-doc-kind-label">
              {labels[active.kind]} · {num}
            </span>
          </div>

          <input
            type="text"
            className="m-document-title-input"
            aria-label="문서 제목"
            spellCheck={false}
            value={active.title}
            placeholder="제목을 입력해 주세요"
            readOnly={isProtected}
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
            readOnly={isProtected}
            open={!!prefs.episodeInfoOpen}
            onToggle={() =>
              savePrefs({ episodeInfoOpen: !prefs.episodeInfoOpen }).catch(
                report,
              )
            }
            onEdit={(patch) => edit(patch)}
            onMenu={(rect, items) => {
              setPropPopup({
                x: rect.left,
                y: rect.bottom + 6,
                align: "left",
                items: items.map((item: any) =>
                  item === "separator"
                    ? "separator"
                    : {
                        label: item.label,
                        icon: item.icon,
                        badge: item.badge,
                        checked: item.checked,
                        danger: item.danger,
                        disabled: item.disabled,
                        action: item.action || (() => {}),
                      },
                ),
              });
            }}
            onNotice={message}
            boundEpisode={boundEpisode}
            onBind={attempt(() => openBinding(active.id))}
            onUnbind={attempt(() => bindDocument(active.id, null))}
            onOpenBound={
              active.episodeId
                ? attempt(() => openDoc(active.episodeId!))
                : undefined
            }
          />

          <Writer
            key="mobile-writer"
            readOnly={isProtected}
            inactive={false}
            visible={true}
            manualLineBreak={!!active.manualLineBreak}
            copyWithBlankLines={prefs.copyWithBlankLines === true}
            id={active.id}
            revision={active.revision}
            body={active.body}
            tables={active.kind === "memo" || active.kind === "plot"}
            reveal={reveal?.docId === active.id ? reveal : null}
            countingRules={writingRules}
            onChange={(body, delta, markdownCopy) => {
              counterUpdate(body, delta);
              edit({ body }, markdownCopy);
            }}
            fontSize={norm.fontSize}
            lineHeight={norm.lineHeight}
            source={source}
            typingOptions={{
              autoCloseQuotes: prefs.autoCloseQuotes,
              autoCloseBrackets: prefs.autoCloseBrackets,
              smartBrackets: prefs.smartBrackets,
              autoSymbolReplacement: prefs.autoSymbolReplacement,
              autoDividerReplacement: prefs.autoDividerReplacement,
              quoteStyle: prefs.quoteStyle,
              textReplacements: prefs.textReplacements,
            }}
            editorStyle={kindPrefs}
            onReplaceSymbols={replaceActiveSymbols}
            lineBreak={{
              def:
                active.kind === "episode"
                  ? lineBreakDefault(project, prefs.defaultManualLineBreak)
                  : false,
              defaultLabel:
                active.kind === "episode" ? "새 에피소드 기본값" : "기본값",
              onChange: (manualLineBreak) => edit({ manualLineBreak }),
            }}
            bookmarks={active.bookmarks}
            onBookmarksChange={(bookmarks) => edit({ bookmarks })}
            jumpToBookmark={
              bookmarkJump?.docId === active.id ? bookmarkJump : null
            }
            onQuickNote={undefined}
            links={active.kind === "memo" || active.kind === "plot"}
            onOpenLink={(href, quote) =>
              attempt(() => openNoteLink(href, quote))()
            }
            notes={undefined}
            onOpenNotes={undefined}
            contextMenu={false}
            images={docImages(active, !isProtected)}
          />
          <div className="end-marker">✧</div>
        </article>
      </EditorScroll>

      <MobileEditorToolbar
        disabled={isProtected}
        moreOpen={moreMenuOpen}
        onToggleMore={() => setMoreMenuOpen((open) => !open)}
        onReplaceSymbols={replaceActiveSymbols}
      />

      {/* 하단 툴바 우측 더보기(⋮) 플로팅 팝업 메뉴 */}
      {moreMenuOpen && (
        <div
          className="m-floating-popup-backdrop"
          onClick={() => setMoreMenuOpen(false)}
          role="presentation"
        >
          <div
            className="m-floating-popup-menu"
            role="menu"
            aria-label="편집 및 원고 더보기 메뉴"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="m-floating-popup-section">
              <button
                type="button"
                className="m-floating-popup-item"
                role="menuitem"
                onClick={() => {
                  setMoreMenuOpen(false);
                  const epId =
                    active.kind === "episode" ? active.id : active.episodeId;
                  attempt(() =>
                    createDoc("plot", epId ? { episodeId: epId } : undefined),
                  )();
                }}
              >
                <FileText size={16} />
                <span>플롯 추가</span>
                {active.kind === "episode" && (
                  <small className="m-floating-popup-badge">현재 회차 연결</small>
                )}
              </button>
              <button
                type="button"
                className="m-floating-popup-item"
                role="menuitem"
                onClick={() => {
                  setMoreMenuOpen(false);
                  const epId =
                    active.kind === "episode" ? active.id : active.episodeId;
                  attempt(() =>
                    createDoc("memo", epId ? { episodeId: epId } : undefined),
                  )();
                }}
              >
                <StickyNote size={16} />
                <span>메모 추가</span>
                {active.kind === "episode" && (
                  <small className="m-floating-popup-badge">현재 회차 연결</small>
                )}
              </button>
            </div>

            <div className="m-floating-popup-divider" />

            <MobileEditorMenuActions
              disabled={isProtected}
              tables={active.kind === "memo" || active.kind === "plot"}
              manualLineBreak={!!active.manualLineBreak}
              onClose={() => setMoreMenuOpen(false)}
              onSave={() => void manualSave().catch(report)}
            />

            <div className="m-floating-popup-divider" />

            <div className="m-floating-popup-section">
              <button
                type="button"
                className="m-floating-popup-item"
                role="menuitem"
                onClick={() => {
                  setMoreMenuOpen(false);
                  setSource((s) => !s);
                }}
              >
                <Code2 size={16} />
                <span>
                  {source ? "일반 편집 모드로 전환" : "Markdown 원문 편집"}
                </span>
              </button>

              <button
                type="button"
                className="m-floating-popup-item"
                role="menuitem"
                onClick={() => {
                  setMoreMenuOpen(false);
                  attempt(showHistory)();
                }}
              >
                <History size={16} />
                <span>변경 이력 및 복원</span>
              </button>

              <button
                type="button"
                className="m-floating-popup-item"
                role="menuitem"
                onClick={() => {
                  setMoreMenuOpen(false);
                  attempt(() =>
                    copyDocManuscript(
                      active,
                      source || requiresSource(active.body),
                    ),
                  )();
                }}
              >
                <Copy size={16} />
                <span>
                  {source || requiresSource(active.body)
                    ? "Markdown 원문 복사"
                    : "본문 텍스트 복사"}
                </span>
              </button>

              <button
                type="button"
                className="m-floating-popup-item"
                role="menuitem"
                onClick={() => {
                  setMoreMenuOpen(false);
                  attempt(async () => {
                    await flush();
                    if (await call("exportDocument", { id: active.id })) {
                      message("원고를 내보냈습니다.");
                    }
                  })();
                }}
              >
                <Download size={16} />
                <span>Markdown 내보내기</span>
              </button>
            </div>

            <div className="m-floating-popup-divider" />

            <div className="m-floating-popup-section">
              <button
                type="button"
                className="m-floating-popup-item"
                role="menuitem"
                onClick={() => {
                  setMoreMenuOpen(false);
                  attempt(() => archiveDoc(active))();
                }}
              >
                <Archive size={16} />
                <span>
                  {active.archived ? "보관함에서 꺼내기" : "보관함으로 이동"}
                </span>
              </button>

              <button
                type="button"
                className="m-floating-popup-item danger"
                role="menuitem"
                onClick={() => {
                  setMoreMenuOpen(false);
                  setDialog({ type: "deleteDoc", value: active.id });
                }}
              >
                <Trash2 size={16} />
                <span>영구 삭제</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 1. 왼쪽 슬라이드 드로어: 파일트리 (에피소드 / 문서 2탭 + Obsidian/Notion 트리) */}
      {leftDrawerOpen && (
        <div
          className="m-drawer-backdrop"
          onClick={() => setLeftDrawerOpen(false)}
          role="presentation"
        >
          <aside
            className="m-slide-drawer left"
            role="dialog"
            aria-modal="true"
            aria-label="파일 트리"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="m-drawer-header">
              <div className="m-drawer-title-group">
                <button
                  type="button"
                  className="m-drawer-title-btn"
                  aria-label="작품 페이지로 이동"
                  onClick={() => {
                    setLeftDrawerOpen(false);
                    attempt(goProject)();
                  }}
                >
                  <strong>{project?.title || "제목 없는 작품"}</strong>
                </button>
                <small>
                  에피소드 {episodes.length} · 문서 {docItems.length}
                </small>
              </div>
              <button
                type="button"
                className="m-icon-btn"
                aria-label="파일 트리 닫기"
                onClick={() => setLeftDrawerOpen(false)}
              >
                <X size={19} />
              </button>
            </div>

            <div className="m-drawer-controls">
              <div className="m-pill-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={treeTab === "episode"}
                  className={`m-pill-tab ${treeTab === "episode" ? "selected" : ""}`}
                  onClick={() => setTreeTab("episode")}
                >
                  <BookOpen size={14} />
                  <span>에피소드</span>
                  <small>{episodes.length}</small>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={treeTab === "document"}
                  className={`m-pill-tab ${treeTab === "document" ? "selected" : ""}`}
                  onClick={() => setTreeTab("document")}
                >
                  <FileText size={14} />
                  <span>문서</span>
                  <small>{docItems.length}</small>
                </button>
              </div>

              <div className="m-modern-toolbar">
                <div className="m-soft-search">
                  <Search size={14} className="m-filter-icon" />
                  <input
                    type="search"
                    className="m-filter-input"
                    placeholder={
                      treeTab === "episode"
                        ? "에피소드 검색..."
                        : "플롯·메모 검색..."
                    }
                    value={treeFilter}
                    onChange={(e) => setTreeFilter(e.target.value)}
                  />
                  {treeFilter && (
                    <button
                      type="button"
                      className="m-filter-clear"
                      onClick={() => setTreeFilter("")}
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="m-drawer-body m-tree-scroll">
              {treeTab === "episode" ? (
                <div className="m-tree-container">
                  {episodes
                    .filter(
                      (ep) =>
                        !treeFilter.trim() ||
                        (ep.title || "")
                          .toLowerCase()
                          .includes(treeFilter.trim().toLowerCase()),
                    )
                    .map((ep) => {
                      const isCur = ep.id === active.id;
                      const n = numberOf(ep);
                      const st = normalizeStatus(ep.status);
                      return (
                        <div
                          key={ep.id}
                          className={`m-tree-row m-episode-row ${isCur ? "active" : ""}`}
                        >
                          <button
                            type="button"
                            className="m-tree-row-main"
                            {...statusLongPress(ep)}
                            onClick={() => {
                              if (consumeLongPress()) return;
                              setLeftDrawerOpen(false);
                              if (!isCur) attempt(() => openDoc(ep.id, false))();
                            }}
                          >
                            <span
                              className={`m-ep-pill ${/^\d/.test(String(n)) ? "" : "named"}`}
                            >
                              {n}
                            </span>
                            <span className="m-tree-label">
                              {ep.title || "제목 없음"}
                            </span>
                            {st !== "in_progress" && (
                              <span
                                className={`m-status-dot-badge ${st === "completed" ? "completed" : ""}`}
                              >
                                {STATUS_SHORT[st]}
                              </span>
                            )}
                            <span className="m-tree-meta">
                              {(
                                ep.platformCharacters ??
                                ep.characters ??
                                0
                              ).toLocaleString()}
                              자
                            </span>
                          </button>
                        </div>
                      );
                    })}
                </div>
              ) : (
                <div className="m-tree-container">
                  {treeFilter.trim()
                    ? docItems
                        .filter((d) =>
                          (d.title || "")
                            .toLowerCase()
                            .includes(treeFilter.trim().toLowerCase()),
                        )
                        .map((d) => {
                          const isCur = d.id === active.id;
                          const isPlot = d.kind === "plot";
                          const Icon = icons[d.kind];
                          return (
                            <div
                              key={d.id}
                              className={`m-tree-row m-doc-tree-item ${isCur ? "active" : ""}`}
                            >
                              <button
                                type="button"
                                className="m-tree-row-main"
                                onClick={() => {
                                  setLeftDrawerOpen(false);
                                  if (!isCur)
                                    attempt(() => openDoc(d.id, false))();
                                }}
                              >
                                <span
                                  className={`m-tree-icon ${isPlot ? "plot" : "memo"}`}
                                >
                                  <Icon size={16} />
                                </span>
                                <span className="m-tree-label">
                                  {d.title || "제목 없음"}
                                </span>
                                <span
                                  className={`m-tree-kind-tag ${isPlot ? "plot" : "memo"}`}
                                >
                                  {isPlot ? "플롯" : "메모"}
                                </span>
                              </button>
                            </div>
                          );
                        })
                    : renderDrawerDocTree("", 0)}
                </div>
              )}
            </div>

            <div className="m-drawer-footer">
              {treeTab === "episode" ? (
                <button
                  type="button"
                  className="m-btn-primary m-tree-add-btn"
                  onClick={() => {
                    setLeftDrawerOpen(false);
                    attempt(() => createDoc("episode"))();
                  }}
                >
                  <Plus size={17} />
                  <span>새 에피소드</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="m-btn-primary m-tree-add-btn"
                  onClick={() => setCreateMenuFolder("")}
                >
                  <Plus size={17} />
                  <span>추가</span>
                </button>
              )}
            </div>
          </aside>
        </div>
      )}

      {/* 2. 오른쪽 슬라이드 드로어: 위젯 영역 (원고 통계 / 연결된 플롯·메모 / 문서 속성 / 조판 / 북마크) */}
      {rightDrawerOpen && (
        <div
          className="m-drawer-backdrop"
          onClick={() => setRightDrawerOpen(false)}
          role="presentation"
        >
          <aside
            className="m-slide-drawer right"
            role="dialog"
            aria-modal="true"
            aria-label="위젯 보드"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="m-drawer-header">
              <div className="m-drawer-title-group">
                <strong>위젯 보드</strong>
                <small>
                  공백 포함 {charsWithSpaces.toLocaleString()}자 · 공백 제외{" "}
                  {charsWithoutSpaces.toLocaleString()}자
                </small>
              </div>
              <button
                type="button"
                className="m-icon-btn"
                aria-label="위젯 보드 닫기"
                onClick={() => setRightDrawerOpen(false)}
              >
                <X size={19} />
              </button>
            </div>

            <div className="m-drawer-controls">
              <div className="m-pill-tabs three-cols" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={rightTab === "widgets"}
                  className={`m-pill-tab ${rightTab === "widgets" ? "selected" : ""}`}
                  onClick={() => setRightTab("widgets")}
                >
                  <SlidersHorizontal size={14} />
                  <span>위젯</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={rightTab === "typesetting"}
                  className={`m-pill-tab ${rightTab === "typesetting" ? "selected" : ""}`}
                  onClick={() => setRightTab("typesetting")}
                >
                  <Pilcrow size={14} />
                  <span>조판</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={rightTab === "bookmarks"}
                  className={`m-pill-tab ${rightTab === "bookmarks" ? "selected" : ""}`}
                  onClick={() => setRightTab("bookmarks")}
                >
                  <BookmarkIcon size={14} />
                  <span>북마크</span>
                </button>
              </div>
            </div>

            <div className="m-drawer-body m-widget-drawer-scroll">
              {rightTab === "widgets" && (
                <div className="m-widget-stack">
                  <PlatformCount
                    stats={stats}
                    rules={writingRules}
                    documentOnly={active.kind !== "episode"}
                    onChange={onUpdateProjectWriting}
                  />

                  <section className="widget session-widget">
                    <span>
                      {active.kind === "episode"
                        ? "이번 회차에서 새로 쓴 글"
                        : "이번 문서에서 새로 쓴 글"}
                    </span>
                    <strong>
                      +{sessionCount.toLocaleString()}
                      <small>자</small>
                    </strong>
                  </section>

                  {/* 연결된 문서 (플롯 / 메모 / 회차) 위젯 */}
                  {active.kind === "episode" ? (
                    <section className="widget episode-plots">
                      <div className="widget-title">
                        <span>이 회차의 플롯</span>
                        <span className="widget-title-tools">
                          <small>{linkedPlots.length}</small>
                          <button
                            type="button"
                            className="widget-quick-add"
                            aria-label="이 회차에 플롯 만들기"
                            onClick={() => {
                              setRightDrawerOpen(false);
                              attempt(() =>
                                createDoc("plot", { episodeId: active.id }),
                              )();
                            }}
                          >
                            <Plus size={14} />
                          </button>
                        </span>
                      </div>
                      {linkedPlots.map((d) => (
                        <button
                          key={d.id}
                          type="button"
                          className="memo-card"
                          onClick={() => {
                            setRightDrawerOpen(false);
                            attempt(() => openDoc(d.id, false))();
                          }}
                        >
                          <FileText size={15} />
                          <span>{d.title || "제목 없음"}</span>
                          <ChevronRight size={13} />
                        </button>
                      ))}
                      {!linkedPlots.length && (
                        <p className="widget-empty">연결된 플롯이 없습니다.</p>
                      )}

                      <div className="widget-title widget-subtitle">
                        <span>이 회차의 메모</span>
                        <span className="widget-title-tools">
                          <small>{linkedMemos.length}</small>
                          <button
                            type="button"
                            className="widget-quick-add"
                            aria-label="이 회차에 메모 만들기"
                            onClick={() => {
                              setRightDrawerOpen(false);
                              attempt(() =>
                                createDoc("memo", { episodeId: active.id }),
                              )();
                            }}
                          >
                            <Plus size={14} />
                          </button>
                        </span>
                      </div>
                      {linkedMemos.map((d) => (
                        <button
                          key={d.id}
                          type="button"
                          className="memo-card"
                          onClick={() => {
                            setRightDrawerOpen(false);
                            attempt(() => openDoc(d.id, false))();
                          }}
                        >
                          <StickyNote size={15} />
                          <span>{d.title || "제목 없음"}</span>
                          <ChevronRight size={13} />
                        </button>
                      ))}
                      {!linkedMemos.length && (
                        <p className="widget-empty">연결된 메모가 없습니다.</p>
                      )}
                    </section>
                  ) : (
                    <section className="widget episode-plots">
                      <div className="widget-title">
                        <span>연결된 회차</span>
                        <span className="widget-title-tools">
                          <button
                            type="button"
                            className="widget-quick-add"
                            title="회차에 연결"
                            onClick={() => {
                              setRightDrawerOpen(false);
                              attempt(() => openBinding(active.id))();
                            }}
                          >
                            <Link2 size={14} />
                          </button>
                        </span>
                      </div>
                      {boundEpisode ? (
                        <button
                          type="button"
                          className="memo-card"
                          onClick={() => {
                            setRightDrawerOpen(false);
                            attempt(() => openDoc(boundEpisode.id, false))();
                          }}
                        >
                          <BookOpen size={15} />
                          <span>{boundEpisode.title || "제목 없음"}</span>
                          <ChevronRight size={13} />
                        </button>
                      ) : (
                        <p className="widget-empty">연결된 회차가 없습니다.</p>
                      )}
                    </section>
                  )}
                </div>
              )}

              {rightTab === "typesetting" && (
                <div className="m-widget-stack">
                  <TypesettingSettings
                    prefs={prefs}
                    savePrefs={savePrefs}
                    saveKindPrefs={saveKindPrefs}
                    report={report}
                    message={message}
                    setTypesettingKind={setTypesettingKind}
                    targetKind={
                      active.kind === "episode" ? "episode" : "document"
                    }
                    inPanel={true}
                  />
                </div>
              )}

              {rightTab === "bookmarks" && setBookmarkJump && (
                <div className="m-widget-stack">
                  <BookmarkList
                    active={active}
                    setBookmarkJump={(jump) => {
                      setBookmarkJump(jump);
                      setRightDrawerOpen(false);
                    }}
                    edit={edit}
                  />
                </div>
              )}
            </div>
          </aside>
        </div>
      )}

      {/* 3. 상단 상태바 · 문서 속성 작은 플로팅 팝업 메뉴 */}
      {propPopup && (
        <div
          className="m-floating-popup-backdrop"
          onClick={() => setPropPopup(null)}
          role="presentation"
        >
          <div
            className="m-floating-anchor-popup"
            role="menu"
            aria-label="속성 선택 팝업"
            style={{
              top: `${Math.max(52, Math.min(propPopup.y, window.innerHeight - 280))}px`,
              left:
                propPopup.align === "center"
                  ? `${Math.max(12, Math.min(propPopup.x - 110, window.innerWidth - 232))}px`
                  : `${Math.max(12, Math.min(propPopup.x, window.innerWidth - 232))}px`,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {propPopup.items.map((item, idx) =>
              item === "separator" ? (
                <div
                  key={`sep:${idx}`}
                  className="m-floating-popup-divider"
                  role="separator"
                />
              ) : (
                <button
                  key={`${item.label}:${idx}`}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  className={`m-floating-popup-item ${item.danger ? "danger" : ""} ${item.checked ? "checked" : ""}`}
                  onClick={() => {
                    setPropPopup(null);
                    item.action();
                  }}
                >
                  {item.icon}
                  <span>{item.label}</span>
                  {item.badge && (
                    <small className="m-floating-popup-badge">
                      {item.badge}
                    </small>
                  )}
                  {item.checked && (
                    <Check size={15} className="m-floating-popup-check" />
                  )}
                </button>
              ),
            )}
          </div>
        </div>
      )}

      {/* 7. 왼쪽 파일트리 드로어 내 문서/폴더 생성 메뉴 */}
      <MobileActionSheet
        open={createMenuFolder !== null}
        title={
          createMenuFolder ? `${createMenuFolder}에 추가` : "문서 · 폴더 추가"
        }
        items={createMenuItems}
        onClose={() => setCreateMenuFolder(null)}
      />

      <MobilePromptSheet
        open={newFolderParent !== null}
        title="새 폴더 만들기"
        placeholder="폴더 이름 입력"
        initialValue=""
        confirmLabel="만들기"
        onConfirm={async (name: string) => {
          const parent = newFolderParent || "";
          setNewFolderParent(null);
          const nextPath = parent ? `${parent}/${name}` : name;
          await call("createMemoFolder", {
            projectId: active.projectId,
            path: nextPath,
          });
          await tree.loadMemoFolders();
          message("폴더를 만들었습니다.");
        }}
        onClose={() => setNewFolderParent(null)}
      />
    </div>
  );
}
