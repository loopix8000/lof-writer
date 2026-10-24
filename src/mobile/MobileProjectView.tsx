import RecoveryCopies from "../RecoveryCopies";
import {
  Archive,
  ArrowDown,
  ArrowDown01,
  ArrowDown10,
  ArrowDownToLine,
  ArrowLeft,
  ArrowUp,
  ArrowUpToLine,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Edit3,
  Feather,
  FilePlus,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Link2,
  Link2Off,
  MoreVertical,
  Pencil,
  Plus,
  Search,
  Settings,
  SquarePen,
  StickyNote,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { STATUS_SHORT, normalizeStatus } from "../../core/episode.mjs";
import { normalizeWriting } from "../../core/platforms.mjs";
import CoverImage from "../CoverImage";
import { labels } from "../app/document-ui";
import { EPISODE_GROUP, parentOfRel, type FolderEntry } from "../app/file-tree-model";
import { patchDocuments, reorderDocuments, type LibraryChange } from "../app/library-changes";
import { type Dialog } from "../app/model";
import type { FileTreeController } from "../app/useFileTree";
import { call, type Doc, type Kind, type Library, type Project } from "../types";
import {
  MobileActionSheet,
  MobileFolderPickerSheet,
  MobilePromptSheet,
  type MobileActionItem,
} from "./MobileActionSheet";
import { compareNames, useDocumentSort, useEpisodeSort } from "./useEpisodeSort";
import { useEpisodeGroups } from "./useEpisodeGroups";
import { useOverlayScrollbar } from "./useOverlayScrollbar";
import MobilePillTabs from "./MobilePillTabs";

// 작품 정보 접힘·펼침 전환 시간. mobile.css의 가장 긴 전환(--hero-duration)보다 조금 길게 둔다.
const HERO_ANIM_MS = 340;

export default function MobileProjectView({
  lib,
  project,
  docs,
  tab,
  setTab,
  archive,
  setArchive,
  prefs,
  tree,
  attempt,
  openDoc,
  createDoc,
  patchDoc,
  archiveDoc,
  duplicateDoc,
  copyDocManuscript,
  openBinding,
  bindDocument,
  goLibrary,
  onSelectProject,
  onOpenLastDoc,
  askDeleteProject,
  setDialog,
  refresh,
  changeLibrary,
  showCreatedDocument,
  message,
  onViewImage,
  numberOf,
}: {
  lib: Library;
  project: Project;
  docs: Doc[];
  tab: Kind;
  setTab: React.Dispatch<React.SetStateAction<Kind>>;
  archive: boolean;
  setArchive: React.Dispatch<React.SetStateAction<boolean>>;
  prefs: Record<string, any>;
  tree: FileTreeController;
  attempt: (fn: () => Promise<any>) => () => Promise<any>;
  openDoc: (id: string, pinned?: boolean) => Promise<void>;
  createDoc: (kind: Kind, opts?: { title?: string; episodeId?: string }) => Promise<void>;
  patchDoc: (id: string, patch: Partial<Doc>) => Promise<void>;
  archiveDoc: (doc: Doc) => Promise<void>;
  duplicateDoc: (doc: Doc) => Promise<void>;
  copyDocManuscript: (doc: Doc, rawMarkdown?: boolean) => Promise<void>;
  openBinding: (id: string) => Promise<void>;
  bindDocument: (id: string, episodeId: string | null) => Promise<void>;
  goLibrary: () => Promise<void>;
  onSelectProject: (id: string) => Promise<void>;
  onOpenLastDoc: (id: string) => Promise<void>;
  askDeleteProject: (id: string) => void;
  setDialog: React.Dispatch<React.SetStateAction<Dialog | null>>;
  refresh: () => Promise<Library | undefined>;
  changeLibrary: <T>(change: LibraryChange, run: () => Promise<T>) => Promise<T>;
  showCreatedDocument: (doc: Doc) => void;
  message: (text: string) => void;
  onViewImage: (src: string, alt: string) => void;
  numberOf: (d: Doc) => any;
}) {
  // 작품 화면은 에피소드 / 플롯 / 메모 3탭으로 구분
  const activeTab: Kind = tab === "plot" ? "plot" : tab === "memo" ? "memo" : "episode";
  const [filterQuery, setFilterQuery] = useState("");
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [docScope, setDocScope] = useState<"all" | "byEpisode">("all");
  const [closedFolders, setClosedFolders] = useState<Set<string>>(() => new Set());
  const { sort: episodeSort, toggleSort: toggleEpisodeSort } = useEpisodeSort();
  const { sort: documentSort, toggleSort: toggleDocumentSort } = useDocumentSort();
  // 내림차순이면 최신 회차 묶음을 먼저 펼친다.
  const lastEpGroupStart = (count: number) =>
    Math.max(0, Math.ceil(count / EPISODE_GROUP) - 1) * EPISODE_GROUP;
  const { isGroupOpen, toggleGroup: toggleEpGroup } = useEpisodeGroups(
    lib.root,
    project.id,
    episodeSort === "desc" ? lastEpGroupStart(docs.filter((d) => d.kind === "episode").length) : 0,
    archive,
  );
  const [activeDocSheet, setActiveDocSheet] = useState<Doc | null>(null);
  const [activeFolderSheet, setActiveFolderSheet] = useState<FolderEntry | null>(null);
  const [addMenuFolder, setAddMenuFolder] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<{
    type: "doc" | "folder" | "newFolder" | "newDoc";
    idOrPath: string;
    initialValue: string;
    kind?: Kind;
    folder?: string;
    episodeId?: string;
  } | null>(null);
  const [moveFolderDoc, setMoveFolderDoc] = useState<Doc | null>(null);
  const [heroCollapsed, setHeroCollapsed] = useState(false);
  const [heroAnimating, setHeroAnimating] = useState(false);
  const collapsedRef = useRef(false);
  const screenRef = useRef<HTMLDivElement>(null);
  const listScrollRef = useRef<HTMLDivElement>(null);
  const listBodyRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const heroHeight = useRef(0);
  const toolsHeight = useRef(0);
  const lastTop = useRef(0);
  const intent = useRef({ down: 0, up: 0 });
  const toggleLockUntil = useRef(0);
  const animTimer = useRef<number | undefined>(undefined);
  const touchY = useRef<number | null>(null);
  const headTouch = useRef<{ x: number; y: number } | null>(null);
  const listThumbRef = useOverlayScrollbar(
    listScrollRef,
    [activeTab, archive, project.id, docs, filterQuery, docScope],
    { startRef: headRef, bodyRef: listBodyRef, reservedTop: () => toolsHeight.current },
  );

  // 작품 정보와 탭·검색줄은 목록 위에 떠 있는 레이어다. 목록은 탭·검색줄 높이만큼만 위를 비워 두고,
  // 펼쳐져 있을 때는 목록 본문을 작품 정보 높이만큼 아래로 밀어 두었다가 접힐 때 레이어와 함께 끌어올린다.
  useLayoutEffect(() => {
    const screen = screenRef.current, head = headRef.current, hero = heroRef.current;
    if (!screen || !head || !hero) return;
    const measure = () => {
      const heroH = hero.offsetHeight;
      const toolsH = Math.max(0, head.offsetHeight - heroH);
      heroHeight.current = heroH;
      toolsHeight.current = toolsH;
      screen.style.setProperty("--project-tools-height", `${toolsH}px`);
      screen.style.setProperty("--project-hero-height", `${heroH}px`);
    };
    const resize = new ResizeObserver(measure);
    resize.observe(head);
    resize.observe(hero);
    measure();
    return () => resize.disconnect();
  }, []);

  const setCollapsed = (next: boolean) => {
    if (collapsedRef.current === next) return;
    collapsedRef.current = next;
    intent.current = { down: 0, up: 0 };
    // 애니메이션 동안에는 상태만 다시 바꾸지 않는다. 목록 스크롤은 그대로 이어진다.
    toggleLockUntil.current = Date.now() + HERO_ANIM_MS;
    setHeroAnimating(true);
    window.clearTimeout(animTimer.current);
    animTimer.current = window.setTimeout(() => {
      setHeroAnimating(false);
    }, HERO_ANIM_MS);
    setHeroCollapsed(next);
  };

  const collapseHero = (el: HTMLDivElement | null) => {
    if (!el || el.scrollHeight <= el.clientHeight + 2) return;
    setCollapsed(true);
  };

  // 작품·보관함을 바꾸면 작품 정보를 펼친 상태로 초기화한다.
  useLayoutEffect(() => {
    window.clearTimeout(animTimer.current);
    setHeroAnimating(false);
    collapsedRef.current = false;
    setHeroCollapsed(false);
  }, [archive, project.id]);

  // 탭 전환은 목록 위치만 초기화하고 작품 정보의 접힘 상태는 유지한다.
  useLayoutEffect(() => {
    const list = listScrollRef.current;
    if (list) list.scrollTop = 0;
    lastTop.current = 0;
    intent.current = { down: 0, up: 0 };
    touchY.current = null;
    headTouch.current = null;
    toggleLockUntil.current = Date.now() + HERO_ANIM_MS;
  }, [activeTab, archive, project.id]);

  useEffect(() => () => window.clearTimeout(animTimer.current), []);

  useEffect(() => {
    setClosedFolders(new Set());
  }, [project.id]);

  // 아래로 내리면 접고, 맨 위 근처로 올라오면 펼친다. 목록 중간에서 위로 올릴 때는 펼치지 않는다.
  const onListScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const top = Math.max(0, el.scrollTop);
    const delta = top - lastTop.current;
    lastTop.current = top;
    if (!delta) return;
    if (Date.now() < toggleLockUntil.current) {
      intent.current = { down: 0, up: 0 };
      return;
    }
    const hint = intent.current;
    if (delta > 0) {
      hint.down += delta;
      hint.up = 0;
    } else {
      hint.up -= delta;
      hint.down = 0;
    }
    if (!collapsedRef.current) {
      if (hint.down >= 14 && top > 6) collapseHero(el);
    } else if (delta < 0 && (top <= 2 || (hint.up >= 10 && top <= 24))) {
      setCollapsed(false);
    }
  };

  // 맨 위에서 더 당기면 목록은 그대로 두고 작품 정보만 펼친다.
  const onListTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    touchY.current = e.touches.length === 1 ? e.touches[0].clientY : null;
  };
  const onListTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (touchY.current === null || e.touches.length !== 1) return;
    const pulled = e.touches[0].clientY - touchY.current;
    if (collapsedRef.current && e.currentTarget.scrollTop <= 0 && pulled > 12) {
      touchY.current = null;
      setCollapsed(false);
    }
  };

  // 작품 정보·탭 영역 위에서 쓸어올리거나 맨 위에서 끌어내릴 때도 접고 펼친다.
  const onHeadTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    headTouch.current =
      e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  };
  const onHeadTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!headTouch.current || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - headTouch.current.x;
    const dy = e.touches[0].clientY - headTouch.current.y;
    if (Math.abs(dy) <= Math.abs(dx)) return;
    if (!collapsedRef.current && dy < -14) {
      headTouch.current = null;
      collapseHero(listScrollRef.current);
    } else if (collapsedRef.current && (listScrollRef.current?.scrollTop ?? 0) <= 16 && dy > 14) {
      headTouch.current = null;
      setCollapsed(false);
    }
  };

  const episodes = useMemo(
    () => docs.filter((d) => d.kind === "episode"),
    [docs],
  );

  const plots = useMemo(
    () => docs.filter((d) => d.kind === "plot"),
    [docs],
  );

  const memos = useMemo(
    () => docs.filter((d) => d.kind === "memo"),
    [docs],
  );

  const currentKindDocs = useMemo(
    () => (activeTab === "plot" ? plots : memos),
    [activeTab, plots, memos],
  );
  const showDocScope = activeTab !== "episode" && currentKindDocs.some(doc => !!doc.episodeId);

  const projectEpisodes = useMemo(
    () => lib.documents.filter((d) => d.projectId === project.id && d.kind === "episode"),
    [lib.documents, project.id],
  );

  const filteredEpisodes = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    if (!q) return episodes;
    return episodes.filter((d) => {
      const num = String(numberOf(d) || "").toLowerCase();
      const title = (d.title || "").toLowerCase();
      const tags = (d.tags || []).join(" ").toLowerCase();
      return num.includes(q) || title.includes(q) || tags.includes(q);
    });
  }, [episodes, filterQuery, numberOf]);

  const sortedEpisodes = useMemo(
    () => (episodeSort === "desc" ? [...filteredEpisodes].reverse() : filteredEpisodes),
    [filteredEpisodes, episodeSort],
  );

  const filteredKindDocs = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    return currentKindDocs.filter((d) => {
      if (!q) return true;
      const title = (d.title || "").toLowerCase();
      const rel = (d.relPath || "").toLowerCase();
      const tags = (d.tags || []).join(" ").toLowerCase();
      return title.includes(q) || rel.includes(q) || tags.includes(q);
    }).sort((a, b) => compareNames(a.title || "제목 없음", b.title || "제목 없음", documentSort));
  }, [currentKindDocs, filterQuery, documentSort]);

  const unlinkedKindDocs = useMemo(() => {
    const episodeIds = new Set(projectEpisodes.map((ep) => ep.id));
    return filteredKindDocs.filter((d) => !d.episodeId || !episodeIds.has(d.episodeId));
  }, [filteredKindDocs, projectEpisodes]);

  const allFolderEntries = useMemo(
    () =>
      tree.memoEntries
        .filter((e) => e.type === "folder")
        .sort((a, b) => compareNames(a.name, b.name, documentSort)),
    [tree.memoEntries, documentSort],
  );

  const allFolderPaths = useMemo(
    () => allFolderEntries.filter((e) => !!e.archived === archive).map((e) => e.path),
    [allFolderEntries, archive],
  );

  const visibleFolderEntries = useMemo(
    () => allFolderEntries.filter((folder) =>
      currentKindDocs.some((doc) => doc.relPath?.startsWith(`doc/${folder.path}/`)),
    ),
    [allFolderEntries, currentKindDocs],
  );

  const toggleFolder = (path: string) => {
    setClosedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const expandFolder = (path: string) => {
    setClosedFolders((prev) => {
      const next = new Set(prev);
      for (let folder = path; folder; folder = parentOfRel(folder)) {
        next.delete(folder);
      }
      return next;
    });
  };

  const moveEpisodeOrder = async (doc: Doc, mode: "up" | "down" | "top" | "bottom") => {
    const activeEps = lib.documents.filter(
      (d) => d.projectId === project.id && d.kind === "episode" && !d.archived,
    );
    const idx = activeEps.findIndex((d) => d.id === doc.id);
    if (idx < 0) return;
    const targetIdx =
      mode === "up"
        ? idx - 1
        : mode === "down"
          ? idx + 1
          : mode === "top"
            ? 0
            : activeEps.length - 1;
    if (targetIdx < 0 || targetIdx >= activeEps.length || targetIdx === idx) return;
    const next = [...activeEps];
    const [item] = next.splice(idx, 1);
    next.splice(targetIdx, 0, item);
    const ids = next.map((d) => d.id);
    const saving = changeLibrary(reorderDocuments(ids), () =>
      call("reorderDocuments", { projectId: project.id, ids }),
    );
    message("회차 순서를 변경했습니다.");
    await saving;
  };

  const moveDocumentToFolder = async (doc: Doc, targetFolder: string) => {
    const rel = doc.relPath?.startsWith("doc/") ? doc.relPath.slice(4) : "";
    if (!rel || parentOfRel(rel) === targetFolder) return;
    const name = rel.slice(rel.lastIndexOf("/") + 1);
    if (targetFolder) {
      expandFolder(targetFolder);
    }
    // 새 폴더 자리에 먼저 보여 주고, 파일 이동으로 바뀐 문서 ID는 다시 읽은 서재에서 받는다.
    const moving = changeLibrary(
      patchDocuments([doc.id], { relPath: `doc/${targetFolder ? `${targetFolder}/` : ""}${name}` }),
      () => call("memoMove", { space: project.id, path: rel, to: targetFolder }),
    );
    message(targetFolder ? `'${targetFolder}' 폴더로 이동했습니다.` : "최상위 위치로 이동했습니다.");
    await moving;
    await tree.loadMemoFolders();
  };

  const createNewDocWithTitle = async (
    kind: Kind,
    title: string,
    folder?: string,
    episodeId?: string,
  ) => {
    const doc = await call<Doc>("createDocument", {
      projectId: project.id,
      kind,
      folder: folder || undefined,
      title,
      episodeId,
      ...(kind !== "episode" ? { manualLineBreak: false } : {}),
    });
    if (folder) {
      expandFolder(folder);
    }
    showCreatedDocument(doc);
    void tree.loadMemoFolders().catch(() => {});
    await openDoc(doc.id, true);
  };

  const createNewFolderWithName = async (parent: string, name: string) => {
    const r = await call<{ path: string }>("memoCreateFolder", {
      space: project.id,
      parent,
      name,
    });
    if (r?.path) expandFolder(r.path);
    message(`'${name}' 폴더를 만들었습니다.`);
    await tree.loadMemoFolders();
  };

  const getDocActionItems = (d: Doc): MobileActionItem[] => {
    const isEp = d.kind === "episode";
    const status = normalizeStatus(d.status);
    const epIdx = isEp ? episodes.findIndex((x) => x.id === d.id) : -1;
    const boundEp = d.episodeId
      ? lib.documents.find((x) => x.id === d.episodeId && x.kind === "episode")
      : undefined;

    return [
      {
        label: "집필 에디터로 열기",
        icon: <BookOpen size={18} />,
        action: attempt(() => openDoc(d.id, true)),
      },
      {
        label: "제목 바꾸기",
        icon: <Edit3 size={18} />,
        action: () =>
          setRenameTarget({
            type: "doc",
            idOrPath: d.id,
            initialValue: d.title || "",
          }),
      },
      ...(isEp
        ? ([
            "separator",
            {
              label: "상태: 집필 중",
              icon: <SquarePen size={18} />,
              checked: status === "in_progress",
              action: attempt(() => patchDoc(d.id, { status: "in_progress" })),
            },
            {
              label: "상태: 퇴고 중",
              icon: <Pencil size={18} />,
              checked: status === "revision",
              action: attempt(() => patchDoc(d.id, { status: "revision" })),
            },
            {
              label: "상태: 집필 완료 (원고 보호)",
              sublabel: "실수로 본문이 수정되지 않도록 잠급니다",
              icon: <CheckCircle2 size={18} />,
              checked: status === "completed",
              action: attempt(async () => {
                const saving = patchDoc(d.id, { status: "completed" });
                message("원고 보호 모드로 전환되었습니다.");
                await saving;
              }),
            },
            ...(!d.archived && episodes.length > 1
              ? ([
                  "separator",
                  {
                    label: "위로 한 칸 이동",
                    icon: <ArrowUp size={18} />,
                    disabled: epIdx <= 0,
                    action: attempt(() => moveEpisodeOrder(d, "up")),
                  },
                  {
                    label: "아래로 한 칸 이동",
                    icon: <ArrowDown size={18} />,
                    disabled: epIdx >= episodes.length - 1,
                    action: attempt(() => moveEpisodeOrder(d, "down")),
                  },
                  {
                    label: "맨 위로 이동",
                    icon: <ArrowUpToLine size={18} />,
                    disabled: epIdx <= 0,
                    action: attempt(() => moveEpisodeOrder(d, "top")),
                  },
                  {
                    label: "맨 아래로 이동",
                    icon: <ArrowDownToLine size={18} />,
                    disabled: epIdx >= episodes.length - 1,
                    action: attempt(() => moveEpisodeOrder(d, "bottom")),
                  },
                ] as MobileActionItem[])
              : []),
            "separator",
            {
              label: "이 회차에 연결된 플롯 만들기",
              icon: <FileText size={18} />,
              disabled: archive,
              action: () =>
                setRenameTarget({
                  type: "newDoc",
                  idOrPath: "",
                  initialValue: `${numberOf(d)}화 플롯`,
                  kind: "plot",
                  episodeId: d.id,
                }),
            },
            {
              label: "이 회차에 연결된 메모 만들기",
              icon: <StickyNote size={18} />,
              disabled: archive,
              action: () =>
                setRenameTarget({
                  type: "newDoc",
                  idOrPath: "",
                  initialValue: `${numberOf(d)}화 메모`,
                  kind: "memo",
                  episodeId: d.id,
                }),
            },
          ] as MobileActionItem[])
        : ([
            "separator",
            {
              label: "폴더 위치 이동...",
              icon: <FolderInput size={18} />,
              action: () => setMoveFolderDoc(d),
            },
            {
              label: boundEp
                ? `연결 회차 변경 (현재: ${numberOf(boundEp)}화)`
                : "특정 회차에 연결...",
              icon: <Link2 size={18} />,
              action: attempt(() => openBinding(d.id)),
            },
            ...(boundEp
              ? ([
                  {
                    label: "회차 연결 해제 (독립 문서로)",
                    icon: <Link2Off size={18} />,
                    action: attempt(() => bindDocument(d.id, null)),
                  },
                ] as MobileActionItem[])
              : []),
            {
              label: d.kind === "memo" ? "플롯 문서로 전환" : "메모 문서로 전환",
              icon: d.kind === "memo" ? <FileText size={18} /> : <StickyNote size={18} />,
              action: attempt(() =>
                patchDoc(d.id, { kind: d.kind === "memo" ? "plot" : "memo" }),
              ),
            },
          ] as MobileActionItem[])),
      "separator",
      {
        label: "본문 복사",
        icon: <Copy size={18} />,
        action: attempt(() => copyDocManuscript(d)),
      },
      {
        label: "사본 복제",
        icon: <FilePlus size={18} />,
        action: attempt(() => duplicateDoc(d)),
      },
      {
        label: "Markdown 파일 내보내기",
        icon: <Download size={18} />,
        action: attempt(async () => {
          if (await call("exportDocument", { id: d.id })) {
            message("원고를 내보냈습니다.");
          }
        }),
      },
      "separator",
      {
        label: d.archived ? "보관함에서 꺼내기" : "보관함으로 이동",
        icon: <Archive size={18} />,
        action: attempt(() => archiveDoc(d)),
      },
      {
        label: "영구 삭제",
        icon: <Trash2 size={18} />,
        danger: true,
        action: () => setDialog({ type: "deleteDoc", value: d.id }),
      },
    ];
  };

  const getFolderActionItems = (folder: FolderEntry): MobileActionItem[] => [
    {
      label: closedFolders.has(folder.path) ? "폴더 펼치기" : "폴더 접기",
      icon: closedFolders.has(folder.path) ? <FolderOpen size={18} /> : <Folder size={18} />,
      action: () => toggleFolder(folder.path),
    },
    {
      label: "이 폴더에 새 플롯 추가",
      icon: <FileText size={18} />,
      disabled: archive,
      action: () =>
        setRenameTarget({
          type: "newDoc",
          idOrPath: "",
          initialValue: "새 플롯",
          kind: "plot",
          folder: folder.path,
        }),
    },
    {
      label: "이 폴더에 새 메모 추가",
      icon: <StickyNote size={18} />,
      disabled: archive,
      action: () =>
        setRenameTarget({
          type: "newDoc",
          idOrPath: "",
          initialValue: "새 메모",
          kind: "memo",
          folder: folder.path,
        }),
    },
    {
      label: "하위 폴더 만들기",
      icon: <FolderPlus size={18} />,
      disabled: archive,
      action: () =>
        setRenameTarget({
          type: "newFolder",
          idOrPath: folder.path,
          initialValue: "새 폴더",
        }),
    },
    "separator",
    {
      label: "폴더 이름 바꾸기",
      icon: <Edit3 size={18} />,
      action: () =>
        setRenameTarget({
          type: "folder",
          idOrPath: folder.path,
          initialValue: folder.name,
        }),
    },
    {
      label: archive ? "폴더 보관 해제" : "폴더 보관함으로 이동",
      icon: <Archive size={18} />,
      action: attempt(() => tree.archiveMemoFolder(folder.path, !archive)),
    },
    {
      label: "폴더 삭제",
      icon: <Trash2 size={18} />,
      danger: true,
      action: attempt(() => tree.removeMemoFolder(folder.path)),
    },
  ];

  const getAddMenuItems = (folder: string): MobileActionItem[] => [
    {
      label: "새 플롯 문서",
      sublabel: "회차 구성안, 세계관, 타임라인 정리",
      icon: <FileText size={18} />,
      action: () =>
        setRenameTarget({
          type: "newDoc",
          idOrPath: "",
          initialValue: "새 플롯",
          kind: "plot",
          folder: folder || undefined,
        }),
    },
    {
      label: "새 메모 문서",
      sublabel: "캐릭터 설정, 아이디어, 자료 스크랩",
      icon: <StickyNote size={18} />,
      action: () =>
        setRenameTarget({
          type: "newDoc",
          idOrPath: "",
          initialValue: "새 메모",
          kind: "memo",
          folder: folder || undefined,
        }),
    },
    "separator",
    {
      label: folder ? "이 안에 하위 폴더 만들기" : "새 폴더 만들기",
      icon: <FolderPlus size={18} />,
      action: () =>
        setRenameTarget({
          type: "newFolder",
          idOrPath: folder,
          initialValue: "새 폴더",
        }),
    },
  ];

  const rules = normalizeWriting(project.writing || prefs.defaultWriting);
  const totalProjectChars = episodes.reduce(
    (sum, d) => sum + (d.platformCharacters ?? d.characters ?? 0),
    0,
  );

  const renderEpisodeRow = (d: Doc) => {
    const num = numberOf(d);
    const status = normalizeStatus(d.status);
    const chars = d.platformCharacters ?? d.characters ?? 0;
    const isCompleted = !d.archived && status === "completed";

    return (
      <div
        key={d.id}
        className={`m-tree-row m-episode-row ${d.id === tree.currentId ? "is-active" : ""}`}
      >
        <button
          type="button"
          className="m-tree-row-main"
          onClick={attempt(() => openDoc(d.id, false))}
        >
          <span className={`m-ep-pill ${/^\d/.test(String(num)) ? "" : "named"}`}>
            {num}
          </span>
          <span className={`m-tree-label ${isCompleted ? "is-completed" : ""}`}>
            {d.title || "제목 없음"}
          </span>
          <span className={`m-status-dot-badge ${d.archived ? "archived" : status}`}>
            {d.archived ? "보관됨" : STATUS_SHORT[status]}
          </span>
          <span className="m-tree-meta">{chars.toLocaleString()}자</span>
        </button>
        <button
          type="button"
          className="m-tree-action-btn"
          aria-label={`${d.title} 메뉴`}
          onClick={(e) => {
            e.stopPropagation();
            setActiveDocSheet(d);
          }}
        >
          <MoreVertical size={17} />
        </button>
      </div>
    );
  };

  const renderDocRow = (d: Doc) => {
    const isMemo = d.kind === "memo";
    const boundEp = d.episodeId
      ? lib.documents.find((x) => x.id === d.episodeId && x.kind === "episode")
      : undefined;

    return (
      <div
        key={d.id}
        className={`m-tree-row m-doc-tree-item ${d.id === tree.currentId ? "is-active" : ""}`}
      >
        <button
          type="button"
          className="m-tree-row-main"
          onClick={attempt(() => openDoc(d.id, false))}
        >
          <span className={`m-tree-icon ${d.kind}`}>
            {isMemo ? <StickyNote size={16} /> : <FileText size={16} />}
          </span>
          <span className="m-tree-label">{d.title || "제목 없음"}</span>
          {boundEp && (
            <span className="m-tree-ep-badge">{numberOf(boundEp)}화</span>
          )}
          <span className={`m-tree-kind-tag ${d.kind}`}>
            {labels[d.kind]}
          </span>
        </button>
        <button
          type="button"
          className="m-tree-action-btn"
          aria-label={`${d.title} 메뉴`}
          onClick={(e) => {
            e.stopPropagation();
            setActiveDocSheet(d);
          }}
        >
          <MoreVertical size={17} />
        </button>
      </div>
    );
  };

  // 옵시디언 / 노션 스타일 계층형 문서 트리 렌더링
  const renderDocTreeLevel = (parentPath: string, depth: number): React.ReactNode => {
    const q = filterQuery.trim();
    const subFolders = visibleFolderEntries.filter((f) => {
      if (parentOfRel(f.path) !== parentPath) return false;
      if (!q) return true;
      const prefix = "doc/" + f.path + "/";
      return (
        f.name.toLowerCase().includes(q.toLowerCase()) ||
        filteredKindDocs.some((d) => d.relPath?.startsWith(prefix)) ||
        visibleFolderEntries.some(
          (sub) =>
            sub.path.startsWith(f.path + "/") &&
            sub.name.toLowerCase().includes(q.toLowerCase()),
        )
      );
    });

    const filesHere = filteredKindDocs.filter((d) => {
      const rel = d.relPath?.startsWith("doc/") ? d.relPath.slice(4) : "";
      return parentOfRel(rel) === parentPath;
    });

    return (
      <>
        {subFolders.map((folder) => {
          const isOpen = !!q || !closedFolders.has(folder.path);
          const prefix = "doc/" + folder.path + "/";
          const insideCount = currentKindDocs.filter((d) =>
            d.relPath?.startsWith(prefix),
          ).length;

          return (
            <div key={`folder:${folder.path}`} className="m-tree-node">
              <div className={`m-tree-row m-tree-folder ${isOpen ? "is-open" : ""}`}>
                <button
                  type="button"
                  className="m-tree-row-main"
                  onClick={() => toggleFolder(folder.path)}
                >
                  <span className="m-tree-chevron">
                    {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  </span>
                  <span className="m-tree-icon folder">
                    {isOpen ? <FolderOpen size={16} /> : <Folder size={16} />}
                  </span>
                  <span className="m-tree-label">{folder.name}</span>
                  <span className="m-tree-count">{insideCount}</span>
                </button>
                {!archive && (
                  <button
                    type="button"
                    className="m-tree-action-btn"
                    aria-label={`${folder.name}에 추가`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setAddMenuFolder(folder.path);
                    }}
                  >
                    <Plus size={16} />
                  </button>
                )}
                <button
                  type="button"
                  className="m-tree-action-btn"
                  aria-label={`${folder.name} 폴더 메뉴`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveFolderSheet(folder);
                  }}
                >
                  <MoreVertical size={17} />
                </button>
              </div>
              {isOpen && (
                <div className="m-tree-children">
                  {renderDocTreeLevel(folder.path, depth + 1)}
                </div>
              )}
            </div>
          );
        })}
        {filesHere.map((d) => renderDocRow(d))}
      </>
    );
  };

  const getProjectActions = (p: Project): MobileActionItem[] => {
    const epCount = lib.documents.filter(
      (d) => d.projectId === p.id && d.kind === "episode" && !d.archived,
    ).length;

    return [
      {
        label: "작품 회차·문서 목록 열기",
        sublabel: `총 ${epCount}편의 에피소드`,
        icon: <BookOpen size={18} />,
        action: attempt(() => onSelectProject(p.id)),
      },
      {
        label: "최근 집필 원고 바로 이어쓰기",
        icon: <Feather size={18} />,
        action: attempt(() => onOpenLastDoc(p.id)),
      },
      "separator",
      {
        label: "소설 정보 및 플랫폼 설정",
        sublabel: "제목, 소개, 표지, 글자 수 계산 기준",
        icon: <Settings size={18} />,
        action: () =>
          setDialog({
            type: "editProject",
            value: p.title,
            description: p.description,
            tags: p.tags || [],
            manualLineBreak: p.manualLineBreak ?? null,
            writing: normalizeWriting(p.writing || prefs.defaultWriting),
          }),
      },
      {
        label: "원고 파일 가져오기",
        sublabel: "TXT, MD 파일 일괄 등록",
        icon: <Upload size={18} />,
        action: attempt(async () => {
          const result = await call("importFiles", { projectId: p.id });
          if (result) {
            await refresh();
            message(
              `${result.count}편 가져옴${result.warnings.length ? " · " + result.warnings.join(" / ") : ""}`,
            );
          }
        }),
      },
      {
        label: "작품 내보내기",
        sublabel: "TXT, Markdown 파일로 내보내기",
        icon: <Download size={18} />,
        action: () => setDialog({ type: "export", value: p.id }),
      },
      "separator",
      {
        label: "작품 삭제",
        icon: <Trash2 size={18} />,
        danger: true,
        action: () => askDeleteProject(p.id),
      },
    ];
  };

  const openEditProjectDialog = () =>
    setDialog({
      type: "editProject",
      value: project.title,
      description: project.description,
      tags: project.tags || [],
      manualLineBreak: project.manualLineBreak ?? null,
      writing: rules,
    });

  return (
    <div
      ref={screenRef}
      className={`m-screen m-modern-workspace m-project-screen ${heroCollapsed ? "hero-collapsed" : ""} ${heroAnimating ? "hero-animating" : ""}`}
    >
      {/* 상단 내 서재 이동 및 작품 영웅(Hero) 헤더 */}
      <header
        className={`m-modern-header m-project-page-header ${heroCollapsed ? "hero-collapsed" : ""}`}
      >
        <div className="m-modern-header-top">
          <button
            type="button"
            className="m-project-back-link"
            onClick={attempt(goLibrary)}
          >
            <ArrowLeft size={16} />
            <span>내 서재</span>
          </button>
          <div
            className="m-project-compact-title"
            aria-hidden={!heroCollapsed}
          >
            {project.title || "제목 없는 작품"}
          </div>
          <div className="m-topbar-actions">
            <button
              type="button"
              className={`m-icon-btn ${archive ? "active" : ""}`}
              aria-label="보관함 보기"
              title="보관함"
              onClick={() => setArchive((a) => !a)}
            >
              <Archive size={18} />
            </button>
            <button
              type="button"
              className="m-icon-btn"
              aria-label="소설 관리"
              title="소설 관리"
              onClick={() => setProjectMenuOpen(true)}
            >
              <Settings size={18} />
            </button>
          </div>
        </div>
      </header>

      {/* 기본 스크롤바 대신 탭·검색줄 아래 목록 구간에만 스크롤바를 덧씌운다 */}
      <div className="m-project-list-wrap">
        {/* 옵시디언 / 노션 스타일 트리 & 리스트 본문 (구분선 없음) */}
        <div
          className="m-scroll-body m-tree-scroll m-project-list"
          ref={listScrollRef}
          onScroll={onListScroll}
          onTouchStart={onListTouchStart}
          onTouchMove={onListTouchMove}
          onTouchEnd={() => { touchY.current = null; }}
          onTouchCancel={() => { touchY.current = null; }}
        >
          {/* 목록 끝 위치는 본문의 transform이 아니라 이 감싸개의 높이로 정한다 */}
          <div className="m-project-list-body">
            <div ref={listBodyRef} className="m-tree-container">
              {archive && <RecoveryCopies projectId={project.id} openDoc={openDoc} />}
              {activeTab === "episode" ? (
                <>
                  {!filterQuery.trim() && filteredEpisodes.length > EPISODE_GROUP
                    ? Array.from(
                        { length: Math.ceil(filteredEpisodes.length / EPISODE_GROUP) },
                        (_, g) => g * EPISODE_GROUP,
                      )
                        .sort((a, b) => (episodeSort === "desc" ? b - a : a - b))
                        .map((start) => {
                          const group = filteredEpisodes.slice(start, start + EPISODE_GROUP);
                          const items = episodeSort === "desc" ? [...group].reverse() : group;
                          const isOpen = isGroupOpen(start);
                          return (
                            <div key={start} className="m-tree-node">
                              <div className="m-tree-row m-tree-folder">
                                <button
                                  type="button"
                                  className="m-tree-row-main"
                                  aria-expanded={isOpen}
                                  onClick={() => toggleEpGroup(start)}
                                >
                                  <span className="m-tree-chevron">
                                    {isOpen ? (
                                      <ChevronDown size={15} />
                                    ) : (
                                      <ChevronRight size={15} />
                                    )}
                                  </span>
                                  <span className="m-tree-label">
                                    {episodeSort === "desc"
                                      ? `${start + items.length} – ${start + 1}화`
                                      : `${start + 1} – ${start + items.length}화`}
                                  </span>
                                  <span className="m-tree-count">{items.length}</span>
                                </button>
                              </div>
                              {isOpen && (
                                <div className="m-tree-children">
                                  {items.map((d) => renderEpisodeRow(d))}
                                </div>
                              )}
                            </div>
                          );
                        })
                    : sortedEpisodes.map((d) => renderEpisodeRow(d))}

                  {filteredEpisodes.length === 0 && (
                    <div className="m-empty-state">
                      <BookOpen size={30} />
                      <h3>
                        {filterQuery.trim()
                          ? "일치하는 에피소드가 없습니다"
                          : archive
                            ? "보관된 에피소드가 없습니다"
                            : "아직 에피소드가 없습니다"}
                      </h3>
                      <p>
                        {archive
                          ? "보관함으로 옮긴 회차가 여기에 표시됩니다."
                          : "새 에피소드 버튼을 눌러 첫 에피소드를 시작해 보세요."}
                      </p>
                      {!archive && !filterQuery.trim() && (
                        <button
                          type="button"
                          className="m-btn-primary"
                          onClick={attempt(() => createDoc("episode"))}
                        >
                          <Plus size={17} />
                          <span>새 에피소드 쓰기</span>
                        </button>
                      )}
                    </div>
                  )}
                </>
              ) : docScope === "byEpisode" ? (
                <>
                  {projectEpisodes.map((ep) => {
                    const bound = filteredKindDocs.filter((d) => d.episodeId === ep.id);
                    if (bound.length === 0) return null;
                    return (
                      <div key={ep.id} className="m-tree-node">
                        <div className="m-tree-group-header">
                          <BookOpen size={14} />
                          <span>
                            {numberOf(ep)} · {ep.title || "제목 없음"}
                          </span>
                          <small>{bound.length}</small>
                        </div>
                        <div className="m-tree-children">
                          {bound.map((d) => renderDocRow(d))}
                        </div>
                      </div>
                    );
                  })}
                  {unlinkedKindDocs.length > 0 && (
                    <div className="m-tree-node">
                      <div className="m-tree-group-header">
                        <Folder size={14} />
                        <span>독립 {labels[activeTab]} (회차 미연결)</span>
                      </div>
                      <div className="m-tree-children">
                        {unlinkedKindDocs.map((d) => renderDocRow(d))}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <>
                  {renderDocTreeLevel("", 0)}

                  {filteredKindDocs.length === 0 && (
                    <div className="m-empty-state">
                      {activeTab === "plot" ? <FileText size={30} /> : <StickyNote size={30} />}
                      <h3>
                        {filterQuery.trim()
                          ? `일치하는 ${labels[activeTab]}가 없습니다`
                          : archive
                            ? `보관된 ${labels[activeTab]}가 없습니다`
                            : `아직 ${labels[activeTab]}가 없습니다`}
                      </h3>
                      <p>
                        {archive
                          ? `보관함으로 옮긴 ${labels[activeTab]} 문서가 여기에 표시됩니다.`
                          : activeTab === "plot"
                            ? "회차별 플롯이나 전체 스토리 구성안을 작성해 보세요."
                            : "캐릭터 설정, 세계관, 아이디어 메모를 자유롭게 정리해 보세요."}
                      </p>
                      {!archive && !filterQuery.trim() && (
                        <button
                          type="button"
                          className="m-btn-primary"
                          onClick={() =>
                            setRenameTarget({
                              type: "newDoc",
                              idOrPath: "",
                              initialValue: activeTab === "plot" ? "새 플롯" : "새 메모",
                              kind: activeTab,
                            })
                          }
                        >
                          <Plus size={17} />
                          <span>첫 {labels[activeTab]} 만들기</span>
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
        {/* 작품 정보와 탭·검색줄 레이어. 접히면 목록 크기를 바꾸지 않고 작품 정보 높이만큼 위로 밀려 올라간다 */}
        <div
          ref={headRef}
          className={`m-project-head ${heroCollapsed ? "collapsed" : ""}`}
          onTouchStart={onHeadTouchStart}
          onTouchMove={onHeadTouchMove}
          onTouchEnd={() => { headTouch.current = null; }}
          onTouchCancel={() => { headTouch.current = null; }}
        >
          {/* 작품 표지(좌측) + 작품 정보·태그·관리 버튼(우측) */}
          <div ref={heroRef} className="m-project-hero-wrap" aria-hidden={heroCollapsed}>
            <div className="m-project-hero">
              <button
                type="button"
                className={`m-project-hero-cover ${
                  project.coverData && !prefs.hideCovers ? "has-image" : ""
                }`}
                aria-label={project.coverData && !prefs.hideCovers ? "표지 크게 보기" : "표지 설정"}
                onClick={() => {
                  if (project.coverData && !prefs.hideCovers) {
                    onViewImage(project.coverData, `${project.title} 표지`);
                  } else {
                    openEditProjectDialog();
                  }
                }}
              >
                {project.coverData && !prefs.hideCovers ? (
                  <CoverImage src={project.coverData} alt={`${project.title} 표지`} />
                ) : (
                  <>
                    <Feather size={26} />
                    <span>YOUR STORY</span>
                  </>
                )}
              </button>

              <div className="m-project-hero-info">
                <div className="m-project-hero-meta">
                  {archive ? "보관함 · " : ""}
                  {episodes.length}편 · 총 {totalProjectChars.toLocaleString()}자
                </div>

                <h1 className="m-project-hero-title">
                  {project.title || "제목 없는 작품"}
                </h1>

                {project.description ? (
                  <p className="m-project-hero-desc">{project.description}</p>
                ) : null}

                <div className="m-project-hero-tags">
                  {(project.tags || []).map((t) => (
                    <span key={t} className="m-project-tag-chip">
                      #{t}
                    </span>
                  ))}
                  <button
                    type="button"
                    className="m-project-tag-chip add"
                    onClick={openEditProjectDialog}
                  >
                    + 태그 추가
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="m-project-tools">
            {/* 작품 화면 3탭 구조: 에피소드 / 플롯 / 메모 */}
            <MobilePillTabs<Kind>
              value={activeTab}
              label="작품 문서 분류"
              items={[
                { value: "episode", label: "에피소드", icon: <BookOpen size={15} />, count: episodes.length },
                { value: "plot", label: "플롯", icon: <FileText size={15} />, count: plots.length },
                { value: "memo", label: "메모", icon: <StickyNote size={15} />, count: memos.length },
              ]}
              onChange={kind => {
                setTab(kind);
                setFilterQuery("");
              }}
            />

            {/* 검색 및 빠른 생성 바 */}
            <div className="m-modern-toolbar">
              <div className="m-soft-search">
                <Search size={15} className="m-filter-icon" />
                <input
                  type="text"
                  className="m-filter-input"
                  placeholder={
                    activeTab === "episode"
                      ? "에피소드 제목·번호·#태그 검색..."
                      : activeTab === "plot"
                        ? "플롯 제목·폴더·#태그 검색..."
                        : "메모 제목·폴더·#태그 검색..."
                  }
                  value={filterQuery}
                  onChange={(e) => setFilterQuery(e.target.value)}
                />
                {filterQuery && (
                  <button
                    type="button"
                    className="m-filter-clear"
                    aria-label="필터 지우기"
                    onClick={() => setFilterQuery("")}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>

              <button
                  type="button"
                  className="m-sort-btn"
                  aria-label={(activeTab === "episode" ? episodeSort : documentSort) === "asc" ? "오름차순 정렬" : "내림차순 정렬"}
                  title={(activeTab === "episode" ? episodeSort : documentSort) === "asc" ? "오름차순 정렬" : "내림차순 정렬"}
                  onClick={activeTab === "episode" ? toggleEpisodeSort : toggleDocumentSort}
                >
                  {(activeTab === "episode" ? episodeSort : documentSort) === "asc" ? <ArrowDown01 size={16} /> : <ArrowDown10 size={16} />}
              </button>

              {!archive && (
                <div className="m-toolbar-create-btns">
                  <button
                    type="button"
                    className="m-btn-secondary m-btn-sm m-project-folder-create"
                    aria-label="새 폴더 만들기"
                    aria-hidden={activeTab === "episode"}
                    disabled={activeTab === "episode"}
                    hidden={activeTab === "episode"}
                    onClick={() => setRenameTarget({
                      type: "newFolder", idOrPath: "", initialValue: "새 폴더",
                    })}
                  >
                    <FolderPlus size={15} />
                  </button>
                  <button
                    type="button"
                    className={`m-btn-primary m-btn-sm m-project-doc-create ${activeTab !== "episode" ? "is-compact" : ""}`}
                    onClick={attempt(async () => {
                      if (activeTab === "episode") await createDoc("episode");
                      else setRenameTarget({
                        type: "newDoc", idOrPath: "",
                        initialValue: activeTab === "plot" ? "새 플롯" : "새 메모",
                        kind: activeTab,
                      });
                    })}
                  >
                    <Plus size={15} />
                    <span>새 {labels[activeTab]}</span>
                  </button>
                </div>
              )}
            </div>

            {/* 플롯/메모 탭 보기 방식 전환 (전체 트리 / 회차별 연결 문서) */}
            <div
              className={`m-project-scope-wrap ${showDocScope ? "is-visible" : ""}`}
              aria-hidden={!showDocScope}
              inert={!showDocScope}
            >
              <div className="m-project-scope-content">
                <div className="m-doc-scope-bar">
                  <button
                    type="button"
                    className={`m-scope-chip ${docScope === "all" ? "active" : ""}`}
                    onClick={() => setDocScope("all")}
                  >
                    전체 폴더 트리
                  </button>
                  <button
                    type="button"
                    className={`m-scope-chip ${docScope === "byEpisode" ? "active" : ""}`}
                    onClick={() => setDocScope("byEpisode")}
                  >
                    회차별 연결 {labels[activeTab]}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div ref={listThumbRef} className="m-overlay-scrollbar" aria-hidden="true" hidden />
      </div>

      <MobileActionSheet
        open={projectMenuOpen}
        title={project.title || "작품 메뉴"}
        subtitle="작품 관리 및 원고 작업"
        items={getProjectActions(project)}
        onClose={() => setProjectMenuOpen(false)}
      />

      {/* 문서 탭 추가 메뉴 시트 (플롯 / 메모 / 폴더) */}
      <MobileActionSheet
        open={addMenuFolder !== null}
        title={addMenuFolder ? `'${addMenuFolder.split("/").pop()}' 폴더에 추가` : "새 문서 또는 폴더 추가"}
        items={addMenuFolder !== null ? getAddMenuItems(addMenuFolder) : []}
        onClose={() => setAddMenuFolder(null)}
      />

      {/* 문서 더보기 액션 시트 */}
      <MobileActionSheet
        open={!!activeDocSheet}
        title={activeDocSheet?.title || "문서 메뉴"}
        subtitle={
          activeDocSheet
            ? `${labels[activeDocSheet.kind]} · ${numberOf(activeDocSheet)}`
            : undefined
        }
        items={activeDocSheet ? getDocActionItems(activeDocSheet) : []}
        onClose={() => setActiveDocSheet(null)}
      />

      {/* 폴더 더보기 액션 시트 (내부 경로 노출 제거) */}
      <MobileActionSheet
        open={!!activeFolderSheet}
        title={activeFolderSheet?.name || "폴더 메뉴"}
        items={activeFolderSheet ? getFolderActionItems(activeFolderSheet) : []}
        onClose={() => setActiveFolderSheet(null)}
      />

      {/* 폴더 이동 시트 */}
      <MobileFolderPickerSheet
        open={!!moveFolderDoc}
        title={`'${moveFolderDoc?.title || "문서"}' 폴더 이동`}
        currentFolder={
          moveFolderDoc?.relPath?.startsWith("doc/")
            ? parentOfRel(moveFolderDoc.relPath.slice(4))
            : ""
        }
        folders={allFolderPaths}
        onSelect={(targetFolder) => {
          if (moveFolderDoc) {
            attempt(() => moveDocumentToFolder(moveFolderDoc, targetFolder))();
          }
        }}
        onClose={() => setMoveFolderDoc(null)}
      />

      {/* 이름 변경 / 새 폴더 / 새 문서 입력 모달 */}
      <MobilePromptSheet
        open={!!renameTarget}
        title={
          renameTarget?.type === "doc"
            ? "문서 제목 바꾸기"
            : renameTarget?.type === "folder"
              ? "폴더 이름 바꾸기"
              : renameTarget?.type === "newFolder"
                ? "새 폴더 만들기"
                : `새 ${renameTarget?.kind ? labels[renameTarget.kind] : "문서"} 만들기`
        }
        initialValue={renameTarget?.initialValue || ""}
        placeholder="이름을 입력하세요"
        confirmLabel={
          renameTarget?.type === "newFolder" || renameTarget?.type === "newDoc"
            ? "만들기"
            : "변경"
        }
        onConfirm={(val) => {
          if (!renameTarget) return;
          if (renameTarget.type === "doc") {
            attempt(() => patchDoc(renameTarget.idOrPath, { title: val }))();
          } else if (renameTarget.type === "folder") {
            attempt(() => tree.renameMemoFolder(renameTarget.idOrPath, val))();
          } else if (renameTarget.type === "newFolder") {
            attempt(() => createNewFolderWithName(renameTarget.idOrPath, val))();
          } else if (renameTarget.type === "newDoc" && renameTarget.kind) {
            attempt(() =>
              createNewDocWithTitle(
                renameTarget.kind!,
                val,
                renameTarget.folder,
                renameTarget.episodeId,
              ),
            )();
          }
        }}
        onClose={() => setRenameTarget(null)}
      />
    </div>
  );
}
