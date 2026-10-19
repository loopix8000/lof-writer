import {
  BookOpen,
  FileText
} from "lucide-react";
import type * as React from "react";
import {
  DEFAULT_EDITOR_STYLE,
  DEFAULT_NOTE_EDITOR_STYLE,
  DIVIDER_STYLES,
  FONT_FAMILY_PRESETS,
  PLATFORM_STYLE_PRESETS,
  TYPESETTING_KINDS,
  WIDTH_PRESETS,
  normalizeEditorStyle
} from "../../core/typesetting.mjs";
import {
  type Kind
} from "../types";

import SettingsToggle from "./SettingsToggle";

type Props = {
  prefs: Record<string, any>;
  saveKindPrefs: (kind: Kind | "document", patch: Record<string, any>) => Promise<void>;
  report: (e: any) => void;
  message: (text: string, action?: { label: string; run: () => void; }) => void;
  setTypesettingKind: React.Dispatch<React.SetStateAction<"episode" | "document">>;
  targetKind: "episode" | "document";
  inPanel: boolean;
};

export default function TypesettingSettings({ prefs, saveKindPrefs, report, message, setTypesettingKind, targetKind, inPanel }: Props) {


  const targetKindInfo =
    TYPESETTING_KINDS.find((k) => k.id === targetKind) || TYPESETTING_KINDS[0];
  const kindEditorStyle = normalizeEditorStyle(prefs, targetKind);
  const allWidthItems = WIDTH_PRESETS.flatMap((g) => g.items);
  const updateTargetPrefs = (patch: Record<string, any>) =>
    saveKindPrefs(targetKind, patch).catch(report);
  const resetTargetPrefs = () => {
    const isNote = targetKind === "document";
    const defPatch = isNote
      ? { ...DEFAULT_NOTE_EDITOR_STYLE }
      : { ...DEFAULT_EDITOR_STYLE };
    saveKindPrefs(targetKind, defPatch)
      .then(() =>
        message(
          `'${targetKindInfo.label}' 조판을 ${isNote ? "메모장 기본값" : "원고 기본값"}으로 초기화했습니다.`,
        ),
      )
      .catch(report);
  };
  return (
    <>
      <div className="typesetting-kind-bar">
        {inPanel ? (
          <strong className="typesetting-kind-current">{targetKindInfo.label}</strong>
        ) : (
          <div className="typesetting-kind-tabs" role="tablist" aria-label="조판 대상 문서 타입">
            {TYPESETTING_KINDS.map((k) => {
              const KIcon = k.id === "episode" ? BookOpen : FileText;
              const selected = targetKind === k.id;
              return (
                <button
                  key={k.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className={`typesetting-kind-tab ${selected ? "active" : ""}`}
                  onClick={() => setTypesettingKind(k.id)}
                >
                  <KIcon size={15} />
                  <span>{k.label}</span>
                </button>
              );
            })}
          </div>
        )}
        <div className="typesetting-kind-meta">
          <span>{targetKindInfo.description}</span>
          <div className="row gap">
            <button type="button" onClick={resetTargetPrefs}>
              {targetKind === "episode" ? "원고 기본값 초기화" : "메모장 기본값 초기화"}
            </button>
          </div>
        </div>
      </div>

      <h3>{targetKindInfo.label} · 플랫폼·환경 조판 프리셋</h3>
      <p className="settings-description">
        현재 선택한 <strong>{targetKindInfo.label}</strong> 문서 타입에 조판 프리셋을 한 번에 적용합니다.
      </p>
      <div className="preset-grid">
        {PLATFORM_STYLE_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="preset-card"
            // 사이드바에서는 이름만 보이고 설명은 마우스를 올리면 보여 준다.
            title={inPanel ? preset.description : undefined}
            onClick={() => {
              updateTargetPrefs(preset.style);
              message(
                `'${targetKindInfo.label}'에 '${preset.name} (${preset.environment})' 조판 프리셋을 적용했습니다.`,
              );
            }}
          >
            <strong>
              {preset.name} <small>({preset.environment})</small>
            </strong>
            {!inPanel && <small>{preset.description}</small>}
          </button>
        ))}
      </div>

      <div className="settings-subsection">
        <h3>{targetKindInfo.label} · 문단·본문 조판 세부 설정</h3>
        <p className="settings-description">
          글꼴, 자간, 단락 간격, 첫 줄 들여쓰기, 정렬, 구분선 모양을 세밀하게 조정합니다.
        </p>
        <div className="settings-grid">
          <label>
            본문 글꼴
            <select
              aria-label="본문 글꼴"
              value={kindEditorStyle.fontFamily}
              onChange={(e) =>
                updateTargetPrefs({ fontFamily: e.target.value })
              }
            >
              {FONT_FAMILY_PRESETS.map((f) => (
                <option key={f.id || "default"} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            글자 크기 (px)
            <input
              type="number"
              min={12}
              max={36}
              step={1}
              aria-label="조판 글자 크기"
              value={kindEditorStyle.fontSize}
              onChange={(e) =>
                updateTargetPrefs({
                  fontSize: Math.min(36, Math.max(12, Number(e.target.value) || 18)),
                })
              }
            />
          </label>
          <label>
            글자 굵기
            <select
              aria-label="글자 굵기"
              value={kindEditorStyle.fontWeight}
              onChange={(e) =>
                updateTargetPrefs({ fontWeight: Number(e.target.value) })
              }
            >
              {[300, 400, 500, 600, 700].map((w) => (
                <option key={w} value={w}>
                  {w === 300 ? "300 (가는 글씨)" : w === 400 ? "400 (보통)" : w === 500 ? "500 (중간)" : w === 600 ? "600 (약간 굵게)" : "700 (굵게)"}
                </option>
              ))}
            </select>
          </label>
          <label>
            자간 (em)
            <input
              type="number"
              min={-0.1}
              max={0.25}
              step={0.01}
              aria-label="자간"
              value={kindEditorStyle.letterSpacing}
              onChange={(e) =>
                updateTargetPrefs({
                  letterSpacing: Number(e.target.value) || 0,
                })
              }
            />
          </label>
          <label>
            줄 간격 (행간)
            <input
              type="number"
              min={1.2}
              max={3.5}
              step={0.05}
              aria-label="조판 줄 간격"
              value={kindEditorStyle.lineHeight}
              onChange={(e) =>
                updateTargetPrefs({
                  lineHeight: Number(e.target.value) || 2,
                })
              }
            />
          </label>
          <label>
            단락 간격 (em)
            <input
              type="number"
              min={0}
              max={3.5}
              step={0.05}
              aria-label="단락 간격"
              value={kindEditorStyle.blockGap}
              onChange={(e) =>
                updateTargetPrefs({
                  blockGap: Math.max(0, Number(e.target.value) || 0),
                })
              }
            />
          </label>
          <label>
            첫 줄 들여쓰기 (em)
            <select
              aria-label="첫 줄 들여쓰기"
              value={kindEditorStyle.indent}
              onChange={(e) =>
                updateTargetPrefs({ indent: Number(e.target.value) })
              }
            >
              <option value={0}>없음 (0em)</option>
              <option value={0.5}>반 칸 (0.5em)</option>
              <option value={1}>한 칸 (1em · 종이책/노벨피아)</option>
              <option value={1.5}>한 칸 반 (1.5em)</option>
              <option value={2}>두 칸 (2em)</option>
            </select>
          </label>
          <label>
            문단 정렬
            <select
              aria-label="문단 정렬"
              value={kindEditorStyle.textAlign}
              onChange={(e) =>
                updateTargetPrefs({ textAlign: e.target.value })
              }
            >
              <option value="left">왼쪽 정렬</option>
              <option value="justify">양쪽 정렬 (종이책 조판)</option>
              <option value="center">가운데 정렬</option>
              <option value="right">오른쪽 정렬</option>
            </select>
          </label>
          <label>
            구분선 모양
            <select
              aria-label="구분선 모양"
              value={kindEditorStyle.dividerStyle}
              onChange={(e) =>
                updateTargetPrefs({ dividerStyle: e.target.value })
              }
            >
              {DIVIDER_STYLES.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label} — {d.description}
                </option>
              ))}
            </select>
          </label>
          <label>
            구분선 상하 여백 (em)
            <input
              type="number"
              min={0.25}
              max={5}
              step={0.25}
              aria-label="구분선 상하 여백"
              value={kindEditorStyle.dividerPaddingY}
              onChange={(e) =>
                updateTargetPrefs({
                  dividerPaddingY: Math.max(0.25, Number(e.target.value) || 1.5),
                })
              }
            />
          </label>
        </div>
        <div className="settings-toggles" style={{ marginTop: 16 }}>
          <SettingsToggle
            label="강제 줄바꿈(Shift+Enter) 뒤 들여쓰기"
            description="단락 안에서 강제로 줄을 바꾼 다음 줄에도 첫 줄 들여쓰기 폭을 똑같이 적용합니다."
            checked={kindEditorStyle.hardBreakIndent}
            onChange={(checked) =>
              updateTargetPrefs({ hardBreakIndent: checked })
            }
          />
          <SettingsToggle
            label="동양식 세리프 문장 부호"
            description="본문이 고딕 글꼴이어도 곡선 따옴표(“ ” ‘ ’), 낫표(「 」 『 』), 말줄임표(…)를 명조 글리프로 조판합니다."
            checked={kindEditorStyle.serifSymbols}
            onChange={(checked) =>
              updateTargetPrefs({ serifSymbols: checked })
            }
          />
        </div>
      </div>

      <div className="settings-subsection">
        <h3>{targetKindInfo.label} · 원고지 폭 · 용지 · 쪽 보기</h3>
        <p className="settings-description">
          원고 영역의 최대 폭을 종이 규격·모바일·태블릿 단말기에 맞추거나 A4 쪽 보기로 전환합니다.
        </p>
        <div className="settings-grid">
          <label>
            단말기 / 용지 폭 프리셋
            <select
              aria-label="단말기 및 용지 폭 프리셋"
              value={
                allWidthItems.some((w) => w.width === kindEditorStyle.editorMaxWidth)
                  ? String(kindEditorStyle.editorMaxWidth)
                  : "custom"
              }
              onChange={(e) => {
                if (e.target.value !== "custom") {
                  updateTargetPrefs({ editorMaxWidth: Number(e.target.value) });
                }
              }}
            >
              <option value="custom">직접 지정 ({kindEditorStyle.editorMaxWidth}px)</option>
              {WIDTH_PRESETS.map((group) => (
                <optgroup key={group.group} label={group.group}>
                  {group.items.map((w) => (
                    <option key={w.id} value={w.width}>
                      {w.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <label>
            원고 최대 너비 (px)
            <input
              type="number"
              min={350}
              max={3000}
              step={10}
              aria-label="원고 최대 너비"
              value={kindEditorStyle.editorMaxWidth}
              onChange={(e) =>
                updateTargetPrefs({
                  editorMaxWidth: Math.min(3000, Math.max(350, Number(e.target.value) || 760)),
                })
              }
            />
          </label>
          <label>
            원고 좌우 여백 (단계)
            <input
              type="number"
              min={0}
              max={10}
              step={1}
              aria-label="원고 좌우 여백"
              value={kindEditorStyle.editorPaddingX}
              onChange={(e) =>
                updateTargetPrefs({
                  editorPaddingX: Math.min(10, Math.max(0, Number(e.target.value) || 0)),
                })
              }
            />
          </label>
          <label>
            원고지 배경색 / 글자색
            <div className="color-pair-row">
              <input
                type="color"
                aria-label="원고지 배경색"
                title="원고지 배경색"
                value={kindEditorStyle.textareaBgColor || "#ffffff"}
                onChange={(e) =>
                  updateTargetPrefs({ textareaBgColor: e.target.value })
                }
              />
              <input
                type="color"
                aria-label="본문 글자색"
                title="본문 글자색"
                value={kindEditorStyle.editorTextColor || "#222222"}
                onChange={(e) =>
                  updateTargetPrefs({ editorTextColor: e.target.value })
                }
              />
              {(kindEditorStyle.textareaBgColor || kindEditorStyle.editorTextColor) && (
                <button
                  type="button"
                  onClick={() =>
                    updateTargetPrefs({ textareaBgColor: "", editorTextColor: "" })
                  }
                >
                  초기화
                </button>
              )}
            </div>
          </label>
        </div>
        <div className="settings-toggles" style={{ marginTop: 16 }}>
          <SettingsToggle
            label="A4 인쇄 규격 쪽 보기 (210mm × 297mm)"
            description="원고 영역을 실제 A4 인쇄 시트(여백 20mm·15mm)와 페이지 구분선으로 표시합니다."
            checked={kindEditorStyle.pageViewEnabled}
            onChange={(checked) =>
              updateTargetPrefs({ pageViewEnabled: checked })
            }
          />
        </div>
      </div>
    </>
  );

}
