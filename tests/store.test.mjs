import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store, FORMAT, memoId, projectTombstone } from "../core/store.mjs";
import { Memos, COMMON } from "../core/memo.mjs";
import { syncOnce } from "../core/sync.mjs";
import { startApi } from "../core/api.mjs";
import { importFiles } from "../core/import.mjs";
import { characterCount, requiresSource } from "../core/text.mjs";
const temp = async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lof-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};
const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const ls = async (dir) => (await fs.readdir(dir)).sort();
const projectDir = (store, project) => path.join(store.root, project.folder);
test("글자 수는 Markdown 기호를 제외하고 지원하지 않는 서식은 원문 모드", () => {
  assert.equal(characterCount("**굵은 원고**\n\n새 문장"), 7);
  assert.equal(characterCount("한글 &amp; 문자"), 5);
  assert.equal(requiresSource("단순 **굵은 글씨**"), false);
  assert.equal(requiresSource("[링크](https://example.com)"), true);
  assert.equal(requiresSource("| a | b |\n| - | - |\n| c | d |"), true);
});
async function fixture(t) {
  const root = await temp(t),
    store = await new Store(root).init(),
    project = await store.createProject({ title: "한글 작품" }),
    doc = await store.create({
      projectId: project.id,
      title: "제1화",
      body: '원고 첫 줄\n\n"한글, 조합과 문단."\n\n**서식**',
    });
  return { root, store, project, doc };
}
test("작품을 만들면 번호 붙은 폴더, 하위 폴더, project.json과 백업본이 생긴다", async (t) => {
  const { root, store, project, doc } = await fixture(t);
  assert.equal(project.folder, "001 한글 작품");
  const dir = projectDir(store, project);
  assert.deepEqual(
    await ls(dir),
    ["assets", "episodes", "memo", "plot", "project.backup.json", "project.json"].sort(),
  );
  const saved = await readJson(path.join(dir, "project.json"));
  assert.equal(saved.format, FORMAT);
  assert.equal(saved.format, 2);
  assert.equal(saved.id, project.id);
  assert.equal(saved.index, 1);
  assert.equal(saved.title, "한글 작품");
  assert.deepEqual(
    saved.documents.map((d) => [d.id, d.kind, d.title, d.path]),
    [[doc.id, "episode", "제1화", "episodes/001 제1화.md"]],
  );
  assert.equal("body" in saved.documents[0], false);
  assert.equal(
    await fs.readFile(path.join(dir, "project.backup.json"), "utf8"),
    await fs.readFile(path.join(dir, "project.json"), "utf8"),
  );
  // 본문 파일은 머리말 없는 순수 Markdown이다.
  assert.equal(doc.relPath, "episodes/001 제1화.md");
  assert.equal(await store.locate(doc.id), path.join(dir, "episodes", "001 제1화.md"));
  assert.equal(await fs.readFile(path.join(dir, "episodes", "001 제1화.md"), "utf8"), doc.body);
  const second = await store.createProject({ title: "둘째 작품" });
  assert.equal(second.folder, "002 둘째 작품");
  const reopened = await new Store(root).init(),
    list = await reopened.list();
  assert.deepEqual(list.projects.map((p) => p.folder).sort(), ["001 한글 작품", "002 둘째 작품"]);
  assert.deepEqual(list.warnings, []);
  assert.equal((await reopened.read(doc.id)).body, doc.body);
});
test("이름이 겹치면 덮어쓰지 않고 ' (2)'를 붙이고, 쓸 수 없는 문자는 바꾼다", async (t) => {
  const root = await temp(t),
    store = await new Store(root).init();
  // 앱이 관리하지 않는 같은 이름의 폴더
  await fs.mkdir(path.join(store.root, "002 같은 제목"));
  await store.createProject({ title: "첫 작품" });
  const project = await store.createProject({ title: "같은 제목" });
  assert.equal(project.folder, "002 같은 제목 (2)");
  const dir = projectDir(store, project);
  // 앱이 관리하지 않는 같은 이름의 회차 파일
  await fs.writeFile(path.join(dir, "episodes", "002 둘째.md"), "남의 파일");
  const one = await store.create({ projectId: project.id, title: "첫째" });
  const two = await store.create({ projectId: project.id, title: "둘째" });
  assert.equal(one.relPath, "episodes/001 첫째.md");
  assert.equal(two.relPath, "episodes/002 둘째 (2).md");
  assert.equal(await fs.readFile(path.join(dir, "episodes", "002 둘째.md"), "utf8"), "남의 파일");
  assert.deepEqual((await store.list()).unlinked, [
    { projectId: project.id, path: "episodes/002 둘째.md" },
  ]);
  const odd = await store.create({ projectId: project.id, title: "질문: 왜/어떻게?" });
  assert.equal(odd.title, "질문: 왜/어떻게?");
  assert.equal(odd.relPath, "episodes/003 질문_ 왜_어떻게_.md");
  // 회차를 하나 더 만들어도 이미 번호 붙은 이름은 그대로 둔다.
  assert.equal((await store.read(two.id)).relPath, "episodes/002 둘째 (2).md");
  const a = await store.create({ projectId: project.id, kind: "plot", title: "설정" });
  const b = await store.create({ projectId: project.id, kind: "plot", title: "설정" });
  assert.equal(a.relPath, "plot/설정.md");
  assert.equal(b.relPath, "plot/설정 (2).md");
  await store.save({ id: a.id, expectedRevision: a.revision, title: "세계관" });
  assert.equal((await store.read(a.id)).relPath, "plot/세계관.md");
  assert.equal((await store.read(b.id)).relPath, "plot/설정 (2).md");
  // 작품 제목을 바꾸면 작품 폴더 이름도 바뀐다.
  const renamed = await store.updateProject({ id: project.id, title: "바뀐 제목" });
  assert.equal(renamed.folder, "002 바뀐 제목");
  assert.equal(
    (await store.read(one.id)).path,
    path.join(store.root, "002 바뀐 제목", "episodes", "001 첫째.md"),
  );
});
test("회차 순서를 바꾸면 번호에 맞춰 파일 이름을 바꾼다", async (t) => {
  const store = await new Store(await temp(t)).init(),
    project = await store.createProject({ title: "순서" });
  const docs = [];
  for (const title of ["출발", "만남", "이별"])
    docs.push(await store.create({ projectId: project.id, title, body: `${title} 본문` }));
  const [a, b, c] = docs;
  const episodes = path.join(projectDir(store, project), "episodes");
  assert.deepEqual(await ls(episodes), ["001 출발.md", "002 만남.md", "003 이별.md"]);
  await store.reorder({ projectId: project.id, ids: [c.id, a.id, b.id] });
  assert.deepEqual(await ls(episodes), ["001 이별.md", "002 출발.md", "003 만남.md"]);
  for (const d of docs) assert.equal((await store.read(d.id)).body, `${d.title} 본문`);
  assert.deepEqual(
    (await store.list()).documents.map((d) => [d.title, d.order]),
    [["이별", 0], ["출발", 1], ["만남", 2]],
  );
  // 제목을 바꾸면 번호는 그대로 두고 이름만 바꾼다.
  const current = await store.read(a.id);
  const renamed = await store.save({ id: a.id, expectedRevision: current.revision, title: "새 출발" });
  assert.equal(renamed.relPath, "episodes/002 새 출발.md");
  const plot = await store.create({ projectId: project.id, kind: "plot", title: "구상" });
  await assert.rejects(store.reorder({ projectId: project.id, ids: [a.id, plot.id] }));
  await assert.rejects(store.reorder({ projectId: project.id, ids: ["없는-문서"] }));
});
test("플롯을 회차에 연결하면 회차 폴더로 옮기고, 순서·연결·삭제에 따라 따라간다", async (t) => {
  const store = await new Store(await temp(t)).init(),
    project = await store.createProject({ title: "플롯" }),
    plotDir = path.join(projectDir(store, project), "plot");
  const first = await store.create({ projectId: project.id, title: "첫 만남" });
  const second = await store.create({ projectId: project.id, title: "재회" });
  let plot = await store.create({
    projectId: project.id,
    kind: "plot",
    title: "구상",
    episodeId: first.id,
    body: "플롯 본문",
  });
  assert.equal(plot.episodeId, first.id);
  assert.equal(plot.relPath, "plot/001 첫 만남/구상.md");
  // 회차 순서가 바뀌면 회차 폴더 번호도 바뀐다.
  await store.reorder({ projectId: project.id, ids: [second.id, first.id] });
  plot = await store.read(plot.id);
  assert.equal(plot.relPath, "plot/002 첫 만남/구상.md");
  assert.deepEqual(await ls(plotDir), ["002 첫 만남"]);
  // 연결을 끊으면 plot/ 바로 아래로 옮기고 빈 회차 폴더는 치운다.
  plot = await store.save({ id: plot.id, expectedRevision: plot.revision, episodeId: null });
  assert.equal(plot.episodeId, undefined);
  assert.equal(plot.relPath, "plot/구상.md");
  assert.deepEqual(await ls(plotDir), ["구상.md"]);
  plot = await store.save({ id: plot.id, expectedRevision: plot.revision, episodeId: second.id });
  assert.equal(plot.relPath, "plot/001 재회/구상.md");
  assert.equal(plot.body, "플롯 본문");
  // 잘못된 연결은 거부한다.
  await assert.rejects(
    store.save({ id: plot.id, expectedRevision: plot.revision, episodeId: "없는-회차" }),
  );
  await assert.rejects(
    store.save({ id: first.id, expectedRevision: (await store.read(first.id)).revision, episodeId: second.id }),
  );
  await assert.rejects(
    store.create({ projectId: project.id, kind: "plot", title: "x", episodeId: plot.id }),
  );
  // 연결된 회차를 지우면 플롯은 남기고 plot/ 바로 아래로 옮긴다.
  await store.remove(second.id);
  plot = await store.read(plot.id);
  assert.equal(plot.episodeId, undefined);
  assert.equal(plot.relPath, "plot/구상.md");
  assert.deepEqual(await ls(plotDir), ["구상.md"]);
  assert.equal((await store.read(first.id)).relPath, "episodes/001 첫 만남.md");
});
test("제목을 바꿔도 본문 파일은 순수 Markdown이고, 변경 이력으로 되돌린다", async (t) => {
  const { root, store, doc } = await fixture(t);
  const body = "수정한 본문\n\n**서식**\n\n끝.";
  const next = await store.save({
    id: doc.id,
    expectedRevision: doc.revision,
    title: "새 제목",
    body,
  });
  assert.equal(next.relPath, "episodes/001 새 제목.md");
  const reopened = await new Store(root).init();
  assert.equal(await fs.readFile(await reopened.locate(doc.id), "utf8"), body);
  await assert.rejects(fs.access(path.join(path.dirname(next.path), "001 제1화.md")));
  const history = await store.history(doc.id);
  assert.equal(history.length, 1);
  const old = await store.historyRead(doc.id, history[0].name);
  assert.equal(old.body, doc.body);
  assert.equal(old.title, "제1화");
  const restored = await store.restore({
    id: doc.id,
    name: history[0].name,
    expectedRevision: next.revision,
  });
  assert.equal(restored.body, doc.body);
  assert.equal(restored.title, "제1화");
  assert.equal(restored.relPath, "episodes/001 제1화.md");
  assert.equal((await store.history(doc.id)).length, 2);
});
test("동시에 저장한 UI/API 중 하나만 성공하고 외부 변경을 보존", async (t) => {
  const { store, doc } = await fixture(t);
  const results = await Promise.allSettled([
    store.save({ id: doc.id, expectedRevision: doc.revision, body: "UI" }),
    store.save({ id: doc.id, expectedRevision: doc.revision, body: "MCP" }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    results.find((r) => r.status === "rejected").reason.code,
    "CONFLICT",
  );
  const current = await store.read(doc.id);
  await fs.writeFile(await store.locate(doc.id), "외부 편집");
  await assert.rejects(
    store.save({
      id: doc.id,
      expectedRevision: current.revision,
      body: "덮어쓰기",
    }),
    (e) => e.code === "CONFLICT",
  );
  assert.equal((await store.read(doc.id)).body, "외부 편집");
  await assert.rejects(
    store.save({ id: doc.id, body: "기준 없음" }),
    (e) => e.code === "CONFLICT",
  );
});
test("보관, 검색, 임시 원고, 잘못된 경로 차단", async (t) => {
  const { store, project, doc } = await fixture(t);
  assert.equal((await store.search("한글")).length, 1);
  await store.draft({ ...doc, body: "미저장" });
  assert.equal((await store.drafts())[0].body, "미저장");
  await store.clearDraft(doc.id);
  assert.equal((await store.drafts()).length, 0);
  await store.save({
    id: doc.id,
    expectedRevision: doc.revision,
    archived: true,
  });
  assert.equal((await store.search("한글")).length, 0);
  await assert.rejects(store.read("../outside"));
  await assert.rejects(store.historyRead(doc.id, "../outside"));
  await assert.rejects(store.projectFile(project.id, "../outside"));
  await assert.rejects(store.projectFile(project.id, "C:/outside"));
  assert.equal(
    await store.projectFile(project.id, "assets/a.png"),
    path.join(projectDir(store, project), "assets", "a.png"),
  );
});
test("작품 메모는 경로로 ID를 만들고 보관 상태는 project.json의 archivedMemos에 둔다", async (t) => {
  const { store, project } = await fixture(t);
  const dir = projectDir(store, project),
    projectJson = () => readJson(path.join(dir, "project.json"));
  let memo = await store.create({
    projectId: project.id,
    kind: "memo",
    title: "인물 노트",
    body: "주인공",
  });
  assert.equal(memo.kind, "memo");
  assert.equal(memo.id, memoId(project.id, "memo/인물 노트.md"));
  assert.equal(memo.relPath, "memo/인물 노트.md");
  assert.equal(await fs.readFile(path.join(dir, "memo", "인물 노트.md"), "utf8"), "주인공");
  const nested = await store.create({
    projectId: project.id,
    kind: "memo",
    folder: "인물",
    title: "조연",
  });
  assert.equal(nested.relPath, "memo/인물/조연.md");
  assert.equal(nested.id, memoId(project.id, "memo/인물/조연.md"));
  // 메모는 project.json 문서 목록에 기록하지 않고, 다시 열어도 같은 ID로 읽힌다.
  assert.ok((await projectJson()).documents.every((d) => d.kind !== "memo"));
  assert.equal((await (await new Store(store.root).init()).read(memo.id)).body, "주인공");

  memo = await store.save({ id: memo.id, expectedRevision: memo.revision, archived: true });
  assert.equal(memo.archived, true);
  assert.deepEqual((await projectJson()).archivedMemos, ["memo/인물 노트.md"]);
  assert.equal((await store.search("주인공")).length, 0);

  // 제목을 바꾸면 파일 이름과 ID가 바뀌고, 보관 상태와 변경 이력은 따라가며 예전 ID는 삭제 기록에 남는다.
  const oldId = memo.id;
  memo = await store.save({ id: memo.id, expectedRevision: memo.revision, title: "등장인물" });
  assert.equal(memo.id, memoId(project.id, "memo/등장인물.md"));
  assert.equal(memo.relPath, "memo/등장인물.md");
  assert.equal(memo.archived, true);
  assert.deepEqual((await projectJson()).archivedMemos, ["memo/등장인물.md"]);
  await assert.rejects(store.read(oldId), (e) => e.code === "NOT_FOUND");
  assert.ok((await store.deleted())[oldId]);
  assert.equal((await store.history(memo.id)).length, 2);
  assert.deepEqual(await store.history(oldId), []);

  await store.remove(memo.id);
  assert.deepEqual((await projectJson()).archivedMemos, []);
  await assert.rejects(fs.access(path.join(dir, "memo", "등장인물.md")));
  assert.ok((await store.deleted())[memo.id]);
});
test("메모 화면(Memos)에서 폴더 이름을 바꾸면 ID·보관 상태·변경 이력이 따라간다", async (t) => {
  const { store, project } = await fixture(t);
  const common = path.join(await temp(t), "공용");
  const memos = new Memos(store, () => common);
  const projectJson = () => readJson(path.join(projectDir(store, project), "project.json"));
  assert.deepEqual((await memos.spaces()).map((s) => s.id), [COMMON, project.id]);
  assert.equal((await memos.createFolder({ space: project.id, name: "설정" })).path, "설정");
  const created = await memos.create({
    space: project.id,
    folder: "설정",
    title: "세계관",
    body: "마법 체계",
  });
  assert.equal(created.path, "설정/세계관.md");
  const oldId = memoId(project.id, "memo/설정/세계관.md");
  const doc = await store.read(oldId);
  await store.save({ id: oldId, expectedRevision: doc.revision, archived: true });
  assert.equal((await memos.rename({ space: project.id, path: "설정", name: "세계" })).path, "세계");
  const newId = memoId(project.id, "memo/세계/세계관.md");
  const moved = await store.read(newId);
  assert.equal(moved.body, "마법 체계");
  assert.equal(moved.archived, true);
  assert.deepEqual((await projectJson()).archivedMemos, ["memo/세계/세계관.md"]);
  assert.equal((await store.history(newId)).length, 1);
  assert.ok((await store.deleted())[oldId]);
  await assert.rejects(
    memos.save({ space: project.id, path: "세계/세계관.md", expectedRevision: "wrong", body: "x" }),
    (e) => e.code === "CONFLICT",
  );
  await memos.remove({ space: project.id, path: "세계" });
  assert.deepEqual((await projectJson()).archivedMemos, []);
  assert.ok((await store.deleted())[newId]);
  await assert.rejects(store.read(newId));
  // 공용 메모는 작품과 상관없는 폴더에 둔다.
  const note = await memos.create({ space: COMMON, title: "아이디어", body: "떠오른 생각" });
  assert.equal(note.path, "아이디어.md");
  assert.equal(await fs.readFile(path.join(common, "아이디어.md"), "utf8"), "떠오른 생각");
  const saved = await memos.save({
    space: COMMON,
    path: note.path,
    expectedRevision: note.revision,
    body: "고친 생각",
  });
  assert.equal(saved.body, "고친 생각");
  await assert.rejects(memos.read(COMMON, "../밖.md"));
});
test("repair: 옮겨진 파일을 내용 해시나 같은 이름으로 다시 연결한다", async (t) => {
  const { store, project, doc } = await fixture(t);
  const episodes = path.join(projectDir(store, project), "episodes");
  const second = await store.create({ projectId: project.id, title: "제2화", body: "둘째 원고" });
  // 첫 회차: 이름만 바꿈(내용 같음) → 해시로 찾는다.
  await fs.rename(path.join(episodes, "001 제1화.md"), path.join(episodes, "옮긴 원고.md"));
  // 둘째 회차: 하위 폴더로 옮기고 내용도 고침 → 같은 폴더 종류의 같은 이름으로 찾는다.
  await fs.mkdir(path.join(episodes, "보관"));
  await fs.rename(path.join(episodes, "002 제2화.md"), path.join(episodes, "보관", "002 제2화.md"));
  await fs.writeFile(path.join(episodes, "보관", "002 제2화.md"), "밖에서 고친 원고");
  const before = await store.list();
  assert.deepEqual(before.missing.map((m) => m.id).sort(), [doc.id, second.id].sort());
  assert.deepEqual(
    before.unlinked.map((u) => u.path).sort(),
    ["episodes/옮긴 원고.md", "episodes/보관/002 제2화.md"].sort(),
  );
  await assert.rejects(store.snapshot(), /동기화를 중단/);
  const report = await store.repair();
  assert.deepEqual(report.restored, []);
  assert.deepEqual(report.ambiguous, []);
  assert.deepEqual(
    report.relinked.map((r) => [r.id, r.to]).sort(),
    [
      [doc.id, "episodes/옮긴 원고.md"],
      [second.id, "episodes/보관/002 제2화.md"],
    ].sort(),
  );
  assert.equal((await store.read(doc.id)).body, doc.body);
  assert.equal((await store.read(second.id)).body, "밖에서 고친 원고");
  const after = await store.list();
  assert.deepEqual(after.missing, []);
  assert.deepEqual(after.unlinked, []);
  assert.deepEqual(after.warnings, []);
  // 고치기 전 상태는 .lof/recovery에 남는다.
  const [backup] = await fs.readdir(path.join(store.root, ".lof", "recovery"));
  assert.deepEqual(
    await ls(path.join(store.root, ".lof", "recovery", backup)),
    ["project.backup.json", "project.json", "reason.json"],
  );
});
test("repair: 깨진 project.json은 보관하고 백업본으로 되살린다", async (t) => {
  const { store, project, doc } = await fixture(t);
  const dir = projectDir(store, project);
  await fs.writeFile(path.join(dir, "project.json"), "{깨진 파일");
  const listed = await store.list();
  assert.ok(listed.warnings.some((w) => w.includes("project.backup.json")));
  assert.equal((await store.read(doc.id)).body, doc.body);
  const report = await store.repair();
  assert.deepEqual(report.restored, [project.id]);
  assert.equal((await readJson(path.join(dir, "project.json"))).id, project.id);
  assert.deepEqual((await store.list()).warnings, []);
  const recovery = path.join(store.root, ".lof", "recovery");
  const [backup] = await fs.readdir(recovery);
  assert.equal(await fs.readFile(path.join(recovery, backup, "project.json"), "utf8"), "{깨진 파일");
});
test("repair: 후보가 여럿이거나 한 파일을 여러 문서가 가리키면 건드리지 않는다", async (t) => {
  const store = await new Store(await temp(t)).init();
  // 후보 파일이 둘
  const one = await store.createProject({ title: "후보 여럿" });
  const lost = await store.create({ projectId: one.id, title: "제1화", body: "같은 원고" });
  const ep1 = path.join(projectDir(store, one), "episodes");
  await fs.copyFile(path.join(ep1, "001 제1화.md"), path.join(ep1, "사본 가.md"));
  await fs.copyFile(path.join(ep1, "001 제1화.md"), path.join(ep1, "사본 나.md"));
  await fs.rm(path.join(ep1, "001 제1화.md"));
  // 한 파일을 두 문서가 가리킴
  const two = await store.createProject({ title: "한 파일 여러 문서" });
  const x = await store.create({ projectId: two.id, title: "가", body: "똑같은 원고" });
  const y = await store.create({ projectId: two.id, title: "나", body: "똑같은 원고" });
  const ep2 = path.join(projectDir(store, two), "episodes");
  await fs.rm(path.join(ep2, "001 가.md"));
  await fs.rename(path.join(ep2, "002 나.md"), path.join(ep2, "남은 파일.md"));
  const projectFiles = () =>
    Promise.all(
      [one, two].map((p) => fs.readFile(path.join(projectDir(store, p), "project.json"), "utf8")),
    );
  const before = await projectFiles();
  const report = await store.repair();
  assert.deepEqual(report.relinked, []);
  assert.deepEqual(report.ambiguous.map((a) => a.id).sort(), [lost.id, x.id, y.id].sort());
  assert.deepEqual(await projectFiles(), before);
  assert.equal((await store.list()).missing.length, 3);
  assert.deepEqual(await ls(ep1), ["사본 가.md", "사본 나.md"]);
  assert.deepEqual(await ls(ep2), ["남은 파일.md"]);
  await assert.rejects(fs.access(path.join(store.root, ".lof", "recovery")));
});
test("끊긴 파일: 고른 파일에 다시 연결, 연결 끊기, 새 문서로 등록", async (t) => {
  const { store, project, doc } = await fixture(t);
  const episodes = path.join(projectDir(store, project), "episodes");
  const gone = await store.create({ projectId: project.id, title: "사라질 회차", body: "x" });
  await assert.rejects(store.forgetDocument({ projectId: project.id, id: gone.id }));
  await fs.rename(path.join(episodes, "001 제1화.md"), path.join(episodes, "다른 곳.md"));
  const relinked = await store.relinkDocument({
    projectId: project.id,
    id: doc.id,
    path: "episodes/다른 곳.md",
  });
  assert.equal(relinked.relPath, "episodes/다른 곳.md");
  assert.equal(relinked.body, doc.body);
  await fs.rm(path.join(episodes, "002 사라질 회차.md"));
  assert.equal(await store.forgetDocument({ projectId: project.id, id: gone.id }), true);
  await assert.rejects(store.read(gone.id));
  await fs.writeFile(path.join(episodes, "007 외전.md"), "외전 본문");
  const adopted = await store.adoptFile({ projectId: project.id, path: "episodes/007 외전.md" });
  assert.equal(adopted.kind, "episode");
  assert.equal(adopted.title, "외전");
  assert.equal(adopted.body, "외전 본문");
  assert.equal(adopted.relPath, "episodes/002 외전.md");
  // 등록하면서 번호·이름 규칙에 맞춰 다시 정리한다.
  assert.equal((await store.read(doc.id)).relPath, "episodes/001 제1화.md");
  const list = await store.list();
  assert.deepEqual(list.missing, []);
  assert.deepEqual(list.unlinked, []);
});
test("작품 삭제는 폴더 전체를 휴지통으로 보내고 문서·작품 삭제 기록을 남긴다", async (t) => {
  const trashed = [];
  const store = await new Store(await temp(t), {
    trash: async (file) => {
      trashed.push(file);
      await fs.rm(file, { recursive: true, force: true });
    },
  }).init();
  const project = await store.createProject({ title: "지울 작품" });
  const doc = await store.create({ projectId: project.id, title: "1화", body: "원고" });
  const plot = await store.create({ projectId: project.id, kind: "plot", title: "구상", episodeId: doc.id });
  const memo = await store.create({ projectId: project.id, kind: "memo", title: "메모", body: "메모 본문" });
  await store.save({ id: doc.id, expectedRevision: doc.revision, body: "고친 원고" });
  await store.draft({ id: doc.id, body: "임시" });
  const other = await store.createProject({ title: "남길 작품" });
  const dir = projectDir(store, project);
  await store.removeProject(project.id);
  assert.deepEqual(trashed, [dir]);
  await assert.rejects(fs.access(dir));
  const list = await store.list();
  assert.deepEqual(list.projects.map((p) => p.id), [other.id]);
  assert.deepEqual(list.documents, []);
  assert.deepEqual(await store.history(doc.id), []);
  assert.deepEqual(await store.drafts(), []);
  const deleted = await store.deleted();
  for (const id of [doc.id, plot.id, memo.id]) assert.equal(deleted[id].projectId, project.id);
  assert.equal(deleted[projectTombstone(project.id)].project, true);
  await assert.rejects(store.read(doc.id), (e) => e.code === "NOT_FOUND");
  await assert.rejects(store.removeProject(project.id));
  assert.ok((await store.snapshot()).deleted[projectTombstone(project.id)]);
});
test("snapshot/merge(형식 2): 회차·플롯 연결·메모·보관 상태를 다른 도서관에 그대로 옮긴다", async (t) => {
  const { store: a, project, doc } = await fixture(t);
  const plot = await a.create({
    projectId: project.id,
    kind: "plot",
    title: "구상",
    episodeId: doc.id,
    body: "플롯",
  });
  let memo = await a.create({
    projectId: project.id,
    kind: "memo",
    folder: "인물",
    title: "주인공",
    body: "메모",
  });
  memo = await a.save({ id: memo.id, expectedRevision: memo.revision, archived: true });
  const snapshot = await a.snapshot();
  assert.equal(snapshot.format, 2);
  assert.equal(snapshot.documents.find((d) => d.id === memo.id).path, "memo/인물/주인공.md");
  assert.equal(snapshot.documents.find((d) => d.id === plot.id).episodeId, doc.id);
  assert.equal("path" in snapshot.documents.find((d) => d.id === doc.id), false);
  const b = await new Store(await temp(t)).init();
  const r = await b.merge(snapshot);
  assert.equal(r.imported.length, 3);
  const dir = path.join(b.root, "001 한글 작품");
  assert.equal(await fs.readFile(path.join(dir, "episodes", "001 제1화.md"), "utf8"), doc.body);
  assert.equal(await fs.readFile(path.join(dir, "plot", "001 제1화", "구상.md"), "utf8"), "플롯");
  assert.equal(await fs.readFile(path.join(dir, "memo", "인물", "주인공.md"), "utf8"), "메모");
  assert.deepEqual((await readJson(path.join(dir, "project.json"))).archivedMemos, [
    "memo/인물/주인공.md",
  ]);
  const revisions = (s) => s.documents.map((d) => `${d.id}:${d.revision}`).sort();
  assert.deepEqual(revisions(await b.snapshot()), revisions(snapshot));
  assert.deepEqual((await b.merge(snapshot)).imported, []);
  await assert.rejects(b.merge({ ...snapshot, format: 1 }), /지원하지 않는 동기화 형식/);
  const tampered = structuredClone(snapshot);
  tampered.documents.find((d) => d.id === doc.id).body = "변조된 원고";
  await assert.rejects(b.merge(tampered), /체크섬/);
  const moved = structuredClone(snapshot);
  moved.documents.find((d) => d.id === memo.id).path = "memo/다른 곳.md";
  await assert.rejects(b.merge(moved), /메모 경로/);
  assert.equal((await b.read(doc.id)).body, doc.body);
});
test("searchText: 줄 번호·위치·대소문자 구분·작품 범위", async (t) => {
  const { store, project } = await fixture(t);
  const doc = await store.create({
    projectId: project.id,
    title: "검색",
    body: "첫 줄\n둘째 줄에 고양이\n고양이와 Cat, cat",
  });
  const other = await store.createProject({ title: "다른 작품" });
  await store.create({ projectId: other.id, title: "남의 회차", body: "여기도 고양이" });
  assert.deepEqual(await store.searchText("  "), { results: [], total: 0, truncated: false });
  assert.equal((await store.searchText("고양이")).total, 3);
  const scoped = await store.searchText("고양이", project.id);
  assert.equal(scoped.total, 2);
  assert.equal(scoped.truncated, false);
  assert.deepEqual(scoped.results.map((r) => r.id), [doc.id]);
  assert.equal(scoped.results[0].relPath, "episodes/002 검색.md");
  assert.deepEqual(
    scoped.results[0].matches.map((m) => [m.index, m.line, m.start, m.length]),
    [
      [0, 2, 6, 3],
      [1, 3, 0, 3],
    ],
  );
  assert.equal(scoped.results[0].matches[0].text, "둘째 줄에 고양이");
  const insensitive = await store.searchText("cat", project.id);
  assert.deepEqual(insensitive.results[0].matches.map((m) => m.start), [5, 10]);
  const sensitive = await store.searchText("cat", project.id, { caseSensitive: true });
  assert.deepEqual(sensitive.results[0].matches.map((m) => [m.index, m.start]), [[0, 10]]);
  // 보관한 문서도 찾는다.
  await store.save({ id: doc.id, expectedRevision: doc.revision, archived: true });
  const archived = await store.searchText("고양이", project.id);
  assert.equal(archived.results[0].archived, true);
});
test("두 도서관 왕복 동기화와 양쪽 오프라인 수정 충돌 사본 보존", async (t) => {
  const { store: a, doc } = await fixture(t),
    b = await new Store(await temp(t)).init(),
    remote = await temp(t),
    config = { id: "test", type: "folder", folder: remote };
  await syncOnce(a, config, "deviceA");
  await syncOnce(b, config, "deviceB");
  assert.equal((await b.read(doc.id)).body, doc.body);
  let bd = await b.read(doc.id);
  await b.save({
    id: bd.id,
    expectedRevision: bd.revision,
    body: "B의 오프라인 원고",
  });
  await syncOnce(b, config, "deviceB");
  await syncOnce(a, config, "deviceA");
  assert.equal((await a.read(doc.id)).body, "B의 오프라인 원고");
  await syncOnce(b, config, "deviceB");
  const ad = await a.read(doc.id);
  bd = await b.read(doc.id);
  await a.save({
    id: doc.id,
    expectedRevision: ad.revision,
    body: "A의 독립 수정",
  });
  await b.save({
    id: doc.id,
    expectedRevision: bd.revision,
    body: "B의 독립 수정",
  });
  await syncOnce(a, config, "deviceA");
  const r = await syncOnce(b, config, "deviceB");
  assert.equal(r.conflicts, 1);
  const docs = await b.snapshot();
  assert.ok(docs.documents.some((d) => d.body === "A의 독립 수정"));
  assert.ok(docs.documents.some((d) => d.body === "B의 독립 수정"));
  const count = docs.documents.length;
  await syncOnce(b, config, "deviceB");
  assert.equal((await b.snapshot()).documents.length, count);
});
test("Muvel 가져오기는 원본 바이트와 제목/본문을 분리 보관", async (t) => {
  const { store, project } = await fixture(t),
    src = path.join(await temp(t), "test.mvle");
  const raw = JSON.stringify({
    title: "가져온 회차",
    blocks: [
      { order: 1, content: [{ type: "text", text: "두 번째" }] },
      {
        order: 0,
        content: [{ type: "text", text: "첫 문단", marks: [{ type: "bold" }] }],
      },
    ],
    comments: [{ text: "댓글" }],
  });
  await fs.writeFile(src, raw);
  const result = await importFiles(store, [src], project.id);
  assert.equal(result.count, 1);
  assert.ok(result.warnings.length);
  const d = (await store.snapshot()).documents.find(
    (d) => d.title === "가져온 회차",
  );
  assert.equal(d.body, "**첫 문단**\n\n두 번째");
  assert.equal(await fs.readFile(src, "utf8"), raw);
  const batches = await fs.readdir(path.join(store.root, ".lof", "imports"));
  const backups = await fs.readdir(
    path.join(store.root, ".lof", "imports", batches[0]),
  );
  const backup = backups.find((n) => n.endsWith(".mvle"));
  assert.equal(
    await fs.readFile(
      path.join(store.root, ".lof", "imports", batches[0], backup),
      "utf8",
    ),
    raw,
  );
});
test("MCP/HTTP 인증, origin 거부, revision 검사와 부분 읽기", async (t) => {
  const { store, doc } = await fixture(t),
    api = await startApi(() => store);
  t.after(() => new Promise((r) => api.server.close(r)));
  const url = `http://127.0.0.1:${api.port}`;
  assert.equal(
    (await fetch(url + "/rpc", { method: "POST", body: "{}" })).status,
    401,
  );
  assert.equal(
    (
      await fetch(url + "/rpc", {
        method: "POST",
        headers: {
          Origin: "https://evil.example",
          Authorization: `Bearer ${api.token}`,
        },
        body: "{}",
      })
    ).status,
    403,
  );
  const rpc = async (payload) =>
    (
      await fetch(url + "/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${api.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...payload }),
      })
    ).json();
  const init = await rpc({
    method: "initialize",
    params: { protocolVersion: "2025-03-26" },
  });
  assert.equal(init.result.serverInfo.name, "lof-writer");
  assert.equal((await rpc({ method: "tools/list" })).result.tools.length, 11);
  const read = await rpc({
    method: "tools/call",
    params: { name: "document_read", arguments: { id: doc.id, limit: 2 } },
  });
  const data = JSON.parse(read.result.content[0].text);
  assert.equal(data.body, doc.body.slice(0, 2));
  assert.equal(data.truncated, true);
  const write = await rpc({
    method: "tools/call",
    params: {
      name: "document_update",
      arguments: { id: doc.id, expectedRevision: "wrong", body: "invalid" },
    },
  });
  assert.equal(write.result.isError, true);
  assert.equal((await store.read(doc.id)).body, doc.body);
});

test("작품 소개도 동기화하고 양쪽 제목 변경은 원격 사본 보관", async (t) => {
  const { store: a, project } = await fixture(t),
    b = await new Store(await temp(t)).init(),
    config = { id: "project", type: "folder", folder: await temp(t) };
  await syncOnce(a, config, "A");
  await syncOnce(b, config, "B");
  await b.updateProject({ id: project.id, title: "B에서 변경한 제목" });
  await syncOnce(b, config, "B");
  await syncOnce(a, config, "A");
  assert.equal((await a.list()).projects[0].title, "B에서 변경한 제목");
  assert.equal((await a.list()).projects[0].folder, "001 B에서 변경한 제목");
  await syncOnce(b, config, "B");
  await a.updateProject({ id: project.id, title: "A 제목" });
  await b.updateProject({ id: project.id, title: "B 제목" });
  await syncOnce(a, config, "A");
  const result = await syncOnce(b, config, "B");
  assert.equal(result.projectConflicts, 1);
  assert.equal((await b.list()).projects[0].title, "B 제목");
  const conflicts = await fs.readdir(
    path.join(b.root, ".lof", "project-conflicts"),
  );
  assert.equal(
    JSON.parse(
      await fs.readFile(
        path.join(b.root, ".lof", "project-conflicts", conflicts[0]),
        "utf8",
      ),
    ).title,
    "A 제목",
  );
});

test("영구 삭제는 파일·변경 이력·임시 원고를 지우고 삭제 기록을 남긴다", async (t) => {
  const { root, store, doc } = await fixture(t);
  await store.save({ id: doc.id, expectedRevision: doc.revision, body: "고친 원고" });
  await store.draft({ id: doc.id, body: "임시" });
  const file = await store.locate(doc.id);
  await store.remove(doc.id);
  await assert.rejects(fs.access(file));
  await assert.rejects(store.locate(doc.id));
  assert.deepEqual(await store.history(doc.id), []);
  assert.equal((await store.drafts()).length, 0);
  assert.ok((await store.deleted())[doc.id]);
  assert.equal((await store.list()).documents.length, 0);
  await assert.rejects(store.remove(doc.id));
  assert.ok((await (await new Store(root).init()).deleted())[doc.id]);
});
test("영구 삭제는 동기화로 다른 장치에 전달되고 다시 살아나지 않는다", async (t) => {
  const { store: a, doc } = await fixture(t),
    b = await new Store(await temp(t)).init(),
    config = { id: "test", type: "folder", folder: await temp(t) };
  await syncOnce(a, config, "deviceA");
  await syncOnce(b, config, "deviceB");
  await b.read(doc.id);
  await a.remove(doc.id);
  await syncOnce(a, config, "deviceA");
  const r = await syncOnce(b, config, "deviceB");
  assert.equal(r.removed, 1);
  await assert.rejects(b.read(doc.id));
  await syncOnce(a, config, "deviceA");
  await assert.rejects(a.read(doc.id));
});
test("다른 장치에서 고친 문서는 영구 삭제가 전달돼도 남긴다", async (t) => {
  const { store: a, doc } = await fixture(t),
    b = await new Store(await temp(t)).init(),
    config = { id: "test", type: "folder", folder: await temp(t) };
  await syncOnce(a, config, "deviceA");
  await syncOnce(b, config, "deviceB");
  const bd = await b.read(doc.id);
  await b.save({ id: doc.id, expectedRevision: bd.revision, body: "B가 고친 원고" });
  await a.remove(doc.id);
  await syncOnce(a, config, "deviceA");
  const r = await syncOnce(b, config, "deviceB");
  assert.equal(r.removed, 0);
  assert.equal((await b.read(doc.id)).body, "B가 고친 원고");
  await syncOnce(a, config, "deviceA");
  await assert.rejects(a.read(doc.id));
});
test("작품 삭제는 동기화로 전달되고 다시 살아나지 않는다", async (t) => {
  const { store: a, project, doc } = await fixture(t),
    b = await new Store(await temp(t)).init(),
    config = { id: "test", type: "folder", folder: await temp(t) };
  await syncOnce(a, config, "deviceA");
  await syncOnce(b, config, "deviceB");
  assert.equal((await b.read(doc.id)).body, doc.body);
  await a.removeProject(project.id);
  await syncOnce(a, config, "deviceA");
  const r = await syncOnce(b, config, "deviceB");
  assert.equal(r.removed, 1);
  assert.deepEqual((await b.list()).projects, []);
  assert.ok((await b.deleted())[projectTombstone(project.id)]);
  await syncOnce(a, config, "deviceA");
  assert.deepEqual((await a.list()).projects, []);
});
test("다른 장치에서 고친 작품은 작품 삭제가 전달돼도 남긴다", async (t) => {
  const { store: a, project, doc } = await fixture(t),
    b = await new Store(await temp(t)).init(),
    config = { id: "test", type: "folder", folder: await temp(t) };
  await syncOnce(a, config, "deviceA");
  await syncOnce(b, config, "deviceB");
  const bd = await b.read(doc.id);
  await b.save({ id: doc.id, expectedRevision: bd.revision, body: "B가 고친 원고" });
  await a.removeProject(project.id);
  await syncOnce(a, config, "deviceA");
  const r = await syncOnce(b, config, "deviceB");
  assert.equal(r.removed, 0);
  assert.deepEqual((await b.list()).projects.map((p) => p.id), [project.id]);
  assert.equal((await b.read(doc.id)).body, "B가 고친 원고");
  // 지운 쪽은 다시 가져오지 않는다.
  await syncOnce(a, config, "deviceA");
  assert.deepEqual((await a.list()).projects, []);
});
test("변경 이력은 최소 간격과 최소 변경 글자 수를 모두 넘을 때만 남긴다", async (t) => {
  let now = 1_000_000;
  const root = await temp(t),
    store = await new Store(root, {
      now: () => now,
      historyPolicy: () => ({ minMinutes: 1, minChars: 200 }),
    }).init(),
    project = await store.createProject({ title: "이력 작품" });
  let doc = await store.create({ projectId: project.id, title: "1화", body: "" });
  const save = async (body) =>
    (doc = await store.save({ id: doc.id, expectedRevision: doc.revision, body }));
  // 빈 원고에서 시작한 짧은 수정: 바뀐 글자가 적어 남기지 않는다.
  await save("가".repeat(50));
  assert.equal((await store.history(doc.id)).length, 0);
  // 저장 직전 원고가 200자를 넘으면 첫 이력을 남긴다(이전 이력이 없으므로 시간 조건 없음).
  await save("가".repeat(300));
  await save("가".repeat(310));
  assert.equal((await store.history(doc.id)).length, 1);
  // 200자 넘게 바뀌어도 1분이 안 지났으면 남기지 않는다.
  now += 30_000;
  await save("가".repeat(310) + "나".repeat(300));
  await save("가".repeat(310) + "나".repeat(301));
  assert.equal((await store.history(doc.id)).length, 1);
  // 다시 연 저장소도 디스크의 마지막 이력을 기준으로 판단한다. 1분이 지나고 그동안 쌓인
  // 변경이 200자를 넘으면 남기고, 바로 이어진 작은 수정은 남기지 않는다.
  const reopened = await new Store(root, {
    now: () => now,
    historyPolicy: () => ({ minMinutes: 1, minChars: 200 }),
  }).init();
  now += 60_000;
  doc = await reopened.save({ id: doc.id, expectedRevision: doc.revision, body: "다".repeat(10) + doc.body.slice(10) });
  assert.equal((await reopened.history(doc.id)).length, 2);
  doc = await reopened.save({ id: doc.id, expectedRevision: doc.revision, body: doc.body + "라" });
  assert.equal((await reopened.history(doc.id)).length, 2);
});
test("되돌리기는 변경 이력 조건과 상관없이 이력을 남긴다", async (t) => {
  const store = await new Store(await temp(t), {
      historyPolicy: () => ({ minMinutes: 60, minChars: 100000 }),
    }).init(),
    project = await store.createProject({ title: "되돌리기" });
  let doc = await store.create({ projectId: project.id, title: "1화", body: "처음" });
  doc = await store.save({ id: doc.id, expectedRevision: doc.revision, body: "둘째" });
  doc = await store.save({ id: doc.id, expectedRevision: doc.revision, body: "셋째", forceHistory: true });
  const [entry] = await store.history(doc.id);
  doc = await store.restore({ id: doc.id, name: entry.name, expectedRevision: doc.revision });
  assert.equal(doc.body, "둘째");
  assert.equal((await store.history(doc.id)).length, 2);
});
