import { Document, parseDocument, isMap, isSeq, isScalar } from "yaml";
import { META_FIELDS, DOCUMENT_META_FIELDS, normalizeMeta, normalizeDocumentMeta, normalizeStatus, checkMetaPatch } from "./episode.mjs";

// 본문과 파일 속성을 분리한다. 본문의 줄바꿈과 빈 줄은 바꾸지 않는다.
const COMMON_FIELDS = ["lof", "id", "kind", "title", ...DOCUMENT_META_FIELDS,
  "episodeId", "archived", "createdAt", "updatedAt", "conflictOf"];
const formatError = (message) => Object.assign(new Error(`Markdown 속성을 읽을 수 없습니다: ${message}`), { code: "FORMAT" });
export function readMarkdown(raw) {
  const source = raw.replace(/^\uFEFF/, "");
  const start = /^---[ \t]*\r?\n/.exec(source);
  if (!start) return { body: source, properties: {}, hasProperties: false, prefix: "" };
  const rest = source.slice(start[0].length);
  const end = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  const looksLikeProperties = /^\s*(?:[\w-]+|"[^"\n]+"|'[^'\n]+')\s*:/.test(rest);
  if (!end) {
    if (looksLikeProperties) throw formatError("속성 영역을 닫는 ---가 없습니다.");
    return { body: source, properties: {}, hasProperties: false, prefix: "" };
  }
  let properties, ast;
  try {
    ast = parseDocument(rest.slice(0, end.index), { version: "1.2", uniqueKeys: true });
    if (ast.errors.length) throw ast.errors[0];
    properties = ast.toJS({ maxAliasCount: 100 });
  }
  catch (e) {
    if (looksLikeProperties) throw formatError(e.reason || e.message);
    return { body: source, properties: {}, hasProperties: false, prefix: "" };
  }
  if (properties == null) properties = {};
  if (typeof properties !== "object" || Array.isArray(properties))
    return { body: source, properties: {}, hasProperties: false, prefix: "" };
  // 순환 참조는 앱과 동기화에서 표현할 수 없으므로 원본을 유지한 채 오류를 알린다.
  try { JSON.stringify(properties); } catch { throw formatError("순환 참조 속성은 지원하지 않습니다."); }
  const offset = start[0].length + end.index + end[0].length;
  return { body: source.slice(offset), properties, hasProperties: true, prefix: raw.slice(0, raw.length - source.length + offset), ast };
}
const extrasOf = (properties, kind) => {
  const managed = new Set([...COMMON_FIELDS, ...(kind === "episode" ? ["order", "status", ...META_FIELDS] : [])]);
  return Object.fromEntries(Object.entries(properties).filter(([k]) => !managed.has(k)));
};

