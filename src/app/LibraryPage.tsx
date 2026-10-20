import {
  BookOpen,
  ChevronRight,
  Download,
  Feather,
  FolderOpen,
  Plus
} from "lucide-react";
import { type MenuItem } from "../ContextMenu";
import CoverImage from "../CoverImage";
import {
  call,
  type Library
} from "../types";
import type { useProjectReorder } from "../useProjectReorder";

import type * as React from "react";
import { type Dialog } from "./model";

type Props = {
  lib: Library;
  loaded: boolean;
  projectReorder: ReturnType<typeof useProjectReorder>;
  prefs: Record<string, any>;
  menu: { x: number; y: number; items: MenuItem[]; target?: string; } | null;
  attempt: (fn: () => Promise<any>) => () => Promise<any>;
  openProject: (id: string) => Promise<void>;
  openMenu: (e: React.MouseEvent, items: MenuItem[], target?: string) => void;
  askDeleteProject: (id: string) => void;
  setDialog: React.Dispatch<React.SetStateAction<Dialog | null>>;
  busy: boolean;
  chooseVault: () => Promise<void>;
};

export default function LibraryPage({
  lib,
  loaded,
  projectReorder,
  prefs,
  menu,
  attempt,
  openProject,
  openMenu,
  askDeleteProject,
  setDialog,
  busy,
  chooseVault,
}: Props) {

  return (
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
        <div className="project-grid" aria-busy={projectReorder.saving || undefined}>
          {lib.projects
            .map((p, i) => (
              <button
                className={`project-card ${prefs.hideCovers ? "no-cover" : ""} ${menu?.target === "project:" + p.id ? "context-target" : ""} ${projectReorder.cardClass(p.id)}`}
                key={p.id}
                {...projectReorder.cardProps(p.id)}
                onClick={attempt(() => openProject(p.id))}
                onContextMenu={(e) =>
                  openMenu(
                    e,
                    [
                      { label: "열기", action: attempt(() => openProject(p.id)) },
                      {
                        label: "작품 내보내기",
                        action: () => setDialog({ type: "export", value: p.id }),
                      },
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
                {!prefs.hideCovers && (
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
                )}
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
              className={`project-card new-project-card ${prefs.hideCovers ? "no-cover" : ""} ${projectReorder.cardClass(null)}`}
              {...projectReorder.cardProps(null)}
              onClick={() => setDialog({ type: "newProject", value: "" })}
            >
              <div className="book-cover new-cover">
                <Plus size={prefs.hideCovers ? 18 : 30} />
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
        <button
          disabled={busy}
          onClick={() => setDialog({ type: "export" })}
        >
          <Download size={15} />
          서재 내보내기
        </button>
        <button onClick={attempt(() => call("reveal"))}>
          폴더에서 보기 <ChevronRight size={13} />
        </button>
      </div>
    </>
  );
}
