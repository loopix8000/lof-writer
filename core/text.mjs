import { Marked } from "marked";
import { decodeHTMLStrict } from "entities";

// 편집기의 표·이미지 확장이 통계와 원문 보호 검사에 섞이지 않게 별도 파서를 사용한다.
const textParser = new Marked();
const COMMENT_MARKER = "\uE002";

// 본문 주석(<!-- ... -->)을 제거한다.
// 코드 블록(``` · ~~~) 안의 내용은 건드리지 않으며, 주석만 있던 줄·문단은 빈 줄을 남기지 않고 함께 정리한다.
export function stripJsdocComments(markdown) {
  if (!markdown || !markdown.includes("<!--")) return markdown;
  const normalized = markdown.replace(/\r\n?|\n/g, "\n");
  let marked = "";
  const fenceRe = /(^[ \t]*(?:```|~~~)[^\n]*\n[\s\S]*?(?:^[ \t]*(?:```|~~~)[^\n]*$|(?![\s\S])))/gm;
  let lastIndex = 0;
  for (const match of normalized.matchAll(fenceRe)) {
    const idx = match.index ?? 0;
    if (idx > lastIndex) {
      marked += normalized.slice(lastIndex, idx).replace(/<!--[\s\S]*?-->/g, COMMENT_MARKER);
    }
    marked += match[0];
    lastIndex = idx + match[0].length;
  }
  if (lastIndex < normalized.length) {
    marked += normalized.slice(lastIndex).replace(/<!--[\s\S]*?-->/g, COMMENT_MARKER);
  }
  if (!marked.includes(COMMENT_MARKER)) return markdown;

  const items = marked.split("\n").map((line) => {
    if (!line.includes(COMMENT_MARKER)) {
      return { kind: line.trim() === "" ? "blank" : "text", text: line };
    }
    if (line.replaceAll(COMMENT_MARKER, "").trim() === "") {
      return { kind: "removed", text: "" };
    }
    const cleaned = line
      .replace(/^([ \t]*)\uE002+[ \t]?/, "$1")
      .replace(/[ \t]*\uE002+[ \t]*$/, "")
      .replace(/([ \t]+)\uE002+[ \t]+/g, "$1")
      .replace(/\uE002+/g, "");
    return { kind: cleaned.trim() === "" ? "removed" : "text", text: cleaned };
  });

  const out = [];
  let i = 0;
  while (i < items.length) {
    if (items[i].kind === "text") {
      out.push(items[i].text);
      i++;
      continue;
    }
    const start = i;
    let hasRemoved = false;
    let blanksBefore = 0;
    let seenRemoved = false;
    let trailingBlanks = 0;
    while (i < items.length && items[i].kind !== "text") {
      if (items[i].kind === "removed") {
        hasRemoved = true;
        seenRemoved = true;
        trailingBlanks = 0;
      } else if (!seenRemoved) {
        blanksBefore++;
      } else {
        trailingBlanks++;
      }
      i++;
    }
    const blanksAfter = trailingBlanks;
    if (!hasRemoved) {
      for (let k = start; k < i; k++) out.push(items[k].text);
    } else if (out.length > 0 && i < items.length) {
      const keepBlanks = Math.max(blanksBefore, blanksAfter);
      for (let k = 0; k < keepBlanks; k++) out.push("");
    }
  }
  return out.join("\n");
}

