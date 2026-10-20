import { Node, type Editor, type JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Markdown, MarkdownManager } from "@tiptap/markdown";
import { Marked, type marked } from "marked";
import { decodeHTMLStrict } from "entities";
import { changedBlocks } from "./doc-index";

const originalParse = MarkdownManager.prototype.parse;
// 주석을 가렸다가 글자로 되돌려 HTML 처리나 Markdown 구분선·목록으로 바뀌지 않게 한다.
MarkdownManager.prototype.parse = function (markdown: string): JSONContent {
  if (typeof markdown !== "string" || (!markdown.includes("<!--") && !markdown.includes("-->"))) {
    return originalParse.call(this, markdown);
  }
  const saved: string[] = [];
  const mask = (text: string) => {
    if (!text.trim()) return text;
    saved.push(text);
    return `\uE000JSDOC${saved.length - 1}\uE001`;
  };
  const masked = markdown
    .replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => comment.split("\n").map(mask).join("\n"))
    .replace(/-->/g, mask);
  const doc = originalParse.call(this, masked);
  const restore = (node: JSONContent) => {
    if (typeof node.text === "string" && node.text.includes("\uE000JSDOC")) {
      node.text = node.text.replace(/\uE000JSDOC(\d+)\uE001/g, (_, i) => saved[Number(i)] ?? "");
    }
    if (node.content) node.content.forEach(restore);
  };
  restore(doc);
  return doc;
};

