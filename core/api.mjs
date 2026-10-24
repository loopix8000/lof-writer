import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

export const toolDefinitions = [
  ["library_list", "작품과 문서 목록 및 revision 조회", {}],
  [
    "document_read",
    "문서의 Markdown 본문과 revision 조회",
    {
      id: { type: "string" },
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 100000 },
    },
    ["id"],
  ],
  [
    "document_search",
    "앱 검색과 같은 통합 검색. 작품(제목·소개·태그), 문서(제목·경로·태그), 본문의 일치한 줄을 반환",
    {
      query: { type: "string", description: "검색어. 정규식으로 해석하며 줄마다 적용(예: 주인공|조연). 올바르지 않은 정규식은 입력한 글자 그대로 검색. #로 시작하면 태그만 검색" },
      projectId: { type: "string", description: "지정하면 해당 작품의 문서로 범위를 좁힘. 작품 검색은 항상 전체 대상" },
      caseSensitive: { type: "boolean", description: "대소문자 구분 여부. 기본값 false" },
    },
    ["query"],
  ],
  [
    "project_create",
    "작품 만들기",
    { title: { type: "string" }, description: { type: "string" } },
    ["title"],
  ],
  [
    "document_create",
    "회차, 플롯, 메모 생성. 플롯·메모는 doc/ 아래 folder에 만들고 episodeId로 회차에 연결할 수 있다",
    {
      projectId: { type: "string" },
      kind: { type: "string", enum: ["episode", "plot", "memo"] },
      title: { type: "string" },
      body: { type: "string" },
      tags: { type: "array", items: { type: "string" }, description: "문서 태그" },
      manualLineBreak: { type: "boolean", description: "true 수동 줄바꿈 관리, false 자동 관리" },
      episodeId: { type: "string" },
      folder: { type: "string" },
      properties: { type: "object", description: "사용자 정의 YAML 속성" },
    },
    ["projectId", "title"],
  ],
  [
    "document_update",
    "expectedRevision이 일치할 때만 본문과 메타데이터 저장",
    {
      id: { type: "string" },
      expectedRevision: { type: "string" },
      body: { type: "string" },
      title: { type: "string" },
      // 회차 상태: 집필 중·퇴고 중·집필 완료(완료하면 원고 보호로 편집이 막힌다).
      status: { type: "string", enum: ["in_progress", "revision", "completed"] },
      episodeType: { type: "integer", enum: [0, 2, 3, 4, 6], description: "0 일반, 2 프롤로그, 3 에필로그, 4 특별편, 6 단편" },
      description: { type: "string", description: "회차 요약" },
      authorComment: { type: "string", description: "작가의 말" },
      manualLineBreak: { type: "boolean", description: "true 수동 줄바꿈 관리, false 자동 줄바꿈 관리" },
      tags: { type: "array", items: { type: "string" } },
      properties: { type: "object", description: "사용자 정의 YAML 속성" },
      order: { type: "number" },
      archived: { type: "boolean" },
      episodeId: { type: ["string", "null"] },
      kind: { type: "string", enum: ["plot", "memo"] },
    },
    ["id", "expectedRevision"],
  ],
  [
    "document_reorder",
    "한 작품의 회차 순서를 ids 순서대로 바꾸고 파일 이름 번호를 다시 매김",
    {
      projectId: { type: "string" },
      ids: { type: "array", items: { type: "string" } },
    },
    ["projectId", "ids"],
  ],
  [
    "document_patch",
    "정확히 한 번 일치하는 텍스트 교체. revision 필수",
    {
      id: { type: "string" },
      expectedRevision: { type: "string" },
      find: { type: "string", minLength: 1 },
      replace: { type: "string" },
    },
    ["id", "expectedRevision", "find", "replace"],
  ],
  [
    "history_list",
    "최근 변경 이력 최대 100개",
    { id: { type: "string" } },
    ["id"],
  ],
  [
    "history_read",
    "이력의 본문 확인",
    { id: { type: "string" }, name: { type: "string" } },
    ["id", "name"],
  ],
  [
    "history_restore",
    "현재 revision 확인 후 이력 복원",
    {
      id: { type: "string" },
      name: { type: "string" },
      expectedRevision: { type: "string" },
    },
    ["id", "name", "expectedRevision"],
  ],
].map(([name, description, properties, required = []]) => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  },
}));

