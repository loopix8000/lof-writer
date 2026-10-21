import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Download,
  Feather,
  File,
  FolderOpen,
  MoreVertical,
  Plus,
  Settings,
  Trash2,
  Upload,
} from "lucide-react";
import React, { useState } from "react";
import { normalizeWriting } from "../../core/platforms.mjs";
import { type Dialog } from "../app/model";
import CoverImage from "../CoverImage";
import { call, type Library, type Project } from "../types";
import { MobileActionSheet, type MobileActionItem } from "./MobileActionSheet";

export default function MobileLibraryView({
  lib,
  loaded,
  prefs,
  busy,
  attempt,
  onSelectProject,
  onOpenLastDoc,
  setDialog,
  askDeleteProject,
  chooseVault,
  refresh,
  message,
}: {
  lib: Library;
  loaded: boolean;
  prefs: Record<string, any>;
  busy: boolean;
  attempt: (fn: () => Promise<any>) => () => Promise<any>;
  onSelectProject: (id: string) => Promise<void>;
  onOpenLastDoc: (id: string) => Promise<void>;
  setDialog: React.Dispatch<React.SetStateAction<Dialog | null>>;
  askDeleteProject: (id: string) => void;
  chooseVault: () => Promise<void>;
  refresh: () => Promise<Library | undefined>;
  message: (text: string) => void;
}) {
  const [sheetProject, setSheetProject] = useState<Project | null>(null);

  const moveProjectOrder = async (projectId: string, delta: -1 | 1) => {
    const ids = lib.projects.map((p) => p.id);
    const index = ids.indexOf(projectId);
    const nextIndex = index + delta;
    if (index < 0 || nextIndex < 0 || nextIndex >= ids.length) return;
    const nextIds = [...ids];
    const [moved] = nextIds.splice(index, 1);
    nextIds.splice(nextIndex, 0, moved);
    await call("reorderProjects", { ids: nextIds });
    await refresh();
  };

  const getProjectActions = (p: Project): MobileActionItem[] => {
    const idx = lib.projects.findIndex((x) => x.id === p.id);
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
      ...(lib.projects.length > 1
        ? ([
            "separator",
            {
              label: "위로 순서 이동",
              icon: <ArrowUp size={18} />,
              disabled: idx <= 0,
              action: attempt(() => moveProjectOrder(p.id, -1)),
            },
            {
              label: "아래로 순서 이동",
              icon: <ArrowDown size={18} />,
              disabled: idx >= lib.projects.length - 1,
              action: attempt(() => moveProjectOrder(p.id, 1)),
            },
          ] as MobileActionItem[])
        : []),
      "separator",
      {
        label: "작품 삭제",
        icon: <Trash2 size={18} />,
        danger: true,
        action: () => askDeleteProject(p.id),
      },
    ];
  };

  return (
    <div className="m-screen">
      <header className="m-topbar">
        <div className="m-topbar-title">
          <h1>내 서재</h1>
          <span className="m-badge">{lib.projects.length}작품</span>
        </div>
        <div className="m-topbar-actions">
          <button
            type="button"
            className="m-btn-secondary m-btn-sm"
            disabled={busy}
            aria-label="서재 위치 변경"
            title="서재 위치 변경"
            onClick={attempt(chooseVault)}
          >
            <FolderOpen size={15} />
            <span>서재 변경</span>
          </button>
          <button
            type="button"
            className="m-btn-primary m-btn-sm"
            onClick={() => setDialog({ type: "newProject", value: "" })}
          >
            <Plus size={16} />
            <span>새 작품</span>
          </button>
        </div>
      </header>

      <div className="m-scroll-body">
        {!loaded ? (
          <div className="m-empty-state">
            <p>내 서재를 불러오는 중...</p>
          </div>
        ) : lib.projects.length === 0 ? (
          <div className="m-empty-state">
            <div className="m-empty-icon">
              <BookOpen size={36} />
            </div>
            <h2>첫 이야기를 시작해 볼까요?</h2>
            <p>
              작품을 만들고 회차별로 원고와 설정집을 정리하세요.
              <br />
              계정 없이 기기에 안전하게 저장됩니다.
            </p>
            <button
              type="button"
              className="m-btn-primary"
              onClick={() => setDialog({ type: "newProject", value: "" })}
            >
              <Plus size={18} />
              <span>첫 이야기 만들기</span>
            </button>
          </div>
        ) : (
          <div className="m-project-list">
            {lib.projects.map((p, i) => {
              const epCount = lib.documents.filter(
                (d) => d.projectId === p.id && d.kind === "episode" && !d.archived,
              ).length;
              const docCount = lib.documents.filter(
                (d) => d.projectId === p.id && d.kind !== "episode" && !d.archived,
              ).length;
              const totalChars = lib.documents
                .filter((d) => d.projectId === p.id && d.kind === "episode" && !d.archived)
                .reduce((acc, d) => acc + (d.platformCharacters ?? d.characters ?? 0), 0);

              return (
                <div key={p.id} className="m-project-card">
                  <button
                    type="button"
                    className="m-project-card-main"
                    onClick={attempt(() => onSelectProject(p.id))}
                  >
                    {!prefs.hideCovers && (
                      <div className={`m-project-cover cover-${i % 4}`}>
                        {p.coverData ? (
                          <CoverImage src={p.coverData} alt={`${p.title} 표지`} />
                        ) : (
                          <>
                            <Feather size={28} />
                            <span>{String(i + 1).padStart(2, "0")}</span>
                          </>
                        )}
                      </div>
                    )}
                    <div className="m-project-meta">
                      <h3>{p.title || "제목 없는 작품"}</h3>
                      <div className="m-project-stats">
                        <span>회차 {epCount}편</span>
                        {docCount > 0 && <span>· 설정/메모 {docCount}개</span>}
                      </div>
                      {totalChars > 0 && (
                        <div className="m-project-chars">
                          <File size={13.5} />
                          <span>총 {totalChars.toLocaleString()}자</span>
                        </div>
                      )}
                      {p.description && (
                        <p className="m-project-desc">{p.description}</p>
                      )}
                      {p.tags && p.tags.length > 0 && (
                        <div className="m-tag-row">
                          {p.tags.map((t) => (
                            <span key={t} className="m-tag-chip">
                              #{t}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </button>
                  <button
                    type="button"
                    className="m-row-more-btn"
                    aria-label={`${p.title} 더보기 메뉴`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSheetProject(p);
                    }}
                  >
                    <MoreVertical size={20} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <MobileActionSheet
        open={!!sheetProject}
        title={sheetProject?.title || "작품 메뉴"}
        subtitle="작품 관리 및 원고 작업"
        items={sheetProject ? getProjectActions(sheetProject) : []}
        onClose={() => setSheetProject(null)}
      />
    </div>
  );
}
