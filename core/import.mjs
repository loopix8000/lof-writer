import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomic } from "./store.mjs";
import { readMarkdown, markdownEntry } from "./markdown.mjs";

function textContent(node, warnings) {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  if (node.type === "hardBreak" || node.type === "hard_break") return "  \n";
  let value =
    node.text ??
    (Array.isArray(node.content)
      ? node.content.map((n) => textContent(n, warnings)).join("")
      : "");
  // Preserve literal prose as text when importing to Markdown.
  if (node.text) value = String(value).replace(/([\\`*_[\]<>])/g, "\\$1");
  for (const m of node.marks || []) {
    if (m.type === "bold") value = `**${value}**`;
    else if (m.type === "italic") value = `*${value}*`;
    else if (m.type === "strike") value = `~~${value}~~`;
    else warnings.add(`지원하지 않는 서식: ${m.type} (원본 보관)`);
  }
  return value;
}
export async function importFiles(store, files, projectId) {
  const warnings = new Set(),
    imported = [];
  const batch = randomUUID();
  for (const file of files) {
    const stat = await fs.stat(file);
    if (stat.size > 20_000_000)
      throw Error("가져오기는 파일당 20MB 이하만 지원합니다.");
    const raw = (await fs.readFile(file, "utf8")).replace(/^\uFEFF/, "");
    let title = path.basename(file, path.extname(file)),
      body = raw;
    let attributes = {}, kind = "episode";
    if (file.toLowerCase().endsWith(".mvle")) {
      const obj = JSON.parse(raw);
      if (!Array.isArray(obj.blocks))
        throw Error("지원하지 않는 mvle 구조입니다.");
      title = obj.title || title;
      body = [...obj.blocks]
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        .map((b) =>
          Array.isArray(b.content)
            ? b.content.map((n) => textContent(n, warnings)).join("")
            : String(b.text || "").replace(/([\\`*_[\]<>])/g, "\\$1"),
        )
        .join("\n\n");
      if (obj.comments?.length)
        warnings.add(
          "Muvel 댓글은 원본 파일에 보관됩니다. 댓글 UI 변환은 지원하지 않습니다.",
        );
      if (obj.blocks.some((b) => Object.keys(b.attr || {}).length))
        warnings.add("문단별 부가 속성은 원본 파일에 보관됩니다.");
      if (obj.blocks.some((b) => b.blockType && b.blockType !== "describe"))
        warnings.add(
          "특수 블록은 문단 텍스트로 가져오며 원본 파일을 보관합니다.",
        );
    } else if (file.toLowerCase().endsWith(".txt"))
      body = raw.replace(/([\\`*_[\]<>])/g, "\\$1").replace(/\r?\n/g, "\n\n");
    else if (file.toLowerCase().endsWith(".md")) {
      const parsed = readMarkdown(raw);
      if (parsed.hasProperties) {
        kind = ["plot", "memo"].includes(parsed.properties.kind) ? parsed.properties.kind : "episode";
        attributes = markdownEntry(raw, { kind, title });
        title = attributes.title;
        body = parsed.body;
        if (attributes.episodeId && !(await store._project(projectId)).project.documents.some((d) => d.id === attributes.episodeId)) {
          attributes.episodeId = null;
          warnings.add("가져온 문서의 연결 회차가 현재 작품에 없어 독립 문서로 등록했습니다.");
        }
      }
    }
    // Keep exact source bytes, including unsupported formatting/comments.
    await fs.mkdir(path.join(store.root, ".lof", "imports", batch), {
      recursive: true,
    });
    const backup = path.join(
      store.root,
      ".lof",
      "imports",
      batch,
      `${randomUUID()}-${path.basename(file)}`,
    );
    await fs.copyFile(file, backup);
    imported.push(
      await store.create({ ...attributes, projectId, kind, title, body }),
    );
  }
  await atomic(
    path.join(store.root, ".lof", "imports", batch, "report.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        count: imported.length,
        warnings: [...warnings],
      },
      null,
      2,
    ),
  );
  return { count: imported.length, warnings: [...warnings] };
}
