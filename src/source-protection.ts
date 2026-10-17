import type { Node as PMNode } from "@tiptap/pm/model";

// 편집기에 이미 있는 구조를 검사한다. 바뀌지 않은 블록의 결과는 다음 입력에서도 재사용한다.
const requirements = new WeakMap<PMNode, boolean>();
export function needsMarkdownCopy(node: PMNode): boolean {
  const cached = requirements.get(node);
  if (cached !== undefined) return cached;
  let required = ["table", "image"].includes(node.type.name) || node.marks.some(mark => mark.type.name === "link");
  if (!required) node.forEach(child => { if (!required) required = needsMarkdownCopy(child); });
  requirements.set(node, required);
  return required;
}
