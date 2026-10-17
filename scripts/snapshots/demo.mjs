import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { quickstart as defaultStory } from "./quickstart.mjs";
import { manuscriptStats, countForWriting } from "../../core/text.mjs";
import { normalizeWriting } from "../../core/platforms.mjs";

// 실제 저장 API로 만드는 소개용 서재. 사용자의 서재와 설정은 사용하지 않는다.
export const demoPreferences = {
  setupComplete: true,
  checkUpdatesOnStartup: false,
  theme: "light",
  colorTheme: "modern",
  goal: 3000,
  defaultManualLineBreak: false,
  episodeInfoOpen: false,
  textReplacementsVersion: 1,
};

export async function loadDemoStory(root, customFile) {
  const story = customFile
    ? JSON.parse(await fs.readFile(path.resolve(root, customFile), "utf8"))
    : defaultStory;
  if (!story.title || !Array.isArray(story.chapters) || story.chapters.length !== 3)
    throw Error("데모에는 작품 제목과 본문을 보여 줄 1~3편이 필요합니다.");
  for (const chapter of story.chapters) {
    if (!chapter.title || !(chapter.body || chapter.paragraphs?.length)) throw Error("데모 본문이나 소제목이 비어 있습니다.");
  }
  const listOnly = story.listOnlyChapters || [];
  if (listOnly.length > 3 || listOnly.some(chapter => chapter.body || chapter.paragraphs || chapter.summary))
    throw Error("4~6편의 목록 항목에는 본문이나 요약을 포함할 수 없습니다.");
  if ((story.specials || []).some(chapter => chapter.body || chapter.paragraphs || chapter.summary))
    throw Error("특별 회차의 목록 항목에는 본문이나 요약을 포함할 수 없습니다.");
  return story;
}

// 브리지의 오류를 그대로 전달해 실패한 데이터 준비를 성공으로 기록하지 않는다.
export async function appCall(page, method, args = {}) {
  return page.evaluate(async ({ method, args }) => {
    const result = await window.lof[method](args);
    if (!result?.ok) throw Error(result?.error || `${method} 호출 실패`);
    return result.data;
  }, { method, args });
}

