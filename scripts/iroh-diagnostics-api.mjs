import http from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = path.join(root, ".test-data", "iroh-diagnostics");
const targetDir = path.join(root, "src-tauri", "target");
const executable = path.join(targetDir, "debug", "examples", `diagnostic_probe${process.platform === "win32" ? ".exe" : ""}`);
const maxRequest = 32_768;

export function validateProbe(body) {
  const allowed = new Set(["code", "mode", "addressMode", "scope", "keepAlive", "label", "samples", "maxFiles", "maxBytes"]);
  if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some(key => !allowed.has(key))) throw new Error("요청 항목을 확인해 주세요.");
  if (typeof body.code !== "string" || !body.code.trim().startsWith("lof-group://")
      || body.code.length > 16_384) throw new Error("전체 연결 코드가 필요합니다.");
  if (body.mode !== undefined && !["connect", "inventory", "read"].includes(body.mode)) throw new Error("지원하지 않는 진단 모드입니다.");
  if (body.addressMode !== undefined && !["discover", "ticket"].includes(body.addressMode)) throw new Error("주소 탐색 방식을 확인해 주세요.");
  if (body.scope !== undefined && !["group", "inviter"].includes(body.scope)) throw new Error("진단 범위를 확인해 주세요.");
  if (body.keepAlive !== undefined && typeof body.keepAlive !== "boolean") throw new Error("연결 유지 설정을 확인해 주세요.");
  for (const [key, min, max] of [["samples", 1, 20], ["maxFiles", 0, 256], ["maxBytes", 0, 100_000_000]]) {
    if (body[key] !== undefined && (!Number.isSafeInteger(body[key]) || body[key] < min || body[key] > max)) throw new Error(`${key} 범위를 확인해 주세요.`);
  }
  if (body.label !== undefined && (typeof body.label !== "string" || [...body.label].length > 100)) throw new Error("실행 구분 이름은 100자 이하로 입력해 주세요.");
  return { ...body, code: body.code.trim(), mode: body.mode ?? "connect", addressMode: body.addressMode ?? "discover", scope: body.scope ?? "group", keepAlive: body.keepAlive ?? true };
}

function launchProbe(input, onEvent, onExit) {
  const child = spawn(executable, [], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    try { onEvent(JSON.parse(line)); } catch { onEvent({ event: "protocolError", data: { error: "진단 출력 형식 오류" } }); }
  });
  // 토큰·그룹 비밀값이 포함될 수 있는 하위 프로세스의 stderr는 저장하지 않는다.
  const timer = input.keepAlive ? null : setTimeout(() => { child.kill(); }, 10 * 60_000);
  let finished = false;
  const finish = (error) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    onExit(error);
  };
  child.once("error", () => finish("진단 실행 파일을 시작하지 못했습니다."));
  child.once("close", code => finish(code === 0 ? null : "진단 프로세스가 종료되었습니다. 임시 진단 장치가 남았는지 확인해 주세요."));
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify(input));
}

