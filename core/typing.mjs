export const DEFAULT_TEXT_REPLACEMENTS = [
  { id: "ellipsis", from: "...", to: "……", enabled: true, label: "말줄임표" },
  { id: "em-dash", from: "--", to: "—", enabled: true, label: "줄표 (엠 대시)" },
  { id: "double-angle-open", from: "<<", to: "《", enabled: true, label: "여는 겹화살괄호" },
  { id: "double-angle-close", from: ">>", to: "》", enabled: true, label: "닫는 겹화살괄호" },
  { id: "corner-open", from: "[[", to: "『", enabled: true, label: "여는 겹낫표" },
  { id: "corner-close", from: "]]", to: "』", enabled: true, label: "닫는 겹낫표" },
  { id: "arrow-right", from: "->", to: "→", enabled: true, label: "오른쪽 화살표" },
  { id: "arrow-left", from: "<-", to: "←", enabled: true, label: "왼쪽 화살표" },
];

export function normalizeTextReplacements(raw) {
  if (!Array.isArray(raw)) {
    return DEFAULT_TEXT_REPLACEMENTS.map((r) => ({ ...r }));
  }
  return raw
    .filter(
      (r) =>
        r &&
        typeof r === "object" &&
        typeof r.from === "string" &&
        r.from.length > 0 &&
        typeof r.to === "string",
    )
    .map((r, idx) => ({
      id: typeof r.id === "string" && r.id ? r.id : `rule-${idx}`,
      from: r.from,
      to: r.to,
      enabled: r.enabled !== false,
      label: typeof r.label === "string" ? r.label : "",
    }));
}

// 기존 말줄임표 설정을 한 번만 대치어로 옮겨 삭제·비활성화한 규칙이 되살아나지 않게 한다.
export function migrateTypingPreferences(prefs = {}) {
  if (Number(prefs.textReplacementsVersion) >= 1) return prefs;
  const rules = normalizeTextReplacements(prefs.textReplacements);
  const legacyEllipsis = typeof prefs.ellipsis === "string" ? prefs.ellipsis : "……";
  const ellipsisRule = {
    ...DEFAULT_TEXT_REPLACEMENTS[0],
    to: legacyEllipsis || "……",
    enabled: legacyEllipsis !== "",
  };
  if (!Array.isArray(prefs.textReplacements)) {
    rules[0] = ellipsisRule;
  } else if (!rules.some((rule) => rule.from === "...")) {
    rules.unshift(ellipsisRule);
  }
  return { ...prefs, textReplacements: rules, textReplacementsVersion: 1 };
}

export const defaultTyping = {
  autoCloseQuotes: true,
  autoCloseBrackets: true,
  smartBrackets: true,
  autoSymbolReplacement: true,
  autoDividerReplacement: true,
  quoteStyle: "straight",
  textReplacements: DEFAULT_TEXT_REPLACEMENTS,
};

const quotePairs = {
  '"': '"',
  "'": "'",
  "“": "”",
  "‘": "’",
  "「": "」",
  "『": "』",
  "《": "》",
  "〈": "〉",
};

const brackets = { "(": ")", "[": "]", "{": "}" };

const bracketUpgrades = {
  "(": { "(": ["《", "》"] },
  "[": { "[": ["「", "」"], "「": ["『", "』"] },
  "{": { "{": ["〈", "〉"], "〈": ["《", "》"] },
};

