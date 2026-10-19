import {
  Feather,
  Trash2,
  Upload
} from "lucide-react";
import {
  lineBreakLabel
} from "../../core/episode.mjs";
import { normalizeWriting } from "../../core/platforms.mjs";
import CoverImage from "../CoverImage";
import PlatformPicker from "../PlatformPicker";
import TagInput from "../TagInput";
import {
  call,
  type Library,
  type Project
} from "../types";
import { type Destination, type Dialog } from "./model";

import type * as React from "react";

type Props = {
  dialog: Dialog;
  prefs: Record<string, any>;
  refresh: () => Promise<Library | undefined>;
  navigate: (destination: Destination, historyIndex?: number, beforeCommit?: () => void) => Promise<void>;
  projectId: string;
  project: Project | undefined;
  setDialog: React.Dispatch<React.SetStateAction<Dialog | null>>;
  report: (e: any) => void;
  setViewer: React.Dispatch<React.SetStateAction<{ src: string; alt: string; } | null>>;
  attempt: (fn: () => Promise<any>) => () => Promise<any>;
  message: (text: string, action?: { label: string; run: () => void; }) => void;
  askDeleteProject: (id: string) => void;
};

export default function ProjectForm({
  dialog,
  prefs,
  refresh,
  navigate,
  projectId,
  project,
  setDialog,
  report,
  setViewer,
  attempt,
  message,
  askDeleteProject,
}: Props) {

  return (
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
  );
}
