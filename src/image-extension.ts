import { Node } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";

// Markdown 이미지 문법. 경로에 빈칸·괄호가 있으면 <>로 감싼다.
export function markdownImage({ src, alt, title }: { src?: string; alt?: string; title?: string | null }) {
  const text = String(alt || "").replace(/[[\]\\]/g, "\\$&");
  const path = String(src || "");
  const dest = /[\s()<>]/.test(path) ? `<${path}>` : path;
  const tail = title ? ` "${String(title).replace(/"/g, '\\"')}"` : "";
  return `![${text}](${dest}${tail})`;
}

// 원고 이미지. Markdown 이미지 문법(![설명](경로))으로 읽고 쓴다. 경로는 원고 파일 기준 상대 경로이며
// (예: ../assets/그림.png) 화면에는 resolve로 읽은 data URL을 그린다. 웹 주소·data URL은 그대로 그린다.
export const MarkdownImage = Node.create<{ resolve: (src: string) => Promise<string | null> }>({
  name: "image",
  inline: true,
  group: "inline",
  atom: true,
  draggable: true,
  selectable: true,
  addOptions() {
    return { resolve: async () => null };
  },
  addAttributes() {
    return {
      src: { default: "" },
      alt: { default: "" },
      title: { default: null },
    };
  },
  parseHTML() {
    return [
      {
        tag: "img[src]",
        // 붙여 넣은 HTML의 data URL 이미지는 원고에 그대로 넣지 않는다(파일 붙여넣기로 assets에 저장한다).
        getAttrs: (el) => {
          const src = (el as HTMLElement).getAttribute("src") || "";
          if (/^data:/i.test(src)) return false;
          return { src, alt: (el as HTMLElement).getAttribute("alt") || "", title: (el as HTMLElement).getAttribute("title") };
        },
      },
    ];
  },
  renderHTML({ HTMLAttributes }) {
    return ["img", HTMLAttributes];
  },
  markdownTokenName: "image",
  parseMarkdown: (token: any) => ({
    type: "image",
    attrs: { src: token.href || "", alt: token.text || "", title: token.title || null },
  }),
  renderMarkdown: (node: any) => markdownImage(node.attrs || {}),
  addNodeView() {
    const resolve = this.options.resolve;
    return ({ node }) => {
      const dom = document.createElement("span");
      dom.className = "md-image";
      dom.contentEditable = "false";
      const img = document.createElement("img");
      img.draggable = false;
      dom.append(img);
      let current: PMNode = node;
      const load = (n: PMNode) => {
        const src = String(n.attrs.src || "");
        img.alt = n.attrs.alt || "";
        dom.title = n.attrs.title || n.attrs.alt || "";
        const show = (url: string | null) => {
          if (current.attrs.src !== src) return;
          dom.classList.toggle("missing", !url);
          dom.dataset.missing = `이미지를 찾을 수 없습니다: ${src}`;
          if (url) img.src = url;
          else img.removeAttribute("src");
        };
        if (/^(https?:|data:)/i.test(src)) show(src);
        else resolve(src).then(show, () => show(null));
      };
      load(node);
      return {
        dom,
        update(next) {
          if (next.type !== current.type) return false;
          const changed = next.attrs.src !== current.attrs.src;
          current = next;
          if (changed) load(next);
          else {
            img.alt = next.attrs.alt || "";
            dom.title = next.attrs.title || next.attrs.alt || "";
          }
          return true;
        },
      };
    };
  },
});
