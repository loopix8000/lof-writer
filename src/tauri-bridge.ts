import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AutoSyncStatus } from "./types";

const methods = [
  "countManuscript",
  "autoSyncStatus",
  "backupStorage",
  "pinStatus",
  "pinUnlock",
  "pinSave",
  "pinReady",
  "bootstrap",
  "chooseVault",
  "createProject",
  "updateProject",
  "createDocument",
  "readDocument",
  "saveDocument",
  "search",
  "searchText",
  "history",
  "historyRead",
  "deleteHistory",
  "checkpointDocument",
  "restore",
  "saveDraft",
  "clearDraft",
  "deleteDocument",
  "importFiles",
  "exportDocument",
  "copyManuscript",
  "reveal",
  "settings",
  "saveConnection",
  "connectGoogleDrive",
  "cancelGoogleDrive",
  "removeConnection",
  "sync",
  "checkSyncUpdates",
  "setSyncConflictPolicy",
  "chooseCover",
  "removeCover",
  "saveImage",
  "readImage",
  "readClipboard",
  "mcpConfig",
  "copyApi",
  "downloadSkill",
  "setPreferences",
  "setTitleBarDimmed",
  "setCompactWindow",
  "reorderDocuments",
  "reorderProjects",
  "deleteProject",
  "repair",
  "relinkDocument",
  "adoptFile",
  "forgetDocument",
  "revealFile",
  "memoSpaces",
  "memoTree",
  "memoRead",
  "memoSave",
  "memoCreate",
  "memoCreateFolder",
  "memoRename",
  "memoMove",
  "memoRemove",
  "memoReveal",
  "chooseCommonMemo",
] as const;

export function installTauriBridge() {
  if (typeof window === "undefined" || window.lof) return;

  const api: Record<string, any> = Object.fromEntries(
    methods.map((name) => [
      name,
      (args?: any) => invoke("lof_invoke", { method: name, args: args ?? {} }),
    ]),
  );

  api.onChange = (fn: () => void) => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    listen("lof:change", () => {
      if (!disposed) fn();
    }).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  };

  api.onAutoSync = (fn: (status: AutoSyncStatus) => void) => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    listen<AutoSyncStatus>("lof:auto-sync", (event) => { if (!disposed) fn(event.payload); }).then((off) => {
      if (disposed) off();
      else unlisten = off;
    });
    return () => { disposed = true; unlisten?.(); };
  };

  api.onFlush = (fn: () => Promise<void>) => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    listen("lof:flush", async () => {
      if (disposed) return;
      try {
        await fn();
        await invoke("lof_flushed", { ok: true });
      } catch {
        await invoke("lof_flushed", { ok: false });
      }
    }).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  };

  api.windowMinimize = () => invoke("window_minimize");
  api.windowToggleMaximize = () => invoke<boolean>("window_toggle_maximize");
  api.windowIsMaximized = () => invoke<boolean>("window_is_maximized");
  api.windowClose = () => invoke("window_close");
  api.windowStartDragging = () => invoke("window_start_dragging");

  window.lof = api as Window["lof"];
}