// project.json의 값은 이전 파일 형식에서만 읽는다. lof: 1 이후에는 Markdown이 기준이다.
export function markdownEntry(raw, fallback) {
  const parsed = readMarkdown(raw);
  const source = parsed.hasProperties
    ? { ...(parsed.properties.lof === 1 || fallback._markdown ? {} : fallback), ...parsed.properties }
    : fallback;
  const episode = fallback.kind === "episode";
  const fields = parsed.properties;
  if (fields.id !== undefined && (typeof fields.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(fields.id)))
    throw formatError("id는 1~80자의 영문·숫자·하이픈·밑줄이어야 합니다.");
  if (fields.order !== undefined && episode && !Number.isFinite(fields.order)) throw formatError("order는 숫자여야 합니다.");
  if (fields.title !== undefined && typeof fields.title !== "string") throw formatError("title은 문자열이어야 합니다.");
  if (fields.archived !== undefined && typeof fields.archived !== "boolean") throw formatError("archived는 true나 false여야 합니다.");
  if (fields.episodeId !== undefined && fields.episodeId !== null && typeof fields.episodeId !== "string")
    throw formatError("episodeId는 회차 ID 또는 null이어야 합니다.");
  if (fields.kind !== undefined && (episode ? fields.kind !== "episode" : !["plot", "memo"].includes(fields.kind)))
    throw formatError("회차와 메모·플롯 사이의 유형 전환은 지원하지 않습니다.");
  for (const key of episode ? META_FIELDS : DOCUMENT_META_FIELDS) {
    if (parsed.properties[key] === undefined) continue;
    const problem = checkMetaPatch(key, parsed.properties[key]);
    if (problem) throw formatError(`${key}: ${problem}`);
  }
  return {
    ...fallback,
    id: fields.id || fallback.id,
    order: episode && Number.isFinite(fields.order) ? fields.order : fallback.order ?? 0,
    kind: episode ? "episode" : (source.kind ?? source.type) === "plot" ? "plot" : "memo",
    title: typeof source.title === "string" ? source.title.slice(0, 300) : fallback.title,
    status: normalizeStatus(source.status),
    ...(episode ? normalizeMeta(source) : normalizeDocumentMeta(source)),
    archived: source.archived === true,
    episodeId: typeof source.episodeId === "string" && source.episodeId ? source.episodeId : undefined,
    conflictOf: typeof source.conflictOf === "string" ? source.conflictOf : undefined,
    createdAt: typeof source.createdAt === "string" ? source.createdAt : fallback.createdAt,
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : fallback.updatedAt,
    properties: extrasOf(parsed.properties, episode ? "episode" : "memo"),
  };
}
export function documentProperties(doc) {
  return {
    ...(doc.properties || {}),
    lof: 1,
    ...(doc.id ? { id: doc.id } : {}),
    kind: doc.kind,
    title: doc.title,
    ...(doc.kind === "episode" ? { status: normalizeStatus(doc.status), ...normalizeMeta(doc) } : normalizeDocumentMeta(doc)),
    ...(doc.kind === "episode" ? { order: doc.order ?? 0 } : {}),
    episodeId: doc.kind !== "episode" ? doc.episodeId || null : null,
    archived: !!doc.archived,
    ...(doc.createdAt ? { createdAt: doc.createdAt } : {}),
    ...(doc.updatedAt ? { updatedAt: doc.updatedAt } : {}),
    ...(doc.conflictOf ? { conflictOf: doc.conflictOf } : {}),
  };
}
export function writeMarkdown(body, doc, previousRaw = "") {
  const parsed = readMarkdown(previousRaw);
  const properties = doc.properties !== undefined ? documentProperties(doc)
    : { ...extrasOf(parsed.properties, doc.kind), ...documentProperties(doc) };
  return writeProperties(body, properties, previousRaw);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function updateNode(doc, node, value) {
  if (isScalar(node) && (value === null || typeof value !== "object")) { node.value = value; return node; }
  if (isMap(node) && value && typeof value === "object" && !Array.isArray(value)) {
    for (const pair of [...node.items]) if (!Object.hasOwn(value, String(pair.key.value))) node.delete(pair.key.value);
    for (const [key, child] of Object.entries(value)) {
      const old = node.get(key, true);
      if (old && same(old.toJS(doc), child)) continue;
      node.set(key, updateNode(doc, old, child));
    }
    return node;
  }
  if (isSeq(node) && Array.isArray(value)) {
    node.items = value.map((v, i) => node.items[i] && same(node.items[i].toJS(doc), v)
      ? node.items[i] : updateNode(doc, node.items[i], v));
    return node;
  }
  const next = doc.createNode(value);
  if (node) for (const key of ["comment", "commentBefore", "spaceBefore", "anchor", "flow"])
    if (node[key] !== undefined) next[key] = node[key];
  return next;
}
// YAML 문서 트리를 수정해 변경하지 않은 키의 순서·주석·인용 표기를 유지한다.
export function writeProperties(body, properties, previousRaw = "") {
  const parsed = readMarkdown(previousRaw);
  const keys = Object.keys(properties), oldKeys = Object.keys(parsed.properties);
  if (parsed.hasProperties && keys.length === oldKeys.length &&
      keys.every((k) => Object.hasOwn(parsed.properties, k) && same(properties[k], parsed.properties[k])))
    return parsed.prefix + body;
  const ast = parsed.ast || new Document({});
  ast.contents = updateNode(ast, ast.contents, properties);
  const eol = parsed.prefix.includes("\r\n") ? "\r\n" : "\n";
  const bom = previousRaw.startsWith("\uFEFF") ? "\uFEFF" : "";
  return `${bom}---${eol}${ast.toString({ lineWidth: 0, defaultStringType: "QUOTE_DOUBLE" }).replace(/\r?\n/g, eol)}---${eol}${body}`;
}
