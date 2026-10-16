import { platforms, normalizeWriting } from "../core/platforms.mjs";
import type { WritingRules } from "./types";
export default function PlatformPicker({
  value,
  onChange,
  compact = false,
}: {
  value: WritingRules;
  onChange: (p: WritingRules) => void;
  compact?: boolean;
}) {
  const preset =
    platforms.find((p: any) => p.id === value.platform) || platforms[0];
  return (
    <div className={`platform-picker ${compact ? "compact" : ""}`}>
      <label>
        연재 플랫폼
        <select
          aria-label="연재 플랫폼"
          value={value.platform}
          onChange={(e) =>
            onChange(normalizeWriting({ platform: e.target.value }))
          }
        >
          {platforms.map((p: any) => (
            <option value={p.id} key={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {value.platform === "custom" && (
        <label>
          규칙 이름
          <input
            aria-label="사용자 규칙 이름"
            value={value.customName}
            placeholder="예: 내 투고 규칙"
            maxLength={60}
            onChange={(e) => onChange({ ...value, customName: e.target.value })}
          />
        </label>
      )}
      <div className="platform-rule-fields">
        {value.platform === "custom" && <>
        <label>
          계산 방식
          <select
            aria-label="플랫폼 계산 방식"
            value={value.rule}
            onChange={(e) =>
              onChange({
                ...value,
                rule: e.target.value as WritingRules["rule"],
              })
            }
          >
            <option value="noSpace">공백 모두 제외</option>
            <option value="spaces">공백 포함 · 줄바꿈 제외</option>
            <option value="all">공백·줄바꿈 포함 (LF 1자)</option>
            <option value="collapsed">연속 공백·줄바꿈을 1자로</option>
            <option value="novelpia">노벨피아 (공백 제외)</option>
          </select>
        </label>
        <label>
          문장부호
          <select
            aria-label="문장부호 계산"
            disabled={value.rule === "novelpia"}
            value={value.punctuation || "include"}
            onChange={(e) =>
              onChange({
                ...value,
                punctuation: e.target.value as WritingRules["punctuation"],
              })
            }
          >
            <option value="include">포함</option>
            <option value="ascii">. , ! ? ' &quot; 제외</option>
            <option value="unicode">모든 문장부호 제외</option>
          </select>
        </label>
        <label>
          말줄임표 …
          <select aria-label="말줄임표 계산" value={value.ellipsisWeight || 1} disabled={value.rule === "novelpia"}
            onChange={e => onChange({...value, ellipsisWeight: Number(e.target.value)})}>
            <option value="1">1자로 계산</option><option value="3">3자로 계산</option>
          </select>
        </label>
        <label className="check-row">
          <input type="checkbox" aria-label="특수문자 제외" checked={!!value.excludeSpecial} disabled={value.rule === "novelpia"}
            onChange={e => onChange({...value, excludeSpecial: e.target.checked})} />
          문자·숫자·공백 외 특수문자 제외
        </label>
        </>}
        <label>
          개인 목표 글자 수
          <input
            aria-label="목표 글자 수"
            type="number"
            min="1"
            max="1000000"
            value={value.goal}
            onChange={(e) => {
              const goal = Number(e.target.value);
              if (goal >= 1 && goal <= 1000000) onChange({ ...value, goal });
            }}
          />
        </label>
      </div>
      {value.platform !== "custom" && <button type="button" onClick={() => onChange(normalizeWriting({...value, platform: "custom", customName: `${preset.name} 개인 규칙`}))}>사용자 규칙으로 조정</button>}
    </div>
  );
}
