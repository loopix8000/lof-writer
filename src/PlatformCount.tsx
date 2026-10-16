import { useState } from "react";
import { Settings2 } from "lucide-react";
import { manuscriptStats, countForRule, countForWriting } from "../core/text.mjs";
import { platforms } from "../core/platforms.mjs";
import PlatformPicker from "./PlatformPicker";
import type { WritingRules } from "./types";
export default function PlatformCount({
  body,
  rules,
  onChange,
}: {
  body: string;
  rules: WritingRules;
  onChange: (p: WritingRules) => void;
}) {
  const [editing, setEditing] = useState(false);
  const stats = manuscriptStats(body),
    value = countForWriting(stats, rules),
    goal = rules.goal;
  const name =
    rules.platform === "custom"
      ? rules.customName || "사용자 규칙"
      : platforms.find((p: any) => p.id === rules.platform)?.name;
  return (
    <section className="widget platform-widget">
      <div className="widget-title">
        <span>연재 분량 체크</span>
        <button
          aria-label="글자 수 규칙 설정"
          title="플랫폼 / 사용자 규칙"
          onClick={() => setEditing((e) => !e)}
        >
          <Settings2 size={16} />
        </button>
      </div>
      <button className="count-profile" onClick={() => setEditing((e) => !e)}>
        {name}
        <small>
          {rules.rule === "novelpia" ? "공백 제외" : rules.rule === "collapsed" ? "연속 공백 1자" : rules.rule === "noSpace"
            ? "공백 제외"
            : rules.rule === "spaces"
              ? "공백 포함"
              : "줄바꿈 포함"}
        </small>
      </button>
      {editing && <PlatformPicker value={rules} onChange={onChange} compact />}
      <div className="word-count" data-testid="platform-count">
        {value.toLocaleString()}
        <small> / {goal.toLocaleString()}자</small>
      </div>
      <div className="progress">
        <div style={{ width: `${Math.min(100, (value / goal) * 100)}%` }} />
      </div>
      <div className="goal-row">
        <span>
          {value >= goal
            ? "목표 달성 · " + (value - goal).toLocaleString() + "자 초과"
            : (goal - value).toLocaleString() + "자 남음"}
        </span>
        <b>{Math.round((value / goal) * 100)}%</b>
      </div>
      <dl className="count-breakdown">
        <div>
          <dt>공백 제외</dt>
          <dd>{countForRule(stats,'noSpace',rules.unit).toLocaleString()}</dd>
        </div>
        <div>
          <dt>공백 포함 · 줄바꿈 제외</dt>
          <dd>{countForRule(stats,'spaces',rules.unit).toLocaleString()}</dd>
        </div>
        <div>
          <dt>줄바꿈까지 포함</dt>
          <dd>{countForRule(stats,'all',rules.unit).toLocaleString()}</dd>
        </div>
        <div>
          <dt>문단 / 줄</dt>
          <dd>
            {stats.paragraphs} / {stats.lines}
          </dd>
        </div>
      </dl>
    </section>
  );
}