// 주석은 원문으로 읽으므로 직렬화가 붙인 문자 참조와 Markdown 이스케이프를 함께 푼다.
function unescapeComments(markdown: string) {
  return markdown.includes("&lt;!--") || markdown.includes("--&gt;")
    ? markdown
        .replace(/&lt;!--[\s\S]*?(?:--&gt;|$)/g, (comment) => decodeHTMLStrict(comment).replace(/\\([\\`*_[\]~])/g, "$1"))
        .replaceAll("--&gt;", "-->")
    : markdown;
}
function dangles(markdown: string) {
  return markdown.includes("&lt;!--") && markdown.replace(/&lt;!--[\s\S]*?--&gt;/g, "").includes("&lt;!--");
}
// 기본 직렬화의 빈 원고 판정과 같은 기준. 블록 사이 구분은 공백이므로 모든 블록이 비었을 때만 원고가 빈다.
const isBlank = (markdown: string) => markdown.replace(/&nbsp;/g, "").replace(/ /g, "").trim() === "";

type Block = { markdown: string; clean: string; blank: boolean; dangling: boolean; marked: boolean };
const CHUNK = 64;

// ProseMirror는 바뀌지 않은 노드를 재사용한다. 그 노드의 JSON과 블록 변환 결과도 함께 재사용한다.
// 저장 시점을 미루지 않고 입력 직후의 본문을 계속 전달하므로 저장·문서 전환 경로는 그대로 쓴다.
export function createCachedMarkdown() {
  const jsonCache = new WeakMap<PMNode, JSONContent>();
  const paragraphCache = new WeakMap<JSONContent, { previousEmpty: boolean; markdown: string }>();
  const blockCache = new WeakMap<PMNode, Block[]>();
  let lastDoc: PMNode | undefined;
  let lastMarkdown = "";
  // lastDoc의 맨 위 블록별 변환 결과와, 이를 CHUNK개씩 이어 붙인 글(joined일 때만 유효).
  let blocks: Block[] = [];
  const chunks: string[] = [];
  let joined = false;

  const document = Node.create({
    name: "doc",
    topNode: true,
    content: "block+",
    renderMarkdown(node, helpers) {
      const content = node.content || [];
      const renderChild = helpers.renderChild;
      // 블록 자체에 마크가 있는 경우에는 기본 렌더러의 마크 경계 처리를 사용한다.
      if (!renderChild || content.some((child) => child.type === "text" || child.marks?.length))
        return helpers.renderChildren(content, "\n\n");
      return content.map((child, index) => {
        // 목록·표 등은 원래 렌더러로 변환하고, 일반 문단만 캐시한다.
        if (child.type !== "paragraph") return renderChild(child, index);
        // 빈 문단의 출력은 앞 문단도 비어 있는지에 따라 달라진다.
        const previous = content[index - 1];
        const previousEmpty = previous?.type === "paragraph" && !previous.content?.length;
        const cached = paragraphCache.get(child);
        if (cached && cached.previousEmpty === previousEmpty) return cached.markdown;
        const markdown = renderChild(child, index);
        paragraphCache.set(child, { previousEmpty, markdown });
        return markdown;
      }).join("\n\n");
    },
  });

  const json = (node: PMNode) => {
    let value = jsonCache.get(node);
    if (!value) jsonCache.set(node, (value = node.toJSON() as JSONContent));
    return value;
  };
  // 맨 위 블록 하나를 문서 직렬화 때와 같은 문맥으로 변환한다. 빈 문단의 출력은 앞 문단도 비어 있는지에 따라 달라지므로
  // 앞 문단 모양만 함께 넘기고, 결과는 노드와 그 조건별로 보관한다.
  function render(manager: MarkdownManager, doc: PMNode, i: number): Block {
    const node = doc.child(i), previous = i > 0 ? doc.child(i - 1) : null;
    const previousEmpty = previous?.type.name === "paragraph" && previous.childCount === 0;
    let cached = blockCache.get(node);
    if (!cached) blockCache.set(node, (cached = []));
    let block = cached[+previousEmpty];
    if (!block) {
      const value = json(node);
      const parent = { type: doc.type.name, content: previousEmpty ? [{ type: "paragraph" }, value] : [value] };
      const markdown = manager.renderNodeToMarkdown(value, parent, previousEmpty ? 1 : 0, 0);
      cached[+previousEmpty] = block = {
        markdown, clean: unescapeComments(markdown), blank: isBlank(markdown), dangling: dangles(markdown), marked: node.marks.length > 0,
      };
    }
    return block;
  }

  function serialize(editor: Editor) {
    const doc = editor.state.doc;
    if (doc === lastDoc) return lastMarkdown;
    const manager = editor.markdown;
    if (!manager) return editor.getMarkdown();
    const count = doc.childCount;
    // 바뀐 블록과 그 바로 다음 블록만 다시 변환하고, 나머지는 앞 문서의 결과를 옮겨 쓴다.
    const { start, endA, endB } = lastDoc ? changedBlocks(lastDoc, doc) : { start: 0, endA: 0, endB: count };
    const shift = endA - endB, renewTo = Math.min(count, endB + 1);
    const next = new Array<Block>(count);
    let empty = true, dangling = false, marked = false;
    for (let i = 0; i < count; i++) {
      const block = (next[i] = i < start ? blocks[i] : i < renewTo ? render(manager, doc, i) : blocks[i + shift]);
      empty &&= block.blank;
      dangling ||= block.dangling;
      marked ||= block.marked;
    }
    let markdown: string;
    if (marked) {
      // 블록 자체에 마크가 있으면 기본 렌더러의 마크 경계 처리를 쓴다.
      const content: JSONContent[] = [];
      doc.forEach((child) => content.push(json(child)));
      markdown = unescapeComments(manager.serialize({ type: doc.type.name, content }));
    } else if (empty) {
      // 공백만 있는 원고는 기본 Markdown 직렬화 규칙처럼 빈 글로 둔다.
      markdown = "";
    } else if (dangling) {
      markdown = unescapeComments(next.map((block) => block.markdown).join("\n\n"));
    } else {
      // 블록을 CHUNK개씩 묶어 두고, 바뀐 블록이 든 묶음만 다시 이어 붙인다.
      const chunkCount = Math.ceil(count / CHUNK);
      const from = joined ? Math.floor(start / CHUNK) : 0;
      const to = joined && shift === 0 ? Math.floor((Math.max(start, renewTo) - 1) / CHUNK) + 1 : chunkCount;
      chunks.length = chunkCount;
      for (let c = from; c < to; c++)
        chunks[c] = next.slice(c * CHUNK, (c + 1) * CHUNK).map((block) => block.clean).join("\n\n");
      markdown = chunks.join("\n\n");
    }
    joined = !marked && !empty && !dangling;
    blocks = next;
    lastDoc = doc;
    lastMarkdown = markdown;
    return markdown;
  }

  // 편집기마다 파서를 따로 만들어 탭을 열 때 확장이 전역 파서에 누적되지 않게 한다.
  const extension = Markdown.configure({ marked: new Marked() as unknown as typeof marked });
  return { document, extension, serialize };
}