export function typingPlan(before, selected, after, input, options = {}) {
  const opts = { ...defaultTyping, ...options };
  if (input.length !== 1 || opts.composing || opts.inCode) return null;

  const slashes = before.match(/\\+$/)?.[0].length || 0;
  const escaped = slashes % 2 === 1;

  // 주석 기호(<!-- -->)는 줄표·화살표 대치어보다 먼저 처리한다.
  if (!selected) {
    if (input === "-" && before.endsWith("<!"))
      return { deleteBefore: 0, deleteAfter: 0, insert: "-", caret: 1 };
    // 주석 열기를 입력하면 닫기를 함께 넣는다. 주석 안에서는 바깥 주석이 일찍 닫히지 않게 생략한다.
    if (input === "-" && before.endsWith("<!-")) {
      const pair = !opts.inComment && opts.autoCloseBrackets !== false && !after.startsWith("-->");
      return { deleteBefore: 0, deleteAfter: 0, insert: pair ? "-  -->" : "-", caret: pair ? 2 : 1 };
    }
    // 주석 닫기는 사용자 대치어보다 먼저 처리한다.
    if (input === ">" && before.endsWith("--"))
      return { deleteBefore: 0, deleteAfter: 0, insert: ">", caret: 1 };
  }

  // 1) 스마트 괄호 업그레이드: 빈 (), [], {} 안에서 같은 여는 괄호를 한 번 더 누르면 겹화살괄호·낫표 등으로 전환
  if (
    !selected &&
    !escaped &&
    opts.autoCloseBrackets !== false &&
    opts.smartBrackets !== false &&
    bracketUpgrades[input]
  ) {
    const prevChar = before.at(-1);
    const upgrade = prevChar ? bracketUpgrades[input][prevChar] : null;
    const expectedClose = prevChar ? (brackets[prevChar] || quotePairs[prevChar]) : null;
    if (upgrade && expectedClose && after.startsWith(expectedClose)) {
      const [open, close] = upgrade;
      return {
        deleteBefore: 1,
        deleteAfter: expectedClose.length,
        insert: open + close,
        caret: open.length,
      };
    }
  }

  // 2) 사용자 대치어 규칙 (괄호·기호 자동 완성보다 우선 적용)
  if (!selected && !escaped && !opts.inComment && opts.autoSymbolReplacement !== false) {
    const rules = normalizeTextReplacements(opts.textReplacements)
      .filter((r) => r.enabled && r.from.length > 0 && r.from !== r.to)
      .sort((a, b) => b.from.length - a.from.length);
    const candidate = before + input;
    for (const rule of rules) {
      if (candidate.endsWith(rule.from)) {
        return {
          deleteBefore: rule.from.length - 1,
          deleteAfter: 0,
          insert: rule.to,
          caret: rule.to.length,
        };
      }
    }
  }

  const pairs = {
    ...(opts.autoCloseQuotes ? quotePairs : {}),
    ...(opts.autoCloseBrackets ? brackets : {}),
  };
  const closers = Object.values(pairs);
  if (
    opts.autoCloseQuotes &&
    opts.quoteStyle === "curly" &&
    !selected &&
    ((input === '"' && after.startsWith("”")) ||
      (input === "'" && after.startsWith("’")))
  )
    return { skip: 1 };
  if (!selected && closers.includes(input) && after.startsWith(input))
    return { skip: 1 };

  if (pairs[input] && !escaped) {
    if (input === "'" && !selected && /[\p{L}\p{N}]$/u.test(before))
      return null;
    let open = input,
      close = pairs[input];
    if (opts.quoteStyle === "curly" && (input === '"' || input === "'")) {
      open = input === '"' ? "“" : "‘";
      close = input === '"' ? "”" : "’";
    }
    if (!selected && after.startsWith(close) && input === close)
      return { skip: close.length };
    return {
      deleteBefore: 0,
      deleteAfter: 0,
      insert: open + selected + close,
      caret: open.length + selected.length,
      open,
      close,
      wrap: !!selected,
    };
  }

  // 따옴표 자동 닫기가 꺼져 있어도 곡선 따옴표 설정이면 문맥에 맞춰 여는/닫는 곡선 따옴표로 변환
  if (
    !opts.autoCloseQuotes &&
    opts.quoteStyle === "curly" &&
    !selected &&
    !escaped &&
    (input === '"' || input === "'")
  ) {
    if (input === "'" && /[\p{L}\p{N}]$/u.test(before)) {
      return { deleteBefore: 0, deleteAfter: 0, insert: "’", caret: 1 };
    }
    const isOpen = /(?:^|[\s([{"“‘「『《〈—-])$/.test(before);
    const ch = input === '"' ? (isOpen ? "“" : "”") : isOpen ? "‘" : "’";
    return { deleteBefore: 0, deleteAfter: 0, insert: ch, caret: ch.length };
  }

  return null;
}

export function pairedBackspace(before, after, options = {}) {
  const opts = { ...defaultTyping, ...options };
  if (opts.composing || opts.inCode) return false;
  const pairs = {
    ...(opts.autoCloseQuotes ? quotePairs : {}),
    ...(opts.autoCloseBrackets ? { ...brackets, "「": "」", "『": "』", "《": "》", "〈": "〉" } : {}),
  };
  // At a line end `after` is empty; only delete when a real closer follows.
  const close = before ? pairs[before.at(-1)] : undefined;
  return !!close && after.startsWith(close);
}

const COMMENT_OPEN = "<!--";
const COMMENT_CLOSE = "-->";

// 빈 주석의 가운데에서 지우면 자동으로 넣은 공백과 닫기도 함께 지운다.
export function commentBackspace(before, after, options = {}) {
  const opts = { ...defaultTyping, ...options };
  if (opts.composing || opts.inCode || opts.autoCloseBrackets === false) return false;
  return (before.endsWith(COMMENT_OPEN) && after.startsWith(COMMENT_CLOSE)) ||
    (before.endsWith(`${COMMENT_OPEN} `) && after.startsWith(` ${COMMENT_CLOSE}`));
}

// 주석 짝 사이(<!-- | -->)에서 줄을 바꾸는지.
export function commentPairEnter(before, after, options = {}) {
  const opts = { ...defaultTyping, ...options };
  if (opts.composing || opts.inCode) return false;
  return /<!--[ \t]*$/.test(before) && /^[ \t]*-->/.test(after);
}

const QUOTE_CLOSERS = new Set(['"', "'", "”", "’", "」", "』"]);
const BRACKET_CLOSERS = new Set([")", "]", "}", "》", "〉"]);

export function smartClosingEnter(before, after, options = {}) {
  const opts = { ...defaultTyping, ...options };
  if (opts.composing || opts.inCode) return false;
  if (!before || !after || after.length !== 1) return false;
  const closer = after[0];
  if (QUOTE_CLOSERS.has(closer) && opts.autoCloseQuotes !== false) {
    const prev = before.at(-1);
    if (prev && quotePairs[prev] === closer) return false;
    return true;
  }
  if (BRACKET_CLOSERS.has(closer) && opts.smartBrackets !== false) {
    const prev = before.at(-1);
    if (prev && (brackets[prev] === closer || quotePairs[prev] === closer)) return false;
    return true;
  }
  return false;
}

export function inMarkdownCode(before) {
  let fence = null;
  for (const line of before.split("\n")) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m) {
      if (!fence) fence = m[1];
      else if (m[1][0] === fence[0] && m[1].length >= fence.length)
        fence = null;
    }
  }
  if (fence) return true;
  const line = before.split("\n").at(-1) || "";
  return (line.match(/(?<!\\)`/g) || []).length % 2 === 1;
}
