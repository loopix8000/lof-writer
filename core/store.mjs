import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { characterCount, manuscriptStats, countForWriting } from "./text.mjs";
import { normalizeWriting } from "./platforms.mjs";
import { normalizeTags, validateCover, validCover } from "./assets.mjs";
import { readMarkdown, writeMarkdown, writeProperties, markdownEntry, documentProperties } from "./markdown.mjs";
import { FileIndex } from "./file-index.mjs";
import {
  STATUSES,
  LEGACY_STATUSES,
  normalizeStatus,
  statusToken,
  normalizeMeta,
  storedMeta,
  customProperties,
  checkMetaPatch,
  META_FIELDS,
  lineBreakDefault,
  DOCUMENT_META_FIELDS,
  normalizeDocumentMeta,
  storedDocumentMeta,
} from "./episode.mjs";

// 도서관 구조
//   {도서관}/001 작품명/
//     assets/            표지·첨부
//     doc/               플롯·메모 문서. 폴더는 자유롭게 만든다.
//     episodes/          001 회차명.md
//     project.json       작품 전체 설정
//     project.backup.json  project.json과 같은 내용의 복구용 사본
//   {도서관}/.lof/       변경 이력, 임시 원고, 삭제 기록, 동기화 상태
// 개별 속성은 Markdown의 YAML 프런트매터가 기준이다. 본문과 속성은 API에서 분리한다.
// 모든 문서 ID와 회차 순서는 YAML에 고정한다. .lof/index.json은 재생성 가능한 캐시다.
// 이전 경로 기반 ID와 docMeta는 기존 연결·이력을 유지하며 이관할 때만 사용한다.
export const FORMAT = 2;
export const FOLDERS = ["assets", "doc", "episodes"];
export const KINDS = ["episode", "plot", "memo"];

export const hash = (text) => createHash("sha256").update(text).digest("hex");
export const validId = (id) =>
  typeof id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(id);
export const fail = (message, code = "INVALID") =>
  Object.assign(new Error(message), { code });
