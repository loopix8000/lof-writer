export const platforms = [
  { id: "novelpia", name: "노벨피아", rule: "novelpia", goal: 3000,
    status: "공백 제외" },
  { id: "munpia", name: "문피아", rule: "spaces", goal: 5000,
    status: "참고값 · 미검증" },
  { id: "naver", name: "네이버 시리즈", rule: "spaces", goal: 5000,
    status: "참고값 · 미검증" },
  { id: "kakao", name: "카카오페이지", rule: "spaces", goal: 5000,
    status: "참고값 · 미검증" },
  { id: "spaces", name: "공백 포함", rule: "spaces", goal: 5000,
    status: "공백 포함 · 줄바꿈 제외" },
  { id: "manuscript", name: "원고지 규격", rule: "manuscript", goal: 25,
    status: "200자 원고지" },
  { id: "custom", name: "사용자 규칙", rule: "noSpace", goal: 3000,
    status: "사용자 지정" },
];
export function normalizeWriting(input = {}) {
  let preset = platforms.find((p) => p.id === input.platform) || platforms[0];
  // Upgrade alpha.2 generic defaults; retain deliberate rule overrides as custom.
  const legacy = input.version !== 2 && input.platform && input.platform !== "custom";
  const oldRule = input.platform === "novelpia" ? "noSpace" : input.platform === "manuscript" ? "manuscript" : "spaces";
  const override = legacy && input.rule && input.rule !== oldRule;
  const customName = override ? (input.customName || preset.name + " 개인 규칙") : input.customName;
  if (override) preset = platforms.find(p => p.id === "custom");
  const custom = preset.id === "custom";
  const goal = Number(input.goal ?? preset.goal);
  return {
    version: 2,
    platform: preset.id,
    rule: custom && ["noSpace", "spaces", "all", "collapsed", "novelpia", "manuscript"].includes(input.rule) ? input.rule : preset.rule,
    unit: "utf16",
    punctuation: custom && ["include", "ascii", "unicode"].includes(input.punctuation) ? input.punctuation : "include",
    excludeSpecial: custom && input.excludeSpecial === true,
    ellipsisWeight: custom && input.ellipsisWeight === 3 ? 3 : 1,
    goal: Number.isInteger(goal) && goal >= 1 && goal <= 1000000 ? goal : preset.goal,
    customName: String(customName || "").slice(0, 60),
  };
}
export const writingName = rules => rules.platform === "custom" ? rules.customName || "사용자 규칙" : platforms.find(p => p.id === rules.platform)?.name || "사용자 규칙";
export const writingUnit = rules => rules.rule === "manuscript" ? "매" : "자";
