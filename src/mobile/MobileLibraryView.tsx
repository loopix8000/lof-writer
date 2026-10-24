import {
  BookOpen,
  Feather,
  File,
  Plus,
} from "lucide-react";
import React from "react";
import { type Dialog } from "../app/model";
import CoverImage from "../CoverImage";
import { type Library } from "../types";
import type { useProjectReorder } from "../useProjectReorder";
import { useMobileProjectReorder } from "./useMobileProjectReorder";

export default function MobileLibraryView({
  lib,
  loaded,
  prefs,
  busy,
  attempt,
  onSelectProject,
  setDialog,
  projectReorder,
}: {
  lib: Library;
  loaded: boolean;
  prefs: Record<string, any>;
  busy: boolean;
  attempt: (fn: () => Promise<any>) => () => Promise<any>;
  onSelectProject: (id: string) => Promise<void>;
  setDialog: React.Dispatch<React.SetStateAction<Dialog | null>>;
  projectReorder: ReturnType<typeof useProjectReorder>;
}) {
  const scrollRef = useMobileProjectReorder(lib, loaded, busy, projectReorder, attempt);
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
            className="m-btn-primary m-btn-sm"
            onClick={() => setDialog({ type: "newProject", value: "" })}
          >
            <Plus size={16} />
            <span>새 작품</span>
          </button>
        </div>
      </header>

      <div className="m-scroll-body" ref={scrollRef} aria-busy={projectReorder.saving || undefined}>
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
                <div key={p.id} className="m-project-card" data-project-id={p.id}>
                  <button
                    type="button"
                    className="m-project-card-main"
                    title="길게 눌러 드래그하여 순서 변경"
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
                        {docCount > 0 && <span>· 플롯/메모 {docCount}개</span>}
                      </div>
                      {totalChars > 0 && (
                        <div className="m-project-chars">
                          <File size={13.5} />
                          <span>총 {totalChars.toLocaleString()}자</span>
                        </div>
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
                      {p.description && (
                        <p className="m-project-desc">{p.description}</p>
                      )}
                    </div>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

    </div>
  );
}