let changeSequence = 0;
const changedPaths = new Map();
const recordChange = (file) => {
  const normalized = path.resolve(file);
  if (normalized.split(path.sep).includes(".lof") || /\.(tmp|lofmv|lofnew)$/i.test(file)) return;
  changedPaths.set(normalized, ++changeSequence);
};
export async function atomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, "wx");
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, file);
    recordChange(file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
// 두 본문에서 앞뒤 공통 부분을 뺀 '바뀐 구간'의 길이. 변경 이력 기록 조건에 쓴다.
export function changedChars(a, b) {
  const max = Math.min(a.length, b.length);
  let start = 0;
  while (start < max && a[start] === b[start]) start++;
  let end = 0;
  while (end < max - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return Math.max(a.length, b.length) - start - end;
}

const missing = (e) => {
  if (e.code === "ENOENT") return [];
  throw e;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (file) => fs.access(file).then(() => true, () => false);
// 백신·색인 프로그램이 잠깐 파일을 잡고 있으면 이름 바꾸기가 실패하므로 몇 번 다시 시도한다.
async function rename(from, to) {
  for (let i = 0; ; i++) {
    try {
      const result = await fs.rename(from, to);
      recordChange(from); recordChange(to);
      return result;
    } catch (e) {
      if (i >= 4 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      await sleep(80 * (i + 1));
    }
  }
}
export const pad = (n) => String(n).padStart(3, "0");
// 작품 폴더 안의 상대 경로는 항상 '/'로 구분해 기록한다.
export const abs = (dir, rel) => path.join(dir, ...rel.split("/"));
const folderOf = (rel) => rel.slice(0, Math.max(0, rel.lastIndexOf("/")));
const baseName = (rel) => rel.slice(rel.lastIndexOf("/") + 1).replace(/\.md$/i, "");
export function validRel(rel) {
  return (
    typeof rel === "string" &&
    rel.length > 0 &&
    rel.length < 1000 &&
    !rel.includes("\\") &&
    !path.isAbsolute(rel) &&
    rel.split("/").every((s) => s && s !== "." && s !== ".." && !/[<>:"|?*\u0000-\u001f]/.test(s))
  );
}
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// 제목을 Windows에서 쓸 수 있는 파일·폴더 이름으로 바꾼다.
export function safeName(title, fallback = "제목 없음") {
  let name = String(title ?? "")
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...name];
  if (chars.length > 80) name = chars.slice(0, 80).join("");
  name = name.replace(/[. ]+$/, "").trim();
  if (!name) name = fallback;
  if (RESERVED.test(name)) name = "_" + name;
  return name;
}
// 같은 이름이 있으면 덮어쓰지 않고 " (2)", " (3)"…을 붙인다. taken은 소문자 경로 집합이다.
function unique(want, ext, taken) {
  const base = want.slice(0, want.length - ext.length);
  let candidate = want;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++)
    candidate = `${base} (${n})${ext}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}
// cur가 want이거나 want에 " (n)"이 붙은 이름이면 참.
function isVariant(cur, want, ext) {
  if (cur === want) return true;
  const base = want.slice(0, want.length - ext.length);
  return (
    cur.startsWith(base) &&
    cur.endsWith(ext) &&
    /^ \(\d+\)$/.test(cur.slice(base.length, cur.length - ext.length))
  );
}
// 원하는 이름을 나눠 준다. 이미 그 이름(또는 번호 붙은 이름)에 있는 항목은 그대로 둔다.
function assign(items, currentOf, wantOf, ext, taken) {
  const out = new Map();
  for (const it of items) {
    const cur = currentOf(it);
    if (cur && isVariant(cur, wantOf(it), ext) && !taken.has(cur.toLowerCase())) {
      taken.add(cur.toLowerCase());
      out.set(it, cur);
    }
  }
  for (const it of items) if (!out.has(it)) out.set(it, unique(wantOf(it), ext, taken));
  return out;
}
// 숨김 파일과 작업 중인 임시 파일은 건너뛴다.
const skipped = (name) => name.startsWith(".") || /\.(tmp|lofmv)$/i.test(name);
async function walk(dir, rel) {
  const files = [];
  for (const e of await fs.readdir(abs(dir, rel), { withFileTypes: true }).catch(missing)) {
    if (skipped(e.name)) continue;
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) files.push(...(await walk(dir, r)));
    else if (e.isFile()) files.push(r);
  }
  return files;
}
const byOrder = (a, b) =>
  (a.order ?? 0) - (b.order ?? 0) ||
  String(a.createdAt).localeCompare(String(b.createdAt)) ||
  a.id.localeCompare(b.id);
export const memoId = (projectId, rel) =>
  "m" + hash(`${projectId}\n${rel.normalize("NFC").toLowerCase()}`).slice(0, 40);
// 동기화에서 문서가 바뀌었는지 판단하는 값. 본문과 속성을 함께 본다.
export function fingerprint(d, body) {
  const meta = d.kind === "episode" ? storedMeta(d) : storedDocumentMeta(d);
  return hash(
    JSON.stringify([
      d.kind,
      d.title,
      statusToken(d.status),
      d.order ?? 0,
      !!d.archived,
      d.episodeId ?? null,
      d.kind !== "episode" ? String(d.path).toLowerCase() : null,
      // 속성이 없으면 생략해 기존 문서의 동기화 지문을 유지한다.
      ...(Object.keys(meta).length ? [meta] : []),
      ...(d.properties && Object.keys(d.properties).length ? [d.properties] : []),
    ]) +
      "\n" +
      body,
  );
}
// 검색어는 rg처럼 정규식으로 해석한다. 정규식으로 올바르지 않으면 입력한 글자 그대로 찾는다.
export function searchRegex(query, caseSensitive = false) {
  const flags = caseSensitive ? "gmu" : "gimu";
  try {
    return new RegExp(String(query), flags);
  } catch {
    return new RegExp(String(query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  }
}
// `a*`처럼 빈 문자열에도 일치하는 패턴이 모든 항목에 일치하지 않도록 길이가 있는 일치만 인정한다.
export const searchHit = (re, text) => {
  for (const m of String(text ?? "").matchAll(re)) if (m[0]) return true;
  return false;
};
// 본문에서 query와 일치한 곳을 줄 단위로 찾는다. 정규식은 줄마다 적용하므로 줄 경계를 넘는 일치는 없다.
// 결과의 index는 본문 안에서 몇 번째 일치인지, text는 일치한 곳 앞뒤를 자른 줄, start·length는 text 안의 일치 위치다.
export function matchLines(body, query, caseSensitive = false, max = 100) {
  const matches = [];
  if (!String(query)) return { matches, truncated: false };
  const re = searchRegex(query, caseSensitive);
  let index = 0;
  const lines = body.split("\n");
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].replace(/\r$/, "");
    for (const m of line.matchAll(re)) {
      if (!m[0]) continue;
      if (matches.length >= max) return { matches, truncated: true };
      const at = m.index,
        from = Math.max(0, at - 40),
        to = Math.min(line.length, at + m[0].length + 100),
        cut = from > 0 ? "…" : "";
      matches.push({
        index: index++,
        line: n + 1,
        text: cut + line.slice(from, to),
        start: cut.length + at - from,
        length: m[0].length,
      });
    }
  }
  return { matches, truncated: false };
}
// 작품 삭제 기록의 키. 문서 ID(UUID, 'm'으로 시작하는 메모 ID)와 겹치지 않는다.
export const projectTombstone = (id) => `p-${id}`;
// manualLineBreak: 이 작품에서 새로 만드는 회차의 줄바꿈 방식. 없으면 공통 설정을 따른다.
const PROJECT_FIELDS =["id", "index", "title", "description", "tags", "writing", "manualLineBreak", "cover", "createdAt", "updatedAt"];
export const projectFields = (p) =>
  Object.fromEntries(PROJECT_FIELDS.filter((k) => p[k] !== undefined).map((k) => [k, p[k]]));
const publicProject = (p) => ({ ...projectFields(p.project), folder: path.basename(p.dir) });

function parseProject(raw) {
  const p = JSON.parse(raw);
  if (p?.format !== FORMAT || !validId(p.id) || !Array.isArray(p.documents))
    throw fail("작품 정보 형식이 올바르지 않습니다.", "FORMAT");
  const ids = new Set();
  for (const d of p.documents) {
    if (
      !validId(d?.id) ||
      ids.has(d.id) ||
      !["episode", "plot"].includes(d.kind) ||
      !validRel(d.path) ||
      (d.title !== undefined && typeof d.title !== "string")
    )
      throw fail("작품 정보의 문서 목록이 올바르지 않습니다.", "FORMAT");
    ids.add(d.id);
    if (d.title === undefined) d.title = baseName(d.path).replace(/^\d+\s+/, "") || "제목 없음";
  }
  // doc/ 문서의 속성: { "doc/경로.md": { type: "plot", episodeId, archived } }.
  if (
    p.docMeta !== undefined &&
    (!p.docMeta ||
      typeof p.docMeta !== "object" ||
      Array.isArray(p.docMeta) ||
      Object.entries(p.docMeta).some(([k, v]) => !validRel(k) || !v || typeof v !== "object"))
  )
    throw fail("작품 정보의 문서 속성이 올바르지 않습니다.", "FORMAT");
  // 예전 형식(memo/ 보관 목록)은 읽어 두었다가 doc/으로 옮길 때 넘긴다.
  if (p.archivedMemos !== undefined && (!Array.isArray(p.archivedMemos) || !p.archivedMemos.every(validRel)))
    throw fail("작품 정보의 보관한 메모 목록이 올바르지 않습니다.", "FORMAT");
  if (p.writing) p.writing = normalizeWriting(p.writing);
  return p;
}
// 작품 전체 설정은 project.json에 유지한다. 문서 캐시는 .lof/index.json에 둔다.
async function readProject(dir) {
  const errors = [];
  for (const name of ["project.json", "project.backup.json"]) {
    try {
      return {
        project: parseProject(await fs.readFile(path.join(dir, name), "utf8")),
        fromBackup: name !== "project.json",
      };
    } catch (e) {
      errors.push(e);
    }
  }
  const real = errors.find((e) => e.code !== "ENOENT");
  if (real) throw real;
  return null;
}
function docOf(p, entry, raw) {
  entry = markdownEntry(raw, entry);
  const { body } = readMarkdown(raw);
  return {
    id: entry.id,
    projectId: p.project.id,
    kind: entry.kind,
    title: entry.title,
    status: normalizeStatus(entry.status),
    ...(entry.kind === "episode" ? normalizeMeta(entry) : normalizeDocumentMeta(entry)),
    order: entry.order ?? 0,
    archived: !!entry.archived,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ...(entry.episodeId ? { episodeId: entry.episodeId } : {}),
    ...(entry.conflictOf ? { conflictOf: entry.conflictOf } : {}),
    ...(Object.keys(entry.properties).length ? { properties: entry.properties } : {}),
    relPath: entry.path,
    path: abs(p.dir, entry.path),
    revision: hash(raw),
    fingerprint: fingerprint(entry, body),
    body,
  };
}
// doc/ 문서의 속성(대소문자를 가리지 않고 경로로 찾는다).
export const metaOf = (project, rel) =>
  Object.entries(project.docMeta || {}).find(([k]) => k.toLowerCase() === rel.toLowerCase())?.[1] || {};
function docEntry(p, rel, stat, raw = "") {
  const m = metaOf(p.project, rel);
  const episodeId =
    m.episodeId && p.project.documents.some((d) => d.id === m.episodeId && d.kind === "episode")
      ? m.episodeId
      : undefined;
  return markdownEntry(raw, {
    id: memoId(p.project.id, rel),
    kind: m.type === "plot" ? "plot" : "memo",
    title: baseName(rel),
    status: "초안",
    order: 0,
    archived: !!m.archived,
    ...normalizeDocumentMeta(m),
    ...(episodeId ? { episodeId } : {}),
    createdAt: stat.birthtime.toISOString(),
    updatedAt: stat.mtime.toISOString(),
    path: rel,
  });
}
// 비어 있는 하위 폴더까지 지우고, 자신도 비었으면 지운다.
async function pruneEmpty(dir) {
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(missing))
    if (e.isDirectory()) await pruneEmpty(path.join(dir, e.name));
  await fs.rmdir(dir).catch(() => {});
}
const RENAME_FAILED =
  "파일 이름을 바꾸지 못했습니다. 다른 프로그램에서 작품 폴더의 파일을 열고 있는지 확인해 주세요.";

export class Store extends EventEmitter {
  // options.trash: 영구 삭제 때 문서 파일을 치우는 함수(Electron에서는 OS 휴지통).
  // 지정하지 않으면 파일을 바로 지운다.
  constructor(root, options = {}) {
    super();
    this.root = path.resolve(root);
    this.tail = Promise.resolve();
    this.trash = options.trash || ((file) => fs.rm(file, { force: true, recursive: true }));
    // options.historyPolicy: () => ({ minMinutes, minChars }). 저장할 때 이 조건을 넘어야
    // 변경 이력을 남긴다. 지정하지 않으면 저장할 때마다 남긴다.
    this.historyPolicy = options.historyPolicy || (() => ({ minMinutes: 0, minChars: 0 }));
    // options.lineBreakDefault: () => boolean. 공통 설정의 새 회차 줄바꿈 방식(true면 수동 관리).
    this.lineBreakDefault = options.lineBreakDefault || (() => false);
    this.now = options.now || Date.now;
    this.lastSnapshot = new Map();
    this.index = new FileIndex(this);
    this._atomic = atomic;
    this.indexSequence = changeSequence;
  }
  async init() {
    await fs.mkdir(path.join(this.root, ".lof"), { recursive: true });
    const f = path.join(this.root, ".lof", "vault.json");
    try {
      this.vault = JSON.parse(await fs.readFile(f, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      this.vault = {
        format: FORMAT,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      };
      await atomic(f, JSON.stringify(this.vault, null, 2));
    }
    try {
      this.catalog = await this.index.load();
      if (this.catalog) { this.indexEnabled = true; await this.refreshIndex({ inventory: true }); }
      else await this.repair();
    }
    catch (e) { this.migrationWarning = `문서 속성 이관을 완료하지 못했습니다: ${e.message}`; }
    return this;
  }
  serial(fn) {
    const task = this.tail.then(fn);
    this.tail = task.catch(() => {});
    return task;
  }
  // 조회는 메모리 색인을 사용한다. 수정된 경로만 원본에서 다시 읽는다.
  async _scan() {
    if (!this.indexEnabled || !this.catalog) return this._scanDisk();
    await this.refreshIndex();
    return { projects: this.catalog.projects.map((p) => ({ ...p, project: structuredClone(p.project) })),
      warnings: [...this.catalog.warnings, ...this.catalog.projects.flatMap((p) => Object.values(p.errors || {}))] };
  }
  async _stamp(file) {
    try { const s = await fs.stat(file); return `${s.mtimeMs}:${s.ctimeMs}:${s.size}`; }
    catch (e) { if (e.code === "ENOENT") return null; throw e; }
  }
  async _indexRecord(p, entry, raw, stat) {
    const { body, ...doc } = docOf(p, entry, raw);
    await this.index.cacheBody(p.project.id, entry.id, body);
    return { entry: { ...entry, hash: hash(body) }, doc: { ...doc,
      characters: characterCount(body), platformCharacters: countForWriting(manuscriptStats(body), normalizeWriting(p.project.writing)) },
      stamp: `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}` };
  }
  invalidatePath(relative) {
    if (relative && !relative.split(/[\\/]/).includes(".lof")) this.index.dirty.add(relative.replaceAll("\\", "/"));
  }
  async _refreshProjectFiles(p, inventory = false) {
    const present = new Set();
    for (const folder of ["episodes", "doc"])
      for (const rel of await walk(p.dir, folder)) {
        if (!/\.md$/i.test(rel)) continue;
        present.add(rel);
        const stamp = await this._stamp(abs(p.dir, rel));
        if (!inventory || p.files[rel]?.stamp !== stamp) await this._refreshIndexedFile(p, rel);
      }
    for (const rel of Object.keys(p.files)) if (!present.has(rel)) delete p.files[rel];
    this._reconcileIndexProject(p);
  }
  _reconcileIndexProject(p) {
    p.project.documents = Object.values(p.files).filter((f) => f.entry.kind === "episode").map((f) => ({ ...f.entry })).sort(byOrder);
  }
  async _refreshIndexedFile(p, rel) {
    p.errors ||= {};
    if (!/^(episodes|doc)\/.+\.md$/i.test(rel)) return;
    const file = abs(p.dir, rel);
    try {
      const stamp = await this._stamp(file);
      if (stamp && p.files[rel]?.stamp === stamp && !p.errors[rel]) return;
      const raw = await fs.readFile(file, "utf8"), stat = await fs.stat(file);
      const fallback = rel.startsWith("episodes/")
        ? { id: memoId(p.project.id, rel), kind: "episode", path: rel, title: baseName(rel).replace(/^\d+\s+/, ""),
            order: Math.max(0, Number(/^episodes\/(\d+)/.exec(rel)?.[1] || 1) - 1),
            createdAt: stat.birthtime.toISOString(), updatedAt: stat.mtime.toISOString() }
        : docEntry(p, rel, stat, raw);
      let entry = markdownEntry(raw, { ...fallback, ...p.files[rel]?.entry, path: rel });
      const duplicate = Object.entries(p.files).find(([other, f]) => other !== rel && f.entry.id === entry.id);
      if (duplicate && await exists(abs(p.dir, duplicate[0]))) {
        delete p.files[rel];
        throw fail("같은 문서 ID를 가진 파일이 여러 개 있습니다. 사본에는 새 ID를 지정해 주세요.", "DUPLICATE");
      }
      const parsed = readMarkdown(raw);
      if (!parsed.properties.id || (entry.kind === "episode" && parsed.properties.order === undefined)) {
        const next = writeMarkdown(parsed.body, entry, raw);
        if (await fs.readFile(file, "utf8") !== raw) throw fail("색인 갱신 중 파일이 변경됐습니다.", "CONFLICT");
        await atomic(file, next);
        entry._markdown = true;
        p.files[rel] = await this._indexRecord(p, entry, next, await fs.stat(file));
      } else {
        entry._markdown = true;
        p.files[rel] = await this._indexRecord(p, entry, raw, stat);
      }
      delete p.errors[rel];
    } catch (e) {
      if (e.code === "ENOENT") { delete p.files[rel]; delete p.errors[rel]; }
      else p.errors[rel] = `${p.project.title} · ${rel}: ${e.message}`;
    }
  }
  async refreshIndex({ inventory = false } = {}) {
    if (!this.indexEnabled || !this.catalog) return;
    const run = async () => {
      const before = new Map(this.catalog.projects.flatMap((p) => Object.values(p.files).map((f) =>
        [f.entry.id, p.project.id])));
      const beforeProjects = new Set(this.catalog.projects.map((p) => p.project.id));
      for (const [file, sequence] of changedPaths) if (sequence > this.indexSequence) {
        const rel = path.relative(this.root, file);
        if (!rel.startsWith("..") && !path.isAbsolute(rel)) this.invalidatePath(rel);
      }
      this.indexSequence = changeSequence;
      if (inventory) {
        for (const p of this.catalog.projects) this.index.dirty.add(path.basename(p.dir));
        for (const e of await fs.readdir(this.root, { withFileTypes: true }))
          if (e.isDirectory() && !e.name.startsWith(".")) this.index.dirty.add(e.name);
      }
      const dirty = [...this.index.dirty]; this.index.dirty.clear();
      if (!dirty.length) return;
      const folders = new Map();
      for (const rel of dirty) {
        const [folder, ...parts] = rel.split("/");
        if (folder.startsWith(".") || /\.(tmp|lofmv|lofnew)$/i.test(rel) || parts.join("/") === "project.backup.json") continue;
        if (!folders.has(folder)) folders.set(folder, new Set());
        folders.get(folder).add(parts.join("/"));
      }
      for (const [folder, paths] of folders) {
        const dir = path.join(this.root, folder);
        let p = this.catalog.projects.find((x) => x.dir === dir);
        if (!await exists(dir)) {
          this.catalog.projects = this.catalog.projects.filter((x) => x !== p);
          this.catalog.warnings = this.catalog.warnings.filter((message) => !message.startsWith(`${folder}:`));
          continue;
        }
        if (!p || paths.has("") || paths.has("project.json")) {
          try {
            const r = await readProject(dir);
            if (!r) { if (p) this.catalog.projects = this.catalog.projects.filter((x) => x !== p); continue; }
            const duplicateProject = !p && this.catalog.projects.find((x) => x.project.id === r.project.id && x.dir !== dir);
            if (duplicateProject && await exists(duplicateProject.dir)) throw fail("다른 작품 폴더와 ID가 겹칩니다.", "DUPLICATE");
            const previousWriting = JSON.stringify(p?.project.writing);
            const changedIdentity = p && p.project.id !== r.project.id;
            if (!r.project.fileCentric) {
              const migration = { dir, ...r };
              await this._migrateLegacy(migration);
              await this._migrateProperties(migration);
              r.project = migration.project;
            }
            if (!p) { p = { dir, ...r, files: {}, errors: {} }; this.catalog.projects.push(p); }
            else p.project = { ...r.project, documents: p.project.documents };
            if (changedIdentity) p.files = {};
            p.projectStamp = await this._stamp(path.join(dir, "project.json"));
            if (paths.has("") || !Object.keys(p.files).length) await this._refreshProjectFiles(p, true);
            if (previousWriting !== JSON.stringify(p.project.writing)) for (const f of Object.values(p.files)) {
              const body = await this._cachedBody(p.project.id, f.entry.id);
              f.doc.platformCharacters = countForWriting(manuscriptStats(body), normalizeWriting(p.project.writing));
            }
            p.fromBackup = r.fromBackup;
            if (r.fromBackup) p.errors.project = `${folder}: 복구용 작품 정보 사본으로 열었습니다.`;
            else delete p.errors.project;
            this.catalog.warnings = this.catalog.warnings.filter((message) => !message.startsWith(`${folder}:`));
          } catch (e) {
            if (p) p.errors.project = `${folder}: ${e.message}`;
            else this.catalog.warnings = [...this.catalog.warnings.filter((message) => !message.startsWith(`${folder}:`)), `${folder}: ${e.message}`];
          }
        }
        if (!p) continue;
        for (const rel of paths) {
          if (/^(episodes|doc)\/.+\.md$/i.test(rel)) await this._refreshIndexedFile(p, rel);
          else if (rel && !/^project(?:\.backup)?\.json$/.test(rel) && !/\.(tmp|lofmv|lofnew)$/i.test(rel))
            await this._refreshProjectFiles(p, true);
        }
        this._reconcileIndexProject(p);
      }
      const presentIds = new Set(this.catalog.projects.flatMap((p) => Object.values(p.files).map((f) => f.entry.id)));
      for (const [id, projectId] of before) if (!presentIds.has(id)) await this._tombstone(id, projectId);
      for (const id of beforeProjects) if (!this.catalog.projects.some((p) => p.project.id === id))
        await this._tombstone(projectTombstone(id), id);
      await this.index.save(this.catalog);
    };
    const task = (this.indexRefresh || Promise.resolve()).catch(() => {}).then(run);
    this.indexRefresh = task;
    await task;
  }
  async _cachedBody(projectId, id) {
    try { return await this.index.body(projectId, id); }
    catch {
      const p = this.catalog?.projects.find((p) => p.project.id === projectId);
      const record = p && Object.values(p.files).find((f) => f.entry.id === id);
      if (!record) throw fail("문서를 찾을 수 없습니다.", "NOT_FOUND");
      const body = readMarkdown(await fs.readFile(abs(p.dir, record.entry.path), "utf8")).body;
      await this.index.cacheBody(projectId, id, body);
      return body;
    }
  }
  async _scanDisk() {
    const projects = [],
      warnings = [],
      seen = new Set();
    for (const e of await fs.readdir(this.root, { withFileTypes: true }).catch(missing)) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const dir = path.join(this.root, e.name);
      try {
        const r = await readProject(dir);
        if (!r) continue;
        if (seen.has(r.project.id)) {
          warnings.push(`${e.name}: 다른 작품 폴더와 ID가 겹쳐 건너뜁니다.`);
          continue;
        }
        seen.add(r.project.id);
        if (r.fromBackup) warnings.push(`${e.name}: 복구용 작품 정보 사본으로 열었습니다.`);
        const cached = r.project.documents, discovered = [], files = {}, errors = {};
        for (const rel of await walk(dir, "episodes")) {
          if (!/\.md$/i.test(rel)) continue;
          try {
            const raw = await fs.readFile(abs(dir, rel), "utf8"), stat = await fs.stat(abs(dir, rel));
            const old = cached.find((d) => d.path.toLowerCase() === rel.toLowerCase());
            const entry = markdownEntry(raw, old || { id: memoId(r.project.id, rel), kind: "episode", path: rel,
              title: baseName(rel).replace(/^\d+\s+/, ""), order: Math.max(0, Number(/^episodes\/(\d+)/.exec(rel)?.[1] || 1) - 1),
              createdAt: stat.birthtime.toISOString(), updatedAt: stat.mtime.toISOString() });
            if (discovered.some((d) => d.id === entry.id)) throw fail("같은 문서 ID를 가진 파일이 여러 개 있습니다.", "DUPLICATE");
            if (readMarkdown(raw).properties.lof === 1) entry._markdown = true;
            entry.hash = hash(readMarkdown(raw).body);
            discovered.push(entry);
            files[rel] = await this._indexRecord({ dir, project: r.project }, entry, raw, stat);
          } catch (error) {
            if (error.code !== "ENOENT") errors[rel] = `${e.name} · ${rel}: ${error.message}`;
          }
        }
        if (!r.project.fileCentric) for (const d of cached)
          if (!discovered.some((x) => x.id === d.id)) discovered.push(d);
        r.project.documents = discovered;
        const p = { dir, ...r, files, errors, projectStamp: await this._stamp(path.join(dir, "project.json")) };
        for (const entry of await this._docFiles(p)) {
          const raw = await fs.readFile(abs(dir, entry.path), "utf8"), stat = await fs.stat(abs(dir, entry.path));
          if (Object.values(files).some((f) => f.entry.id === entry.id)) {
            errors[entry.path] = `${e.name} · ${entry.path}: 같은 문서 ID를 가진 파일이 여러 개 있습니다.`; continue;
          }
          files[entry.path] = await this._indexRecord(p, entry, raw, stat);
        }
        for (const warning of p.documentWarnings || []) errors[warning] = warning;
        projects.push(p);
      } catch (err) {
        warnings.push(`${e.name}: ${err.message}`);
      }
    }
    return { projects, warnings };
  }
  async _project(id) {
    if (!validId(id)) throw fail("잘못된 작품 ID");
    const p = (await this._scan()).projects.find((x) => x.project.id === id);
    if (!p) throw fail("작품을 찾을 수 없습니다.", "NOT_FOUND");
    return p;
  }
  async _docFiles(p) {
    if (this.indexEnabled && p.files)
      return Object.entries(p.files).filter(([rel]) => rel.startsWith("doc/")).map(([, file]) => structuredClone(file.entry));
    const out = [];
    p.documentWarnings = [];
    for (const rel of await walk(p.dir, "doc"))
      if (/\.md$/i.test(rel))
        try {
          out.push(docEntry(p, rel, await fs.stat(abs(p.dir, rel)), await fs.readFile(abs(p.dir, rel), "utf8")));
        } catch (e) {
          if (e.code !== "ENOENT") p.documentWarnings.push(`${p.project.title} · ${rel}: ${e.message}`);
        }
    return out;
  }
  // 문서 ID로 작품과 기록을 찾는다. doc/ 문서의 ID는 'm'으로 시작한다(UUID는 16진수라 겹치지 않는다).
  async _find(id) {
    if (!validId(id)) throw fail("잘못된 문서 ID");
    const { projects } = await this._scan();
    const matches = [];
    for (const p of projects) for (const entry of [...p.project.documents, ...await this._docFiles(p)])
      if (entry.id === id) matches.push({ ...p, entry, file: abs(p.dir, entry.path) });
    if (matches.length > 1) throw fail("같은 문서 ID를 가진 파일이 여러 개 있습니다. 사본에는 새 ID를 지정해 주세요.", "DUPLICATE");
    if (matches.length === 1) return matches[0];
    throw fail("문서를 찾을 수 없습니다.", "NOT_FOUND");
  }
  async _writeProject(p) {
    const project = { ...p.project, documents: p.project.documents.map((d) => {
      if (d._markdown) return { id: d.id, kind: d.kind, path: d.path, order: d.order, hash: d.hash };
      const { _markdown, properties, ...legacy } = d;
      return legacy;
    }) };
    if (project.docMeta && !Object.keys(project.docMeta).length) delete project.docMeta;
    if (p.project.fileCentric) project.documents = [];
    const data = JSON.stringify(project, null, 2);
    await atomic(path.join(p.dir, "project.json"), data);
    await atomic(path.join(p.dir, "project.backup.json"), data);
  }
  async list() {
    const { projects, warnings } = await this._scan(),
      documents = [],
      unlinked = [],
      missingFiles = [];
    if (this.migrationWarning) warnings.push(this.migrationWarning);
    if (this.indexEnabled) {
      const ids = new Set();
      for (const p of projects) for (const file of Object.values(p.files)) {
        if (ids.has(file.doc.id)) { warnings.push(`중복 문서 ID: ${file.doc.id}`); continue; }
        ids.add(file.doc.id); documents.push(structuredClone(file.doc));
      }
      documents.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, "ko") || a.id.localeCompare(b.id));
      return { root: this.root, vault: this.vault, projects: projects.map(publicProject), documents,
        unlinked: [], missing: [], warnings };
    }
    for (const p of projects) {
      const writing = normalizeWriting(p.project.writing);
      const add = (entry, raw) => {
        const { body, ...meta } = docOf(p, entry, raw);
        documents.push({
          ...meta,
          characters: characterCount(body),
          platformCharacters: countForWriting(manuscriptStats(body), writing),
        });
      };
      for (const entry of p.project.documents)
        try {
          add(entry, await fs.readFile(abs(p.dir, entry.path), "utf8"));
        } catch (e) {
          if (e.code === "ENOENT")
            missingFiles.push({
              projectId: p.project.id,
              id: entry.id,
              kind: entry.kind,
              title: entry.title,
              path: entry.path,
            });
          warnings.push(
            `${p.project.title} · ${entry.path}: ${e.code === "ENOENT" ? "파일을 찾을 수 없습니다." : e.message}`,
          );
        }
      for (const entry of await this._docFiles(p))
        try {
          add(entry, await fs.readFile(abs(p.dir, entry.path), "utf8"));
        } catch (e) {
          if (e.code !== "ENOENT") warnings.push(`${p.project.title} · ${entry.path}: ${e.message}`);
        }
      warnings.push(...(p.documentWarnings || []));
      // 회차 폴더에 있지만 project.json에 연결되지 않은 Markdown 파일.
      const tracked = new Set(p.project.documents.map((d) => d.path.toLowerCase()));
      for (const rel of await walk(p.dir, "episodes"))
        if (/\.md$/i.test(rel) && !tracked.has(rel.toLowerCase()))
          unlinked.push({ projectId: p.project.id, path: rel });
    }
    documents.sort(
      (a, b) =>
        (a.order ?? 0) - (b.order ?? 0) ||
        a.title.localeCompare(b.title, "ko") ||
        a.id.localeCompare(b.id),
    );
    return {
      root: this.root,
      vault: this.vault,
      projects: projects.map(publicProject),
      documents,
      unlinked,
      missing: missingFiles,
      warnings,
    };
  }
  async locate(id) {
    return (await this._find(id)).file;
  }
  async read(id) {
    const f = await this._find(id);
    return docOf(f, f.entry, await fs.readFile(f.file, "utf8"));
  }
  async markdown(id) {
    return fs.readFile((await this._find(id)).file, "utf8");
  }
  // 두 단계로 이름을 바꾼다(먼저 임시 이름, 그다음 목표 이름). 서로 이름을 맞바꾸는 경우도 안전하다.
  // 하나라도 실패하면 바꾼 것을 되돌린다. 성공하면 되돌리는 함수를 돌려준다.
  async _move(dir, moves) {
    const done = [];
    const undo = async () => {
      for (const [from, to] of [...done].reverse())
        await rename(abs(dir, to), abs(dir, from)).catch(() => {});
    };
    try {
      for (const m of moves) {
        m.temp = `${m.from}.${randomUUID().slice(0, 8)}.lofmv`;
        await rename(abs(dir, m.from), abs(dir, m.temp));
        done.push([m.from, m.temp]);
      }
      for (const m of moves) {
        if (await exists(abs(dir, m.to))) throw fail("같은 이름의 파일이 이미 있습니다.", "EXISTS");
        await fs.mkdir(path.dirname(abs(dir, m.to)), { recursive: true });
        await rename(abs(dir, m.temp), abs(dir, m.to));
        done.push([m.temp, m.to]);
      }
    } catch (e) {
      await undo();
      throw fail(`${RENAME_FAILED} (${e.message})`, "RENAME");
    }
    return undo;
  }
  // 회차 순서와 제목에 맞춰 회차 파일 이름('001 회차명.md')을 맞춘다.
  // 앱이 관리하지 않는 파일과 이름이 겹치면 덮어쓰지 않고 번호를 붙인다.
  // 실패하면 디스크를 되돌리고 오류를 던진다(p.project의 경로는 성공했을 때만 바뀐다).
  async _layout(p) {
    const episodes = p.project.documents.filter((d) => d.kind === "episode").sort(byOrder),
      number = new Map(episodes.map((d, i) => [d.id, i + 1]));
    const tracked = new Set(episodes.map((d) => d.path.toLowerCase())),
      taken = new Set();
    for (const rel of await walk(p.dir, "episodes"))
      if (!tracked.has(rel.toLowerCase())) taken.add(rel.toLowerCase());
    const present = [];
    for (const d of episodes)
      if (await exists(abs(p.dir, d.path))) present.push(d);
      else taken.add(d.path.toLowerCase());
    const target = assign(
      present,
      (d) => d.path,
      (d) => `episodes/${pad(number.get(d.id))} ${safeName(d.title)}.md`,
      ".md",
      taken,
    );
    const moves = present
      .filter((d) => target.get(d) !== d.path)
      .map((d) => ({ from: d.path, to: target.get(d) }));
    await this._move(p.dir, moves);
    for (const d of present) d.path = target.get(d);
  }
  // 예전 구조(plot/·memo/)를 doc/으로 옮긴다. 플롯 문서의 역할·회차 연결·보관과 변경 이력을 넘기고,
  // 보관한 메모 목록은 문서 속성으로 바꾼다. 옮기기 전에 project.json을 백업한다.
  async _migrateLegacy(p) {
    const legacy = p.project.documents.filter((d) => d.kind !== "episode");
    const dirs = [];
    for (const root of ["memo", "plot"]) if (await exists(abs(p.dir, root))) dirs.push(root);
    if (!legacy.length && !dirs.length && !p.project.archivedMemos) return false;
    await this._backupProject(p, ["plot/·memo/의 문서를 doc/으로 옮김"]);
    await fs.mkdir(abs(p.dir, "doc"), { recursive: true });
    const taken = new Set((await walk(p.dir, "doc")).map((r) => r.toLowerCase())),
      moved = new Map();
    for (const root of dirs)
      for (const rel of await walk(p.dir, root)) {
        const ext = path.posix.extname(rel),
          to = unique("doc/" + rel.slice(root.length + 1), ext, taken);
        await fs.mkdir(path.dirname(abs(p.dir, to)), { recursive: true });
        await rename(abs(p.dir, rel), abs(p.dir, to));
        moved.set(rel.toLowerCase(), to);
        // 메모의 변경 이력은 경로로 만든 ID에 붙어 있으므로 새 경로의 ID로 옮긴다.
        if (root === "memo" && /\.md$/i.test(rel))
          await rename(
            path.join(this.root, ".lof", "history", memoId(p.project.id, rel)),
            path.join(this.root, ".lof", "history", memoId(p.project.id, to)),
          ).catch(() => {});
      }
    for (const d of legacy) {
      const to = moved.get(d.path.toLowerCase());
      if (!to) continue;
      const memo = d.role === "memo" || (!d.role && String(d.title).includes("메모"));
      this._setDocMeta(p, to, {
        type: memo ? "memo" : "plot",
        episodeId: d.episodeId ?? null,
        archived: !!d.archived,
        ...storedDocumentMeta(d),
      });
      await rename(
        path.join(this.root, ".lof", "history", d.id),
        path.join(this.root, ".lof", "history", memoId(p.project.id, to)),
      ).catch(() => {});
    }
    for (const r of p.project.archivedMemos || []) {
      const to = moved.get(r.toLowerCase());
      if (to) this._setDocMeta(p, to, { archived: true });
    }
    delete p.project.archivedMemos;
    p.project.documents = p.project.documents.filter((d) => d.kind === "episode");
    for (const root of dirs) await pruneEmpty(abs(p.dir, root));
    return true;
  }
  // 복구로 project.json을 고치기 전에 지금 상태를 .lof/recovery에 남긴다.
  async _backupProject(p, reason) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = path.join(this.root, ".lof", "recovery", `${stamp}-${p.project.id}`);
    await fs.mkdir(dir, { recursive: true });
    for (const name of ["project.json", "project.backup.json"])
      await fs.copyFile(path.join(p.dir, name), path.join(dir, name)).catch(() => {});
    await atomic(
      path.join(dir, "reason.json"),
      JSON.stringify({ at: new Date().toISOString(), folder: path.basename(p.dir), reason }, null, 2),
    );
    return dir;
  }
  // 파일을 먼저 쓰고 마지막에 이전 속성 저장소를 정리한다. 중단되어도 재실행할 수 있다.
  async _migrateProperties(p) {
    const changes = [], migratedDocs = [];
    for (const entry of [...p.project.documents, ...await this._docFiles(p)]) {
      let raw;
      try { raw = await fs.readFile(abs(p.dir, entry.path), "utf8"); }
      catch (e) { if (e.code === "ENOENT") continue; throw e; }
      const parsed = readMarkdown(raw);
      const properties = markdownEntry(raw, entry);
      if (parsed.properties.lof !== 1 || !parsed.properties.id ||
          (entry.kind === "episode" && parsed.properties.order === undefined)) {
        changes.push({ entry, raw, next: writeMarkdown(parsed.body, properties, raw) });
      }
      if (entry.kind !== "episode") migratedDocs.push(entry.path);
    }
    const cleanup = !p.project.fileCentric || p.project.propertyStorage !== "markdown" ||
      migratedDocs.some((rel) => Object.keys(metaOf(p.project, rel)).length);
    if (!changes.length && !cleanup) return;
    const backup = await this._backupProject(p, ["문서 속성을 Markdown YAML 프런트매터로 이관"]);
    // 원본 Markdown도 속성과 함께 백업한다. 본문은 바이트 단위로 그대로 이어 붙인다.
    for (const change of changes)
      await atomic(abs(backup, `files/${change.entry.path}`), change.raw);
    for (const change of changes) {
      const file = abs(p.dir, change.entry.path);
      if (await fs.readFile(file, "utf8") !== change.raw)
        throw fail("속성 이관 중 외부에서 파일이 변경됐습니다. 다시 열어 주세요.", "CONFLICT");
      await atomic(file, change.next);
      if (change.entry.kind === "episode") change.entry._markdown = true;
    }
    for (const rel of migratedDocs) this._dropDocMeta(p, rel);
    p.project.propertyStorage = "markdown";
    p.project.fileCentric = true;
    await this._writeProject(p);
  }
  // 회차 폴더에서 project.json에 연결되지 않은 Markdown 파일과 그 내용 해시.
  async _unlinkedFiles(p) {
    const tracked = new Set(p.project.documents.map((d) => d.path.toLowerCase()));
    const out = [];
    for (const rel of await walk(p.dir, "episodes"))
      if (/\.md$/i.test(rel) && !tracked.has(rel.toLowerCase()))
        try {
          const raw = await fs.readFile(abs(p.dir, rel), "utf8");
          const parsed = readMarkdown(raw);
          out.push({ path: rel, hash: hash(parsed.body), id: parsed.properties.id });
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
    return out;
  }
  // 외부에서 파일을 옮기거나 이름을 바꿔 연결이 끊긴 회차·플롯을 다시 연결한다.
  // - project.json이 깨져 백업본으로 열었으면, 깨진 파일을 보관하고 백업본으로 되살린다.
  // - 파일이 없어진 문서는 같은 내용(해시)의 연결되지 않은 파일, 없으면 같은 폴더 종류의 같은 이름 파일을 찾는다.
  // - 후보가 둘 이상이거나 한 후보를 여러 문서가 가리키면 모호하므로 건드리지 않는다.
  // - 고치기 전에는 항상 .lof/recovery에 지금 상태를 백업한다. 파일은 옮기거나 지우지 않는다.
  repair() {
    return this.serial(async () => {
      const previousIndexEnabled = this.indexEnabled;
      try {
      this.indexEnabled = false;
      const { projects } = await this._scan();
      const report = { restored: [], relinked: [], ambiguous: [] };
      for (const p of projects) {
        let write = await this._migrateLegacy(p);
        const reasons = [];
        if (p.fromBackup) {
          reasons.push("project.json을 읽지 못해 project.backup.json으로 되살림");
          report.restored.push(p.project.id);
        }
        const lost = [];
        for (const d of p.project.documents)
          try {
            const raw = await fs.readFile(abs(p.dir, d.path), "utf8");
            // 외부 편집으로 내용이 바뀌었으면 해시를 갱신해, 나중에 파일이 옮겨져도 다시 찾을 수 있게 한다.
            const h = hash(readMarkdown(raw).body);
            if (d.hash !== h) {
              d.hash = h;
              write = true;
            }
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
            lost.push(d);
          }
        if (lost.length) {
          const files = await this._unlinkedFiles(p);
          const root = (rel) => rel.split("/")[0];
          const name = (rel) => rel.slice(rel.lastIndexOf("/") + 1).toLowerCase();
          const pick = new Map();
          for (const d of lost) {
            let found = files.filter((f) => f.id === d.id);
            if (!found.length) found = d.hash ? files.filter((f) => f.hash === d.hash && (!f.id || f.id === d.id)) : [];
            if (!found.length)
              found = files.filter((f) => (!f.id || f.id === d.id) && root(f.path) === root(d.path) && name(f.path) === name(d.path));
            if (found.length === 1) pick.set(d, found[0]);
            else if (found.length > 1)
              report.ambiguous.push({ projectId: p.project.id, id: d.id, title: d.title });
          }
          const claims = new Map();
          for (const f of pick.values()) claims.set(f, (claims.get(f) || 0) + 1);
          for (const [d, f] of pick)
            if (claims.get(f) > 1)
              report.ambiguous.push({ projectId: p.project.id, id: d.id, title: d.title });
            else {
              reasons.push(`${d.path} → ${f.path}`);
              report.relinked.push({ projectId: p.project.id, id: d.id, from: d.path, to: f.path });
              d.path = f.path;
              write = true;
            }
        }
        if (reasons.length) await this._backupProject(p, reasons);
        if (write || p.fromBackup) await this._writeProject(p);
        await this._migrateProperties(p);
      }
      this.emit("change");
      this.migrationWarning = "";
      this.catalog = await this._scanDisk();
      this.indexEnabled = true;
      this.indexSequence = changeSequence;
      this.index.dirty.clear();
      await this.index.save(this.catalog);
      return report;
      } catch (e) { this.indexEnabled = previousIndexEnabled; throw e; }
    });
  }
  // 이야기 폴더 안의 상대 경로를 절대 경로로 바꾼다(폴더 밖은 거부).
  async projectFile(projectId, rel) {
    if (!validRel(rel)) throw fail("잘못된 경로");
    return abs((await this._project(projectId)).dir, rel);
  }
  // 파일이 없어진 문서를 사용자가 고른 연결되지 않은 파일에 다시 연결한다.
  relinkDocument(input) {
    return this.serial(async () => {
      const p = await this._project(input.projectId);
      const entry = p.project.documents.find((d) => d.id === input.id);
      if (!entry) throw fail("문서를 찾을 수 없습니다.", "NOT_FOUND");
      if (await exists(abs(p.dir, entry.path))) throw fail("이 문서의 파일은 이미 있습니다.");
      const file = (await this._unlinkedFiles(p)).find((f) => f.path === input.path);
      if (!file) throw fail("연결되지 않은 파일이 아닙니다.");
      const raw = await fs.readFile(abs(p.dir, file.path), "utf8");
      const backup = await this._backupProject(p, [`수동 연결: ${entry.path} → ${file.path}`]);
      await atomic(abs(backup, `files/${file.path}`), raw);
      Object.assign(entry, markdownEntry(raw, entry));
      entry.path = file.path;
      entry.hash = file.hash;
      await atomic(abs(p.dir, entry.path), writeMarkdown(readMarkdown(raw).body, entry, raw));
      entry._markdown = true;
      await this._writeProject(p);
      this.emit("change");
      return this.read(entry.id);
    });
  }
  // 연결되지 않은 파일을 새 회차나 플롯 문서로 등록한다. 등록한 뒤에는 번호·이름 규칙을 따른다.
  adoptFile(input) {
    return this.serial(async () => {
      const p = await this._project(input.projectId);
      const kind = "episode";
      if (input.kind && input.kind !== "episode") throw fail("회차만 등록할 수 있습니다.");
      const file = (await this._unlinkedFiles(p)).find((f) => f.path === input.path);
      if (!file) throw fail("연결되지 않은 파일이 아닙니다.");
      const same = p.project.documents.filter((d) => d.kind === kind);
      const raw = await fs.readFile(abs(p.dir, file.path), "utf8");
      const availableId = validId(file.id) && !(await this._scan()).projects.some((p) => p.project.documents.some((d) => d.id === file.id));
      const now = new Date().toISOString();
      const entry = {
        id: availableId ? file.id : randomUUID(),
        kind,
        // '003 제목.md'처럼 번호가 붙은 파일은 번호를 뺀 이름을 제목으로 쓴다.
        title: baseName(file.path).replace(/^\d+\s+/, "") || "제목 없음",
        status: "in_progress",
        ...(lineBreakDefault(p.project, this.lineBreakDefault()) ? { manualLineBreak: true } : {}),
        order: same.length ? Math.max(...same.map((d) => d.order || 0)) + 1 : 0,
        archived: false,
        createdAt: now,
        updatedAt: now,
        hash: file.hash,
        path: file.path,
      };
      const backup = await this._backupProject(p, [`파일 등록: ${file.path}`]);
      await atomic(abs(backup, `files/${file.path}`), raw);
      Object.assign(entry, markdownEntry(raw, entry));
      await atomic(abs(p.dir, entry.path), writeMarkdown(readMarkdown(raw).body, entry, raw));
      entry._markdown = true;
      p.project.documents.push(entry);
      // 이름을 맞추지 못해도(파일이 잠겨 있어도) 등록은 끝낸다. 다음 정리 때 맞춰진다.
      await this._layout(p).catch(() => {});
      await this._writeProject(p);
      this.emit("change");
      return this.read(entry.id);
    });
  }
  // 파일이 없어진 문서의 연결을 끊는다. 디스크의 파일은 건드리지 않는다.
  forgetDocument(input) {
    return this.serial(async () => {
      const p = await this._project(input.projectId);
      const entry = p.project.documents.find((d) => d.id === input.id);
      if (!entry) throw fail("문서를 찾을 수 없습니다.", "NOT_FOUND");
      if (await exists(abs(p.dir, entry.path)))
        throw fail("파일이 있는 문서는 연결을 끊을 수 없습니다. 삭제를 사용해 주세요.");
      await this._backupProject(p, [`연결 해제: ${entry.path}`]);
      p.project.documents = p.project.documents.filter((d) => d.id !== entry.id);
      await this._writeProject(p);
      this.emit("change");
      return true;
    });
  }
  createProject(input) {
    return this.serial(async () => {
      const p = await this._newProject(input);
      this.emit("change");
      return publicProject(p);
    });
  }
  // fixed: 동기화로 받은 작품처럼 ID와 시각을 그대로 써야 할 때.
  async _newProject(input, fixed = {}) {
    const { projects } = await this._scan();
    const used = new Set(projects.map((p) => Number(p.project.index) || 0));
    let index =
      fixed.index && !used.has(fixed.index) ? fixed.index : Math.max(0, ...used) + 1;
    const title = String(input.title || "제목 없는 작품").slice(0, 300);
    const taken = new Set(
      (await fs.readdir(this.root).catch(missing)).map((n) => n.toLowerCase()),
    );
    const folder = unique(`${pad(index)} ${safeName(title, "제목 없는 작품")}`, "", taken);
    const now = new Date().toISOString();
    const project = {
      format: FORMAT,
      id: fixed.id || randomUUID(),
      index,
      title,
      description: String(input.description || "").slice(0, 3000),
      tags: normalizeTags(input.tags),
      writing: normalizeWriting(input.writing),
      ...(typeof input.manualLineBreak === "boolean" ? { manualLineBreak: input.manualLineBreak } : {}),
      cover: fixed.cover ?? null,
      createdAt: fixed.createdAt || now,
      updatedAt: fixed.updatedAt || now,
      documents: [],
      propertyStorage: "markdown",
      fileCentric: true,
    };
    const p = { dir: path.join(this.root, folder), project };
    for (const f of FOLDERS) await fs.mkdir(path.join(p.dir, f), { recursive: true });
    await this._writeProject(p);
    return p;
  }
  updateProject(input) {
    return this.serial(() => this._updateProject(input));
  }
  async _updateProject(input, { keepTime = false } = {}) {
    const p = await this._project(input.id),
      old = p.project;
    p.project = {
      ...old,
      title: String(input.title ?? old.title).slice(0, 300),
      description: String(input.description ?? old.description).slice(0, 3000),
      ...(input.tags !== undefined ? { tags: normalizeTags(input.tags) } : {}),
      ...(input.writing !== undefined
        ? { writing: normalizeWriting(input.writing) }
        : {}),
      // null이면 작품 설정을 지우고 공통 설정을 따른다.
      ...(input.manualLineBreak !== undefined
        ? { manualLineBreak: typeof input.manualLineBreak === "boolean" ? input.manualLineBreak : undefined }
        : {}),
      ...(input.cover !== undefined
        ? {
            cover:
              input.cover === null
                ? null
                : validCover(input.cover)
                  ? input.cover
                  : (() => {
                      throw fail("잘못된 표지 경로");
                    })(),
          }
        : {}),
      updatedAt: keepTime && input.updatedAt ? input.updatedAt : new Date().toISOString(),
    };
    // 제목이 바뀌면 작품 폴더 이름도 바꾼다. 다른 프로그램이 폴더를 잡고 있으면 예전 이름을 유지한다.
    const want = `${pad(p.project.index)} ${safeName(p.project.title, "제목 없는 작품")}`;
    if (!isVariant(path.basename(p.dir), want, "")) {
      const taken = new Set(
        (await fs.readdir(this.root)).filter((n) => n !== path.basename(p.dir)).map((n) => n.toLowerCase()),
      );
      const next = path.join(this.root, unique(want, "", taken));
      try {
        await rename(p.dir, next);
        p.dir = next;
      } catch {}
    }
    await this._writeProject(p);
    this.emit("change");
    return publicProject(p);
  }
  setCover(id, data) {
    return this.serial(async () => {
      const filename = validateCover(data);
      const p = await this._project(id);
      await atomic(path.join(p.dir, "assets", filename), data);
      return this._updateProject({ id, cover: filename });
    });
  }
  async coverData(project) {
    if (!validCover(project.cover) || typeof project.folder !== "string") return null;
    try {
      const file = path.join(this.root, project.folder, "assets", project.cover);
      if ((await fs.stat(file)).size > 8_000_000) throw fail("표지 용량 초과");
      return (
        "data:image/png;base64," + (await fs.readFile(file)).toString("base64")
      );
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }
  create(input) {
    return this.serial(() => this._create(input));
  }
  async _create(input, fixed = {}) {
    const kind = input.kind ?? "episode";
    if (!KINDS.includes(kind)) throw fail("잘못된 문서 종류");
    const p = await this._project(input.projectId);
    const body = String(input.body ?? "");
    if (body.length > 10_000_000) throw fail("본문은 10MB 이하만 지원합니다.");
    const title = String(input.title || "제목 없음").slice(0, 300);
    if (kind !== "episode") {
      if (input.episodeId && !p.project.documents.some((d) => d.id === input.episodeId && d.kind === "episode" && !d.archived))
        throw fail("연결할 회차를 찾을 수 없습니다.");
      for (const key of DOCUMENT_META_FIELDS) if (input[key] !== undefined) {
        const problem = checkMetaPatch(key, input[key]);
        if (problem) throw fail(problem);
      }
      return this._createDocFile(p, kind, title, body, input.folder, input.episodeId,
        { ...storedDocumentMeta(input), properties: customProperties(input) });
    }
    const same = p.project.documents.filter((d) => d.kind === kind);
    const now = new Date().toISOString();
    const entry = {
      id: fixed.id || randomUUID(),
      kind,
      title,
      // 새 회차는 집필 중으로 시작한다.
      status: fixed.status ? normalizeStatus(fixed.status) : "in_progress",
      ...storedMeta({
        ...input,
        // 뮤블처럼 만들 때의 기본값으로 정해 두고, 나중에 기본값을 바꿔도 이 회차는 그대로 둔다.
        manualLineBreak:
          typeof input.manualLineBreak === "boolean"
            ? input.manualLineBreak
            : lineBreakDefault(p.project, this.lineBreakDefault()),
      }),
      properties: customProperties(input),
      order: fixed.order ?? (same.length ? Math.max(...same.map((d) => d.order || 0)) + 1 : 0),
      archived: fixed.archived ?? false,
      createdAt: fixed.createdAt || now,
      updatedAt: fixed.updatedAt || now,
      ...(fixed.conflictOf ? { conflictOf: fixed.conflictOf } : {}),
      hash: hash(body),
      path: "",
    };
    await this._insert(p, entry, body);
    this.emit("change");
    return this.read(entry.id);
  }
  // 새 파일을 숨김 임시 이름으로 쓴 뒤, 배치 규칙에 따라 제 이름을 찾아 옮긴다.
  async _insert(p, entry, body) {
    const temp = `episodes/.${entry.id}.lofnew`;
    entry.path = temp;
    await atomic(abs(p.dir, temp), writeMarkdown(body, entry));
    entry._markdown = true;
    p.project.documents.push(entry);
    try {
      await this._layout(p);
    } catch (e) {
      await fs.rm(abs(p.dir, temp), { force: true });
      throw e;
    }
    await this._writeProject(p);
  }
  _docFolder(folder) {
    if (folder === undefined || folder === null || folder === "") return "doc";
    if (!validRel(folder)) throw fail("잘못된 문서 폴더");
    return `doc/${folder}`;
  }
  // doc/ 폴더(없으면 바로 아래)에 문서를 만든다. 플롯이거나 회차에 연결하면 속성을 기록한다.
  async _createDocFile(p, kind, title, body, folder, episodeId, attributes = {}) {
    const dir = this._docFolder(folder);
    const taken = new Set((await walk(p.dir, "doc")).map((r) => r.toLowerCase()));
    const rel = unique(`${dir}/${safeName(title)}.md`, ".md", taken);
    const now = new Date().toISOString();
    const id = randomUUID();
    await atomic(abs(p.dir, rel), writeMarkdown(body, {
      id, kind, title, episodeId: episodeId || null, ...attributes, createdAt: now, updatedAt: now,
    }));
    this.emit("change");
    return this.read(id);
  }
  save(input) {
    return this.serial(() => this._save(input));
  }
  async _save(input) {
    const f = await this._find(input.id),
      raw = await fs.readFile(f.file, "utf8"),
      current = docOf(f, f.entry, raw);
    if (current.id !== input.id) throw fail("문서 ID가 외부에서 변경됐습니다. 문서를 다시 열어 주세요.", "CONFLICT");
    if (!input.expectedRevision || current.revision !== input.expectedRevision)
      throw fail(
        "다른 곳에서 수정된 문서입니다. 현재 내용을 다시 확인해 주세요.",
        "CONFLICT",
      );
    const isDoc = f.entry.kind !== "episode";
    const patch = {};
    for (const key of isDoc
      ? ["title", "archived", "episodeId", "kind", "properties", ...DOCUMENT_META_FIELDS]
      : ["title", "status", "order", "archived", "properties", ...META_FIELDS])
      if (input[key] !== undefined) patch[key] = input[key];
    for (const key of META_FIELDS) {
      if (patch[key] === undefined) continue;
      const problem = checkMetaPatch(key, patch[key]);
      if (problem) throw fail(problem);
      patch[key] = normalizeMeta({ [key]: patch[key] })[key];
    }
    if (patch.title !== undefined)
      patch.title = String(patch.title).slice(0, 300);
    if (patch.status !== undefined) {
      // 예전 상태(초안·진행·완료, 집필 예정)도 받아서 바꿔 둔다.
      if (!STATUSES.includes(patch.status) && !LEGACY_STATUSES.includes(patch.status))
        throw fail("잘못된 상태");
      patch.status = normalizeStatus(patch.status);
    }
    if (patch.order !== undefined && !Number.isFinite(patch.order))
      throw fail("잘못된 순서");
    if (patch.kind !== undefined && !["plot", "memo"].includes(patch.kind))
      throw fail("문서 타입은 플롯이나 메모여야 합니다.");
    if (patch.archived !== undefined && typeof patch.archived !== "boolean")
      throw fail("잘못된 보관 상태");
    if (patch.properties !== undefined && (!patch.properties || typeof patch.properties !== "object" || Array.isArray(patch.properties)))
      throw fail("사용자 속성은 객체여야 합니다.");
    if (patch.episodeId !== undefined && patch.episodeId !== (current.episodeId ?? null)) {
      if (
        patch.episodeId !== null &&
        !f.project.documents.some((d) => d.id === patch.episodeId && d.kind === "episode" && !d.archived)
      )
        throw fail("연결할 회차를 찾을 수 없습니다.");
    }
    if (input.body !== undefined && typeof input.body !== "string")
      throw fail("본문은 문자열이어야 합니다.");
    if (input.body?.length > 10_000_000)
      throw fail("본문은 10MB 이하만 지원합니다.");
    const body = input.body ?? current.body;
    const changed = Object.keys(patch).filter((k) =>
      ["tags", "properties"].includes(k)
        ? JSON.stringify(current[k] || (k === "tags" ? [] : {})) !== JSON.stringify(patch[k])
        : (k === "episodeId" ? (f.entry.episodeId ?? null) : current[k]) !== patch[k],
    );
    if (!changed.length && body === current.body) return current;
    // 원고 보호: 집필 완료인 회차는 상태를 먼저 바꾸기 전에는 제목과 본문을 고칠 수 없다.
    if (
      !isDoc &&
      current.status === "completed" &&
      (patch.status ?? "completed") === "completed" &&
      (body !== current.body || changed.includes("title"))
    )
      throw fail("집필 완료된 회차는 원고 보호 중이라 제목과 본문을 고칠 수 없습니다. 상태를 바꾼 뒤 편집해 주세요.", "PROTECTED");
    // 이력은 본문과 제목을 기준으로 남긴다. 상태·태그·북마크 같은 속성만 바뀐 저장은 남기지 않는다.
    // 북마크는 본문을 고치면 문단 번호가 따라 바뀌어 자동 저장마다 함께 실리므로, 속성 변경으로 남기면
    // 최소 간격·글자 수 조건을 건너뛰고 저장할 때마다 이력이 쌓인다.
    if (
      input.forceHistory ||
      changed.includes("title") ||
      (body !== current.body && (await this._historyDue(current.id, current.body)))
    )
      await this._history(current.id, current);
    // Check again after history I/O: an external editor may have written meanwhile.
    if (hash(await fs.readFile(f.file, "utf8")) !== current.revision)
      throw fail("파일이 외부에서 변경됐습니다.", "CONFLICT");
    if (isDoc) return this._saveDocFile(f, patch, body, current, raw);
    const entry = f.entry;
    for (const k of changed)
      if (k === "episodeId" && patch[k] === null) delete entry.episodeId;
      else entry[k] = patch[k];
    // 기본값은 정규화하고, 최종 속성은 Markdown에 기록한다.
    if (changed.some((k) => META_FIELDS.includes(k))) {
      const kept = storedMeta(entry);
      for (const k of META_FIELDS) if (!(k in kept)) delete entry[k];
    }
    entry.updatedAt = new Date().toISOString();
    entry.hash = hash(body);
    if (changed.some((k) => ["title", "order"].includes(k))) await this._layout(f);
    await atomic(abs(f.dir, entry.path), writeMarkdown(body, entry, raw));
    entry._markdown = true;
    await this._writeProject(f);
    this.emit("change");
    return this.read(entry.id);
  }
  // doc/ 문서: 본문과 속성(타입·회차·보관)을 저장한다. 제목을 바꾸면 파일 이름이 바뀌고 ID도 바뀐다.
  // 변경 이력은 새 ID로 옮기고, 예전 ID는 삭제 기록에 남긴다(동기화가 다른 장치의 예전 파일을 정리한다).
  async _saveDocFile(f, patch, body, current, raw) {
    const { title } = patch;
    let rel = f.entry.path;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await atomic(f.file, writeMarkdown(body, next, raw));
    if (this._dropDocMeta(f, rel)) await this._writeProject(f);
    if (title !== undefined && safeName(title) !== baseName(rel)) {
      const taken = new Set(
        (await walk(f.dir, "doc")).filter((r) => r !== rel).map((r) => r.toLowerCase()),
      );
      const next = unique(`${folderOf(rel)}/${safeName(title)}.md`, ".md", taken);
      await this._move(f.dir, [{ from: rel, to: next }]);
      if (this._moveDocMeta(f, rel, next)) await this._writeProject(f);
      rel = next;
    }
    this.emit("change");
    return this.read(current.id);
  }
  // 문서 속성을 고친다. replace면 통째로 바꾼다. 기본값(메모, 회차 없음, 보관 안 함)은 기록하지 않는다.
  _setDocMeta(p, rel, patch, replace = false) {
    const all = { ...(p.project.docMeta || {}) },
      key = Object.keys(all).find((k) => k.toLowerCase() === rel.toLowerCase());
    const next = { ...(replace || !key ? {} : all[key]), ...patch };
    if (key) delete all[key];
    for (const k of Object.keys(next))
      if (next[k] === null || next[k] === false || next[k] === undefined ||
          (Array.isArray(next[k]) && !next[k].length) || (k === "type" && next[k] === "memo"))
        delete next[k];
    if (Object.keys(next).length) all[rel] = next;
    p.project.docMeta = all;
  }
  // 문서나 폴더를 옮기면 그 안 문서의 속성 경로도 따라 바꾼다. 바뀐 것이 있으면 true.
  _moveDocMeta(p, from, to) {
    let changed = false;
    const f = from.toLowerCase(),
      next = {};
    for (const [k, v] of Object.entries(p.project.docMeta || {})) {
      const low = k.toLowerCase();
      if (low === f || low.startsWith(f + "/")) {
        next[to + k.slice(from.length)] = v;
        changed = true;
      } else next[k] = v;
    }
    p.project.docMeta = next;
    return changed;
  }
  // 지운 문서(또는 폴더 안의 문서)의 속성을 뺀다. 바뀐 것이 있으면 true.
  _dropDocMeta(p, rel) {
    const f = rel.toLowerCase(),
      before = Object.keys(p.project.docMeta || {}).length;
    p.project.docMeta = Object.fromEntries(
      Object.entries(p.project.docMeta || {}).filter(
        ([k]) => k.toLowerCase() !== f && !k.toLowerCase().startsWith(f + "/"),
      ),
    );
    return Object.keys(p.project.docMeta).length !== before;
  }
  // 회차 순서를 한 번에 바꾼다. ids 순서대로 0, 1, 2…를 매기고 파일 이름을 맞춘다.
  reorder(input) {
    return this.serial(async () => {
      const p = await this._project(input.projectId);
      if (!Array.isArray(input.ids) || input.ids.length > 20000) throw fail("잘못된 순서 목록");
      const entries = input.ids.map((id) => p.project.documents.find((d) => d.id === id));
      if (entries.some((d) => !d || d.kind !== "episode")) throw fail("잘못된 순서 목록");
      for (const [i, d] of entries.entries()) {
        if (d.order === i) continue;
        // 순서만 바뀌고 본문은 그대로이므로 이력을 남기지 않는다. 한 회차를 옮겨도 사이의 회차가
        // 모두 밀려 회차마다 이력이 쌓이기 때문이다.
        const raw = await fs.readFile(abs(p.dir, d.path), "utf8");
        d.order = i;
        await atomic(abs(p.dir, d.path), writeMarkdown(readMarkdown(raw).body, d, raw));
      }
      await this._layout(p);
      await this._writeProject(p);
      this.emit("change");
      return true;
    });
  }
  async _history(id, doc) {
    const at = this.now();
    let previousRaw = "";
    try { previousRaw = await fs.readFile((await this._find(id)).file, "utf8"); } catch {}
    await atomic(
      path.join(this.root, ".lof", "history", id, `${at}-${randomUUID()}.md`),
      writeProperties(doc.body, documentProperties(doc), previousRaw),
    );
    this.lastSnapshot.set(id, { at, body: doc.body });
  }
  // 가장 최근 이력. 처음 한 번만 디스크에서 읽고 이후에는 메모리에 둔다.
  async _latestSnapshot(id) {
    if (this.lastSnapshot.has(id)) return this.lastSnapshot.get(id);
    const dir = path.join(this.root, ".lof", "history", id);
    const names = (await fs.readdir(dir).catch(missing))
      .filter((n) => /^\d+-[a-f0-9-]+\.(json|md)$/.test(n))
      .sort((a, b) => Number(a.split("-")[0]) - Number(b.split("-")[0]));
    let latest = null;
    if (names.length) {
      const name = names[names.length - 1];
      try {
        const v = name.endsWith(".md") ? readMarkdown(await fs.readFile(path.join(dir, name), "utf8"))
          : JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
        latest = { at: Number(name.split("-")[0]), body: String(v.body ?? "") };
      } catch {
        latest = { at: Number(name.split("-")[0]), body: "" };
      }
    }
    this.lastSnapshot.set(id, latest);
    return latest;
  }
  // 마지막 이력 이후 최소 간격이 지났고, 본문이 최소 글자 수 이상 바뀌었을 때만 남긴다.
  async _historyDue(id, body) {
    const { minMinutes = 0, minChars = 0 } = this.historyPolicy() || {};
    const latest = await this._latestSnapshot(id);
    const elapsed = latest ? this.now() - latest.at : Infinity;
    if (elapsed < minMinutes * 60_000) return false;
    return changedChars(latest?.body ?? "", body) >= minChars;
  }
  async history(id) {
    if (!validId(id)) throw fail("잘못된 ID");
    const dir = path.join(this.root, ".lof", "history", id);
    return (await fs.readdir(dir).catch(missing))
      .filter((n) => /\.(json|md)$/.test(n))
      .sort()
      .reverse()
      .slice(0, 100)
      .map((name) => ({ name }));
  }
  async historyRead(id, name) {
    if (!validId(id) || !/^\d+-[a-f0-9-]+\.(json|md)$/.test(name))
      throw fail("잘못된 이력");
    const raw = await fs.readFile(
        path.join(this.root, ".lof", "history", id, name),
        "utf8",
      );
    if (name.endsWith(".md")) {
      const parsed = readMarkdown(raw), attributes = parsed.properties;
      const normalized = markdownEntry(raw, { id, kind: attributes.kind || "episode", title: attributes.title || "" });
      return { id, title: normalized.title, status: normalized.status, body: parsed.body,
        savedAt: new Date(Number(name.split("-")[0])).toISOString(), attributes: { ...attributes, properties: normalized.properties } };
    }
    const v = JSON.parse(raw);
    return {
      id,
      title: String(v.title ?? ""),
      status: normalizeStatus(v.status),
      body: String(v.body ?? ""),
      savedAt: v.savedAt,
    };
  }
  async restore(input) {
    const old = await this.historyRead(input.id, input.name);
    const attributes = { ...(old.attributes || {}) };
    if (attributes.episodeId) {
      const current = await this._find(input.id);
      if (!current.project.documents.some((d) => d.id === attributes.episodeId && !d.archived)) attributes.episodeId = null;
    }
    return this.save({
      ...attributes,
      id: input.id,
      expectedRevision: input.expectedRevision,
      // 되돌리기도 다시 되돌릴 수 있도록 조건과 상관없이 이력을 남긴다.
      forceHistory: true,
      body: old.body,
      title: old.title,
      status: old.status,
    });
  }
  async search(query, projectId) {
    const q = String(query).toLocaleLowerCase();
    if (!q.trim()) return [];
    const results = [];
    for (const m of (await this.list()).documents.filter(
      (d) => !d.archived && (!projectId || d.projectId === projectId),
    )) {
      const d = this.indexEnabled ? { ...m, body: await this._cachedBody(m.projectId, m.id) } : await this.read(m.id),
        pos = d.body.toLocaleLowerCase().indexOf(q);
      if (pos >= 0 || d.title.toLocaleLowerCase().includes(q))
        results.push({
          ...m,
          snippet: d.body.slice(Math.max(0, pos - 35), Math.max(0, pos) + 150),
        });
    }
    return results.slice(0, 100);
  }
  async searchDocumentIds(query, projectId) {
    const q = String(query ?? "").trim().toLocaleLowerCase();
    if (!q || !projectId) return [];
    const ids = [];
    for (const doc of (await this.list()).documents.filter(d => d.projectId === projectId)) {
      const body = this.indexEnabled
        ? await this._cachedBody(doc.projectId, doc.id).catch(() => "")
        : (await this.read(doc.id).catch(() => null))?.body ?? "";
      if (body.toLocaleLowerCase().includes(q)) ids.push(doc.id);
    }
    return ids;
  }
  // VS Code식 본문 검색: 문서마다 일치한 줄과 위치를 돌려준다.
  // index는 그 문서 안에서 몇 번째 일치인지(편집기에서 그 위치를 고를 때 쓴다).
  async searchText(query, projectId, { caseSensitive = false, includeArchived = true } = {}) {
    const q = String(query ?? "");
    if (!q.trim()) return { results: [], total: 0, truncated: false };
    const results = [];
    let total = 0,
      truncated = false;
    for (const m of (await this.list()).documents.filter(
      (d) => (!projectId || d.projectId === projectId) && (includeArchived || !d.archived),
    )) {
      const d = this.indexEnabled ? { ...m, body: await this._cachedBody(m.projectId, m.id).catch(() => "") }
        : await this.read(m.id).catch(() => null);
      if (!d) continue;
      const found = matchLines(d.body, q, caseSensitive, Math.min(100, 2000 - total));
      if (found.truncated) truncated = true;
      total += found.matches.length;
      if (found.matches.length)
        results.push({
          id: d.id,
          projectId: d.projectId,
          kind: d.kind,
          title: d.title,
          relPath: d.relPath,
          archived: d.archived,
          matches: found.matches,
        });
      if (total >= 2000) {
        truncated = true;
        break;
      }
    }
    return { results, total, truncated };
  }
  // 통합 검색: 작품(제목·소개·태그), 파일 이름(제목·경로·태그), 본문을 한 번에 찾는다.
  // '#'으로 시작하면 태그만 찾는다. 작품은 범위와 상관없이 모든 작품에서 찾는다.
  async searchAll(query, projectId, { caseSensitive = false, includeArchived = true } = {}) {
    const raw = String(query ?? "").trim();
    const empty = { projects: [], files: [], results: [], total: 0, truncated: false };
    if (!raw) return empty;
    const tagOnly = raw.startsWith("#"),
      pattern = tagOnly ? raw.replace(/^#+/, "") : raw;
    if (!pattern) return empty;
    const re = searchRegex(pattern, caseSensitive);
    const list = await this.list();
    const projects = [];
    for (const p of list.projects) {
      const tags = (p.tags || []).filter((t) => searchHit(re, t)),
        fields = tagOnly
          ? tags.length ? ["태그"] : []
          : [
              ...(searchHit(re, p.title) ? ["제목"] : []),
              ...(searchHit(re, p.description) ? ["소개"] : []),
              ...(tags.length ? ["태그"] : []),
            ];
      if (fields.length)
        projects.push({ id: p.id, title: p.title, tags, fields, description: p.description || "" });
    }
    const innerPath = (p) => String(p ?? "").replace(/^(?:assets|doc|episodes|plot|memo)\//i, "");
    const files = [];
    for (const d of list.documents) {
      if (!includeArchived && d.archived) continue;
      if (projectId && d.projectId !== projectId) continue;
      const tags = (d.tags || []).filter((t) => searchHit(re, t));
      if (
        tagOnly
          ? !tags.length
          : !(searchHit(re, d.title) || searchHit(re, innerPath(d.relPath)) || tags.length)
      )
        continue;
      files.push({
        id: d.id,
        projectId: d.projectId,
        kind: d.kind,
        title: d.title,
        relPath: d.relPath,
        archived: d.archived,
        tags,
      });
      if (files.length >= 200) break;
    }
    if (tagOnly) return { ...empty, projects, files };
    return { projects, files, ...(await this.searchText(raw, projectId, { caseSensitive, includeArchived })) };
  }
  async draft(input) {
    if (!validId(input.id)) throw fail("잘못된 문서 ID");
    await atomic(
      path.join(this.root, ".lof", "drafts", `${input.id}.json`),
      JSON.stringify({ ...input, savedAt: new Date().toISOString() }),
    );
    return true;
  }
  async drafts() {
    const dir = path.join(this.root, ".lof", "drafts");
    const out = [];
    for (const n of await fs.readdir(dir).catch(missing))
      if (n.endsWith(".json"))
        out.push(JSON.parse(await fs.readFile(path.join(dir, n), "utf8")));
    return out;
  }
  async clearDraft(id) {
    if (!validId(id)) throw fail("잘못된 ID");
    await fs.rm(path.join(this.root, ".lof", "drafts", `${id}.json`), {
      force: true,
    });
  }
  // 영구 삭제한 문서 ID 기록. 동기화가 다른 장치에서 같은 문서를 다시 가져오지 않게 한다.
  get deletedFile() {
    return path.join(this.root, ".lof", "deleted.json");
  }
  async deleted() {
    try {
      return JSON.parse(await fs.readFile(this.deletedFile, "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return {};
      throw e;
    }
  }
  async _tombstone(id, projectId, deletedAt = new Date().toISOString()) {
    const deleted = await this.deleted();
    deleted[id] = { projectId, deletedAt, ...(id === projectTombstone(projectId) ? { project: true } : {}) };
    await atomic(this.deletedFile, JSON.stringify(deleted, null, 2));
  }
  remove(id) {
    return this.serial(() => this._remove(id));
  }
  // 문서 파일은 휴지통으로 보내고, 변경 이력과 임시 원고는 지운 뒤 삭제 기록을 남긴다.
  // 회차를 지워도 그 회차에 연결된 문서는 남는다(연결만 사라진다).
  async _remove(id, deletedAt = new Date().toISOString()) {
    const f = await this._find(id);
    if (await exists(f.file)) await this.trash(f.file);
    recordChange(f.file);
    if (f.entry.kind !== "episode" && this._dropDocMeta(f, f.entry.path)) await this._writeProject(f);
    if (f.entry.kind === "episode") {
      f.project.documents = f.project.documents.filter((d) => d.id !== id);
      // 대상 회차를 지워도 본문·속성을 보존하고 Markdown의 연결 값만 지운다.
      for (const doc of await this._docFiles(f)) if (doc.episodeId === id) {
        const file = abs(f.dir, doc.path), raw = await fs.readFile(file, "utf8");
        await this._history(doc.id, docOf(f, doc, raw));
        await atomic(file, writeMarkdown(readMarkdown(raw).body,
          { ...doc, episodeId: null, updatedAt: new Date().toISOString() }, raw));
      }
      // 번호를 다시 매기지 못해도(파일이 잠겨 있어도) 삭제 자체는 끝낸다. 다음 정리 때 맞춰진다.
      await this._layout(f).catch(() => {});
      await this._writeProject(f);
    }
    await fs.rm(path.join(this.root, ".lof", "history", id), {
      recursive: true,
      force: true,
    });
    this.lastSnapshot.delete(id);
    await this.clearDraft(id);
    await this._tombstone(id, f.project.id, deletedAt);
    this.emit("change");
    return true;
  }
  removeProject(id) {
    return this.serial(() => this._removeProject(id));
  }
  // 작품 폴더 전체(회차·플롯·메모·표지)를 휴지통으로 보내고, 그 작품 문서의 변경 이력과
  // 임시 원고를 지운 뒤 삭제 기록을 남긴다. 동기화가 다른 장치에서 작품을 다시 가져오지 않게
  // 작품 자체의 삭제 기록('p-' + 작품 ID)도 남긴다.
  async _removeProject(id, deletedAt = new Date().toISOString()) {
    const p = await this._project(id);
    const ids = [
      ...p.project.documents.map((d) => d.id),
      ...(await this._docFiles(p)).map((d) => d.id),
    ];
    await this.trash(p.dir);
    recordChange(p.dir);
    const deleted = await this.deleted();
    for (const docId of ids) {
      await fs.rm(path.join(this.root, ".lof", "history", docId), {
        recursive: true,
        force: true,
      });
      this.lastSnapshot.delete(docId);
      await this.clearDraft(docId);
      deleted[docId] = { projectId: id, deletedAt };
    }
    deleted[projectTombstone(id)] = { projectId: id, deletedAt, project: true };
    await atomic(this.deletedFile, JSON.stringify(deleted, null, 2));
    this.emit("change");
    return true;
  }
  async snapshot() {
    const list = await this.list();
    if (list.warnings.length)
      throw fail(
        "읽을 수 없는 문서가 있어 동기화를 중단했습니다. " +
          list.warnings.join("; "),
      );
    return {
      format: FORMAT,
      projects: list.projects.map(projectFields),
      assets: await Promise.all(
        list.projects
          .filter((p) => validCover(p.cover))
          .map(async (p) => ({
            projectId: p.id,
            filename: p.cover,
            data: (
              await fs.readFile(path.join(this.root, p.folder, "assets", p.cover))
            ).toString("base64"),
          })),
      ),
      documents: await Promise.all(
        list.documents.map(async (m) => {
          const d = await this.read(m.id);
          return {
            id: d.id,
            projectId: d.projectId,
            kind: d.kind,
            title: d.title,
            status: d.status,
            ...(d.kind === "episode" ? storedMeta(d) : storedDocumentMeta(d)),
            ...(d.properties && Object.keys(d.properties).length ? { properties: d.properties } : {}),
            order: d.order,
            archived: d.archived,
            createdAt: d.createdAt,
            updatedAt: d.updatedAt,
            ...(d.episodeId ? { episodeId: d.episodeId } : {}),
            ...(d.kind !== "episode" ? { path: d.relPath } : {}),
            body: d.body,
            revision: d.fingerprint,
          };
        }),
      ),
      // 지금 로컬에 없는 문서의 삭제 기록만 알린다(휴지통에서 되살린 문서는 제외).
      deleted: Object.fromEntries(
        Object.entries(await this.deleted()).filter(
          ([id]) =>
            !list.documents.some((d) => d.id === id) &&
            !list.projects.some((p) => projectTombstone(p.id) === id),
        ),
      ),
    };
  }
  // 동기화로 받은 문서를 그대로 쓴다. 회차는 속성까지, doc/ 문서는 같은 경로에 본문을 쓰고 속성을 맞춘다.
  async _put(remote) {
    const p = await this._project(remote.projectId);
    if (remote.kind !== "episode") {
      const old = (await this._docFiles(p)).find((d) => d.id === remote.id);
      if (await exists(abs(p.dir, remote.path)) && old?.path !== remote.path)
        throw fail("동기화 대상 경로에 다른 문서가 있습니다. 파일 이름을 바꾼 뒤 다시 동기화해 주세요.", "EXISTS");
      if (old && old.path !== remote.path) await this._move(p.dir, [{ from: old.path, to: remote.path }]);
      const linked =
        remote.episodeId &&
        p.project.documents.some((d) => d.id === remote.episodeId && d.kind === "episode");
      await atomic(abs(p.dir, remote.path), writeMarkdown(remote.body,
        { ...remote, episodeId: linked ? remote.episodeId : null }));
      if (this._dropDocMeta(p, remote.path)) await this._writeProject(p);
      return;
    }
    const fields = {
      title: remote.title,
      status: normalizeStatus(remote.status),
      ...storedMeta(remote),
      properties: customProperties(remote),
      order: Number.isFinite(remote.order) ? remote.order : 0,
      archived: !!remote.archived,
      createdAt: String(remote.createdAt || new Date().toISOString()),
      updatedAt: String(remote.updatedAt || new Date().toISOString()),
      hash: hash(remote.body),
    };
    let entry = p.project.documents.find((d) => d.id === remote.id);
    if (!entry) {
      entry = { id: remote.id, kind: remote.kind, ...fields };
      await this._insert(p, entry, remote.body);
      return;
    }
    for (const k of META_FIELDS) delete entry[k];
    Object.assign(entry, fields);
    await this._layout(p);
    await atomic(abs(p.dir, entry.path), writeMarkdown(remote.body, entry));
    entry._markdown = true;
    await this._writeProject(p);
  }
  merge(snapshot, base = {}) {
    return this.serial(async () => {
      if (
        snapshot.format !== FORMAT ||
        !Array.isArray(snapshot.projects) ||
        !Array.isArray(snapshot.documents) ||
        snapshot.documents.length > 20000
      )
        throw fail("지원하지 않는 동기화 형식");
      const ids = new Set();
      const assets = snapshot.assets || [];
      if (!Array.isArray(assets) || assets.length > snapshot.projects.length)
        throw fail("잘못된 표지 목록");
      for (const p of snapshot.projects) {
        if (!validId(p.id) || typeof p.title !== "string")
          throw fail("잘못된 작품 데이터");
        normalizeTags(p.tags);
        if (p.cover && !validCover(p.cover)) throw fail("잘못된 표지 경로");
      }
      const seenAssets = new Set();
      for (const asset of assets) {
        if (
          typeof asset.data !== "string" ||
          asset.data.length > 11_000_000 ||
          !snapshot.projects.some(
            (p) => p.id === asset.projectId && p.cover === asset.filename,
          ) ||
          seenAssets.has(asset.projectId)
        )
          throw fail("잘못된 표지 데이터");
        validateCover(Buffer.from(asset.data, "base64"), asset.filename);
        seenAssets.add(asset.projectId);
      }
      for (const p of snapshot.projects)
        if (p.cover && !seenAssets.has(p.id))
          throw fail("원격 표지가 누락됐습니다.");
      for (const remote of snapshot.documents) {
        if (
          !validId(remote.id) ||
          ids.has(remote.id) ||
          !KINDS.includes(remote.kind) ||
          typeof remote.title !== "string" ||
          typeof remote.body !== "string" ||
          remote.body.length > 10_000_000 ||
          !snapshot.projects.some((p) => p.id === remote.projectId)
        )
          throw fail("잘못된 원격 문서");
        if (
          remote.kind !== "episode" &&
          (!validRel(remote.path) || !/^doc\/.+\.md$/i.test(remote.path))
        )
          throw fail("잘못된 원격 문서 경로");
        ids.add(remote.id);
        if (fingerprint(remote, remote.body) !== remote.revision)
          throw fail("원격 문서 체크섬 불일치");
      }
      const remoteDeleted = snapshot.deleted ?? {};
      if (
        typeof remoteDeleted !== "object" ||
        Array.isArray(remoteDeleted) ||
        Object.keys(remoteDeleted).length > 20000 ||
        Object.keys(remoteDeleted).some((id) => !validId(id))
      )
        throw fail("잘못된 삭제 기록");
      let local = await this.list();
      const tombstones = await this.deleted();
      // 다른 장치에서 영구 삭제한 문서: 마지막 동기화 이후 여기서 고치지 않았을 때만 지운다.
      // 그 사이 고쳤다면 원고를 잃지 않도록 남겨 둔다.
      const removed = [];
      // 다른 장치에서 지운 작품: 마지막 동기화 이후 여기서 작품 정보와 문서를 하나도 고치지 않았을 때만 지운다.
      for (const [id, info] of Object.entries(remoteDeleted)) {
        if (!info?.project || !id.startsWith("p-")) continue;
        const projectId = id.slice(2),
          lp = local.projects.find((p) => p.id === projectId);
        if (
          lp &&
          base[`project:${projectId}`] === hash(JSON.stringify(projectFields(lp))) &&
          local.documents
            .filter((d) => d.projectId === projectId)
            .every((d) => base[d.id] === d.fingerprint)
        ) {
          await this._removeProject(projectId, String(info.deletedAt || new Date().toISOString()));
          removed.push(id);
        } else if (!lp && !tombstones[id]) {
          tombstones[id] = {
            projectId,
            deletedAt: String(info.deletedAt || new Date().toISOString()),
            project: true,
          };
          await atomic(this.deletedFile, JSON.stringify(tombstones, null, 2));
        }
      }
      if (removed.length) local = await this.list();
      for (const [id, info] of Object.entries(remoteDeleted)) {
        // 작품째 지운 문서는 위에서 작품 단위로 판단했다(고친 작품은 문서까지 모두 남긴다).
        if (info?.project || remoteDeleted[projectTombstone(String(info?.projectId))]) continue;
        const lm = local.documents.find((d) => d.id === id);
        if (lm && base[id] === lm.fingerprint) {
          await this._remove(id, String(info?.deletedAt || new Date().toISOString()));
          removed.push(id);
        } else if (!lm && !tombstones[id]) {
          tombstones[id] = {
            projectId: String(info?.projectId || ""),
            deletedAt: String(info?.deletedAt || new Date().toISOString()),
          };
          await atomic(this.deletedFile, JSON.stringify(tombstones, null, 2));
        }
      }
      if (removed.length) local = await this.list();
      const deletedHere = await this.deleted();
      const imported = [],
        conflicts = [],
        projectConflicts = [];
      for (const p of snapshot.projects) {
        const existing = local.projects.find((x) => x.id === p.id),
          fields = projectFields(p);
        // 여기서 지운 작품은 다시 가져오지 않는다.
        if (!existing && deletedHere[projectTombstone(p.id)]) continue;
        if (!existing)
          await this._newProject(fields, {
            id: p.id,
            index: Number.isInteger(p.index) ? p.index : undefined,
            cover: p.cover ?? null,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
          });
        else {
          const mine = projectFields(existing);
          if (JSON.stringify(mine) === JSON.stringify(fields)) continue;
          const oldHash = hash(JSON.stringify(mine)),
            remoteHash = hash(JSON.stringify(fields));
          if (base[`project:${p.id}`] === oldHash)
            await this._updateProject({ ...fields, manualLineBreak: p.manualLineBreak ?? null, cover: p.cover ?? null }, { keepTime: true });
          else if (base[`project:${p.id}`] !== remoteHash) {
            await atomic(
              path.join(
                this.root,
                ".lof",
                "project-conflicts",
                `${p.id}-${remoteHash}.json`,
              ),
              JSON.stringify(p, null, 2),
            );
            projectConflicts.push(p.id);
          }
        }
      }
      for (const asset of assets) {
        if (deletedHere[projectTombstone(asset.projectId)] && !local.projects.some((x) => x.id === asset.projectId))
          continue;
        const p = await this._project(asset.projectId);
        await atomic(
          path.join(p.dir, "assets", asset.filename),
          Buffer.from(asset.data, "base64"),
        );
      }
      // 회차를 먼저 받아야 문서의 회차 연결이 끊기지 않는다.
      const rank = { episode: 0, plot: 1, memo: 1 };
      for (const remote of [...snapshot.documents].sort((a, b) => rank[a.kind] - rank[b.kind])) {
        const lm = local.documents.find((d) => d.id === remote.id);
        // 여기서 영구 삭제한 문서와, 여기서 지운 작품의 문서는 다시 가져오지 않는다.
        if (!lm && (deletedHere[remote.id] || deletedHere[projectTombstone(remote.projectId)]))
          continue;
        if (!lm) {
          await this._put(remote);
          imported.push(remote.id);
        } else if (lm.fingerprint !== remote.revision) {
          if (
            base[remote.id] === lm.fingerprint &&
            lm.projectId === remote.projectId &&
            (lm.kind === remote.kind || (lm.kind !== "episode" && remote.kind !== "episode"))
          ) {
            const current = await this.read(remote.id);
            if (current.fingerprint !== lm.fingerprint)
              throw fail("동기화 중 로컬 문서가 변경됐습니다.", "CONFLICT");
            await this._history(remote.id, current);
            await this._put(remote);
            imported.push(remote.id);
          } else if (base[remote.id] !== remote.revision) {
            const key = `${remote.id}:${remote.revision}`;
            if (!local.documents.some((d) => d.conflictOf === key)) {
              const copy = await this._create(
                {
                  projectId: remote.projectId,
                  kind: remote.kind,
                  title: `${remote.title} (동기화 충돌 사본)`,
                  body: remote.body,
                  ...(remote.kind !== "episode" ? storedDocumentMeta(remote) : {}),
                  properties: customProperties(remote),
                  episodeId: local.documents.some((d) => d.id === remote.episodeId)
                    ? remote.episodeId
                    : undefined,
                  folder: remote.kind !== "episode" ? folderOf(remote.path).slice(4) : undefined,
                },
                { conflictOf: key },
              );
              conflicts.push(copy.id);
            }
          }
        }
      }
      this.emit("change");
      return { imported, conflicts, projectConflicts, removed };
    });
  }
}
