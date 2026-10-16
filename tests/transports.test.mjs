import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { adapter } from "../core/sync.mjs";

test("WebDAV 실제 HTTP 프로토콜로 업로드·목록·다운로드·교체", async (t) => {
  const files = new Map(),
    dirs = new Set(["/", "/writing", "/writing/lof-writer-sync-v1"]);
  const server = http.createServer(async (req, res) => {
    const name =
      decodeURIComponent(new URL(req.url, "http://localhost").pathname).replace(
        /\/$/,
        "",
      ) || "/";
    if (
      req.headers.authorization !==
      "Basic " + Buffer.from("writer:test").toString("base64")
    ) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="test"' });
      return res.end();
    }
    if (req.method === "MKCOL") {
      dirs.add(name);
      res.writeHead(201);
      return res.end();
    }
    if (req.method === "PUT") {
      let body = "";
      for await (const c of req) body += c;
      files.set(name, body);
      res.writeHead(201);
      return res.end();
    }
    if (req.method === "MOVE") {
      const target = new URL(req.headers.destination).pathname;
      files.set(target, files.get(name));
      files.delete(name);
      res.writeHead(201);
      return res.end();
    }
    if (req.method === "GET") {
      if (!files.has(name)) {
        res.writeHead(404);
        return res.end();
      }
      return res.end(files.get(name));
    }
    if (req.method === "PROPFIND") {
      const items =
        req.headers.depth === "0"
          ? [name]
          : [
              name,
              ...[...files.keys()].filter((n) => n.startsWith(name + "/")),
            ];
      if (!dirs.has(name) && !files.has(name)) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(207, { "Content-Type": "application/xml" });
      return res.end(
        `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${items.map((n) => `<d:response><d:href>${n}</d:href><d:propstat><d:prop><d:displayname>${n.split("/").pop()}</d:displayname><d:resourcetype>${dirs.has(n) ? "<d:collection/>" : ""}</d:resourcetype><d:getcontentlength>${Buffer.byteLength(files.get(n) || "")}</d:getcontentlength><d:getlastmodified>Mon, 12 Oct 2026 12:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join("")}</d:multistatus>`,
      );
    }
    res.writeHead(405);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const client = await adapter({
    type: "webdav",
    url: `http://127.0.0.1:${server.address().port}`,
    username: "writer",
    password: "test",
    remotePath: "/writing",
  });
  await client.write("device-A.json", '{"원고":"한글"}');
  assert.deepEqual(await client.list(), ["device-A.json"]);
  assert.equal(await client.read("device-A.json"), '{"원고":"한글"}');
  await client.write("device-A.json", '{"원고":"수정"}');
  assert.equal(await client.read("device-A.json"), '{"원고":"수정"}');
  await client.close();
});

test("FTP 실제 제어/데이터 소켓으로 업로드·MLSD·다운로드·교체", async (t) => {
  const files = new Map(),
    sockets = new Set(),
    passiveServers = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.write("220 Test FTP\r\n");
    let buffer = "",
      cwd = "/",
      dataConnection,
      passive,
      from;
    const send = (s) => socket.write(s + "\r\n");
    const key = (n) =>
      n.startsWith("/") ? n : cwd.replace(/\/$/, "") + "/" + n;
    let chain = Promise.resolve();
    socket.on("data", (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        chain = chain
          .then(async () => {
            const at = line.indexOf(" "),
              cmd = (at < 0 ? line : line.slice(0, at)).toUpperCase(),
              arg = at < 0 ? "" : line.slice(at + 1);
            if (cmd === "USER") return send("331 Password");
            if (cmd === "PASS") return send("230 Logged in");
            if (cmd === "FEAT") {
              socket.write(
                "211-Features\r\n MLST type;size;modify;\r\n UTF8\r\n211 End\r\n",
              );
              return;
            }
            if (["OPTS", "TYPE", "STRU"].includes(cmd)) return send("200 OK");
            if (cmd === "PWD") return send(`257 "${cwd}"`);
            if (cmd === "CWD") {
              cwd = key(arg);
              return send("250 Directory changed");
            }
            if (cmd === "CDUP") {
              cwd = "/";
              return send("250 OK");
            }
            if (cmd === "MKD") return send(`257 "${arg}"`);
            if (cmd === "EPSV") {
              passive = net.createServer();
              passiveServers.add(passive);
              dataConnection = new Promise((r) =>
                passive.once("connection", (s) => {
                  sockets.add(s);
                  s.on("close", () => sockets.delete(s));
                  r(s);
                }),
              );
              await new Promise((r) => passive.listen(0, "127.0.0.1", r));
              return send(
                `229 Entering Extended Passive Mode (|||${passive.address().port}|)`,
              );
            }
            if (cmd === "STOR") {
              send("150 Opening data");
              const s = await dataConnection;
              let data = "";
              s.on("data", (c) => (data += c));
              await new Promise((r) => s.on("end", r));
              files.set(key(arg), data);
              s.end();
              passive.close();
              return send("226 Transfer complete");
            }
            if (cmd === "RETR" || cmd === "MLSD") {
              send("150 Opening data");
              const s = await dataConnection;
              const value =
                cmd === "RETR"
                  ? files.get(key(arg))
                  : [...files]
                      .filter(([n]) =>
                        n.startsWith(cwd.replace(/\/$/, "") + "/"),
                      )
                      .map(
                        ([n, v]) =>
                          `type=file;size=${Buffer.byteLength(v)};modify=20261012120000; ${n.split("/").pop()}\r\n`,
                      )
                      .join("");
              s.end(value || "");
              await new Promise((r) => s.on("close", r));
              passive.close();
              return send("226 Transfer complete");
            }
            if (cmd === "SIZE") {
              const f = files.get(key(arg));
              return send(
                f === undefined ? "550 Missing" : `213 ${Buffer.byteLength(f)}`,
              );
            }
            if (cmd === "RNFR") {
              from = key(arg);
              return send("350 Ready");
            }
            if (cmd === "RNTO") {
              files.set(key(arg), files.get(from));
              files.delete(from);
              return send("250 Renamed");
            }
            if (cmd === "QUIT") {
              send("221 Bye");
              socket.end();
              return;
            }
            return send("502 Unsupported");
          })
          .catch((e) => {
            send("451 " + e.message);
          });
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    for (const s of sockets) s.destroy();
    for (const p of passiveServers) p.close();
    server.close();
  });
  const client = await adapter({
    type: "ftp",
    host: "127.0.0.1",
    port: server.address().port,
    username: "writer",
    password: "test",
    remotePath: "/writing",
  });
  t.after(() => client.close());
  await client.write("device-A.json", '{"본문":"첫 원고"}');
  assert.deepEqual(await client.list(), ["device-A.json"]);
  assert.equal(await client.read("device-A.json"), '{"본문":"첫 원고"}');
  await client.write("device-A.json", "수정 원고");
  assert.equal(await client.read("device-A.json"), "수정 원고");
});

test("제거된 Google Drive 연결은 사용할 수 없음", async () => {
  await assert.rejects(adapter({ type: "drive" }), /연결 방식/);
});
