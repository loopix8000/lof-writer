import { call } from "./types";

export type EditorSelection = { anchor: number; head: number };
export type EditorSession = { scope: string; documentId: string };
type SelectionMode = "rich" | "source";
type WorkspaceState = {
  layout?: unknown;
  scroll?: Record<string, unknown>;
  selections?: Record<string, Partial<Record<SelectionMode, EditorSelection>>>;
  mobileEpisodeGroups?: Partial<Record<"current" | "archive", Record<string, boolean>>>;
};
let states: Record<string, WorkspaceState> = {};
let initialized = false;
let revision = 0, saved = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let saving: Promise<void> | null = null;
let reportError: (error: unknown) => void = () => {};

export function initializeWorkspaceState(value: unknown, report: (error: unknown) => void) {
  reportError = report;
  if (initialized) return;
  initialized = true;
  if (value && typeof value === "object" && !Array.isArray(value)) states = value as typeof states;
}

export function workspaceKey(root: string, project: string) {
  return JSON.stringify([root, project]);
}

export function readWorkspaceState(key: string): WorkspaceState {
  return states[key] ?? {};
}

export function readEditorSelection(session: EditorSession | undefined, mode: SelectionMode, length: number): EditorSelection | undefined {
  const value = session && readWorkspaceState(session.scope).selections?.[session.documentId]?.[mode];
  if (!value || !Number.isSafeInteger(value.anchor) || !Number.isSafeInteger(value.head) || value.anchor < 0 || value.head < 0) return;
  return { anchor: Math.min(value.anchor, length), head: Math.min(value.head, length) };
}

export function saveEditorSelection(session: EditorSession | undefined, mode: SelectionMode, selection: EditorSelection) {
  if (!session) return;
  const selections = readWorkspaceState(session.scope).selections ?? {};
  const previous = selections[session.documentId];
  if (previous?.[mode]?.anchor === selection.anchor && previous[mode]?.head === selection.head) return;
  saveWorkspaceState(session.scope, { selections: { ...selections, [session.documentId]: { ...previous, [mode]: selection } } });
}

export function saveWorkspaceState(key: string, patch: WorkspaceState) {
  if (!initialized || !key) return;
  if (Object.entries(patch).every(([field, value]) => JSON.stringify(states[key]?.[field as keyof WorkspaceState]) === JSON.stringify(value))) return;
  states = { ...states, [key]: { ...states[key], ...patch } };
  revision++;
  clearTimeout(timer);
  // 스크롤 중 디스크에 매번 쓰지 않고, 마지막 변경을 모아 저장한다.
  timer = setTimeout(() => { void flushWorkspaceState().catch(reportError); }, 500);
}

// 그룹을 옮겨도 탭별 읽던 위치는 새 위치로 함께 가져간다. 원래 그룹의 기록도 유지한다.
export function copyWorkspaceScroll(scope: string, from: string, to: string, ids: string[]) {
  if (from === to) return;
  const scroll = { ...readWorkspaceState(scope).scroll };
  for (const id of ids) {
    const position = scroll[`${from}\n${id}`];
    if (position) scroll[`${to}\n${id}`] = position;
    else delete scroll[`${to}\n${id}`];
  }
  saveWorkspaceState(scope, { scroll });
}

export async function flushWorkspaceState(): Promise<void> {
  clearTimeout(timer);
  if (saving) { await saving; return flushWorkspaceState(); }
  if (saved === revision) return;
  const current = revision, snapshot = states;
  saving = call("setPreferences", { workspaceSessions: snapshot }).then(() => { saved = current; });
  try { await saving; } finally { saving = null; }
  if (saved !== revision) await flushWorkspaceState();
}
