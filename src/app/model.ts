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
};
export type Navigation = { entries: Destination[]; index: number };
// 편집기 탭. VS Code처럼 고정되지 않은 탭(미리보기)은 다음 문서를 열 때 재사용된다.
export type EditorTab = { id: string; pinned: boolean };
export type EditorGroup = { tabs: EditorTab[]; docId: string };
export type Side = "left" | "right";
export function withoutTab(group: EditorGroup | null, id: string): EditorGroup | null {
  if (!group) return group;
  const index = group.tabs.findIndex((t) => t.id === id);
  if (index < 0) return group;
  const tabs = group.tabs.filter((t) => t.id !== id);
  if (!tabs.length) return null;
  const docId =
    group.docId === id ? (tabs[index] || tabs[index - 1]).id : group.docId;
  return { tabs, docId };
}
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
