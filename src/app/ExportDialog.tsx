import { Download } from "lucide-react";
import { useState } from "react";
import { call, type Library } from "../types";
import SettingsToggle from "./SettingsToggle";
import DialogFooter from "../DialogFooter";

type Props = {
  lib: Library;
  projectId?: string;
  defaultPreserveBreaks: boolean;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  flush: () => Promise<void>;
  onCancel: () => void;
  onSuccess: (result: { path: string; fileCount: number; projectCount: number }) => void;
  report: (error: any) => void;
};

export default function ExportDialog({
  lib,
  projectId,
  defaultPreserveBreaks,
  busy,
  setBusy,
  flush,
  onCancel,
  onSuccess,
  report,
}: Props) {
  const [format, setFormat] = useState<"txt" | "md">("txt");
  const [includeEpisodes, setIncludeEpisodes] = useState(true);
  const [includeDocs, setIncludeDocs] = useState(true);
  const [includeCommonMemos, setIncludeCommonMemos] = useState(true);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [mergeEpisodes, setMergeEpisodes] = useState(false);
  const [preserveParagraphBreaks, setPreserveParagraphBreaks] = useState(defaultPreserveBreaks);

  const isProjectExport = Boolean(projectId);
  const targetProject = isProjectExport
    ? lib.projects.find((p) => p.id === projectId)
    : undefined;

  const nothingSelected =
    !includeEpisodes &&
    !includeDocs &&
    (isProjectExport || !includeCommonMemos);

  async function runExport() {
    if (busy || nothingSelected) return;
    setBusy(true);
    try {
      await flush();
      const result = await call<{
        path: string;
        fileCount: number;
        projectCount: number;
      } | null>(isProjectExport ? "exportProject" : "exportLibrary", {
        projectId: projectId || undefined,
        format,
        includeEpisodes,
        includeDocs,
        includeCommonMemos: !isProjectExport && includeCommonMemos,
        includeArchived,
        mergeEpisodes,
        preserveParagraphBreaks,
      });
      if (result) {
        onSuccess(result);
      }
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="export-dialog">
      <p className="muted" style={{ marginTop: 0 }}>
        {isProjectExport ? (
          <>
            <b>{targetProject?.title || "제목 없는 작품"}</b> 작품을 내부 관리용 메타
            정보 없이 바로 열람할 수 있는 파일로 내보냅니다.
          </>
        ) : (
          <>
            현재 서재의 작품({lib.projects.length}작품)과 문서를 내부 관리용 메타 정보
            없이 바로 열람할 수 있는 폴더와 파일로 내보냅니다.
          </>
        )}
      </p>

      <fieldset className="linebreak-options">
        <legend>파일 형식</legend>
        <div className="linebreak-choices">
          {(
            [
              [
                "txt",
                "일반 텍스트 (.txt)",
                "Markdown 문법과 내부 관리 정보를 모두 제거한 순수 텍스트 본문으로 저장합니다.",
              ],
              [
                "md",
                "마크다운 (.md)",
                "내부 관리용 메타 정보(YAML 프론트매터)만 제거하고 마크다운 서식은 유지합니다.",
              ],
            ] as const
          ).map(([val, title, desc]) => (
            <label
              key={val}
              className={`linebreak-choice${format === val ? " selected" : ""}`}
            >
              <input
                type="radio"
                name="exportFormat"
                value={val}
                checked={format === val}
                onChange={() => setFormat(val)}
              />
              <span>
                <strong>{title}</strong>
                <span>{desc}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {includeEpisodes && (
        <fieldset className="linebreak-options" style={{ marginTop: 14 }}>
          <legend>회차 저장 방식</legend>
          <div className="linebreak-choices">
            {(
              [
                [
                  false,
                  "회차별 개별 파일",
                  "001 1화, 002 2화처럼 회차마다 별도 파일로 저장합니다.",
                ],
                [
                  true,
                  "단일 파일로 합치기 (합본)",
                  "작품의 모든 회차를 순서대로 하나의 파일로 묶어 저장합니다.",
                ],
              ] as const
            ).map(([merged, title, desc]) => (
              <label
                key={String(merged)}
                className={`linebreak-choice${mergeEpisodes === merged ? " selected" : ""}`}
              >
                <input
                  type="radio"
                  name="exportEpisodeMode"
                  value={String(merged)}
                  checked={mergeEpisodes === merged}
                  onChange={() => setMergeEpisodes(merged)}
                />
                <span>
                  <strong>
                    {title}
                    {!merged && <small>기본</small>}
                  </strong>
                  <span>{desc}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div className="settings-toggles" style={{ marginTop: 14 }}>
        <SettingsToggle
          label="에피소드 (원고)"
          description="작품의 회차 원고를 순서대로 내보냅니다."
          checked={includeEpisodes}
          onChange={setIncludeEpisodes}
        />
        <SettingsToggle
          label="플롯 · 작품 메모"
          description="작품 안의 플롯과 메모 문서를 폴더 구조 그대로 내보냅니다."
          checked={includeDocs}
          onChange={setIncludeDocs}
        />
        {!isProjectExport && (
          <SettingsToggle
            label="공용 메모"
            description="여러 작품에서 함께 쓰는 공용 메모 폴더의 문서를 함께 내보냅니다."
            checked={includeCommonMemos}
            onChange={setIncludeCommonMemos}
          />
        )}
        <SettingsToggle
          label="보관함 문서 포함"
          description="보관함에 넣어 둔 에피소드와 문서도 '보관함' 하위 폴더로 함께 내보냅니다."
          checked={includeArchived}
          onChange={setIncludeArchived}
        />
        {format === "txt" && (
          <SettingsToggle
            label="자동 줄바꿈 문단 사이 빈 줄 유지"
            description="자동 줄바꿈 문서를 텍스트(.txt)로 내보낼 때 문단 사이에 빈 줄을 한 줄 넣습니다."
            checked={preserveParagraphBreaks}
            onChange={setPreserveParagraphBreaks}
          />
        )}
      </div>

      <DialogFooter style={{ marginTop: 18 }}>
        <button type="button" disabled={busy} onClick={onCancel}>
          취소
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || nothingSelected}
          onClick={runExport}
        >
          <Download size={15} />
          {busy ? "내보내는 중…" : "폴더 선택 후 내보내기"}
        </button>
      </DialogFooter>
    </div>
  );
}
