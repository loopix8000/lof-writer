import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { atomic, validId, hash } from "./store.mjs";

const nameOK = (n) => /^device-[a-zA-Z0-9_-]+\.json$/.test(n);
const MAX = 50_000_000;
export async function adapter(config) {
  const prefix = "lof-writer-sync-v1";
  if (config.type === "folder") {
    const root = path.join(path.resolve(config.folder), prefix);
    await fs.mkdir(root, { recursive: true });
    return {
      list: async () => (await fs.readdir(root)).filter(nameOK),
      read: async (n) => {
        const f = path.join(root, n);
        if ((await fs.stat(f)).size > MAX)
          throw Error("동기화 파일이 50MB를 초과합니다.");
        return fs.readFile(f, "utf8");
      },
      write: async (n, v) => atomic(path.join(root, n), v),
      close: () => {},
    };
  }
  if (config.type === "webdav") {
    const { createClient } = await import("webdav");
    const url = new URL(config.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw Error("WebDAV 주소를 확인해 주세요.");
    const client = createClient(config.url, {
      username: config.username,
      password: config.password,
    });
    const root =
      `/${String(config.remotePath || "").replace(/^\/+|\/+$/g, "")}/${prefix}`.replace(
        /\/+/g,
        "/",
      );
    await client.createDirectory(root, { recursive: true });
    return {
      list: async () =>
        (await client.getDirectoryContents(root))
          .filter((f) => f.type === "file" && nameOK(f.basename))
          .map((f) => f.basename),
      read: async (n) => {
        const s = await client.stat(`${root}/${n}`);
        if (s.size > MAX) throw Error("동기화 파일이 너무 큽니다.");
        return client.getFileContents(`${root}/${n}`, { format: "text" });
      },
      write: async (n, v) => {
        const temp = `${root}/.${n}.upload`;
        await client.putFileContents(temp, v, { overwrite: true });
        await client.moveFile(temp, `${root}/${n}`, { overwrite: true });
      },
      close: () => {},
    };
  }
  if (config.type === "ftp") {
    const { Client } = await import("basic-ftp");
    const client = new Client(20000);
    await client.access({
      host: config.host,
      port: Number(config.port) || 21,
      user: config.username,
      password: config.password,
      secure: config.secure ? true : false,
    });
    await client.ensureDir(`${config.remotePath || "/"}/${prefix}`);
    return {
      list: async () =>
        (await client.list())
          .filter((f) => f.isFile && nameOK(f.name))
          .map((f) => f.name),
      read: async (n) => {
        const size = await client.size(n);
        if (size > MAX) throw Error("동기화 파일이 너무 큽니다.");
        const chunks = [];
        let bytes = 0;
        const target = new Writable({
          write(c, e, cb) {
            bytes += c.length;
            if (bytes > MAX) return cb(Error("동기화 파일이 너무 큽니다."));
            chunks.push(c);
            cb();
          },
        });
        await client.downloadTo(target, n);
        return Buffer.concat(chunks).toString("utf8");
      },
      write: async (n, v) => {
        const temp = `.${n}.upload`;
        await client.uploadFrom(Readable.from([v]), temp);
        await client.rename(temp, n);
      },
      close: () => client.close(),
    };
  }
  throw Error("연결 방식을 선택해 주세요.");
}
export async function syncOnce(store, config, deviceId) {
  if (!validId(deviceId)) throw Error("잘못된 장치 ID");
  const dir = path.join(store.root, ".lof", "sync"),
    stateFile = path.join(dir, `${config.id}.json`);
  let state = { peers: {} };
  try {
    state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const remote = await adapter(config);
  const result = {
    downloaded: 0,
    conflicts: 0,
    projectConflicts: 0,
    removed: 0,
    uploaded: 0,
  };
  try {
    const peers = await remote.list();
    if (peers.length > 100) throw Error("동기화 장치가 100개를 초과합니다.");
    for (const n of peers.filter((n) => n !== `device-${deviceId}.json`)) {
      if (!nameOK(n)) continue;
      const raw = await remote.read(n);
      if (Buffer.byteLength(raw) > MAX)
        throw Error("동기화 파일이 너무 큽니다.");
      const snapshot = JSON.parse(raw);
      const merged = await store.merge(snapshot, {
        ...(state.published || {}),
        ...(state.peers[n] || {}),
      });
      result.downloaded += merged.imported.length;
      result.conflicts += merged.conflicts.length;
      result.projectConflicts += merged.projectConflicts.length;
      result.removed += merged.removed.length;
      state.peers[n] = Object.fromEntries([
        ...snapshot.documents.map((d) => [d.id, d.revision]),
        ...snapshot.projects.map((p) => [
          `project:${p.id}`,
          hash(JSON.stringify(p)),
        ]),
      ]);
    }
    const snapshot = await store.snapshot();
    const raw = JSON.stringify({
      ...snapshot,
      deviceId,
      at: new Date().toISOString(),
    });
    if (Buffer.byteLength(raw) > MAX)
      throw Error("알파 동기화는 도서관당 50MB까지 지원합니다.");
    await remote.write(`device-${deviceId}.json`, raw);
    result.uploaded = snapshot.documents.length;
    state.published = Object.fromEntries([
      ...snapshot.documents.map((d) => [d.id, d.revision]),
      ...snapshot.projects.map((p) => [
        `project:${p.id}`,
        hash(JSON.stringify(p)),
      ]),
    ]);
    await atomic(stateFile, JSON.stringify(state, null, 2));
    return result;
  } finally {
    await remote.close();
  }
}
