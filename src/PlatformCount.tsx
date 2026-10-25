import { useState } from "react";
import { Settings2 } from "lucide-react";
import { countForRule, manuscriptPaperPages } from "../core/text.mjs";
import type { ManuscriptCounts } from "./manuscript-counts";
import { platforms } from "../core/platforms.mjs";
import PlatformPicker from "./PlatformPicker";
import type { WritingRules } from "./types";
export default function PlatformCount({
  stats,
  rules,
  onChange,
  documentOnly = false,
}: {
  stats: ManuscriptCounts | null;
  rules: WritingRules;
  onChange: (p: WritingRules) => void;
  documentOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const unit = documentOnly ? "utf16" : rules.unit,
    goal = rules.goal;
  const value = stats ? documentOnly ? countForRule(stats, "spaces", unit) : stats.platformCharacters : 0;
  const count = (rule: string) => stats ? countForRule(stats, rule, unit).toLocaleString() : "…";
  const name =
    rules.platform === "custom"
      ? rules.customName || "사용자 규칙"
      : platforms.find((p: any) => p.id === rules.platform)?.name;
  return (
    <section className="widget platform-widget">
      <div className="widget-title">
        <span>{documentOnly ? "글자 수" : "연재 분량 체크"}</span>
        {!documentOnly && <button
          aria-label="글자 수 규칙 설정"
          title="플랫폼 / 사용자 규칙"
          onClick={() => setEditing((e) => !e)}
        >
          <Settings2 size={16} />
        </button>}
      </div>
      {!documentOnly && <>
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
      </>}
      <div className="word-count" data-testid={documentOnly ? "document-count" : "platform-count"}>
        {stats ? value.toLocaleString() : "…"}
        <small>{documentOnly ? "자" : ` / ${goal.toLocaleString()}자`}</small>
      </div>
      {!documentOnly && <>
      <div className="progress">
        <div style={{ width: `${Math.min(100, (value / goal) * 100)}%` }} />
      </div>
      <div className="goal-row">
        <span>
          {!stats ? "계산 중…" : value >= goal
            ? "목표 달성 · " + (value - goal).toLocaleString() + "자 초과"
            : (goal - value).toLocaleString() + "자 남음"}
        </span>
        <b>{stats ? `${Math.round((value / goal) * 100)}%` : "…"}</b>
      </div>
      </>}
      <dl className="count-breakdown">
        <div>
          <dt>공백 제외</dt>
          <dd>{count('noSpace')}</dd>
        </div>
        <div>
          <dt>공백 포함 · 줄바꿈 제외</dt>
          <dd>{count('spaces')}</dd>
        </div>
        <div>
          <dt>줄바꿈까지 포함</dt>
          <dd>{count('all')}</dd>
        </div>
        <div>
          <dt>200자 원고지</dt>
          <dd>{stats ? `${manuscriptPaperPages(stats.manuscriptLines ?? 0).toLocaleString()}매` : "…"}</dd>
        </div>
        <div>
          <dt>문단 / 줄</dt>
          <dd>
            {stats?.paragraphs ?? "…"} / {stats?.lines ?? "…"}
          </dd>
        </div>
      </dl>
    </section>
  );
}
