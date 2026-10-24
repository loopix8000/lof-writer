import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomic, hash, fail, validRel, safeName, memoId, abs, matchLines, searchHit, searchRegex } from "./store.mjs";
import { readMarkdown, writeMarkdown, markdownEntry } from "./markdown.mjs";

// 메모 공간: 공용 메모 폴더(사용자가 위치를 정함)와 각 작품의 doc/ 폴더.
// 안의 폴더와 Markdown 파일은 자유롭게 만들고, 이름을 바꾸고, 옮기고, 지울 수 있다.
// 경로는 공간 루트 기준 상대 경로('/' 구분)로 주고받는다.
export const COMMON = "common";
const missing = (e) => {
  if (e.code === "ENOENT") return [];
  throw e;
};
const isMd = (name) => /\.md$/i.test(name);
const skipped = (name) => name.startsWith(".") || /\.(tmp|lofmv)$/i.test(name);
const parentOf = (rel) => rel.slice(0, Math.max(0, rel.lastIndexOf("/")));
const nameOf = (rel) => rel.slice(rel.lastIndexOf("/") + 1);
const join = (folder, name) => (folder ? `${folder}/${name}` : name);
const byName = (a, b) => a.localeCompare(b, "ko", { numeric: true });

export class Memos {
  // commonRoot: 공용 메모 폴더의 절대 경로를 돌려주는 함수.
  constructor(store, commonRoot) {
    this.store = store;
    this.commonRoot = commonRoot;
  }
  async spaces() {
    const { projects } = await this.store._scan();
    return [
      { id: COMMON, title: "공용 메모", root: path.resolve(this.commonRoot()) },
      ...projects
        .sort((a, b) => (a.project.index ?? 0) - (b.project.index ?? 0))
        .map((p) => ({ id: p.project.id, title: p.project.title, root: path.join(p.dir, "doc") })),
    ];
  }
  async _space(id) {
    if (id === COMMON) {
      const root = path.resolve(this.commonRoot());
      await fs.mkdir(root, { recursive: true });
      return { id, title: "공용 메모", root, projectId: null };
    }
    const p = await this.store._project(id);
    const root = path.join(p.dir, "doc");
    await fs.mkdir(root, { recursive: true });
    return { id, title: p.project.title, root, projectId: p.project.id };
  }
  _abs(space, rel) {
    if (!validRel(rel)) throw fail("잘못된 메모 경로");
    return abs(space.root, rel);
  }
  // 폴더 안의 하위 폴더와 Markdown 파일을 모두 평평한 목록으로 돌려준다.
  async _walk(space, rel = "") {
    const out = [];
    const dir = rel ? abs(space.root, rel) : space.root;
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(missing)) {
      if (skipped(e.name)) continue;
      const r = join(rel, e.name);
      if (e.isDirectory()) {
        out.push({ path: r, name: e.name, type: "folder" });
        out.push(...(await this._walk(space, r)));
      } else if (e.isFile() && isMd(e.name)) {
        const stat = await fs.stat(abs(space.root, r)).catch(() => null);
        if (stat)
          out.push({
            path: r,
            name: e.name.replace(/\.md$/i, ""),
            type: "file",
            updatedAt: stat.mtime.toISOString(),
          });
      }
    }
    return out;
  }
  async tree(spaceId) {
    const space = await this._space(spaceId);
    const entries = await this._walk(space);
    entries.sort(
      (a, b) =>
        byName(parentOf(a.path), parentOf(b.path)) ||
        (a.type === b.type ? 0 : a.type === "folder" ? -1 : 1) ||
        byName(a.name, b.name),
    );
    // 작품의 doc/ 문서에는 타입(플롯/메모)과 연결된 회차를 붙인다.
    if (space.projectId) {
      const p = await this.store._project(space.projectId);
      const docs = await this.store._docFiles(p);
      for (const e of entries)
        if (e.type === "file") {
          const m = docs.find((d) => d.path === `doc/${e.path}`);
          if (!m) continue;
          e.kind = m.kind;
          if (m.episodeId) e.episodeId = m.episodeId;
        }
    }
    return { space: { id: space.id, title: space.title, root: space.root }, entries };
  }
  async read(spaceId, rel) {
    const space = await this._space(spaceId);
    if (!isMd(rel)) throw fail("Markdown 메모만 열 수 있습니다.");
    const file = this._abs(space, rel);
    const raw = await fs.readFile(file, "utf8").catch((e) => {
      if (e.code === "ENOENT") throw fail("메모를 찾을 수 없습니다.", "NOT_FOUND");
      throw e;
    });
    const stat = await fs.stat(file);
    return {
      space: space.id,
      path: rel,
      title: nameOf(rel).replace(/\.md$/i, ""),
      body: readMarkdown(raw).body,
      manualLineBreak: readMarkdown(raw).properties.manualLineBreak === true,
      revision: hash(raw),
      updatedAt: stat.mtime.toISOString(),
    };
  }
  // 작업을 저장소의 쓰기 순서에 맞춰 하나씩 실행하고, 끝나면 화면에 변경을 알린다.
  _write(fn) {
    return this.store.serial(async () => {
      const result = await fn();
      this.store.emit("change");
      return result;
    });
  }
  save(input) {
    return this._write(async () => {
      const space = await this._space(input.space);
      if (!isMd(input.path)) throw fail("Markdown 메모만 저장할 수 있습니다.");
      if (typeof input.body !== "string" || input.body.length > 10_000_000)
        throw fail("본문은 10MB 이하 문자열이어야 합니다.");
      const file = this._abs(space, input.path);
      const raw = await fs.readFile(file, "utf8").catch((e) => {
        if (e.code === "ENOENT") throw fail("메모를 찾을 수 없습니다.", "NOT_FOUND");
        throw e;
      });
      if (!input.expectedRevision || hash(raw) !== input.expectedRevision)
        throw fail("다른 곳에서 수정된 메모입니다. 현재 내용을 다시 확인해 주세요.", "CONFLICT");
      const parsed = readMarkdown(raw);
      if (input.body !== parsed.body) {
        if (space.projectId) {
          await this.store._save({ id: parsed.properties.id || memoId(space.projectId, `doc/${input.path}`),
            body: input.body, expectedRevision: input.expectedRevision });
        } else {
          const doc = markdownEntry(raw, { id: randomUUID(), kind: "memo", title: nameOf(input.path).replace(/\.md$/i, "") });
          await atomic(file, writeMarkdown(input.body, { ...doc, updatedAt: new Date().toISOString() }, raw));
        }
      }
      return this.read(space.id, input.path);
    });
  }
  // 같은 폴더에 같은 이름이 있으면 덮어쓰지 않고 " (2)"를 붙인다.
  async _unique(space, folder, name, ext) {
    const taken = new Set(
      (await fs.readdir(folder ? abs(space.root, folder) : space.root).catch(missing)).map((n) =>
        n.toLowerCase(),
      ),
    );
    let candidate = name + ext;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${name} (${n})${ext}`;
    return join(folder, candidate);
  }
  _folder(space, folder) {
    if (!folder) return "";
    this._abs(space, folder);
    return folder;
  }
  create(input) {
    return this._write(async () => {
      const space = await this._space(input.space);
      const folder = this._folder(space, input.folder);
      const body = String(input.body ?? "");
      if (body.length > 10_000_000) throw fail("본문은 10MB 이하만 지원합니다.");
      if (space.projectId) {
        const doc = await this.store._create({ ...input, projectId: space.projectId, kind: "memo", folder, body });
        return this.read(space.id, doc.relPath.slice(4));
      }
      const rel = await this._unique(space, folder, safeName(input.title, "새 메모"), ".md");
      const now = new Date().toISOString();
      await atomic(abs(space.root, rel), writeMarkdown(body, { id: randomUUID(), kind: "memo", title: nameOf(rel).replace(/\.md$/i, ""), createdAt: now, updatedAt: now }));
      return this.read(space.id, rel);
    });
  }
  createFolder(input) {
    return this._write(async () => {
      const space = await this._space(input.space);
      const parent = this._folder(space, input.parent);
      const rel = await this._unique(space, parent, safeName(input.name, "새 폴더"), "");
      await fs.mkdir(abs(space.root, rel), { recursive: true });
      return { path: rel };
    });
  }
  rename(input) {
    return this._write(async () => {
      const space = await this._space(input.space);
      const file = this._abs(space, input.path);
      const stat = await fs.stat(file);
      const ext = stat.isDirectory() ? "" : ".md";
      const name = safeName(input.name, stat.isDirectory() ? "새 폴더" : "새 메모");
      if (name + ext === nameOf(input.path)) return { path: input.path };
      // 대소문자만 바꾸는 경우에는 자기 자신과 겹치므로 번호를 붙이지 않는다.
      const target =
        (name + ext).toLowerCase() === nameOf(input.path).toLowerCase()
          ? join(parentOf(input.path), name + ext)
          : await this._unique(space, parentOf(input.path), name, ext);
      await this._relocate(space, input.path, target);
      return { path: target };
    });
  }
  // to: 옮길 대상 폴더(공간 루트는 빈 문자열).
  move(input) {
    return this._write(async () => {
      const space = await this._space(input.space);
      this._abs(space, input.path);
      const to = this._folder(space, input.to);
      if (to === input.path || to.startsWith(input.path + "/"))
        throw fail("폴더를 자기 안으로 옮길 수 없습니다.");
      if (parentOf(input.path) === to) return { path: input.path };
      const stat = await fs.stat(abs(space.root, input.path));
      if (to && !(await fs.stat(abs(space.root, to))).isDirectory())
        throw fail("폴더로만 옮길 수 있습니다.");
      const ext = stat.isDirectory() ? "" : ".md";
      const target = await this._unique(space, to, nameOf(input.path).slice(0, nameOf(input.path).length - ext.length), ext);
      await this._relocate(space, input.path, target);
      return { path: target };
    });
  }
  async _filesUnder(space, rel) {
    const stat = await fs.stat(abs(space.root, rel));
    if (!stat.isDirectory()) return isMd(rel) ? [rel] : [];
    return (await this._walk(space, rel)).filter((e) => e.type === "file").map((e) => e.path);
  }
  // 파일 안의 고정 ID를 유지한다. 경로 이동은 변경 이력과 회차 연결을 바꾸지 않는다.
  async _relocate(space, from, to) {
    const before = space.projectId ? await this._filesUnder(space, from) : [];
    const temp = `${from}.${Date.now().toString(36)}.lofmv`;
    await fs.rename(abs(space.root, from), abs(space.root, temp));
    try {
      await fs.rename(abs(space.root, temp), abs(space.root, to));
    } catch (e) {
      await fs.rename(abs(space.root, temp), abs(space.root, from)).catch(() => {});
      throw fail(`이름을 바꾸지 못했습니다. 다른 프로그램에서 열려 있는지 확인해 주세요. (${e.message})`, "RENAME");
    }
    this.store.invalidatePath(`${path.basename(path.dirname(space.root))}/doc/${from}`);
    this.store.invalidatePath(`${path.basename(path.dirname(space.root))}/doc/${to}`);
    // 이전 형식의 경로 속성도 함께 옮긴다. 고정 ID·속성·이력은 파일 이동에 영향을 받지 않는다.
    if (space.projectId) {
      const p = await this.store._project(space.projectId);
      if (this.store._moveDocMeta(p, `doc/${from}`, `doc/${to}`))
        await this.store._writeProject(p);
      if (isMd(from) && before.length === 1 && before[0] === from && nameOf(from) !== nameOf(to)) {
        const file = abs(space.root, to), raw = await fs.readFile(file, "utf8");
        const doc = markdownEntry(raw, { kind: "memo", title: nameOf(from).replace(/\.md$/i, "") });
        await atomic(file, writeMarkdown(readMarkdown(raw).body,
          { ...doc, title: nameOf(to).replace(/\.md$/i, ""), updatedAt: new Date().toISOString() }, raw));
      }
    }
  }
  // 파일과 폴더는 휴지통으로 보낸다(Electron에서는 Windows 휴지통).
  remove(input) {
    return this._write(async () => {
      const space = await this._space(input.space);
      const file = this._abs(space, input.path);
      const files = space.projectId ? await this._filesUnder(space, input.path) : [];
      const ids = new Map();
      for (const rel of files) ids.set(rel,
        readMarkdown(await fs.readFile(abs(space.root, rel), "utf8")).properties.id || memoId(space.projectId, `doc/${rel}`));
      await this.store.trash(file);
      if (space.projectId) this.store.invalidatePath(`${path.basename(path.dirname(space.root))}/doc/${input.path}`);
      if (space.projectId) {
        const p = await this.store._project(space.projectId);
        if (this.store._dropDocMeta(p, `doc/${input.path}`)) await this.store._writeProject(p);
      }
      for (const rel of files) {
        const id = ids.get(rel);
        await fs.rm(path.join(this.store.root, ".lof", "history", id), { recursive: true, force: true });
        this.store.lastSnapshot.delete(id);
        await this.store.clearDraft(id);
        await this.store._tombstone(id, space.projectId);
      }
      return true;
    });
  }
  // 통합 검색용: 메모 이름(경로)과 본문에서 찾는다. '#'으로 시작하면 태그 검색이라 건너뛴다.
  async searchText(spaceId, query, { caseSensitive = false } = {}) {
    const raw = String(query ?? "").trim();
    if (!raw || raw.startsWith("#")) return { files: [], results: [] };
    const space = await this._space(spaceId);
    const re = searchRegex(raw, caseSensitive);
    const files = [],
      results = [];
    const cache = this.store.index.common;
    if (cache.root !== space.root) { cache.root = space.root; cache.files = {}; }
    let changed = false;
    for (const e of await this._walk(space)) {
      if (e.type !== "file") continue;
      if (searchHit(re, e.path)) files.push({ space: space.id, path: e.path, name: e.name });
      const file = abs(space.root, e.path), stamp = await this.store._stamp(file);
      let indexed = cache.files[e.path];
      if (!indexed || indexed.stamp !== stamp) {
        const raw = await fs.readFile(file, "utf8").catch(() => ""), parsed = readMarkdown(raw);
        const id = typeof parsed.properties.id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(parsed.properties.id)
          ? parsed.properties.id : hash(`${space.root}/${e.path}`);
        await this.store.index.cacheBody("common", id, parsed.body);
        indexed = cache.files[e.path] = { id, stamp };
        changed = true;
      }
      let body;
      try { body = await this.store.index.body("common", indexed.id); }
      catch { body = readMarkdown(await fs.readFile(file, "utf8")).body; await this.store.index.cacheBody("common", indexed.id, body); }
      const found = matchLines(body, raw, caseSensitive, 50);
      if (found.matches.length)
        results.push({ space: space.id, path: e.path, name: e.name, matches: found.matches });
      if (results.length >= 200) break;
    }
    if (changed && this.store.catalog) await this.store.index.save(this.store.catalog);
    return { files, results };
  }
  async locate(spaceId, rel) {
    const space = await this._space(spaceId);
    return rel ? this._abs(space, rel) : space.root;
  }
}