export function createDiagnosticServer({ token, runProbe = launchProbe, saveReport = () => {} }) {
  const jobs = new Map();
  let active = false;
  const send = (res, status, data) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
  };
  return http.createServer(async (req, res) => {
    const expected = Buffer.from(`Bearer ${token}`);
    const auth = Buffer.from(req.headers.authorization ?? "");
    if (req.headers.origin || !/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? "")) return send(res, 403, { error: "로컬 API 요청만 허용합니다." });
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return send(res, 401, { error: "인증이 필요합니다." });
    if (req.method === "GET" && req.url === "/health") return send(res, 200, { name: "Lof iroh diagnostics", active });
    if (req.method === "GET" && /^\/v1\/probes\/[\da-f-]+$/.test(req.url)) {
      const job = jobs.get(req.url.split("/").at(-1));
      return send(res, job ? 200 : 404, job ?? { error: "진단 기록이 없습니다." });
    }
    const control = req.url?.match(/^\/v1\/probes\/([\da-f-]+)\/(leave|recheck)$/);
    if (req.method === "POST" && control) {
      const job = jobs.get(control[1]);
      if (!job || !["running","holding"].includes(job.status)) return send(res,404,{error:"유지 중인 진단 연결이 없습니다."});
      const controlFile = path.join(runtimeDir,`${job.id}.${control[2]}`);
      fs.writeFileSync(controlFile,"",{mode:0o600});
      return send(res,202,{id:job.id,action:control[2]});
    }
    if (req.method !== "POST" || req.url !== "/v1/probes") return send(res, 404, { error: "API 경로가 없습니다." });
    if (active) return send(res, 409, { error: "앞선 진단이 진행 중입니다." });
    if (!req.headers["content-type"]?.startsWith("application/json")) return send(res, 415, { error: "JSON 요청이 필요합니다." });
    let input;
    try {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > maxRequest) return send(res, 413, { error: "요청이 너무 큽니다." });
        chunks.push(chunk);
      }
      input = validateProbe(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch { return send(res, 400, { error: "진단 요청 형식 또는 한도를 확인해 주세요." }); }
    // 본문을 읽는 동안 다른 요청이 실행됐을 수도 있다.
    if (active) return send(res, 409, { error: "앞선 진단이 진행 중입니다." });
    const id = randomUUID();
    const job = { id, label: input.label ?? "", mode: input.mode, addressMode: input.addressMode, scope: input.scope,
      keepAlive:input.keepAlive,status: "running", startedAt: new Date().toISOString(), events: [] };
    const controlFile = path.join(runtimeDir,`${id}.control`);
    if (input.keepAlive) input.controlFile = controlFile;
    active = true;
    if (jobs.size >= 30) jobs.delete(jobs.keys().next().value);
    jobs.set(id, job);
    send(res, 202, { id, statusUrl: `/v1/probes/${id}`, joinsGroup: input.mode !== "connect" });
    const finish = (error) => {
      if (!["running","holding"].includes(job.status)) return;
      const completed = job.events.findLast(event => event.event === "completed");
      job.status = !error && completed?.data?.ok === true ? "succeeded" : "failed";
      job.error = error ?? completed?.data?.error ?? (completed ? null : "진단 종료 보고가 없습니다.");
      job.finishedAt = new Date().toISOString();
      active = false;
      try { saveReport(id, job); } catch { job.reportError = "보고서를 파일로 저장하지 못했습니다."; }
    };
    try {
      runProbe(input, event => {
        if(job.events.length>=1500)job.events.splice(50,1);
        job.events.push(event);
        if(event.event==="sessionHolding") {
          job.status="holding";active=false;
          try{saveReport(id,job);}catch{}
        }
        if(event.event==="diagnosisCompleted")job.diagnosis=event.data;
      }, finish);
    } catch { finish("진단 프로세스를 시작하지 못했습니다."); }
  }).on("clientError", (_error, socket) => { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); });
}

function main() {
  const portArg = process.argv.find(arg => arg.startsWith("--port="));
  const port = portArg ? Number(portArg.slice(7)) : 47675;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("포트는 1024~65535 범위여야 합니다.");
  if (!process.argv.includes("--skip-build")) {
    const build = spawnSync("cargo", ["build", "--offline", "--locked", "--manifest-path", "crates/lof-realtime/Cargo.toml", "--target-dir", targetDir, "--example", "diagnostic_probe"], { cwd: root, windowsHide: true, stdio: "inherit" });
    if (build.status !== 0) process.exit(build.status ?? 1);
  }
  fs.mkdirSync(runtimeDir, { recursive: true });
  const token = randomBytes(32).toString("hex");
  const server = createDiagnosticServer({ token, saveReport: (id, job) => fs.writeFileSync(path.join(runtimeDir, `${id}.json`), JSON.stringify(job, null, 2), { mode: 0o600 }) });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 16;
  server.once("error", error => { console.error(`진단 API를 열지 못했습니다: ${error.code}`); process.exitCode = 1; });
  server.listen(port, "127.0.0.1", () => {
    fs.writeFileSync(path.join(runtimeDir, "runtime.json"), JSON.stringify({ url: `http://127.0.0.1:${port}`, token, pid: process.pid }), { mode: 0o600 });
    console.log(`진단 API: http://127.0.0.1:${port} · 인증 정보: .test-data/iroh-diagnostics/runtime.json`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
