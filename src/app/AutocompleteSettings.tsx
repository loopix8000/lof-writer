import { Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import type * as React from "react";
import { DEFAULT_TEXT_REPLACEMENTS, normalizeTextReplacements } from "../../core/typing.mjs";
import type { Doc } from "../types";
import SettingsToggle from "./SettingsToggle";

type Props = {
  prefs: Record<string, any>;
  savePrefs: (p: Record<string, any>) => Promise<void>;
  report: (e: any) => void;
  message: (text: string, action?: { label: string; run: () => void; }) => void;
  newRepFrom: string;
  newRepTo: string;
  newRepLabel: string;
  setNewRepFrom: React.Dispatch<React.SetStateAction<string>>;
  setNewRepTo: React.Dispatch<React.SetStateAction<string>>;
  setNewRepLabel: React.Dispatch<React.SetStateAction<string>>;
  active: Doc | null;
  isProtected: boolean;
  replaceActiveSymbols: () => void;
};

export default function AutocompleteSettings({
  prefs,
  savePrefs,
  report,
  message,
  active,
  isProtected,
  replaceActiveSymbols,
  newRepFrom,
  newRepTo,
  newRepLabel,
  setNewRepFrom,
  setNewRepTo,
  setNewRepLabel,
}: Props) {
  const rules = normalizeTextReplacements(prefs.textReplacements);
  const updateRules = (nextRules: typeof rules) =>
    savePrefs({ textReplacements: nextRules }).catch(report);
  const addRule = () => {
    const from = newRepFrom;
    const to = newRepTo;
    if (!from || !to) return;
    const next = [
      ...rules,
      {
        id: `custom-${Date.now()}`,
        from,
        to,
        enabled: true,
        label: newRepLabel.trim(),
      },
    ];
    setNewRepFrom("");
    setNewRepTo("");
    setNewRepLabel("");
    updateRules(next);
  };
  return (
    <>
      <h3>따옴표 · 괄호 · 말줄임 치환</h3>
      <p className="settings-description">
        집필 중 따옴표, 괄호, 말줄임표, 구분선을 입력할 때 자동으로 짝을 맞추거나 출판 부호로 치환합니다.
      </p>
      <div className="settings-toggles" style={{ marginTop: 14 }}>
        <SettingsToggle
          label="따옴표 자동 닫기"
          description="여는 따옴표를 입력하면 닫는 따옴표를 함께 넣습니다. 현재 줄의 커서 앞에 같은 종류의 따옴표가 홀수 개이면 자동 닫기를 생략합니다. 줄 끝 닫는 따옴표 앞에서 Enter를 누르면 다음 문단으로 빠져나갑니다."
          checked={prefs.autoCloseQuotes !== false}
          onChange={(checked) =>
            savePrefs({ autoCloseQuotes: checked }).catch(report)
          }
        />
        <SettingsToggle
          label="곡선 따옴표 사용"
          description="직선 따옴표를 입력하면 곡선 따옴표 “ ” ‘ ’로 바꿉니다. 끄면 직선 따옴표를 사용합니다."
          checked={prefs.quoteStyle === "curly"}
          onChange={(checked) =>
            savePrefs({ quoteStyle: checked ? "curly" : "straight" }).catch(report)
          }
        />
        <SettingsToggle
          label="괄호 자동 닫기"
          description="여는 괄호 ( [ { 〈 《 「 『 를 입력하면 짝이 되는 닫는 괄호를 함께 넣습니다."
          checked={prefs.autoCloseBrackets !== false}
          onChange={(checked) =>
            savePrefs({ autoCloseBrackets: checked }).catch(report)
          }
        />
        <SettingsToggle
          label="괄호 연속 입력 변환"
          description="빈 괄호 안에서 여는 괄호를 한 번 더 누르면 겹화살괄호·낫표·겹낫표((|) → 《|》, [|] → 「|」 → 『|』, {|} → 〈|〉 → 《|》)로 변환합니다."
          checked={prefs.smartBrackets !== false}
          onChange={(checked) =>
            savePrefs({ smartBrackets: checked }).catch(report)
          }
        />
        <SettingsToggle
          label="구분선 자동 변환"
          description="빈 줄에서 --- 또는 *** 를 입력하면 원고 구분선으로 즉시 변환합니다."
          checked={prefs.autoDividerReplacement !== false}
          onChange={(checked) =>
            savePrefs({ autoDividerReplacement: checked }).catch(report)
          }
        />
      </div>
      <div className="row gap" style={{ marginTop: 14, flexWrap: "wrap" }}>
        <button
          type="button"
          disabled={!active || isProtected}
          onClick={replaceActiveSymbols}
        >
          <Sparkles size={15} />
          현재 문서 따옴표 · 말줄임표 일괄 교정
        </button>
        <small className="muted">
          {active
            ? `열린 문서 '${active.title || "제목 없음"}'에 곡선 따옴표 설정과 활성화된 '...' 대치어를 적용합니다.`
            : "문서를 열면 곡선 따옴표 설정과 활성화된 '...' 대치어를 본문에 한 번에 적용할 수 있습니다."}
        </small>
      </div>

      <div className="settings-subsection">
        <div className="typesetting-scope-header">
          <h3>사용자 대치어</h3>
          <button
            type="button"
            onClick={() =>
              savePrefs({
                textReplacements: DEFAULT_TEXT_REPLACEMENTS.map((r) => ({ ...r })),
              })
                .then(() => message("기본 대치어 목록으로 복원했습니다."))
                .catch(report)
            }
          >
            <RefreshCw size={14} />
            기본 대치어 복원
          </button>
        </div>
        <p className="settings-description">
          자주 쓰는 특수 기호나 상용구를 등록해 두면, 입력어를 치는 즉시 대치어로 자동 변환합니다. 말줄임표도 아래 목록에서 변환 결과를 수정하거나 끌 수 있습니다.
        </p>
        <div className="settings-toggles" style={{ marginBottom: 14 }}>
          <SettingsToggle
            label="사용자 대치어 사용"
            description="집필 중 아래 목록에 켜져 있는 입력어가 완성되면 대치어로 즉시 바꿉니다."
            checked={prefs.autoSymbolReplacement !== false}
            onChange={(checked) =>
              savePrefs({ autoSymbolReplacement: checked }).catch(report)
            }
          />
        </div>
        <div className="replacement-add-row">
          <input
            type="text"
            aria-label="새 대치어 입력어"
            placeholder="입력어 (예: --, ->, ㅇㅇ)"
            value={newRepFrom}
            onChange={(e) => setNewRepFrom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addRule();
              }
            }}
          />
          <span className="replacement-arrow" aria-hidden="true">
            →
          </span>
          <input
            type="text"
            aria-label="새 대치어 변환 결과"
            placeholder="대치어 (예: —, →, 상용구)"
            value={newRepTo}
            onChange={(e) => setNewRepTo(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addRule();
              }
            }}
          />
          <input
            type="text"
            aria-label="새 대치어 설명"
            placeholder="설명 (선택)"
            value={newRepLabel}
            onChange={(e) => setNewRepLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addRule();
              }
            }}
          />
          <button
            type="button"
            className="primary"
            disabled={!newRepFrom || !newRepTo}
            onClick={addRule}
          >
            <Plus size={15} />
            추가
          </button>
        </div>
        <div className="replacement-list" role="list" aria-label="사용자 대치어 목록">
          {rules.map((rule, idx) => (
            <div
              key={rule.id || idx}
              role="listitem"
              className={`replacement-row ${rule.enabled ? "" : "disabled"}`}
            >
              <input
                type="checkbox"
                aria-label={`${rule.from} 대치어 사용`}
                checked={rule.enabled}
                onChange={(e) => {
                  const next = rules.map((r, i) =>
                    i === idx ? { ...r, enabled: e.target.checked } : r,
                  );
                  updateRules(next);
                }}
              />
              <input
                type="text"
                className="replacement-from"
                aria-label={`${idx + 1}번 입력어`}
                value={rule.from}
                onChange={(e) => {
                  const val = e.target.value;
                  if (!val) return;
                  const next = rules.map((r, i) =>
                    i === idx ? { ...r, from: val } : r,
                  );
                  updateRules(next);
                }}
              />
              <span className="replacement-arrow" aria-hidden="true">
                →
              </span>
              <input
                type="text"
                className="replacement-to"
                aria-label={`${idx + 1}번 대치어`}
                value={rule.to}
                onChange={(e) => {
                  const next = rules.map((r, i) =>
                    i === idx ? { ...r, to: e.target.value } : r,
                  );
                  updateRules(next);
                }}
              />
              <input
                type="text"
                className="replacement-label"
                aria-label={`${idx + 1}번 대치어 설명`}
                placeholder="설명"
                value={rule.label || ""}
                onChange={(e) => {
                  const next = rules.map((r, i) =>
                    i === idx ? { ...r, label: e.target.value } : r,
                  );
                  updateRules(next);
                }}
              />
              <button
                type="button"
                className="replacement-delete"
                aria-label={`${rule.from} 대치어 삭제`}
                title="삭제"
                onClick={() => {
                  const next = rules.filter((_, i) => i !== idx);
                  updateRules(next);
                }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          {!rules.length && (
            <p className="muted" style={{ padding: "12px 0", margin: 0 }}>
              등록된 대치어가 없습니다. 위 입력칸에서 새 대치어를 추가하거나 기본 대치어를 복원하세요.
            </p>
          )}
        </div>
      </div>
    </>
  );
}