export async function dispatch(store, name, args = {}) {
  switch (name) {
    case "library_list":
      return store.list();
    case "document_read": {
      const d = await store.read(args.id);
      const offset = Math.max(0, args.offset || 0),
        limit = Math.min(100000, args.limit || 100000);
      return {
        ...d,
        body: d.body.slice(offset, offset + limit),
        offset,
        totalLength: d.body.length,
        truncated: offset + limit < d.body.length,
      };
    }
    case "document_search":
      return store.searchAll(args.query, args.projectId, args);
    case "project_create":
      return store.createProject(args);
    case "document_create":
      return store.create(args);
    case "document_update":
      return store.save(args);
    case "document_reorder":
      return store.reorder(args);
    case "document_patch": {
      const d = await store.read(args.id);
      if (
        typeof args.find !== "string" ||
        !args.find ||
        typeof args.replace !== "string"
      )
        throw Error("find와 replace가 필요합니다.");
      const i = d.body.indexOf(args.find);
      if (i < 0 || d.body.indexOf(args.find, i + args.find.length) >= 0)
        throw Error("find는 본문에서 정확히 한 번 일치해야 합니다.");
      return store.save({
        id: d.id,
        expectedRevision: args.expectedRevision,
        body:
          d.body.slice(0, i) +
          args.replace +
          d.body.slice(i + args.find.length),
      });
    }
    case "history_list":
      return store.history(args.id);
    case "history_read":
      return store.historyRead(args.id, args.name);
    case "history_restore":
      return store.restore(args);
    default:
      throw Error("지원하지 않는 도구");
  }
}
export async function startApi(getStore) {
  const token = randomBytes(32).toString("hex");
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify(body));
    };
    if (req.headers.origin)
      return send(403, { error: "Browser origins are not allowed" });
    if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host || ""))
      return send(403, { error: "Invalid host" });
    if (req.url === "/health" && req.method === "GET")
      return send(200, { name: "Lof Writer", version: "1.0.0-beta.1" });
    const auth = Buffer.from(req.headers.authorization || ""),
      expected = Buffer.from(`Bearer ${token}`);
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected))
      return send(401, { error: "Unauthorized" });
    if (req.method !== "POST" || !["/mcp", "/rpc"].includes(req.url))
      return send(404, { error: "Not found" });
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 12_000_000)
          throw Error("Request too large");
      }
      const data = JSON.parse(body);
      if (req.url === "/rpc") {
        const def = toolDefinitions.find((t) => t.name === data.name);
        if (!def) throw Error("Unknown operation");
        return send(200, {
          result: await dispatch(getStore(), data.name, data.arguments),
        });
      }
      const { id, method, params } = data;
      if (id === undefined) {
        res.writeHead(202);
        return res.end();
      }
      const rpc = (result) => send(200, { jsonrpc: "2.0", id, result });
      if (method === "initialize")
        return rpc({
          protocolVersion: [
            "2024-11-05",
            "2025-03-26",
            "2025-06-18",
            "2025-11-25",
          ].includes(params?.protocolVersion)
            ? params.protocolVersion
            : "2025-03-26",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "lof-writer", version: "1.0.0-beta.1" },
        });
      if (method === "ping") return rpc({});
      if (method === "tools/list") return rpc({ tools: toolDefinitions });
      if (method === "tools/call") {
        try {
          const result = await dispatch(
            getStore(),
            params.name,
            params.arguments,
          );
          return rpc({
            content: [{ type: "text", text: JSON.stringify(result) }],
          });
        } catch (e) {
          return rpc({
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: e.message,
                  code: e.code || "ERROR",
                }),
              },
            ],
          });
        }
      }
      return send(200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Method not found" },
      });
    } catch (e) {
      return send(e.code === "CONFLICT" ? 409 : 400, {
        error: e.message,
        code: e.code || "ERROR",
      });
    }
  });
  server.requestTimeout = 30000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, token, port: server.address().port };
}
