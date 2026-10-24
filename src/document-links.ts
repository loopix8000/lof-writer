import { noteLinkTarget } from "./note-links";
import type { Library } from "./types";

export type DocumentLinkSource = { projectId?: string; space?: string; docPath: string };
export type DocumentLinkTarget =
  | { kind: "document"; id: string }
  | { kind: "memo"; space: string; path: string };
export type OpenDocumentLink = (
  href: string,
  quote: string,
  source: DocumentLinkSource,
) => Promise<"document" | "memo" | null>;

export const memoLinkSource = (space: string, path: string): DocumentLinkSource =>
  space === "common" ? { space, docPath: path } : { projectId: space, docPath: `doc/${path}` };

function relativeLinkPath(href: string): string | null {
  // 쿼리·앵커를 먼저 떼어 파일 이름에 인코딩된 #과 ?는 보존한다.
  try {
    const path = decodeURIComponent(href.split(/[?#]/)[0]).replace(/\\/g, "/");
    if (!path || path.startsWith("/") || /^[a-z][a-z\d+.-]*:/i.test(path) || /[\u0000-\u001f]/.test(path)) return null;
    return path;
  } catch {
    return null;
  }
}

export const isRelativeDocumentLink = (href: string) => relativeLinkPath(href) !== null;

function normalizeRelativePath(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

export function resolveDocumentLink(href: string, source: DocumentLinkSource, library: Library): DocumentLinkTarget | null {
  const id = noteLinkTarget(href);
  if (id) return library.documents.some(d => d.id === id) ? { kind: "document", id } : null;
  const relative = relativeLinkPath(href);
  if (!relative || !source.docPath) return null;
  const directory = source.docPath.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
  const path = normalizeRelativePath(`${directory}/${relative}`);
  if (!path || !/\.md$/i.test(path)) return null;
  if (source.space === "common") return { kind: "memo", space: "common", path };
  if (!source.projectId) return null;
  const pathKey = (value: string) => library.platform === "windows" ? value.toLowerCase() : value;
  const doc = library.documents.find(d => d.projectId === source.projectId
    && d.relPath && pathKey(normalizeRelativePath(d.relPath) || "") === pathKey(path));
  if (doc) return { kind: "document", id: doc.id };
  // 작품의 doc/ 안에 있는 메모는 메모 화면에서도 열 수 있다.
  if (path.startsWith("doc/")) return { kind: "memo", space: source.projectId, path: path.slice(4) };
  return null;
}
