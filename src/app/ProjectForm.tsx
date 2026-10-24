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
import DialogFooter from "../DialogFooter";
import {
  call,
  type Library,
  type Project
} from "../types";
import { insertProject, patchProject, type LibraryChange } from "./library-changes";
import { type Destination, type Dialog } from "./model";

import { useEffect, useId, useRef, useState, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import type * as React from "react";

type Props = {
  dialog: Dialog;
  prefs: Record<string, any>;
  refresh: () => Promise<Library | undefined>;
  changeLibrary: <T>(change: LibraryChange, run: () => Promise<T>) => Promise<T>;
  navigate: (destination: Destination, historyIndex?: number, beforeCommit?: () => void) => Promise<void>;
  projectId: string;
  project: Project | undefined;
  setDialog: React.Dispatch<React.SetStateAction<Dialog | null>>;
  report: (e: any) => void;
  setViewer: React.Dispatch<React.SetStateAction<{ src: string; alt: string; } | null>>;
  attempt: (fn: () => Promise<any>) => () => Promise<any>;
  message: (text: string, action?: { label: string; run: () => void; }) => void;
  askDeleteProject: (id: string) => void;
  mobile?: boolean;
  closeRef?: MutableRefObject<(() => void) | null>;
};

export default function ProjectForm({
  dialog,
  prefs,
  refresh,
  changeLibrary,
  navigate,
  projectId,
  project,
  setDialog,
  report,
  setViewer,
  attempt,
  message,
  askDeleteProject,
  mobile = false,
  closeRef,
}: Props) {
  const formRef = useRef<HTMLFormElement>(null);
  const formId = useId();
  const [closePrompt, setClosePrompt] = useState(false);
  const snapshot = JSON.stringify({
    title: dialog.value || "",
    description: dialog.description || "",
    tags: dialog.tags || [],
    manualLineBreak: dialog.manualLineBreak ?? null,
    writing: normalizeWriting(dialog.writing || project?.writing || prefs.defaultWriting),
  });
  const initialSnapshot = useRef(snapshot);
  const requestClose = () => {
    if (closePrompt) setClosePrompt(false);
    else if (mobile && dialog.type === "editProject" && snapshot !== initialSnapshot.current) setClosePrompt(true);
    else setDialog(null);
  };
  useEffect(() => {
    if (!closeRef) return;
    closeRef.current = requestClose;
    return () => { closeRef.current = null; };
  });
  useEffect(() => {
    if (!mobile || dialog.type !== "editProject") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      requestClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  return (
    <>
      <form
        id={formId}
        ref={formRef}
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
              // 다시 읽기를 기다리지 않고 새 작품을 목록에 넣은 뒤 바로 연다.
              void changeLibrary(insertProject(p), async () => {}).catch(report);
              await navigate({ view: "project", projectId: p.id, tab: "episode", archive: false });
            } else if (dialog.type === "editProject") {
              const id = projectId;
              const patch = {
                title: dialog.value,
                description: dialog.description,
                tags: dialog.tags || [],
                manualLineBreak: dialog.manualLineBreak ?? undefined,
                writing:
                  dialog.writing ||
                  normalizeWriting(
                    project?.writing || prefs.defaultWriting,
                  ),
              };
              setDialog(null);
              await changeLibrary(patchProject(id, patch), () =>
                call("updateProject", { id, ...patch, manualLineBreak: dialog.manualLineBreak ?? null }),
              );
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
                  type="button"
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
                    const saving = changeLibrary(patchProject(projectId, { cover: null, coverData: null }), () =>
                      call("removeCover", { id: projectId }),
                    );
                    message("기본 표지로 바꿨습니다.");
                    await saving;
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
        <DialogFooter>
          {dialog.type === "editProject" && !mobile && (
            <button
              type="button"
              className="danger-outline footer-start"
              onClick={() => askDeleteProject(projectId)}
            >
              <Trash2 size={15} />
              작품 삭제
            </button>
          )}
          <button type="button" onClick={requestClose}>
            취소
          </button>
          <button type="submit" form={formId} className="primary">
            {dialog.type === "editProject" ? "저장" : "만들기"}
          </button>
        </DialogFooter>
      </form>
    {closePrompt && createPortal(
      <div className="modal-backdrop confirm-backdrop m-project-save-confirm">
        <div className="modal confirm-modal" role="alertdialog" aria-modal="true" aria-label="변경 사항 저장">
          <div className="modal-header"><h2>변경 사항을 저장할까요?</h2></div>
          <p>소설 관리에서 변경한 내용을 저장하고 닫을 수 있습니다.</p>
          <div className="modal-footer">
            <button type="button" className="m-project-save-discard" onClick={() => setDialog(null)}>저장 안 함</button>
            <div className="m-project-save-actions">
              <button type="button" autoFocus onClick={() => setClosePrompt(false)}>계속 편집</button>
              <button type="button" className="primary" onClick={() => {
                setClosePrompt(false);
                formRef.current?.requestSubmit();
              }}>저장</button>
            </div>
          </div>
        </div>
      </div>,
      document.querySelector(".app") ?? document.body,
    )}
    </>
  );
}
