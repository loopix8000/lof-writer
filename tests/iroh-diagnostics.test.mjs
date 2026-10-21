import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { createDiagnosticServer } from "../scripts/iroh-diagnostics-api.mjs";

const token = "local-test-token";
async function withServer(runProbe, action) {
  const server = createDiagnosticServer({ token, runProbe });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try { await action(url); } finally { await new Promise(resolve => server.close(resolve)); }
}
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

test("API는 인증 없이 또는 브라우저 Origin으로 진단을 시작하지 않는다", async () => {
  await withServer(() => assert.fail("진단 실행 금지"), async url => {
    assert.equal((await fetch(`${url}/health`)).status, 401);
    assert.equal((await fetch(`${url}/health`, { headers: { ...headers, Origin: "https://example.com" } })).status, 403);
    assert.equal((await fetch(`${url}/health`, { headers })).status, 200);
  });
});

test("진단 오류·단계·시간을 보존하고 연결 코드는 결과에 남기지 않는다", async () => {
  let complete;
  const code = "lof-group://secret-test-ticket";
  await withServer((input, emit, finish) => {
    assert.equal(input.code, code);
    assert.equal(input.mode, "inventory");
    emit({ event: "requestFailed", elapsedMs: 28, data: { op: "inventory", durationMs: 12, error: "상대 서재 진단: warnings=[], pending_missing=true" } });
    complete = () => { emit({ event: "completed", data: { ok: false, error: "파일 상태 검사 실패" } }); finish(null); };
  }, async url => {
    const start = await fetch(`${url}/v1/probes`, { method: "POST", headers, body: JSON.stringify({ code, mode: "inventory", label: "Android 외부망" }) });
    assert.equal(start.status, 202);
    const job = await start.json();
    const busy = await fetch(`${url}/v1/probes`, { method: "POST", headers, body: JSON.stringify({ code }) });
    assert.equal(busy.status, 409);
    complete();
    const result = await (await fetch(`${url}${job.statusUrl}`, { headers })).json();
    assert.equal(result.status, "failed");
    assert.equal(result.events[0].data.op, "inventory");
    assert.match(result.events[0].data.error, /pending_missing=true/);
    assert.ok(!JSON.stringify(result).includes(code));
    assert.equal((await (await fetch(`${url}/health`, { headers })).json()).active, false);
  });
});

test("실패한 입력은 실행하지 않고 완료 이벤트 없는 종료도 성공으로 표시하지 않는다", async () => {
  let runs = 0;
  await withServer((_input, _emit, finish) => { runs++; finish(null); }, async url => {
    for (const body of [{ code: "bad" }, { code: "lof-group://x", mode: "write" }, { code: "lof-group://x", maxBytes: -1 }]) {
      assert.equal((await fetch(`${url}/v1/probes`, { method: "POST", headers, body: JSON.stringify(body) })).status, 400);
    }
    assert.equal(runs, 0);
    const result = await (await fetch(`${url}/v1/probes`, { method: "POST", headers, body: JSON.stringify({ code: "lof-group://x" }) })).json();
    const job = await (await fetch(`${url}${result.statusUrl}`, { headers })).json();
    assert.equal(job.status, "failed");
    assert.equal(runs, 1);
  });
});

test("HTTP API가 실제 Rust 진단 프로세스의 잘못된 코드 오류를 수집한다", async () => {
  await withServer(undefined, async url => {
    const start = await fetch(`${url}/v1/probes`, { method: "POST", headers, body: JSON.stringify({ code: "lof-group://eA" }) });
    assert.equal(start.status, 202);
    const job = await start.json();
    const deadline = Date.now() + 10_000;
    let result;
    do {
      result = await (await fetch(`${url}${job.statusUrl}`, { headers })).json();
      if (result.status !== "running") break;
      await setTimeout(25);
    } while (Date.now() < deadline);
    assert.equal(result.status, "failed");
    assert.match(result.error, /페어링 코드 형식/);
    assert.equal(result.events.at(-1).event, "completed");
    assert.ok(!JSON.stringify(result).includes("lof-group://eA"));
  });
});
