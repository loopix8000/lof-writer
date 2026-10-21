import {
  Archive,
  ArrowLeft,
  Bold,
  Bookmark as BookmarkIcon,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  CornerDownLeft,
  Download,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Heading2,
  History,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  Lock,
  MessageSquareCode,
  Minus,
  MoreVertical,
  PanelLeft,
  PanelRight,
  Pilcrow,
  Plus,
  Quote,
  Redo2,
  Search,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  StickyNote,
  Strikethrough,
  Table2,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  lineBreakDefault,
  normalizeStatus,
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
import MobilePreview from "../MobilePreview";
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
import {
  MobileActionSheet,
  MobilePromptSheet,
  type MobileActionItem,
} from "./MobileActionSheet";

const EXTRA_SYMBOLS: Array<{
  label: string;
  insert?: string;
  pair?: { open: string; close: string };
}> = [
  { label: "—", insert: "—" },
  { label: "「…」", pair: { open: "「", close: "」" } },
  { label: "『…』", pair: { open: "『", close: "』" } },
  { label: "〈…〉", pair: { open: "〈", close: "〉" } },
  { label: "《…》", pair: { open: "《", close: "》" } },
  { label: "!", insert: "!" },
  { label: "?", insert: "?" },
  { label: "?!", insert: "?!" },
];

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
  composition,
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
  goBackToProject,
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
  composition: (composing: boolean) => void;
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
  goBackToProject: () => Promise<void>;
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

  // 하단 플로팅 필 툴바 시트 상태
  const [plusSheetOpen, setPlusSheetOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [propMenuItems, setPropMenuItems] = useState<MobileActionItem[] | null>(
    null,
  );
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
  const norm = normalizeEditorStyle(prefs, active.kind);
  const status = normalizeStatus(active.status);
  const num = numberOf(active);

  // 안드로이드 뒤로가기 시 열려 있는 드로어나 시트를 먼저 닫음
  useEffect(() => {
    (window as any).__lofEditorSubBack = () => {
      if (propMenuItems) {
        setPropMenuItems(null);
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
      if (plusSheetOpen) {
        setPlusSheetOpen(false);
        return true;
      }
      if (moreMenuOpen) {
        setMoreMenuOpen(false);
        return true;
      }
      if (previewOpen) {
        setPreviewOpen(false);
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
    propMenuItems,
    newFolderParent,
    createMenuFolder,
    plusSheetOpen,
    moreMenuOpen,
    previewOpen,
    leftDrawerOpen,
    rightDrawerOpen,
  ]);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    const target = e.target as HTMLElement | null;
    // 가로 스크롤 요소나 슬라이더(input[type=range]) 터치 시에는 제스처 제외
    const ignore = Boolean(
      target?.closest(
        'input[type="range"], .tableWrapper, .m-doc-scope-bar, .m-pill-tabs',
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

  const allFolders = useMemo(() => {
    const set = new Set<string>(
      tree.memoEntries
        .filter((e) => e.type === "folder" && !e.archived)
        .map((e) => e.path),
    );
    for (const d of docItems) {
      const f = parentOfRel(d.relPath || "");
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

  const moreMenuItems: MobileActionItem[] = [
    {
      label: "실행 취소 (Undo)",
      icon: <Undo2 size={18} />,
      disabled: isProtected,
      action: () =>
        window.dispatchEvent(
          new CustomEvent("lof:editor-action", { detail: "undo" }),
        ),
    },
    {
      label: "다시 실행 (Redo)",
      icon: <Redo2 size={18} />,
      disabled: isProtected,
      action: () =>
        window.dispatchEvent(
          new CustomEvent("lof:editor-action", { detail: "redo" }),
        ),
    },
    {
      label: "지금 저장하기",
      sublabel: `현재 상태: ${saveStatus}`,
      icon: <Check size={18} />,
      action: attempt(async () => {
        await manualSave();
        message("저장했습니다.");
      }),
    },
    "separator",
    {
      label: "파일 트리 열기",
      sublabel: "왼쪽에서 오른쪽으로 밀어서 열 수도 있습니다",
      icon: <PanelLeft size={18} />,
      action: () => {
        setTreeTab(active.kind === "episode" ? "episode" : "document");
        setLeftDrawerOpen(true);
      },
    },
    {
      label: "위젯 보드 열기",
      sublabel: "오른쪽에서 왼쪽으로 밀어서 열 수도 있습니다",
      icon: <PanelRight size={18} />,
      action: () => {
        setRightTab("widgets");
        setRightDrawerOpen(true);
      },
    },
    {
      label: "조판 설정 (글꼴·크기·줄간격)",
      icon: <Pilcrow size={18} />,
      action: () => {
        setRightTab("typesetting");
        setRightDrawerOpen(true);
      },
    },
    {
      label: "모바일 독자 미리보기",
      icon: <Smartphone size={18} />,
      checked: previewOpen,
      action: () => setPreviewOpen(true),
    },
    {
      label: "기호 일괄 교정",
      sublabel: "직선 따옴표와 마침표 말줄임표를 자동 변환",
      icon: <Sparkles size={18} />,
      disabled: isProtected,
      action: replaceActiveSymbols,
    },
    {
      label: source ? "일반 편집 모드로 전환" : "Markdown 원문 편집 모드",
      icon: <Code2 size={18} />,
      checked: source,
      action: () => setSource((s) => !s),
    },
    {
      label: "변경 이력 및 복원",
      icon: <History size={18} />,
      action: attempt(showHistory),
    },
    "separator",
    {
      label:
        source || requiresSource(active.body)
          ? "Markdown 원문 복사"
          : "본문 텍스트 복사",
      icon: <Copy size={18} />,
      action: attempt(() =>
        copyDocManuscript(active, source || requiresSource(active.body)),
      ),
    },
    {
      label: "사본 복제",
      icon: <FilePlus size={18} />,
      action: attempt(() => duplicateDoc(active)),
    },
    {
      label: "Markdown 파일 내보내기",
      icon: <Download size={18} />,
      action: attempt(async () => {
        await flush();
        if (await call("exportDocument", { id: active.id })) {
          message("원고를 내보냈습니다.");
        }
      }),
    },
    "separator",
    {
      label: active.archived ? "보관함에서 꺼내기" : "보관함으로 이동",
      icon: <Archive size={18} />,
      action: attempt(() => archiveDoc(active)),
    },
    {
      label: "영구 삭제",
      icon: <Trash2 size={18} />,
      danger: true,
      action: () => setDialog({ type: "deleteDoc", value: active.id }),
    },
  ];

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

    const childDocs = docItems.filter(
      (d) => parentOfRel(d.relPath || "") === parentPath,
    );

    return (
      <>
        {childFolders.map((folderPath) => {
          const name = folderPath.split("/").pop() || folderPath;
          const isCollapsed = Boolean(collapsedPaths[folderPath]);
          const countInFolder = docItems.filter((d) => {
            const f = parentOfRel(d.relPath || "");
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
            aria-label="문서 목록으로 돌아가기"
            title="문서 목록"
            onClick={attempt(goBackToProject)}
          >
            <ArrowLeft size={19} />
          </button>
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

        <button
          type="button"
          className="m-editor-doc-Switch"
          onClick={() => {
            setTreeTab(active.kind === "episode" ? "episode" : "document");
            setLeftDrawerOpen(true);
          }}
        >
          <span
            className={`m-save-dot ${saveStatus === "저장됨" ? "saved" : "pending"}`}
            title={saveStatus}
          />
          <span className="m-editor-doc-title">
            {active.title || "제목 없음"}
          </span>
          <ChevronDown size={14} />
        </button>

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
            <PanelRight size={19} />
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

      {/* 원고 보호 상태 안내 바 */}
      {isProtected && (
        <div className="m-protected-banner">
          <span>
            <Lock size={14} /> 집필 완료 (원고 보호 모드)
          </span>
          <button
            type="button"
            onClick={attempt(() => patchDoc(active.id, { status: "revision" }))}
          >
            퇴고 중으로 잠금 해제
          </button>
        </div>
      )}

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
            <SyncStatus
              status={autoSync}
              checking={syncChecking}
              available={syncAvailable}
              editing={saveStatus !== "저장됨"}
            />
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
            onComposition={(value) => composition(value)}
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

      {/* 2026 플로팅 필(Pill) 스타일 하단 툴바: [ ↶   ↷   …   ‘…’   “…”   +  |  ⋮ ] */}
      <div className="m-floating-pill-wrap">
        <div
          className="m-floating-pill-bar"
          role="toolbar"
          aria-label="모바일 집필 툴바"
        >
          <div className="m-pill-center-tools">
            <button
              type="button"
              className="m-pill-tool-btn"
              aria-label="실행 취소"
              disabled={isProtected}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("lof:editor-action", { detail: "undo" }),
                )
              }
            >
              <Undo2 size={18} strokeWidth={2} />
            </button>

            <button
              type="button"
              className="m-pill-tool-btn"
              aria-label="다시 실행"
              disabled={isProtected}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("lof:editor-action", { detail: "redo" }),
                )
              }
            >
              <Redo2 size={18} strokeWidth={2} />
            </button>

            <button
              type="button"
              className="m-pill-tool-btn"
              aria-label="말줄임표 입력"
              disabled={isProtected}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("lof:insert-text", { detail: "…" }),
                )
              }
            >
              …
            </button>

            <button
              type="button"
              className="m-pill-tool-btn"
              aria-label="작은따옴표 쌍 입력"
              disabled={isProtected}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("lof:insert-pair", {
                    detail: { open: "‘", close: "’" },
                  }),
                )
              }
            >
              ‘…’
            </button>

            <button
              type="button"
              className="m-pill-tool-btn"
              aria-label="큰따옴표 쌍 입력"
              disabled={isProtected}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("lof:insert-pair", {
                    detail: { open: "“", close: "”" },
                  }),
                )
              }
            >
              “…”
            </button>

            <button
              type="button"
              className={`m-pill-tool-btn ${plusSheetOpen ? "active" : ""}`}
              aria-label="추가 기호 및 문단 서식"
              disabled={isProtected}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setPlusSheetOpen((v) => !v)}
            >
              <Plus size={20} strokeWidth={2} />
            </button>
          </div>

          <span className="m-pill-divider" aria-hidden="true" />

          <button
            type="button"
            className="m-pill-more-btn"
            aria-label="원고 더보기 메뉴"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setMoreMenuOpen(true)}
          >
            <MoreVertical size={19} strokeWidth={2} />
          </button>
        </div>
      </div>

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
                <strong>{project?.title || "파일 트리"}</strong>
                <small>
                  에피소드 {episodes.length} · 문서 {docItems.length}
                </small>
              </div>
              <div className="m-drawer-header-actions">
                <button
                  type="button"
                  className="m-scope-chip"
                  onClick={() => {
                    setLeftDrawerOpen(false);
                    attempt(goBackToProject)();
                  }}
                >
                  <span>전체 화면</span>
                </button>
                <button
                  type="button"
                  className="m-icon-btn"
                  aria-label="파일 트리 닫기"
                  onClick={() => setLeftDrawerOpen(false)}
                >
                  <X size={19} />
                </button>
              </div>
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

                {treeTab === "episode" ? (
                  <button
                    type="button"
                    className="m-btn-primary m-btn-sm"
                    onClick={() => {
                      setLeftDrawerOpen(false);
                      attempt(() => createDoc("episode"))();
                    }}
                  >
                    <Plus size={14} />
                    <span>새 회차</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="m-btn-primary m-btn-sm"
                    onClick={() => setCreateMenuFolder("")}
                  >
                    <Plus size={14} />
                    <span>추가</span>
                  </button>
                )}
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
                            onClick={() => {
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

                  {/* 문서 속성 및 태그 위젯 */}
                  <section className="widget m-props-widget">
                    <div className="widget-title">
                      <span>속성 · 태그</span>
                    </div>
                    <EpisodeProperties
                      propertyPresets={prefs.propertyPresets}
                      onSavePresets={(propertyPresets) =>
                        savePrefs({ propertyPresets })
                      }
                      favoriteTags={prefs.favoriteTags}
                      key={active.id}
                      doc={active}
                      open={true}
                      onToggle={() => {}}
                      onEdit={(patch) => edit(patch)}
                      onMenu={(_rect, items) => {
                        setPropMenuItems(
                          items.map((item: any): MobileActionItem =>
                            item === "separator"
                              ? "separator"
                              : {
                                  label: item.label,
                                  icon: item.icon,
                                  checked: item.checked,
                                  danger: item.danger,
                                  disabled: item.disabled,
                                  action: item.action || (() => {}),
                                },
                          ),
                        );
                      }}
                      onNotice={message}
                      boundEpisode={boundEpisode}
                      onBind={attempt(() => openBinding(active.id))}
                      onUnbind={attempt(() => bindDocument(active.id, null))}
                      onOpenBound={
                        active.episodeId
                          ? attempt(async () => {
                              setRightDrawerOpen(false);
                              await openDoc(active.episodeId!);
                            })
                          : undefined
                      }
                    />
                  </section>
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

      {/* 3. 하단 플로팅 바의 [+] 기호·서식 삽입 시트 */}
      {plusSheetOpen && (
        <div
          className="m-sheet-backdrop"
          onClick={() => setPlusSheetOpen(false)}
          role="presentation"
        >
          <div
            className="m-action-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="기호 및 서식 삽입"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="m-sheet-handle" />
            <div className="m-sheet-header">
              <div className="m-sheet-title-group">
                <h3>기호 및 문단 서식</h3>
              </div>
              <button
                type="button"
                className="m-icon-btn"
                onClick={() => setPlusSheetOpen(false)}
              >
                <X size={19} />
              </button>
            </div>
            <div className="m-sheet-scroll-content m-plus-sheet-body">
              <div className="m-plus-group-label">문장 부호 · 괄호</div>
              <div className="m-plus-symbol-grid">
                {EXTRA_SYMBOLS.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    className="m-plus-sym-btn"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setPlusSheetOpen(false);
                      if (item.pair) {
                        window.dispatchEvent(
                          new CustomEvent("lof:insert-pair", {
                            detail: item.pair,
                          }),
                        );
                      } else if (item.insert) {
                        window.dispatchEvent(
                          new CustomEvent("lof:insert-text", {
                            detail: item.insert,
                          }),
                        );
                      }
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <div className="m-plus-group-label">문단 · 서식 도구</div>
              <div className="m-plus-format-grid">
                <button
                  type="button"
                  className="m-plus-format-btn"
                  onClick={() => {
                    setPlusSheetOpen(false);
                    window.dispatchEvent(
                      new CustomEvent("lof:editor-action", {
                        detail: "divider",
                      }),
                    );
                  }}
                >
                  <Minus size={17} />
                  <span>장면 구분선</span>
                </button>
                <button
                  type="button"
                  className="m-plus-format-btn"
                  onClick={() => {
                    setPlusSheetOpen(false);
                    window.dispatchEvent(
                      new CustomEvent("lof:editor-action", {
                        detail: "heading",
                      }),
                    );
                  }}
                >
                  <Heading2 size={17} />
                  <span>소제목</span>
                </button>
                <button
                  type="button"
                  className="m-plus-format-btn"
                  onClick={() => {
                    setPlusSheetOpen(false);
                    window.dispatchEvent(
                      new CustomEvent("lof:editor-action", { detail: "bold" }),
                    );
                  }}
                >
                  <Bold size={17} />
                  <span>굵게</span>
                </button>
                <button
                  type="button"
                  className="m-plus-format-btn"
                  onClick={() => {
                    setPlusSheetOpen(false);
                    window.dispatchEvent(
                      new CustomEvent("lof:editor-action", {
                        detail: "italic",
                      }),
                    );
                  }}
                >
                  <Italic size={17} />
                  <span>기울임</span>
                </button>
                <button
                  type="button"
                  className="m-plus-format-btn"
                  onClick={() => {
                    setPlusSheetOpen(false);
                    window.dispatchEvent(
                      new CustomEvent("lof:editor-action", {
                        detail: "strike",
                      }),
                    );
                  }}
                >
                  <Strikethrough size={17} />
                  <span>취소선</span>
                </button>
                <button
                  type="button"
                  className="m-plus-format-btn"
                  onClick={() => {
                    setPlusSheetOpen(false);
                    window.dispatchEvent(
                      new CustomEvent("lof:editor-action", { detail: "quote" }),
                    );
                  }}
                >
                  <Quote size={17} />
                  <span>인용구</span>
                </button>
                <button
                  type="button"
                  className="m-plus-format-btn"
                  onClick={() => {
                    setPlusSheetOpen(false);
                    window.dispatchEvent(
                      new CustomEvent("lof:editor-action", {
                        detail: "bulletList",
                      }),
                    );
                  }}
                >
                  <List size={17} />
                  <span>글머리 목록</span>
                </button>
                <button
                  type="button"
                  className="m-plus-format-btn"
                  onClick={() => {
                    setPlusSheetOpen(false);
                    window.dispatchEvent(
                      new CustomEvent("lof:editor-action", {
                        detail: "orderedList",
                      }),
                    );
                  }}
                >
                  <ListOrdered size={17} />
                  <span>번호 목록</span>
                </button>
                <button
                  type="button"
                  className="m-plus-format-btn"
                  onClick={() => {
                    setPlusSheetOpen(false);
                    window.dispatchEvent(
                      new CustomEvent("lof:editor-action", {
                        detail: "comment",
                      }),
                    );
                  }}
                >
                  <MessageSquareCode size={17} />
                  <span>주석</span>
                </button>
                {(active.kind === "memo" || active.kind === "plot") && (
                  <button
                    type="button"
                    className="m-plus-format-btn"
                    onClick={() => {
                      setPlusSheetOpen(false);
                      window.dispatchEvent(
                        new CustomEvent("lof:editor-action", {
                          detail: "table",
                        }),
                      );
                    }}
                  >
                    <Table2 size={17} />
                    <span>표 삽입</span>
                  </button>
                )}
                <button
                  type="button"
                  className="m-plus-format-btn"
                  onClick={() => {
                    setPlusSheetOpen(false);
                    window.dispatchEvent(
                      new CustomEvent("lof:editor-action", { detail: "image" }),
                    );
                  }}
                >
                  <ImagePlus size={17} />
                  <span>이미지 삽입</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 4. 모바일 독자 미리보기 전체 화면 모달 */}
      {previewOpen && (
        <div className="m-fullscreen-overlay">
          <MobilePreview
            title={active.title}
            label={`${labels[active.kind]} · ${num}`}
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
        </div>
      )}

      {/* 5. 더보기 메뉴 액션 시트 */}
      <MobileActionSheet
        open={moreMenuOpen}
        title={active.title || "원고 메뉴"}
        subtitle={`${labels[active.kind]} · ${num} (${saveStatus})`}
        items={moreMenuItems}
        onClose={() => setMoreMenuOpen(false)}
      />

      {/* 6. 속성 선택 액션 시트 */}
      <MobileActionSheet
        open={Boolean(propMenuItems)}
        title="속성 선택"
        items={propMenuItems || []}
        onClose={() => setPropMenuItems(null)}
      />

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