export async function prepareDemo(page, { vault, cover, story }) {
  const library = await appCall(page, "bootstrap");
  if (library.projects.length || library.documents.length)
    throw Error("촬영용 서재가 비어 있지 않습니다. 새 데모 프로필이 필요합니다.");
  const project = await appCall(page, "createProject", {
    title: story.title,
    description: story.description,
    tags: story.tags,
    writing: { platform: "custom", customName: story.writingLabel || "퀵스타트 가이드", rule: story.countRule || "all", goal: story.goal || 3000 },
  });
  const bytes = await fs.readFile(cover);
  if (bytes.length > 8_000_000 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    throw Error("데모 표지는 8MB 이하의 PNG 파일이어야 합니다.");
  const coverHash = createHash("sha256").update(bytes).digest("hex");
  const assets = path.resolve(vault, project.folder, "assets");
  const relative = path.relative(vault, assets);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw Error("데모 작품의 자산 경로가 잘못되었습니다.");
  await fs.mkdir(assets, { recursive: true });
  const filename = `cover-${coverHash}.png`;
  await fs.writeFile(path.join(assets, filename), bytes);
  await appCall(page, "updateProject", { id: project.id, cover: filename });
  const specials = [];
  for (const special of story.specials || []) {
    specials.push(await appCall(page, "createDocument", {
      projectId: project.id, kind: "episode", title: special.title,
      episodeType: special.episodeType, body: "",
    }));
  }
  const episodes = [];
  for (const [i, chapter] of story.chapters.entries()) {
    const body = chapter.body || chapter.paragraphs.join("\n\n") + "\n";
    const firstParagraph = body.trim().split(/\r?\n\s*\r?\n/)[0];
    const created = await appCall(page, "createDocument", {
      projectId: project.id,
      kind: "episode",
      title: chapter.title,
      body,
      status: chapter.status,
      description: chapter.summary,
      tags: chapter.tags || (i === 0 ? ["도입", "복선"] : []),
      bookmarks: [{ index: 0, text: firstParagraph.slice(0, 80) }],
      properties: chapter.properties || { 분류: "사용 안내", 집필목표: story.goal || 3000 },
    });
    const current = await appCall(page, "readDocument", { id: created.id });
    episodes.push(await appCall(page, "saveDocument", {
      ...current, expectedRevision: current.revision, status: chapter.status,
    }));
  }
  const listOnly = [];
  for (const chapter of story.listOnlyChapters || []) {
    listOnly.push(await appCall(page, "createDocument", {
      projectId: project.id, kind: "episode", title: chapter.title, body: "",
    }));
  }
  const opening = episodes[0].body.trim().split(/\r?\n\s*\r?\n/)[0];
  const plot = await appCall(page, "createDocument", {
    projectId: project.id, kind: "plot", episodeId: episodes[0].id,
    title: story.plot?.title || "푸른 리본과 편지의 복선",
    body: story.plot?.body || "## 3화 구성\n\n1. 발견: 창가에서 편지를 발견하고 답장을 쓴다.\n2. 선택: 은재와 기억을 모으고 바다에 갈 날짜를 정한다.\n3. 약속: 편지의 주인을 만나고 다음 여름을 기약한다.\n\n## 반복되는 이미지\n\n- 푸른 리본: 처음에는 책갈피, 마지막에는 서하의 손목에 남는다.\n- 오후 네 시의 빛: 혼자 앉던 자리가 함께 기다리는 자리로 바뀐다.\n",
    tags: ["구성", "복선"],
  });
  const note = await appCall(page, "createDocument", {
    projectId: project.id, kind: "memo", episodeId: episodes[0].id,
    title: story.note?.title || "처음과 마지막 창가 장면 연결",
    body: `출처: [${episodes[0].title}](lof://doc/${encodeURIComponent(episodes[0].id)})\n\n## 선택한 본문\n\n> ${opening}\n\n## 메모\n\n${story.note?.body || "첫 문장의 빛을 마지막 회차에서도 반복한다. 처음에는 혼자 머무는 자리, 마지막에는 친구를 기다리는 자리로 의미가 달라지도록 구성한다."}\n`,
    tags: ["아이디어"],
  });
  const table = await appCall(page, "createDocument", {
    projectId: project.id, kind: "memo", title: story.table?.title || "등장인물과 장면 설정",
    body: story.table?.body || "## 등장인물 노트\n\n| 이름 | 역할 | 바라는 것 | 변화 |\n| --- | --- | --- | --- |\n| 서하 | 창가를 좋아하는 학생 | 여름이 끝나지 않기를 | 다음 만남을 약속한다 |\n| 은재 | 이사를 앞둔 친구 | 함께 보낼 시간 | 기다릴 날짜를 정한다 |\n| 사서 선생님 | 첫 편지의 주인 | 미뤄 둔 인사 전하기 | 오래된 친구와 연락한다 |\n\n## 장면과 소품\n\n- 오후 네 시, 도서관 안쪽 창가의 푸른 빛.\n- 바다 여행기와 편지지, 푸른 리본.\n- 아이스크림 두 개: 재회의 장면에서도 반복한다.\n",
    properties: { 분류: "설정집", 상태: "정리 중" },
  });
  const libraryAfter = await appCall(page, "bootstrap");
  if (libraryAfter.documents.some(doc => doc.manualLineBreak === true))
    throw Error("데모 문서가 기본 자동 관리 대신 수동 관리로 생성되었습니다.");
  const metadataOnly = [...specials, ...listOnly];
  for (const entry of metadataOnly) {
    const doc = await appCall(page, "readDocument", { id: entry.id });
    if (doc.body.trim()) throw Error("목록 전용 회차에 본문이 포함되어 있습니다.");
  }
  if (libraryAfter.documents.filter(doc => doc.kind === "episode").length !== episodes.length + metadataOnly.length)
    throw Error("데모 회차 수가 촬영 범위와 일치하지 않습니다.");
  const counts = episodes.map(doc => ({ title: doc.title, value: countForWriting(manuscriptStats(doc.body), normalizeWriting(project.writing)) }));
  if (story.countRange && counts.some(({ value }) => value < story.countRange.min || value > story.countRange.max))
    throw Error(`에피소드 본문이 요청한 글자 수 범위를 벗어났습니다: ${counts.map(({ value }) => value).join(", ")}`);
  return { project, episodes, specials, listOnly, plot, note, table, coverHash,
    quickNote: story.quickNote, searchQuery: story.searchQuery || "조판", counts };
}
