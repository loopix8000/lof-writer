import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  data = path.join(root, ".test-data", `edge-${Date.now()}`),
  user = path.join(data, "profile"),
  vault = path.join(data, "vault");
await fs.mkdir(data, { recursive: true });
const env = { ...process.env, LOF_VAULT: vault, LOF_USER_DATA: user };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({ args: [root], env });
  const page = await app.firstWindow();
  await page.getByRole('button',{name:'이 설정으로 시작',exact:true}).click();
  await page.getByRole("button", { name: "첫 프로젝트 만들기" }).click();
  await page.getByRole("textbox", { name: "새 제목" }).fill("충돌 검증");
  await page.getByRole("button", { name: "만들기", exact: true }).click();
  await page.getByRole("button", { name: "새 편 쓰기", exact: true }).click();
  await page.getByRole("button", { name: "만들기", exact: true }).click();
  const editor = page.locator('[data-testid="manuscript"]');
  await editor.fill("첫 문단");
  await editor.press("Enter");
  await editor.press("Enter");
  await page.keyboard.insertText("두 번째 문단");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await page.locator(".save-indicator").filter({ hasText: "저장됨" }).waitFor();
  const runtime = JSON.parse(
    await fs.readFile(path.join(user, "runtime.json"), "utf8"),
  );
  const rpc = async (name, args = {}) => {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/rpc`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${runtime.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, arguments: args }),
    });
    const j = await response.json();
    assert.equal(response.status, 200);
    return j.result;
  };
  const list = await rpc("library_list"),
    first = list.documents[0];
  let d = await rpc("document_read", { id: first.id });
  assert.equal(d.body, "첫 문단\n\n\n\n두 번째 문단");
  await page
    .getByRole("button", { name: `${first.title} 닫기`, exact: true })
    .click();
  await page.locator(".episode-row").first().click();
  await editor.waitFor();
  assert.equal(await editor.locator("p").count(), 3);
  await page
    .getByRole("button", { name: "위키 문서 추가", exact: true })
    .click();
  await page.getByRole("textbox", { name: "새 제목" }).fill("등장인물");
  await page.getByRole("button", { name: "만들기", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "문서 제목", exact: true }),
  ).toHaveValue("등장인물");
  await editor.fill("캐릭터 설정");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await page
    .getByRole("button", { name: "메모 추가", exact: true })
    .first()
    .click();
  await page.getByRole("textbox", { name: "새 제목" }).fill("아이디어");
  await page.getByRole("button", { name: "만들기", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "문서 제목", exact: true }),
  ).toHaveValue("아이디어");
  await editor.fill("메모 원고");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await page.locator(".tree-item").filter({ hasText: first.title }).click();
  await page
    .getByRole("button", { name: "Markdown 모드", exact: true })
    .click();
  const source = page.getByRole("textbox", {
    name: "Markdown 원문",
    exact: true,
  });
  await source.dispatchEvent("compositionstart");
  await source.fill("내가 편집 중인 원고");
  d = await rpc("document_read", { id: first.id });
  await rpc("document_update", {
    id: d.id,
    expectedRevision: d.revision,
    body: "외부 AI가 편집한 원고",
  });
  await source.dispatchEvent("compositionend");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await page
    .getByRole("button", { name: "내 편집 사본 만들기", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "내 편집 사본 만들기", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "문서 제목", exact: true }),
  ).toHaveValue(first.title + " (내 편집 사본)");
  const library = await rpc("library_list"),
    bodies = await Promise.all(
      library.documents.map((m) => rpc("document_read", { id: m.id })),
    );
  assert.ok(bodies.some((b) => b.body === "내가 편집 중인 원고"));
  assert.ok(bodies.some((b) => b.body === "외부 AI가 편집한 원고"));
  assert.ok(bodies.some((b) => b.body === "캐릭터 설정"));
  assert.ok(bodies.some((b) => b.body === "메모 원고"));
  // Stdio bridge talks to the same running application.
  const child = spawn(
    process.execPath,
    [path.join(root, "scripts", "mcp.mjs")],
    {
      env: { ...process.env, LOF_RUNTIME: path.join(user, "runtime.json") },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const stdio = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(Error("stdio timeout"));
    }, 10000);
    child.stdout.on("data", (c) => {
      buffer += c;
      if (buffer.includes("\n")) {
        clearTimeout(timer);
        resolve(JSON.parse(buffer.split("\n")[0]));
        child.stdin.end();
      }
    });
    child.once("error", reject);
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list" }) + "\n",
    );
  });
  assert.equal(stdio.result.tools.length, 10);
  // Close while edits are still pending and verify the close handshake flushed them.
  await source.fill("종료 직전 입력한 한글 원고");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  await new Promise((r) => app.once("close", r));
  app = null;
  const files = await fs.readdir(
    path.join(vault, "projects", first.projectId, "episodes"),
  );
  const raw = await Promise.all(
    files.map((f) =>
      fs.readFile(
        path.join(vault, "projects", first.projectId, "episodes", f),
        "utf8",
      ),
    ),
  );
  assert.ok(raw.some((r) => r.endsWith("종료 직전 입력한 한글 원고")));
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: [
          "blank paragraph roundtrip",
          "wiki and memo",
          "UI/MCP conflict copies",
          "stdio bridge",
          "close flush",
        ],
        data,
      },
      null,
      2,
    ),
  );
} finally {
  if (app) await app.close();
}
