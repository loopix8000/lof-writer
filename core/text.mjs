import { marked } from "marked";
import { decodeHTMLStrict } from "entities";

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

export function plainText(markdown, { preserveParagraphBreaks = false } = {}) {
  function walk(tokens) {
    return tokens
      .map((t) => {
        if (t.type === "space") {
          const breaks = (t.raw.match(/\n/g) || []).length;
          return "\n".repeat(
            Math.max(0, (preserveParagraphBreaks ? breaks : Math.floor(breaks / 2)) - 1),
          );
        }
        if (t.type === "br" || t.type === "hr") return "\n";
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
  const content = preserveParagraphBreaks ? splitSoftBreaks(markdown, true) : markdown;
  return walk(marked.lexer(content)).replace(/\n$/, "");
}
export const characterCount = (markdown, spaces = false) =>
  (spaces ? plainText(markdown).replace(/[\r\n]/g, "") : plainText(markdown).replace(/\s/g, "")).length;
export function requiresSource(markdown, { tables = false, links = false, images = false } = {}) {
  let unsupported = false;
  marked.walkTokens(marked.lexer(markdown), (t) => {
    if (tables && (t.type === "table" ||
      (t.type === "html" && /^<br\s*\/?\s*>$/i.test(t.raw.trim())))) return;
    if (links && t.type === "link") return;
    if (images && t.type === "image") return;
    if (["table", "image", "html", "link"].includes(t.type)) unsupported = true;
  });
  return unsupported;
}
export function manuscriptStats(markdown) {
  const text = plainText(markdown)
    .replace(/\r\n?|\u2028|\u2029/g, "\n")
    .replace(/\u00a0/g, " ");
  const noSpace = text.replace(/\s/g, ""),
    spaces = text.replace(/[\n\r]/g, "");
  return {
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
}
export function countForRule(stats, rule = "noSpace", unit = "utf16") {
  const key =
    { noSpace: "WithoutSpaces", spaces: "WithSpaces", all: "WithLineBreaks" }[
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
  if (rules.rule === "novelpia") return novelpiaCount(stats.text);
  let text = stats.text;
  if (rules.rule === "noSpace") text = text.replace(/\s/g, "");
  else if (rules.rule === "spaces") text = text.replace(/\n/g, "");
  else if (rules.rule === "collapsed") text = text.trim().replace(/\s+/g, " ");
  if (rules.punctuation === "ascii") text = text.replace(/[.,!?'"\u002c]/g, "");
  else if (rules.punctuation === "unicode") text = text.replace(/\p{P}/gu, "");
  if (rules.excludeSpecial) text = text.replace(/[^\p{L}\p{N}\s]/gu, "");
  return text.length + (rules.ellipsisWeight === 3 ? (text.match(/…/g) || []).length * 2 : 0);
}



