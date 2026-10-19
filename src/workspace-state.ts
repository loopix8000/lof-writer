import { call } from "./types";

type WorkspaceState = { layout?: unknown; scroll?: Record<string, unknown> };
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

export function saveWorkspaceState(key: string, patch: WorkspaceState) {
  if (!initialized || !key) return;
  if (Object.entries(patch).every(([field, value]) => JSON.stringify(states[key]?.[field as keyof WorkspaceState]) === JSON.stringify(value))) return;
  states = { ...states, [key]: { ...states[key], ...patch } };
  revision++;
  clearTimeout(timer);
  // 스크롤 중 디스크에 매번 쓰지 않고, 마지막 변경을 모아 저장한다.
  timer = setTimeout(() => { void flushWorkspaceState().catch(reportError); }, 500);
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
