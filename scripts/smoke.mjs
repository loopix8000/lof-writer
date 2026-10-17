import { _electron as electron } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const data = path.join(root, ".test-data", `smoke-${Date.now()}`),
  vault = path.join(data, "vault"),
  user = path.join(data, "profile");
await fs.mkdir(data, { recursive: true });
const env = { ...process.env, LOF_VAULT: vault, LOF_USER_DATA: user };
delete env.ELECTRON_RUN_AS_NODE;
let app;
const errors = [];
const launchOptions =
  process.env.LOF_TEST_PACKAGED === "1"
    ? {
        executablePath: process.env.LOF_TEST_EXECUTABLE || path.join(
          root,
          "release",
          "win-unpacked",
          "Lof Writer.exe",
        ),
        args: [],
        env,
      }
    : { args: [root], env };
try {
  app = await electron.launch(launchOptions);
  const page = await app.firstWindow();
  await page.getByRole('button',{name:'이 설정으로 시작',exact:true}).click();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.getByRole("button", { name: "첫 프로젝트 만들기" }).waitFor();
  await page.getByRole("button", { name: "첫 프로젝트 만들기" }).click();
  await page.getByRole("textbox", { name: "새 제목" }).fill("알파 검증 작품");
  await page.getByRole("button", { name: "만들기", exact: true }).click();
  await page.getByRole("button", { name: "새 에피소드 쓰기", exact: true }).click();
  await page.getByRole("textbox", { name: "새 제목" }).fill("프롤로그");
  await page.getByRole("button", { name: "만들기", exact: true }).click();
  const editor = page.locator('[data-testid="manuscript"]');
  await editor.waitFor();
  await editor.fill("한글 원고를 씁니다.");
  await editor.press("Enter");
  await editor.press("Enter");
  await page.keyboard.insertText("두 번째 문단입니다.");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await page.locator(".save-indicator").filter({ hasText: "저장됨" }).waitFor();
  const runtime = JSON.parse(
    await fs.readFile(path.join(user, "runtime.json"), "utf8"),
  );
  async function rpc(name, args = {}) {
    const r = await fetch(`http://127.0.0.1:${runtime.port}/rpc`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${runtime.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, arguments: args }),
    });
    const j = await r.json();
    if (!r.ok) throw Error(JSON.stringify(j));
    return j.result;
  }
  const library = await rpc("library_list");
  const doc = await rpc("document_read", { id: library.documents[0].id });
  assert.ok(doc.body.includes("한글 원고를 씁니다."));
  assert.ok(doc.body.includes("두 번째 문단입니다."));
  await rpc("document_update", {
    id: doc.id,
    expectedRevision: doc.revision,
    body: doc.body + "\n\nMCP에서 추가한 문장입니다.",
  });
  await editor
    .getByText("MCP에서 추가한 문장입니다.", { exact: false })
    .waitFor();
  await page
    .getByRole("button", { name: "Markdown 모드", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Markdown 원문", exact: true })
    .fill("**굵은 원고**\n\n새로 저장한 원고입니다.");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await page.locator(".save-indicator").filter({ hasText: "저장됨" }).waitFor();
  await page
    .getByRole("button", { name: "Markdown 모드", exact: true })
    .click();
  assert.ok(await editor.locator("strong").count());
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await page
    .getByRole("textbox", { name: "검색어", exact: true })
    .fill("새로 저장");
  await page.locator(".search-results button").first().waitFor();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("button", { name: "변경 이력", exact: true }).click();
  await page.locator(".history-list button").first().waitFor();
  assert.ok(await page.locator(".history-list button").count());
  await page.locator(".history-list button").last().click();
  await page.locator(".history-preview pre").waitFor();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page.screenshot({
    path: path.join(root, "docs", "alpha-workspace.png"),
  });
  const before = await rpc("document_read", { id: doc.id });
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page
    .getByRole("button", { name: "MCP 설정 복사", exact: true })
    .click();
  const copied = JSON.parse(
    await app.evaluate(({ clipboard }) => clipboard.readText()),
  ).mcpServers["lof-writer"];
  const bridge = spawn(copied.command, copied.args, {
    env: { ...process.env, ...copied.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const tools = await new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => {
      bridge.kill();
      reject(Error("Packaged MCP bridge timeout"));
    }, 10000);
    bridge.once("error", reject);
    bridge.stdout.on("data", (c) => {
      buffer += c;
      if (buffer.includes("\n")) {
        clearTimeout(timeout);
        resolve(JSON.parse(buffer.split("\n")[0]));
        bridge.stdin.end();
      }
    });
    bridge.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }) + "\n",
    );
  });
  assert.equal(tools.result.tools.length, 10);
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  assert.deepEqual(errors, []);
  await app.close();
  app = null;
  app = await electron.launch(launchOptions);
  const restarted = await app.firstWindow();
  await restarted.locator(".project-card").first().waitFor();
  await restarted.locator(".project-card").first().click();
  await restarted.locator(".episode-row").first().click();
  await restarted.locator('[data-testid="manuscript"]').waitFor();
  assert.ok(
    (
      await restarted.locator('[data-testid="manuscript"]').innerText()
    ).includes("새로 저장한 원고입니다."),
  );
  const text = await fs.readFile(
    before.path ||
      path.join(
        vault,
        "projects",
        before.projectId,
        "episodes",
        before.id + ".md",
      ),
    "utf8",
  );
  assert.ok(text.endsWith(before.body));
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: [
          "UI create",
          "Korean paragraphs",
          "autosave",
          "MCP to open editor",
          "Markdown bold roundtrip",
          "search",
          "history preview",
          "settings MCP config",
          "MCP config executable bridge",
          "restart persistence",
          "disk readback",
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
