import fs from "node:fs/promises";
import path from "node:path";

// Markdown 원본과 분리된 재생성 가능한 캐시. 본문 검색 캐시는 문서별로 갱신한다.
export class FileIndex {
  constructor(store) {
    this.store = store;
    this.file = path.join(store.root, ".lof", "index.json");
    this.bodies = new Map();
    this.dirty = new Set();
    this.tail = Promise.resolve();
    this.common = { root: "", files: {} };
  }
  async load() {
    try {
      const data = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (data.version !== 1 || data.vaultId !== this.store.vault.id || !Array.isArray(data.projects)) return null;
      for (const p of data.projects) {
        if (typeof p.folder !== "string" || p.folder.startsWith(".") || /[<>:"/\\|?*\u0000-\u001f]/.test(p.folder) || path.basename(p.folder) !== p.folder ||
            !/^[a-zA-Z0-9_-]{1,80}$/.test(p.project?.id) || !p.files || typeof p.files !== "object") return null;
        for (const [rel, f] of Object.entries(p.files)) if (!/^(episodes|doc)\/.+\.md$/i.test(rel) ||
            rel.split("/").some((part) => !part || part === "." || part === ".." || part.includes("\\")) ||
            !/^[a-zA-Z0-9_-]{1,80}$/.test(f.entry?.id) || f.entry.path !== rel || f.doc?.id !== f.entry.id) return null;
      }
      for (const p of data.projects) {
        p.dir = path.join(this.store.root, p.folder);
        for (const [rel, file] of Object.entries(p.files)) {
          file.doc.path = path.join(p.dir, ...rel.split("/"));
          file.doc.relPath = rel;
        }
      }
      if (data.common?.files && typeof data.common.root === "string" &&
          Object.values(data.common.files).every((f) => /^[a-zA-Z0-9_-]{1,80}$/.test(f.id))) this.common = data.common;
      return { projects: data.projects, warnings: data.warnings || [] };
    } catch { return null; }
  }
  bodyFile(projectId, id) {
    if (![projectId, id].every((value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value)))
      throw new Error("검색 캐시의 문서 ID가 올바르지 않습니다.");
    return path.join(this.store.root, ".lof", "search", projectId, `${id}.txt`);
  }
  async cacheBody(projectId, id, body) {
    this.bodies.set(`${projectId}:${id}`, body);
    await this.store._atomic(this.bodyFile(projectId, id), body);
  }
  async body(projectId, id) {
    const key = `${projectId}:${id}`;
    if (!this.bodies.has(key)) this.bodies.set(key, await fs.readFile(this.bodyFile(projectId, id), "utf8"));
    return this.bodies.get(key);
  }
  save(catalog) {
    const payload = JSON.stringify({ version: 1, vaultId: this.store.vault.id,
      projects: catalog.projects.map(({ dir, ...p }) => ({ ...p, folder: path.basename(dir) })),
      common: this.common,
      warnings: catalog.warnings || [] });
    const write = this.tail.catch(() => {}).then(() => this.store._atomic(this.file, payload));
    this.tail = write;
    return write;
  }
}
