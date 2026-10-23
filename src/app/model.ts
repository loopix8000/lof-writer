import { requiresSource } from "../../core/text.mjs";
import type { Doc, Kind, WritingRules } from "../types";

// 특정 작품에 매이지 않는 화면(서재, 전체 북마크). 이동해도 보던 작품은 그대로 둔다.
export const globalView = (view: string) => view === "library" || view === "bookmarks";
// 숨겨진 탭의 도구 막대를 준비할 때도 본문을 다시 분석하지 않는다.
const documentSourceCache = new WeakMap<Doc, { body: string; required: boolean }>();
export function cloneDocument(doc: Doc, patch: Partial<Doc> = {}): Doc {
  const next = { ...doc, ...patch }, cached = documentSourceCache.get(doc);
  if (cached && cached.body === next.body) documentSourceCache.set(next, cached);
  return next;
}
// 파일 위치·회차 순서·저장 버전이 달라져도 원고와 속성이 같으면 편집 충돌이 아니다.
const documentLocationKeys = new Set([
  "path", "relPath", "order", "revision", "fingerprint", "updatedAt", "characters", "platformCharacters",
]);
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((value, index) => sameValue(value, b[index]));
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].every(key => sameValue(left[key], right[key]));
}
export function sameDocumentContent(a: Doc, b: Doc): boolean {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter(key => !documentLocationKeys.has(key))
    .every(key => sameValue(a[key as keyof Doc], b[key as keyof Doc]));
}
export function updateDocumentLocation(doc: Doc, next: Doc): Doc {
  return cloneDocument(doc, {
    id: next.id, path: next.path, relPath: next.relPath, order: next.order,
    revision: next.revision, fingerprint: next.fingerprint, updatedAt: next.updatedAt,
  });
}
// 이동 후 목록에는 본문이 없으므로 저장 버전을 채택하지 않고 위치만 갱신한다.
export function relocateDocument(doc: Doc, next: Doc): Doc {
  return cloneDocument(doc, { id: next.id, path: next.path, relPath: next.relPath });
}
export function requiresDocumentSource(doc: Doc) {
  const cached = documentSourceCache.get(doc);
  if (cached?.body === doc.body) return cached.required;
  const required = requiresSource(doc.body);
  documentSourceCache.set(doc, { body: doc.body, required });
  return required;
}
export function editDocument(doc: Doc, patch: Partial<Doc>, markdownCopy?: boolean): Doc {
  const previousPolicy = documentSourceCache.get(doc);
  const next = cloneDocument(doc, patch);
  const required = markdownCopy ?? (patch.body === undefined ? previousPolicy?.required : undefined);
  if (required !== undefined) documentSourceCache.set(next, { body: next.body, required });
  return next;
}
export type Dialog = {
  type: string;
  kind?: Kind;
  value?: string;
  returnToSettings?: boolean;
  // 여러 문서를 한 번에 다루는 대화상자(파일 트리 다중 선택의 영구 삭제).
  ids?: string[];
  description?: string;
  tags?: string[];
  writing?: WritingRules;
  manualLineBreak?: boolean | null;
};
export type Destination = {
  // bookmarks는 서재처럼 작품에 매이지 않는 전체 북마크 화면이다.
  view: "library" | "project" | "workspace" | "bookmarks";
  projectId: string;
  documentId?: string;
  tab?: Kind;
  archive?: boolean;
  pinned?: boolean;
  linkedDocument?: boolean;
};
export type Navigation = { entries: Destination[]; index: number };
// 편집기 탭. VS Code처럼 고정되지 않은 탭(미리보기)은 다음 문서를 열 때 재사용된다.
export type EditorTab = { id: string; pinned: boolean };
export type Side = import("../split/layout").GroupId;
export function placeTab(tabs: EditorTab[], id: string, pinned: boolean, after: string) {
  const index = tabs.findIndex((t) => t.id === id);
  if (index >= 0)
    return pinned && !tabs[index].pinned
      ? tabs.map((t, i) => (i === index ? { ...t, pinned: true } : t))
      : tabs;
  const previewIndex = pinned ? -1 : tabs.findIndex((t) => !t.pinned);
  if (previewIndex >= 0)
    return tabs.map((t, i) => (i === previewIndex ? { id, pinned } : t));
  const anchor = tabs.findIndex((t) => t.id === after);
  const next = [...tabs];
  next.splice(anchor < 0 ? next.length : anchor + 1, 0, { id, pinned });
  return next;
}
export const initialNavigation = (): Navigation => ({
  entries: [{ view: "library", projectId: "" }], index: 0,
});
