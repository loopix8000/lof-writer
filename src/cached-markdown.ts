import { Node, type Editor, type JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Markdown, MarkdownManager } from "@tiptap/markdown";
import { Marked, type marked } from "marked";

const originalParse = MarkdownManager.prototype.parse;
MarkdownManager.prototype.parse = function (markdown: string): JSONContent {
  if (typeof markdown !== "string" || (!markdown.includes("/*") && !markdown.includes("*/"))) {
    return originalParse.call(this, markdown);
  }
  const saved: string[] = [];
  const maskLine = (line: string) => {
    if (!line.trim()) return line;
    const idx = saved.length;
    saved.push(line);
    return `\uE000JSDOC${idx}\uE001`;
  };
  const masked = markdown
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.split("\n").map(maskLine).join("\n"))
    .replace(/\/\*+|\*+\//g, (delim) => maskLine(delim));
  if (!saved.length) return originalParse.call(this, markdown);
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

// ProseMirror는 바뀌지 않은 노드를 재사용한다. 그 노드의 JSON과 문단 변환 결과도 함께 재사용한다.
// 저장 시점을 미루지 않고 입력 직후의 본문을 계속 전달하므로 저장·문서 전환 경로는 그대로 쓴다.
export function createCachedMarkdown() {
  const jsonCache = new WeakMap<PMNode, JSONContent>();
  const paragraphCache = new WeakMap<JSONContent, { previousEmpty: boolean; markdown: string }>();
  let lastDoc: PMNode | undefined;
  let lastMarkdown = "";

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

  function serialize(editor: Editor) {
    const doc = editor.state.doc;
    if (doc === lastDoc) return lastMarkdown;
    const manager = editor.markdown;
    if (!manager) return editor.getMarkdown();
    const content: JSONContent[] = [];
    doc.forEach((child) => {
      const json: JSONContent = jsonCache.get(child) ?? child.toJSON();
      jsonCache.set(child, json);
      content.push(json);
    });
    // 공백만 있는 원고와 엔티티 처리도 기본 Markdown 직렬화 규칙을 따른다.
    const rawMarkdown = manager.serialize({ type: doc.type.name, content });
    const markdown = rawMarkdown.includes("\\*")
      ? rawMarkdown
          .replace(/\/\\\*[\s\S]*?\\\*\//g, (match) =>
            match.replace(/\\([\\`*_[\]~])/g, "$1"),
          )
          .replace(/\/(\\\*)+/g, (match) => match.replace(/\\\*/g, "*"))
          .replace(/(\\\*)+\//g, (match) => match.replace(/\\\*/g, "*"))
      : rawMarkdown;
    lastDoc = doc;
    lastMarkdown = markdown;
    return markdown;
  }

  // 편집기마다 파서를 따로 만들어 탭을 열 때 확장이 전역 파서에 누적되지 않게 한다.
  const extension = Markdown.configure({ marked: new Marked() as unknown as typeof marked });
  return { document, extension, serialize };
}
