import { _electron as electron, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  data = path.join(root, ".test-data", `features-${Date.now()}`),
  user = path.join(data, "profile"),
  vault = path.join(data, "vault");
await fs.mkdir(data, { recursive: true });
await fs.mkdir(user,{recursive:true});
await fs.writeFile(path.join(user,'settings.json'),JSON.stringify({connections:[{id:'legacy-drive',type:'drive',name:'Google Drive',refreshToken:'obsolete-test-value'},{id:'local-folder',type:'folder',name:'로컬 폴더',folder:path.join(data,'sync')}]}));
const env = { ...process.env, LOF_VAULT: vault, LOF_USER_DATA: user };
delete env.ELECTRON_RUN_AS_NODE;
const launchOptions =
  process.env.LOF_TEST_PACKAGED === "1"
    ? {
        executablePath: path.join(
          root,
          "release",
          "win-unpacked",
          "Lof Writer.exe",
        ),
        args: [],
        env,
      }
    : { args: [root], env };
let app;
const errors = [];
try {
  app = await electron.launch(launchOptions);
  let page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page
    .getByRole("combobox", { name: "연재 플랫폼", exact: true })
    .selectOption("custom");
  await page
    .getByRole("textbox", { name: "사용자 규칙 이름" })
    .fill("내 연재 규칙");
  await page
    .getByRole("combobox", { name: "플랫폼 계산 방식" })
    .selectOption("all");
  assert.equal(await page.getByRole("combobox", { name: "문자 계산 단위" }).count(), 0);
  await page.getByRole("spinbutton", { name: "목표 글자 수" }).fill("4321");
  await page.getByRole("button", { name: "이 설정으로 시작" }).click();
  await page.getByRole("button", { name: "첫 프로젝트 만들기" }).click();
  await page.getByRole("textbox", { name: "새 제목" }).fill("집필 기능 검증");
  await expect(page.getByRole("combobox", { name: "연재 플랫폼" })).toHaveValue(
    "custom",
  );
  await expect(
    page.getByRole("spinbutton", { name: "목표 글자 수" }),
  ).toHaveValue("4321");
  const tag = page.getByRole("textbox", { name: "태그 입력" });
  await tag.fill("판타지");
  await tag.press("Enter");
  await tag.fill("일상");
  await tag.press("Enter");
  await page.getByRole("button", { name: "만들기", exact: true }).click();
  await expect(page.locator(".project-tags")).toContainText("#판타지");
  await page.getByRole("button", { name: "소설 관리하기" }).click();
  await page.getByRole("button", { name: "일상 태그 제거" }).click();
  await app.evaluate(
    ({ dialog }, file) => {
      globalThis._lofOriginalDialog = dialog.showOpenDialog;
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      });
    },
    path.join(root, "assets", "icon.png"),
  );
  await page.getByRole("button", { name: "표지 업로드", exact: true }).click();
  await page.getByAltText("현재 표지").waitFor();
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = globalThis._lofOriginalDialog;
  });
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await page.locator(".hero-cover img").waitFor();
  await expect(page.locator(".project-tags")).not.toContainText("#일상");
  await page.getByRole("button", { name: "새 에피소드 쓰기", exact: true }).click();
  await page.getByRole("button", { name: "만들기", exact: true }).click();
  const editor = page.locator('[data-testid="manuscript"]');
  await editor.waitFor();
  async function reset(text = "") {
    await editor.click();
    await editor.press("Control+a");
    await editor.press("Backspace");
    if (text) await page.keyboard.insertText(text);
    await expect(editor).toHaveText(text);
  }

  await reset();
  await editor.click();
  await page.keyboard.type('"');
  await expect(editor).toHaveText('""');
  await page.keyboard.type('hello"');
  await expect(editor).toHaveText('"hello"');
  await reset();
  await editor.click();
  await page.keyboard.type("(");
  await expect(editor).toHaveText("()");
  await page.keyboard.press("Backspace");
  await expect(editor).toHaveText("");
  // Backspace at a paragraph end deletes one character and keeps the caret there.
  await reset();
  await editor.click();
  await page.keyboard.type("첫째 줄");
  await page.keyboard.press("Enter");
  await page.keyboard.type("둘째 줄");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("End");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("X");
  await expect(editor.locator("p")).toHaveText(["첫째 X", "둘째 줄"]);
  // An unfinished Hangul syllable must not trigger the composition save error.
  await reset();
  await editor.click();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", {
    text: "하",
    selectionStart: 1,
    selectionEnd: 1,
  });
  await page.waitForTimeout(1500);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await cdp.send("Input.insertText", { text: "한" });
  await expect(editor).toHaveText("한");
  await page.locator(".save-indicator").filter({ hasText: "저장됨" }).waitFor();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await cdp.detach();
  await reset("시작 ");
  await editor.press("End");
  await page.keyboard.type("...");
  await expect(editor).toHaveText("시작 ……");
  await page.keyboard.press("Control+z");
  await expect(editor).toHaveText("시작 ..");
  await reset();
  await editor.click();
  await page.keyboard.insertText('붙여넣기 "...');
  await expect(editor).toHaveText('붙여넣기 "...');
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toContainText("Google");
  await expect(
    page.getByRole("combobox", { name: "연결 방식" }).locator("option"),
  ).toHaveCount(3);
  await page
    .getByRole("switch", { name: "곡선 따옴표 사용" })
    .check();
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await reset();
  await editor.click();
  await page.keyboard.type('"hi"');
  await expect(editor).toHaveText("“hi”");
  await page
    .getByRole("button", { name: "Markdown 모드", exact: true })
    .click();
  const source = page.getByRole("textbox", {
    name: "Markdown 원문",
    exact: true,
  });
  await source.fill("");
  await source.click();
  await page.keyboard.type('"');
  await expect(source).toHaveValue("“”");
  await page.keyboard.type('..."');
  await expect(source).toHaveValue("“……”");
  await source.fill("**가 나**\n\n\n\n다😀");
  await expect(page.getByTestId("platform-count")).toContainText("8");
  assert.equal(await page.locator('html').evaluate(el => getComputedStyle(el).fontSize), "15px");
  assert.equal(await source.evaluate(el => getComputedStyle(el).fontSize), "18px");
  await page.getByRole("button", {name:"글자 수 규칙 설정"}).click();
  await page.getByRole("combobox", {name:"연재 플랫폼",exact:true}).selectOption("novelpia");
  assert.equal(await page.getByRole("combobox", {name:"문자 계산 단위"}).count(),0);
  await source.fill('**가.,!?\'"** … &lt; &gt; &amp; 😀');
  await expect(page.getByTestId("platform-count")).toContainText("17");
  await expect(page.locator('.editor-footer')).toContainText("노벨피아 17자");
  // Verify real text clipboard, restoring every pre-existing clipboard format.
  await app.evaluate(({clipboard}) => { globalThis._lofClipboard = clipboard.availableFormats().map(f => [f, clipboard.readBuffer(f)]); });
  try {
    await page.getByRole("button", {name:"본문 텍스트 복사"}).click();
    await expect(page.getByText("본문을 복사했습니다.", {exact:false})).toBeVisible();
    assert.equal(await app.evaluate(({clipboard}) => clipboard.readText()), '가.,!?\'" … < > & 😀');
  } finally {
    await app.evaluate(({clipboard}) => {clipboard.clear(); for (const [f,b] of globalThis._lofClipboard) clipboard.writeBuffer(f,b); delete globalThis._lofClipboard;});
  }
  // Text export and copy must use exactly the body used by the counter.
  const exported = path.join(data, 'count-body.txt');
  await app.evaluate(({dialog}, file) => {globalThis._lofSaveDialog=dialog.showSaveDialog;dialog.showSaveDialog=async()=>({canceled:false,filePath:file});}, exported);
  try {
    await page.getByRole("button", {name:"내보내기",exact:true}).click();
    await expect(page.getByText("원고를 내보냈습니다.",{exact:true})).toBeVisible();
    assert.equal(await fs.readFile(exported,'utf8'), '가.,!?\'" … < > & 😀');
  } finally {
    await app.evaluate(({dialog})=>{dialog.showSaveDialog=globalThis._lofSaveDialog;});
  }
  await source.fill("😀👨‍👩‍👧‍👦");
  await expect(page.getByTestId("platform-count")).toContainText("13");
  await page.getByRole("combobox", {name:"연재 플랫폼",exact:true}).selectOption("custom");
  await page.getByRole("combobox", {name:"플랫폼 계산 방식"}).selectOption("all");
  await page.getByRole("spinbutton", {name:"목표 글자 수"}).fill("4321");
  await page.getByRole("textbox", {name:"사용자 규칙 이름"}).fill("내 연재 규칙");
  await source.fill("**가 나**\n\n\n\n다😀");
  await expect(page.getByTestId("platform-count")).toContainText("8");
  await page.getByRole("button", {name:"글자 수 규칙 설정"}).click();
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await page.locator(".save-indicator").filter({ hasText: "저장됨" }).waitFor();
  const spell = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return {
      window: w.webContents.getLastWebPreferences().spellcheck,
      session: w.webContents.session.isSpellCheckerEnabled(),
    };
  });
  assert.equal(spell.session, false);
  assert.equal(await source.evaluate((el) => el.spellcheck), false);
  assert.equal(
    await page.evaluate(() => typeof window.lof.googleConnect),
    "undefined",
  );
  await page.screenshot({
    path: path.join(root, "docs", "alpha-9-editor.png"),
  });
  assert.deepEqual(errors, []);
  await app.close();
  app = null;
  app = await electron.launch(launchOptions);
  page = await app.firstWindow();
  await page.locator(".project-card").first().waitFor();
  assert.equal(
    await page.getByRole("button", { name: "이 설정으로 시작" }).count(),
    0,
  );
  await page.locator(".project-card").first().click();
  await page.locator(".hero-cover img").waitFor();
  await expect(page.locator(".project-tags")).toContainText("#판타지");
  await page.locator(".episode-row").first().click();
  await page.locator('[data-testid="manuscript"]').waitFor();
  await expect(page.getByTestId("platform-count")).toContainText("8");
  const settings = JSON.parse(
    await fs.readFile(path.join(user, "settings.json"), "utf8"),
  );
  assert.equal(settings.preferences.quoteStyle, "curly");
  assert.equal(settings.preferences.defaultWriting.goal, 4321);
  assert.equal(settings.preferences.defaultWriting.customName, "내 연재 규칙");
  assert.equal(settings.connections.some(c=>c.type==='drive'),false);assert.equal(settings.connections.length,1);
  console.log(
    JSON.stringify(
      {
        passed: true,
        packaged: process.env.LOF_TEST_PACKAGED === "1",
        checks: [
          "first-run platform and custom rules",
          "project tags add/remove",
          "local cover upload",
          "quote pair and closer skip",
          "paired backspace",
          "line-end backspace stays on its line",
          "autosave waits for Hangul composition",
          "ellipsis and undo",
          "paste unchanged",
          "curly quotes",
          "Markdown typing",
          "Novelpia punctuation / HTML entity weighted count and matching footer",
          "emoji UTF-16 count without unit selector",
          "plain-text copy and TXT export match counted manuscript",
          "15px UI and 18px manuscript",
          "spellcheck disabled in session and editor",
          "Google Drive absent",
          "restart persistence",
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