// 웹소설 원고처럼 한 줄바꿈으로만 이어진 줄도 한 줄을 한 문단으로 읽는다. Markdown 규칙대로라면 이런 줄은
// 한 문단으로 합쳐져 문단 간격·들여쓰기가 첫 줄에만 붙으므로, 읽기 전에 줄 사이를 문단 구분(빈 줄)으로 바꾼다.
// 자동 관리(hardBreaks)에서는 강제 줄바꿈(줄 끝 공백 두 칸·역슬래시)으로 이어진 줄도 붙여 넣기 규칙처럼
// 한 줄을 한 문단으로 나눈다. 수동 관리에서는 강제 줄바꿈을 그대로 둔다. 코드 블록 안, 이어지는 표·인용 줄은 건드리지 않는다.
export function splitSoftBreaks(markdown, hardBreaks) {
  const lines = markdown.split(/\r\n?|\n/),
    fenceLine = /^\s*(```|~~~)/,
    hardEnd = /( {2,}|\\)$/,
    joined = (line) => /^\s*[|>]/.test(line);
  const out = [];
  let fence = false;
  lines.forEach((line, i) => {
    if (fenceLine.test(line)) fence = !fence;
    const next = lines[i + 1],
      split =
        !fence &&
        next !== undefined &&
        !!line.trim() &&
        !!next.trim() &&
        !(joined(line) && joined(next)) &&
        (hardBreaks || !hardEnd.test(line));
    out.push(split ? line.replace(hardEnd, "") : line);
    if (split) out.push("");
  });
  return out.join("\n");
}

export function plainText(markdown, { preserveParagraphBreaks = false, dividerText = "" } = {}) {
  function walk(tokens) {
    return tokens
      .map((t) => {
        if (t.type === "space") {
          const breaks = (t.raw.match(/\n/g) || []).length;
          return "\n".repeat(
            Math.max(0, (preserveParagraphBreaks ? breaks : Math.floor(breaks / 2)) - 1),
          );
        }
        if (t.type === "br") return "\n";
        // 복사할 때만 구분 문자를 넣고, 글자 수 계산에는 기존의 빈 줄을 사용한다.
        if (t.type === "hr") return dividerText + "\n";
        if (t.type === "list")
          return t.items.map((i) => walk(i.tokens).replace(/\n$/, "")).join("\n") + "\n";
        if (t.type === "table")
          return [...t.header, ...t.rows.flat()]
            .map((c) => walk(c.tokens))
            .join("\n");
        if (t.type === "html") return decodeHTMLStrict(t.text.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<\/(?:p|div|h[1-6]|li)>/gi, "\n").replace(/<[^>]*>/g, ""));
        if (t.type === "image") return "";
        // Code and escaped Markdown are already literal text; decode entities only
        // in ordinary text tokens, once, so &amp;lt; and `&amp;` stay literal.
        if (t.type === "code" || t.type === "codespan") return t.text + (t.type === "code" ? "\n" : "");
        if (t.type === "escape") return t.text;
        const value = t.tokens ? walk(t.tokens) : t.text || "";
        return ["paragraph", "heading", "code"].includes(t.type)
          ? value + "\n"
          : t.tokens ? value : decodeHTMLStrict(value);
      })
      .join("");
  }
  // 자동 관리 복사는 편집기와 같은 문단 구분을 적용하고, 문단 사이의 빈 줄을 보존한다.
  const stripped = stripJsdocComments(markdown);
  const content = preserveParagraphBreaks ? splitSoftBreaks(stripped, true) : stripped;
  return walk(lex(content)).replace(/\n$/, "");
}
export const characterCount = (markdown, spaces = false) =>
  (spaces ? plainText(markdown).replace(/[\r\n]/g, "") : plainText(markdown).replace(/\s/g, "")).length;
// 같은 원고를 화면 여러 곳에서 연달아 검사하므로 마지막으로 읽은 토큰을 다시 쓴다.
let lastLexed = { markdown: "", tokens: [] };
function lex(markdown) {
  if (lastLexed.markdown !== markdown) lastLexed = { markdown, tokens: textParser.lexer(markdown) };
  return lastLexed.tokens;
}
// 토큰을 깊이 우선으로 돌며 test가 참인 토큰이 나오면 바로 멈춘다(marked.walkTokens와 같은 자식 순서).
function someToken(tokens, test) {
  for (const t of tokens) {
    if (test(t)) return true;
    const children =
      t.type === "table" ? [...t.header, ...t.rows.flat()].flatMap((cell) => cell.tokens)
      : t.type === "list" ? t.items
      : t.tokens;
    if (children && someToken(children, test)) return true;
  }
  return false;
}
export function requiresSource(markdown, { tables = false, links = false, images = false } = {}) {
  // 편집기에서 직접 표시하는 주석 때문에 원문 모드로 전환하지 않는다.
  const content = stripJsdocComments(markdown).replaceAll("<!--", "&lt;!--");
  return someToken(lex(content), (t) => {
    if (tables && (t.type === "table" ||
      (t.type === "html" && /^<br\s*\/?\s*>$/i.test(t.raw.trim())))) return false;
    if (links && t.type === "link") return false;
    if (images && t.type === "image") return false;
    return ["table", "image", "html", "link"].includes(t.type);
  });
}
let lastStats;
export function manuscriptStats(markdown) {
  if (lastStats?.markdown === markdown) return lastStats.stats;
  const text = plainText(markdown)
    .replace(/\r\n?|\u2028|\u2029/g, "\n")
    .replace(/\u00a0/g, " ");
  const noSpace = text.replace(/\s/g, ""),
    spaces = text.replace(/[\n\r]/g, "");
  const stats = {
    text,
    withoutSpaces: [...noSpace].length,
    withSpaces: [...spaces].length,
    withLineBreaks: [...text].length,
    utf16WithoutSpaces: noSpace.length,
    utf16WithSpaces: spaces.length,
    utf16WithLineBreaks: text.length,
    utf8Bytes: new TextEncoder().encode(text).length,
    lines: text ? text.split("\n").length : 0,
    paragraphs: text ? text.split(/\n+/).filter((p) => p.trim()).length : 0,
  };
  // 상태줄과 분량 패널 등에서 같은 본문을 연달아 요청하면 계산 결과를 공유한다.
  lastStats = { markdown, stats };
  return stats;
}
export function countForRule(stats, rule = "noSpace", unit = "utf16") {
  const key =
    { noSpace: "WithoutSpaces", all: "WithLineBreaks" }[
      rule
    ] || "WithoutSpaces";
  return unit === "utf16"
    ? stats["utf16" + key]
    : stats[key[0].toLowerCase() + key.slice(1)];
}

// Plain-text paste into an HTML editor: escape only HTML text-node characters.
// The published Novelpia counter removes ASCII punctuation but counts the
// remaining HTML entities literally. See docs/counting.md for evidence limits.
export function novelpiaCount(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[ .,\n\t\r!?'"\u00a0]/g, "")
    .replace(/^\s+|\s+$/g, "")
    .replace(/\u200e/gi, "").length;
}
export function countForWriting(stats, rules) {
  if (rules.rule === "manuscript") return manuscriptPaperPages(manuscriptPaperLines(stats.text));
  if (rules.rule === "novelpia") return novelpiaCount(stats.text);
  let text = stats.text;
  if (rules.rule === "noSpace") text = text.replace(/\s/g, "");
  else if (rules.rule === "collapsed") text = text.trim().replace(/\s+/g, " ");
  if (rules.punctuation === "ascii") text = text.replace(/[.,!?'"\u002c]/g, "");
  else if (rules.punctuation === "unicode") text = text.replace(/\p{P}/gu, "");
  if (rules.excludeSpecial) text = text.replace(/[^\p{L}\p{N}\s]/gu, "");
  return text.length + (rules.ellipsisWeight === 3 ? (text.match(/…/g) || []).length * 2 : 0);
}

// 200자 원고지(한 줄 20칸 × 10줄)에 옮겨 적을 때 차지하는 줄 수를 원고지 작성법에 따라 센다.
// - 문단은 새 줄에서 시작하고 첫 칸을 비운다. 빈 줄은 원고지에 옮기지 않는다.
// - 로마자 소문자와 아라비아 숫자는 두 자를 한 칸에 쓴다.
// - 줄 끝에 걸린 띄어쓰기는 다음 줄 첫 칸으로 넘기지 않는다.
// - 줄이 꽉 찬 뒤에 오는 닫는 문장부호는 마지막 칸에 함께 쓴다.
// 문단마다 따로 세므로 문단별 증감을 더해도 전체 값과 같다. src-tauri/src/text.rs와 같은 규칙이다.
export const PAPER_COLUMNS = 20;
export const PAPER_ROWS = 10;
const paperClosingMarks = new Set([...".,?!:;)]}」』”’〉》、。"]);
const paperHalfWidth = /^[a-z0-9]$/;
export function manuscriptPaperLines(text) {
  let total = 0;
  for (const raw of text.split("\n")) {
    const chars = [...raw.trim()];
    if (!chars.length) continue;
    let rows = 1, column = 1;
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      if (/\s/.test(c)) {
        if (column < PAPER_COLUMNS) column++;
        continue;
      }
      if (paperHalfWidth.test(c) && paperHalfWidth.test(chars[i + 1] ?? "")) i++;
      if (column < PAPER_COLUMNS) column++;
      else if (!paperClosingMarks.has(c)) { rows++; column = 1; }
    }
    total += rows;
  }
  return total;
}
export const manuscriptPaperPages = (lines) => Math.ceil(lines / PAPER_ROWS);
