// 퀵 노트 출처 링크: lof://doc/<문서 ID>. 문서 이름이나 파일 위치가 바뀌어도 ID로 찾아간다.
const PREFIX = "lof://doc/";
export const NOTE_LINK_PROTOCOL = "lof";

// 원고에 표시할 메모 하나: 메모 문서와, 그 메모가 인용한 원고 문장.
export type NoteMark = { id: string; title: string; text: string };

export const noteLink = (id: string) => PREFIX + encodeURIComponent(id);

export function noteLinkTarget(href: string | null | undefined): string | null {
  if (!href?.startsWith(PREFIX)) return null;
  try {
    return decodeURIComponent(href.slice(PREFIX.length).split(/[?#]/)[0]) || null;
  } catch {
    return null;
  }
}

// 메모 Markdown의 첫 인용 줄. 원고에서 이 글을 찾아 메모 위치로 삼는다.
export function firstQuote(markdown: string): string {
  const line = markdown.split(/\r\n?|\n/).find((l) => /^\s*>\s*\S/.test(l));
  return line ? line.replace(/^\s*>\s*/, "").replace(/\\(.)/g, "$1").trim() : "";
}

// 링크 글에서 Markdown 링크 문법과 겹치는 글자를 막는다.
export const escapeLinkText = (text: string) => text.replace(/[[\]\\]/g, "\\$&");
