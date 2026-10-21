import {
  Archive,
  ArrowLeft,
  Bookmark as BookmarkIcon,
  Check,
  FolderOpen,
  Library as LibraryIcon,
  Moon,
  Search,
  Settings,
  StickyNote,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { normalizeWriting } from "../../core/platforms.mjs";
import BookmarksPage from "../app/BookmarksPage";
import ExportDialog from "../app/ExportDialog";
import { type Destination, type Dialog } from "../app/model";
import ProjectForm from "../app/ProjectForm";
import { settingPages, type SettingsPage } from "../app/settings-pages";
import SettingsContent from "../app/SettingsContent";
import type { FileTreeController } from "../app/useFileTree";
import { ImageViewer } from "../CoverImage";
import type { EditorScrollPositions } from "../EditorScroll";
import EpisodeBindingPicker from "../EpisodeBindingPicker";
import HistoryDialog from "../HistoryDialog";
import PlatformPicker from "../PlatformPicker";
import { ReleaseNotesDialog, ReleaseNotice } from "../ReleaseNotes";
import type { SearchMatch, SearchResult } from "../SearchViews";
import {
  call,
  type AutoSyncStatus,
  type Doc,
  type Kind,
  type Library,
  type Project,
  type WritingRules,
} from "../types";
import { isAndroidApp } from "../tauri-bridge";
import { UpdateLock, UpdateNotice } from "../Updater";
import MobileEditorView from "./MobileEditorView";
import MobileLibraryView from "./MobileLibraryView";
import MobileMemoView from "./MobileMemoView";
import MobileProjectView from "./MobileProjectView";
import MobileSearchView from "./MobileSearchView";
import "./mobile.css";

type MobileTab = "library" | "bookmarks" | "memo" | "search" | "settings";

export default function MobileShell({
  lib,
  loaded,
  view,
  projectId,
  project,
  tab,
  setTab,
  archive,
  setArchive,
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
  dialog,
  setDialog,
  settingsPage,
  setSettingsPage,
  typesettingKind,
  setTypesettingKind,
  newRepFrom,
  newRepTo,
  newRepLabel,
  setNewRepFrom,
  setNewRepTo,
  setNewRepLabel,
  commonMemoPath,
  setCommonMemoPath,
  skillDownloading,
  setSkillDownloading,
  busy,
  setBusy,
  toast,
  toastAction,
  clearToast,
  error,
  setError,
  viewer,
  closeViewer,
  confirmTitle,
  setConfirmTitle,
  confirmDialog,
  recoverable,
  updater,
  releaseNotice,
  releaseNotesOpen,
  setReleaseNotesOpen,
  searchQuery,
  setSearchQuery,
  searchCase,
  setSearchCase,
  bookmarkQuery,
  setBookmarkQuery,
  bookmarkJump,
  setBookmarkJump,
  memoApi,
  memoFlush,
  attempt,
  navigate,
  goView,
  openLibraryProject,
  switchProject,
  openDoc,
  createDoc,
  patchDoc,
  archiveDoc,
  deleteDocs,
  deleteProject,
  askDeleteProject,
  duplicateDoc,
  copyDocManuscript,
  openBinding,
  bindDocument,
  openNoteLink,
  openSearchResult,
  replaceActiveSymbols,
  showHistory,
  chooseVault,
  openSettingsData,
  renderSyncConnections,
  onUpdateProjectWriting,
  edit,
  counterUpdate,
  manualSave,
  flush,
  resolveConflict,
  checkOpenDocument,
  restoreHistory,
  discardDraft,
  refresh,
  message,
  report,
}: {
  lib: Library;
  loaded: boolean;
  view: string;
  projectId: string;
  project?: Project;
  tab: Kind;
  setTab: React.Dispatch<React.SetStateAction<Kind>>;
  archive: boolean;
  setArchive: React.Dispatch<React.SetStateAction<boolean>>;
  active: Doc | null;
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
  dialog: Dialog | null;
  setDialog: React.Dispatch<React.SetStateAction<Dialog | null>>;
  settingsPage: SettingsPage;
  setSettingsPage: React.Dispatch<React.SetStateAction<SettingsPage>>;
  typesettingKind: "episode" | "document";
  setTypesettingKind: React.Dispatch<React.SetStateAction<"episode" | "document">>;
  newRepFrom: string;
  newRepTo: string;
  newRepLabel: string;
  setNewRepFrom: React.Dispatch<React.SetStateAction<string>>;
  setNewRepTo: React.Dispatch<React.SetStateAction<string>>;
  setNewRepLabel: React.Dispatch<React.SetStateAction<string>>;
  commonMemoPath: string;
  setCommonMemoPath: React.Dispatch<React.SetStateAction<string>>;
  skillDownloading: boolean;
  setSkillDownloading: React.Dispatch<React.SetStateAction<boolean>>;
  busy: boolean;
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;
  toast: string;
  toastAction: { label: string; run: () => void } | null;
  clearToast: () => void;
  error: string;
  setError: React.Dispatch<React.SetStateAction<string>>;
  viewer: { src: string; alt: string } | null;
  closeViewer: () => void;
  confirmTitle: string;
  setConfirmTitle: React.Dispatch<React.SetStateAction<string>>;
  confirmDialog: React.ReactNode;
  recoverable: number;
  updater: any;
  releaseNotice: any;
  releaseNotesOpen: boolean;
  setReleaseNotesOpen: React.Dispatch<React.SetStateAction<boolean>>;
  searchQuery: string;
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  searchCase: boolean;
  setSearchCase: React.Dispatch<React.SetStateAction<boolean>>;
  bookmarkQuery: string;
  setBookmarkQuery: React.Dispatch<React.SetStateAction<string>>;
  bookmarkJump: { docId: string; index: number; seq: number } | null;
  setBookmarkJump: React.Dispatch<
    React.SetStateAction<{ docId: string; index: number; seq: number } | null>
  >;
  memoApi: React.MutableRefObject<{
    open: (space: string, path: string, pinned?: boolean) => Promise<void>;
  } | null>;
  memoFlush: React.MutableRefObject<
    ((options?: { closing?: boolean }) => Promise<void>) | null
  >;
  attempt: (fn: () => Promise<any>) => () => Promise<any>;
  navigate: (
    destination: Destination,
    historyIndex?: number,
    beforeCommit?: () => boolean | void,
  ) => Promise<void>;
  goView: (next: "library" | "project" | "bookmarks", id?: string) => Promise<void>;
  openLibraryProject: (id: string) => Promise<void>;
  switchProject: (id: string) => Promise<void>;
  openDoc: (id: string, pinned?: boolean) => Promise<void>;
  createDoc: (
    kind: Kind,
    opts?: { title?: string; episodeId?: string },
  ) => Promise<void>;
  patchDoc: (id: string, patch: Partial<Doc>) => Promise<void>;
  archiveDoc: (doc: Doc) => Promise<void>;
  deleteDocs: (docs: Doc[]) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  askDeleteProject: (id: string) => void;
  duplicateDoc: (doc: Doc) => Promise<void>;
  copyDocManuscript: (doc: Doc, rawMarkdown?: boolean) => Promise<void>;
  openBinding: (id: string) => Promise<void>;
  bindDocument: (id: string, episodeId: string | null) => Promise<void>;
  openNoteLink: (href: string, quote: string) => Promise<void>;
  openSearchResult: (
    r: SearchResult,
    m: SearchMatch,
    pinned?: boolean,
  ) => Promise<void>;
  replaceActiveSymbols: () => void;
  showHistory: () => Promise<void>;
  chooseVault: () => Promise<void>;
  openSettingsData: () => Promise<void>;
  renderSyncConnections: () => React.JSX.Element;
  onUpdateProjectWriting: (rules: WritingRules) => void;
  edit: (patch: Partial<Doc>, markdownCopy?: boolean) => void;
  counterUpdate: (body: string, delta: any) => void;
  manualSave: () => Promise<void>;
  flush: () => Promise<void>;
  resolveConflict: () => Promise<void>;
  checkOpenDocument: (apply?: boolean) => Promise<void>;
  restoreHistory: (
    id: string,
    name: string,
    onDone: () => void,
  ) => Promise<{ historyWarning?: string }>;
  discardDraft: (id: string) => void;
  refresh: () => Promise<Library | undefined>;
  message: (text: string, action?: { label: string; run: () => void }) => void;
  report: (e: any) => void;
}) {
  const [mobileTab, setMobileTab] = useState<MobileTab>("library");
  const [inMemoEditor, setInMemoEditor] = useState(false);
  const closeMemoEditorRef = useRef<(() => void) | null>(null);
  const [settingsDetailOpen, setSettingsDetailOpen] = useState(false);

  // dialog가 serverSync나 settings로 열리면 설정 화면(하위 메뉴 포함)으로 전환한다.
  useEffect(() => {
    if (dialog?.type === "serverSync") {
      setDialog(null);
      setSettingsPage("realtime");
      setSettingsDetailOpen(true);
      setMobileTab("settings");
    } else if (dialog?.type === "settings") {
      setDialog(null);
      setSettingsDetailOpen(false);
      setMobileTab("settings");
    }
  }, [dialog?.type, setDialog, setSettingsPage]);

  // view가 project 또는 workspace로 바뀌면 모바일 탭도 내 서재(library)로 맞춘다.
  useEffect(() => {
    if (view === "project" || view === "workspace") {
      if (mobileTab === "bookmarks" || mobileTab === "search") {
        setMobileTab("library");
      }
    }
  }, [view]);

  const isWritingEditor =
    mobileTab === "library" && view === "workspace" && !!active;
  const hideBottomNav = isWritingEditor || (mobileTab === "memo" && inMemoEditor);

  const handleMemoDetailState = useCallback(
    (inEditor: boolean, closeFn: () => void) => {
      setInMemoEditor(inEditor);
      closeMemoEditorRef.current = closeFn;
    },
    [],
  );

  // 안드로이드 시스템 뒤로가기 버튼/제스처 연결
  useEffect(() => {
    (window as any).__lofMobileBack = () => {
      if (viewer) {
        closeViewer();
        return true;
      }
      if (dialog && dialog.type !== "setup") {
        setDialog(null);
        return true;
      }
      if ((window as any).__lofEditorSubBack?.()) {
        return true;
      }
      if (mobileTab === "settings" && settingsDetailOpen) {
        setSettingsDetailOpen(false);
        return true;
      }
      if (mobileTab === "memo" && inMemoEditor && closeMemoEditorRef.current) {
        closeMemoEditorRef.current();
        return true;
      }
      if (isWritingEditor && active) {
        attempt(() => goView("project", active.projectId))();
        return true;
      }
      if (mobileTab === "library" && view === "project") {
        attempt(() => goView("library"))();
        return true;
      }
      if (mobileTab !== "library") {
        setMobileTab("library");
        attempt(() => goView("library"))();
        return true;
      }
      return false;
    };
    return () => {
      delete (window as any).__lofMobileBack;
    };
  }, [
    viewer,
    closeViewer,
    dialog,
    setDialog,
    mobileTab,
    settingsDetailOpen,
    inMemoEditor,
    isWritingEditor,
    active,
    view,
    attempt,
    goView,
  ]);

  const switchMainTab = async (next: MobileTab) => {
    if (dialog && dialog.type !== "setup") {
      setDialog(null);
    }
    if (mobileTab === "memo") {
      await memoFlush.current?.();
    } else {
      await flush();
    }
    if (next === "library") {
      setMobileTab("library");
      await goView("library");
    } else if (next === "bookmarks") {
      setMobileTab("bookmarks");
    } else if (next === "memo") {
      setMobileTab("memo");
    } else if (next === "search") {
      setMobileTab("search");
    } else if (next === "settings") {
      await openSettingsData();
      setSettingsDetailOpen(false);
      setMobileTab("settings");
    }
  };

  const isProtected =
    active?.kind === "episode" && active?.status === "completed";

  // 상태 표시줄·내비게이션 바도 상단 앱바·하단 탭과 같은 색과 아이콘 밝기로 맞춘다.
  const shellRef = useRef<HTMLDivElement>(null);
  const dark = prefs.theme === "dark";
  useEffect(() => {
    if (!isAndroidApp() || !shellRef.current) return;
    const color = getComputedStyle(shellRef.current).getPropertyValue("--surface").trim();
    if (!/^#[0-9a-f]{6}$/i.test(color)) return;
    void invoke("android_set_system_bars", { color, dark }).catch(() => {});
  }, [dark, prefs.colorTheme]);

  return (
    <div
      ref={shellRef}
      className={`app mobile-app ${prefs.theme === "dark" ? "dark" : ""} ${prefs.colorTheme === "bakery" ? "bakery" : ""}`}
      inert={updater.locked}
    >
      {/* 상단 오류 배너 */}
      {error && (
        <div className="m-error-banner" role="alert">
          <span>{error}</span>
          <button
            type="button"
            aria-label="오류 닫기"
            onClick={() => setError("")}
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* 메인 화면 영역 */}
      <div className={`m-viewport ${hideBottomNav ? "no-bottom-nav" : ""}`}>
        {mobileTab === "library" && (
          <>
            {isWritingEditor && active ? (
              <MobileEditorView
                lib={lib}
                project={project}
                active={active}
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
                reveal={reveal}
                scrollPositions={scrollPositions}
                tree={tree}
                docImages={docImages}
                attempt={attempt}
                edit={edit}
                counterUpdate={counterUpdate}
                manualSave={manualSave}
                flush={flush}
                resolveConflict={resolveConflict}
                checkOpenDocument={checkOpenDocument}
                replaceActiveSymbols={replaceActiveSymbols}
                openDoc={openDoc}
                createDoc={createDoc}
                patchDoc={patchDoc}
                archiveDoc={archiveDoc}
                duplicateDoc={duplicateDoc}
                copyDocManuscript={copyDocManuscript}
                openBinding={openBinding}
                bindDocument={bindDocument}
                openNoteLink={openNoteLink}
                showHistory={showHistory}
                goProject={() => goView("project", active.projectId)}
                onUpdateProjectWriting={onUpdateProjectWriting}
                setDialog={setDialog}
                message={message}
                report={report}
                numberOf={tree.numberOf}
                bookmarkJump={bookmarkJump}
                setBookmarkJump={setBookmarkJump}
              />
            ) : view === "project" && project ? (
              <MobileProjectView
                lib={lib}
                project={project}
                docs={tree.docs}
                tab={tab}
                setTab={setTab}
                archive={archive}
                setArchive={setArchive}
                prefs={prefs}
                tree={tree}
                attempt={attempt}
                openDoc={openDoc}
                createDoc={createDoc}
                patchDoc={patchDoc}
                archiveDoc={archiveDoc}
                duplicateDoc={duplicateDoc}
                copyDocManuscript={copyDocManuscript}
                openBinding={openBinding}
                bindDocument={bindDocument}
                switchProject={async (id) => {
                  await goView("project", id);
                }}
                goLibrary={async () => {
                  await goView("library");
                }}
                setDialog={setDialog}
                refresh={refresh}
                message={message}
                numberOf={tree.numberOf}
              />
            ) : (
              <MobileLibraryView
                lib={lib}
                loaded={loaded}
                prefs={prefs}
                busy={busy}
                attempt={attempt}
                onSelectProject={async (id) => {
                  await goView("project", id);
                }}
                onOpenLastDoc={async (id) => {
                  await openLibraryProject(id);
                }}
                setDialog={setDialog}
                askDeleteProject={askDeleteProject}
                chooseVault={chooseVault}
                refresh={refresh}
                message={message}
              />
            )}
          </>
        )}

        {mobileTab === "bookmarks" && (
          <div className="m-screen m-bookmarks-screen">
            <header className="m-topbar">
              <div className="m-topbar-title">
                <h1>북마크</h1>
              </div>
              <div className="m-topbar-actions" />
            </header>
            <div className="m-scroll-body m-bookmarks-host">
              <BookmarksPage
                active={active}
                bookmarkQuery={bookmarkQuery}
                lib={lib}
                attempt={attempt}
                openDoc={async (id, pinned) => {
                  setMobileTab("library");
                  await openDoc(id, pinned);
                }}
                setBookmarkJump={(jump) => {
                  setMobileTab("library");
                  setBookmarkJump(jump);
                }}
                setBookmarkQuery={setBookmarkQuery}
                patchDoc={patchDoc}
              />
            </div>
          </div>
        )}

        <MobileMemoView
          active={mobileTab === "memo"}
          syncStatus={autoSync}
          syncChecking={syncChecking}
          syncAvailable={syncAvailable}
          prefs={prefs}
          apiRef={memoApi}
          flushRef={memoFlush}
          onOpenLink={(href, quote) =>
            attempt(async () => {
              await memoFlush.current?.();
              setMobileTab("library");
              await openNoteLink(href, quote);
            })()
          }
          message={message}
          report={report}
          onDetailStateChange={handleMemoDetailState}
        />

        {mobileTab === "search" && (
          <MobileSearchView
            lib={lib}
            project={project}
            query={searchQuery}
            setQuery={setSearchQuery}
            caseSensitive={searchCase}
            setCaseSensitive={setSearchCase}
            onOpenMatch={(r, m) =>
              attempt(async () => {
                setMobileTab("library");
                await openSearchResult(r, m, false);
              })()
            }
            onOpenFile={(id) =>
              attempt(async () => {
                setMobileTab("library");
                await openDoc(id, false);
              })()
            }
            onOpenProject={(id) =>
              attempt(async () => {
                setMobileTab("library");
                await goView("project", id);
              })()
            }
            onOpenCommon={(path) =>
              attempt(async () => {
                await flush();
                setMobileTab("memo");
                await memoApi.current?.open("common", path, true);
              })()
            }
            report={report}
          />
        )}

        {mobileTab === "settings" && (
          <div className="m-screen m-settings-screen">
            <header className="m-topbar">
              {settingsDetailOpen && (
                <button
                  type="button"
                  className="m-back-btn"
                  onClick={() => setSettingsDetailOpen(false)}
                >
                  <ArrowLeft size={18} />
                  <span>설정</span>
                </button>
              )}
              <div className="m-topbar-title">
                <h1>
                  {settingsDetailOpen
                    ? settingPages.find((item) => item.id === settingsPage)?.label ||
                      "설정"
                    : "설정"}
                </h1>
              </div>
              <div className="m-topbar-actions">
                <button
                  type="button"
                  className="m-icon-btn"
                  aria-label="테마 전환"
                  onClick={() =>
                    savePrefs({
                      theme: prefs.theme === "dark" ? "light" : "dark",
                    }).catch(report)
                  }
                >
                  {prefs.theme === "dark" ? <Sun size={19} /> : <Moon size={19} />}
                </button>
              </div>
            </header>
            <div className="m-scroll-body m-settings-host">
              <SettingsContent
                isMobile
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
                isProtected={!!isProtected}
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
                onOpenExport={() => setDialog({ type: "export" })}
                chooseVault={chooseVault}
                mobileDetailOpen={settingsDetailOpen}
                onMobileDetailChange={setSettingsDetailOpen}
              />
            </div>
          </div>
        )}
      </div>

      {/* 하단 모바일 전용 내비게이션 바 (집필/메모 에디터 중에는 숨김) */}
      {!hideBottomNav && (
        <nav className="m-bottom-nav" aria-label="모바일 주 메뉴">
          <button
            type="button"
            className={mobileTab === "library" ? "selected" : ""}
            onClick={attempt(() => switchMainTab("library"))}
          >
            <LibraryIcon size={20} />
            <span>내 서재</span>
          </button>
          <button
            type="button"
            className={mobileTab === "memo" ? "selected" : ""}
            onClick={attempt(() => switchMainTab("memo"))}
          >
            <StickyNote size={20} />
            <span>메모</span>
          </button>
          <button
            type="button"
            className={mobileTab === "bookmarks" ? "selected" : ""}
            onClick={attempt(() => switchMainTab("bookmarks"))}
          >
            <BookmarkIcon size={20} />
            <span>북마크</span>
          </button>
          <button
            type="button"
            className={mobileTab === "search" ? "selected" : ""}
            onClick={attempt(() => switchMainTab("search"))}
          >
            <Search size={20} />
            <span>검색</span>
          </button>
          <button
            type="button"
            className={mobileTab === "settings" ? "selected" : ""}
            onClick={attempt(() => switchMainTab("settings"))}
          >
            <Settings size={20} />
            <span>설정</span>
          </button>
        </nav>
      )}

      {/* 복구 가능 임시 원고 알림 */}
      {recoverable > 0 && !hideBottomNav && (
        <div className="m-recovery-banner" role="status">
          <span>복구 가능한 임시 원고 {recoverable}개</span>
          <button
            type="button"
            onClick={() => setDialog({ type: "recovery" })}
          >
            확인하기
          </button>
        </div>
      )}

      {/* 토스트 알림 */}
      {toast && (
        <div className="m-toast" role="status">
          <Check size={16} />
          <span>{toast}</span>
          {toastAction && (
            <button
              type="button"
              className="m-toast-action"
              onClick={() => {
                const run = toastAction.run;
                clearToast();
                run();
              }}
            >
              {toastAction.label}
            </button>
          )}
        </div>
      )}

      {/* 이미지 뷰어 */}
      {viewer && (
        <ImageViewer src={viewer.src} alt={viewer.alt} onClose={closeViewer} />
      )}

      {confirmDialog}

      {/* 모바일 전용 전체 화면 서브 다이얼로그 (새 작품, 소설 관리, 변경 이력, 내보내기 등) */}
      {dialog && !["settings", "serverSync"].includes(dialog.type) && (
        <div className="m-dialog-page" role="dialog" aria-modal="true">
          <header className="m-topbar">
            {dialog.type !== "setup" ? (
              <button
                type="button"
                className="m-back-btn"
                onClick={() => setDialog(null)}
              >
                <ArrowLeft size={18} />
                <span>닫기</span>
              </button>
            ) : (
              <div />
            )}
            <div className="m-topbar-title">
              <h1>
                {
                  {
                    newProject: "새 이야기 만들기",
                    editProject: "소설 관리",
                    history: "변경 이력",
                    document: "문서 관리",
                    deleteDoc: "영구 삭제",
                    deleteProject: "작품 삭제",
                    linkEpisode: "회차에 연결",
                    recovery: "임시 원고 복구",
                    setup: "처음 집필 환경 설정",
                    export: dialog.value ? "작품 내보내기" : "서재 내보내기",
                  }[dialog.type]
                }
              </h1>
            </div>
            <div className="m-topbar-actions" />
          </header>

          <div className="m-dialog-body">
            {dialog.type === "setup" && (
              <div className="setup-content">
                <section className="setup-vault">
                  <h3>서재 위치</h3>
                  <p className="muted">
                    작품과 원고를 저장할 폴더입니다. 기본 위치를 그대로 사용하거나 다른 폴더를 선택하세요.
                  </p>
                  <div className="setup-vault-picker">
                    <output title={lib.root}>
                      {/^\/data\/(?:data|user\/\d+)\/local\.lof\.writer\//i.test(
                        lib.root || "",
                      )
                        ? `앱 기본 서재 폴더 (${(lib.root || "").split("/").filter(Boolean).pop() || "LofWriter"})`
                        : lib.root}
                    </output>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={attempt(chooseVault)}
                    >
                      <FolderOpen size={15} /> 서재 변경
                    </button>
                  </div>
                </section>
                <p>주로 연재할 플랫폼을 선택해 주세요.</p>
                <PlatformPicker
                  value={dialog.writing || normalizeWriting()}
                  onChange={(writing) => setDialog({ ...dialog, writing })}
                />
                <button
                  type="button"
                  className="m-btn-primary m-btn-full"
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
              <ProjectForm
                dialog={dialog}
                prefs={prefs}
                refresh={refresh}
                navigate={async (dest, idx, before) => {
                  await navigate(dest, idx, before);
                  setMobileTab("library");
                }}
                projectId={projectId}
                project={project}
                setDialog={setDialog}
                report={report}
                setViewer={() => {}}
                attempt={attempt}
                message={message}
                askDeleteProject={askDeleteProject}
              />
            )}

            {dialog.type === "history" && active && (
              <HistoryDialog
                documentId={active.id}
                report={report}
                onRestore={async (id, name) => {
                  const restored = await restoreHistory(id, name, () =>
                    setDialog(null),
                  );
                  await refresh();
                  message(
                    restored.historyWarning ??
                      "이전 원고를 복원했습니다.",
                  );
                }}
              />
            )}

            {dialog.type === "deleteDoc" &&
              (() => {
                const ids = dialog.ids ?? [dialog.value];
                const targets = lib.documents.filter((d) => ids.includes(d.id));
                if (!targets.length) return <p>이미 삭제된 문서입니다.</p>;
                return (
                  <div className="m-confirm-box">
                    <p>
                      {targets.length > 1 ? (
                        <>
                          <b>문서 {targets.length}개</b>를 영구 삭제할까요?
                        </>
                      ) : (
                        <>
                          <b>{targets[0].title || "제목 없음"}</b> 문서를 영구 삭제할까요?
                        </>
                      )}
                    </p>
                    <p className="muted">
                      문서 목록과 임시 원고에서 제거됩니다. 동기화를 사용 중이면 다른 기기에서도 삭제됩니다.
                    </p>
                    <div className="m-prompt-footer">
                      <button
                        type="button"
                        className="m-btn-secondary"
                        onClick={() => setDialog(null)}
                      >
                        취소
                      </button>
                      <button
                        type="button"
                        className="m-btn-danger"
                        onClick={attempt(async () => {
                          setDialog(null);
                          tree.clearSelection();
                          await deleteDocs(targets);
                        })}
                      >
                        <Trash2 size={16} />
                        <span>영구 삭제</span>
                      </button>
                    </div>
                  </div>
                );
              })()}

            {dialog.type === "linkEpisode" &&
              (() => {
                const target = lib.documents.find((d) => d.id === dialog.value);
                if (!target) return <p>이미 없는 문서입니다.</p>;
                return (
                  <EpisodeBindingPicker
                    key={target.id}
                    doc={target}
                    documents={lib.documents}
                    onSelect={async (episodeId) => {
                      await bindDocument(target.id, episodeId);
                      setDialog(null);
                    }}
                    onCancel={() => setDialog(null)}
                  />
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
                    className="m-confirm-box"
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
                      작품 폴더 전체(회차 {count}편, 플롯, 작품 메모, 표지)를 삭제합니다.
                    </p>
                    <label className="confirm-title">
                      확인을 위해 작품 제목 <b>{name}</b>을(를) 입력해 주세요.
                      <input
                        className="m-text-input"
                        value={confirmTitle}
                        onChange={(e) => setConfirmTitle(e.target.value)}
                      />
                    </label>
                    <div className="m-prompt-footer">
                      <button
                        type="button"
                        className="m-btn-secondary"
                        onClick={() => setDialog(null)}
                      >
                        취소
                      </button>
                      <button
                        type="submit"
                        className="m-btn-danger"
                        disabled={confirmTitle !== name}
                      >
                        <Trash2 size={16} />
                        <span>작품 삭제</span>
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
                      type="button"
                      className="m-btn-primary"
                      onClick={attempt(async () => {
                        const copy = await call<Doc>("createDocument", {
                          projectId: d.projectId,
                          kind: d.kind,
                          title: d.title + " (복구 사본)",
                          body: d.body,
                        });
                        await call("clearDraft", { id: d.id });
                        await refresh();
                        discardDraft(d.id);
                        setDialog(null);
                        setMobileTab("library");
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

            {dialog.type === "export" && (
              <ExportDialog
                lib={lib}
                projectId={dialog.value}
                defaultPreserveBreaks={prefs.copyWithBlankLines === true}
                busy={busy}
                setBusy={setBusy}
                flush={flush}
                report={report}
                onCancel={() => setDialog(null)}
                onSuccess={(res) => {
                  setDialog(null);
                  const targetLabel = dialog.value ? "작품을" : "서재를";
                  message(
                    `${targetLabel} 내보냈습니다 (파일 ${res.fileCount}개)`,
                  );
                }}
              />
            )}
          </div>
        </div>
      )}

      <UpdateNotice
        updater={updater}
        onOpen={() => {
          setSettingsPage("updates");
          void switchMainTab("settings");
        }}
      />
      {releaseNotice.visible && (
        <ReleaseNotice
          version={lib.version}
          onOpen={() => setReleaseNotesOpen(true)}
          onClose={releaseNotice.dismiss}
        />
      )}
      {releaseNotesOpen && (
        <ReleaseNotesDialog
          version={lib.version}
          onClose={() => setReleaseNotesOpen(false)}
        />
      )}
      <UpdateLock phase={updater.phase} />
    </div>
  );
}
