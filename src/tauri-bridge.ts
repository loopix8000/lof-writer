import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AutoSyncStatus } from "./types";

const methods = [
  "realtimeStatus", "realtimeInvite", "realtimePair", "realtimeRemove", "realtimeSync",
  "realtimeCancelPair", "realtimeValidateCode", "realtimeClipboard", "realtimeRename",
  "realtimeRenameDevice", "realtimeLeave", "realtimeResetNotice", "realtimeDismissReset",
  "countManuscript",
  "autoSyncStatus",
  "appLifecycle",
  "backgroundNotifications",
  "gitEditing",
  "backupStorage",
  "backupGitHistory",
  "resetHistory",
  "pinStatus",
  "pinUnlock",
  "pinSave",
  "pinReady",
  "bootstrap",
  "prepareAndroidLibrary",
  "chooseVault",
  "pickVaultDestination",
  "moveVault",
  "createProject",
  "updateProject",
  "createDocument",
  "readDocument",
  "saveDocument",
  "adoptDocument",
  "saveRecoveryCopy",
  "recoveryCopies",
  "readRecoveryCopy",
  "deleteRecoveryCopy",
  "restoreRecoveryCopy",
  "finishDocumentSync",
  "adoptMemo",
  "search",
  "searchText",
  "searchDocumentIds",
  "history",
  "historyPage",
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
  "removeConnection",
  "sync",
  "requestSyncNow",
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
  "memoArchive",
  "memoArchiveFolder",
  "memoRemove",
  "memoReveal",
  "chooseCommonMemo",
  "installFontFiles",
  "systemFonts",
  "addSystemFont",
  "removeUserFont",
  "readUserFont",
  "exportLibrary",
  "exportProject",
  "openExportFolder",
] as const;

export function isAndroidApp(): boolean {
  return typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
}

// 파일 선택기처럼 앱이 연 외부 화면이 떠 있는 동안에는 백그라운드로 가도 잠그지 않는다.
// 선택기의 취소가 전달되지 않는 경우에 대비해 앱 화면으로 돌아오면 표시를 지운다.
let externalScreens = 0;
export function externalScreenOpen(): boolean {
  return externalScreens > 0;
}
if (typeof document !== "undefined")
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") externalScreens = 0;
  });
async function withExternalScreen<T>(open: () => Promise<T>): Promise<T> {
  externalScreens++;
  try {
    return await open();
  } finally {
    externalScreens = Math.max(0, externalScreens - 1);
  }
}

export function openBackgroundBatterySettings() {
  return withExternalScreen(() => invoke<{ exempt: boolean }>("android_background_battery", { open: true }));
}

async function pickAndroidImage(mimeTypes: string[]): Promise<{ name: string; data: string } | null> {
  const picked = await withExternalScreen(() =>
    invoke<{ name?: string; data?: string | null }>("android_pick_image", { mimeTypes }),
  );
  return picked?.data ? { name: picked.name || "image", data: picked.data } : null;
}

async function pickAndroidFolder(): Promise<string | null> {
  const picked = await withExternalScreen(() => invoke<{ path?: string | null }>("android_pick_folder"));
  return picked?.path || null;
}

function pickBrowserFiles(options: {
  accept: string;
  multiple?: boolean;
}): Promise<Array<{ name: string; data: string }> | null> {
  return withExternalScreen(() => new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = options.accept;
    input.multiple = Boolean(options.multiple);
    input.style.position = "fixed";
    input.style.left = "-9999px";
    input.style.opacity = "0";
    document.body.appendChild(input);

    let settled = false;
    const finish = (result: Array<{ name: string; data: string }> | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(result);
    };

    input.addEventListener("cancel", () => finish(null));
    input.addEventListener("change", async () => {
      const files = Array.from(input.files ?? []);
      if (files.length === 0) {
        finish(null);
        return;
      }
      try {
        const items = await Promise.all(
          files.map(
            (file) =>
              new Promise<{ name: string; data: string }>((res, rej) => {
                const reader = new FileReader();
                reader.onload = () => {
                  const raw = typeof reader.result === "string" ? reader.result : "";
                  const base64 = raw.includes(";base64,") ? raw.split(";base64,")[1] : raw;
                  res({ name: file.name, data: base64 });
                };
                reader.onerror = () => rej(new Error("파일을 읽을 수 없습니다."));
                reader.readAsDataURL(file);
              }),
          ),
        );
        finish(items);
      } catch {
        finish(null);
      }
    });

    input.click();
  }));
}

export function installTauriBridge() {
  if (typeof window === "undefined" || window.lof) return;

  const android = isAndroidApp();

  const api: Record<string, any> = Object.fromEntries(
    methods.map((name) => [
      name,
      async (args?: any) => {
        const payload = args ?? {};
        if (android) {
          if (name === "pickVaultDestination") {
            return { ok: true, data: await pickAndroidFolder() };
          }
          if ((name === "exportLibrary" || name === "exportProject") && !payload.path) {
            const folder = await pickAndroidFolder();
            if (!folder) return { ok: true, data: null };
            return invoke("lof_invoke", {
              method: name,
              args: { ...payload, path: folder },
            });
          }
          if ((name === "chooseVault" || name === "chooseCommonMemo") && !payload.path && !payload.internal) {
            const folder = await pickAndroidFolder();
            if (!folder) return { ok: true, data: name === "chooseVault" ? false : null };
            return invoke("lof_invoke", {
              method: name,
              args: { ...payload, path: folder },
            });
          }
          if (name === "chooseCover" && !payload.data) {
            const picked = await pickAndroidImage(["image/png", "image/jpeg", "image/webp"]);
            if (!picked) return { ok: true, data: null };
            return invoke("lof_invoke", {
              method: name,
              args: { ...payload, data: picked.data },
            });
          }
          if (name === "saveImage" && !payload.data) {
            const picked = await pickAndroidImage(["image/png", "image/jpeg", "image/gif", "image/webp"]);
            if (!picked) return { ok: true, data: null };
            return invoke("lof_invoke", {
              method: name,
              args: { ...payload, name: picked.name, data: picked.data },
            });
          }
          if (name === "importFiles" && !payload.items) {
            const picked = await pickBrowserFiles({
              accept: ".md,.txt,.mvle,text/markdown,text/plain",
              multiple: true,
            });
            if (!picked || picked.length === 0) return { ok: true, data: null };
            return invoke("lof_invoke", {
              method: name,
              args: { ...payload, items: picked },
            });
          }
          if (name === "installFontFiles" && !payload.items && !payload.paths) {
            const picked = await pickBrowserFiles({
              accept: ".ttf,.otf,.woff,.woff2,.ttc",
              multiple: true,
            });
            if (!picked || picked.length === 0) return { ok: true, data: null };
            return invoke("lof_invoke", {
              method: name,
              args: { ...payload, items: picked },
            });
          }
          if (name === "realtimeClipboard") {
            try {
              if (payload.action === "write") {
                await navigator.clipboard.writeText(String(payload.text ?? ""));
                return { ok: true, data: true };
              }
              const text = await navigator.clipboard.readText();
              if (!text) {
                return {
                  ok: false,
                  error: "클립보드에 텍스트가 없습니다. 다른 장치에서 페어링 코드를 복사해 주세요.",
                };
              }
              return { ok: true, data: text };
            } catch {
              return {
                ok: false,
                error: "클립보드 권한을 확인할 수 없습니다. 코드를 직접 붙여 넣어 주세요.",
              };
            }
          }
          if (name === "readClipboard") {
            try {
              const text = await navigator.clipboard.readText();
              return { ok: true, data: text ? { text } : {} };
            } catch {
              return { ok: true, data: {} };
            }
          }
        }

        const res: any = await invoke("lof_invoke", { method: name, args: payload });

        if (android && res?.ok) {
          if (name === "copyManuscript" && res.data?.text) {
            try {
              await navigator.clipboard.writeText(res.data.text);
            } catch {
              // ignore clipboard fallback failure
            }
          }
          if (name === "exportDocument" && res.data?.content && res.data?.fileName) {
            try {
              const blob = new Blob([res.data.content], { type: "text/markdown;charset=utf-8" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = res.data.fileName;
              document.body.appendChild(a);
              a.click();
              a.remove();
              setTimeout(() => URL.revokeObjectURL(url), 5000);
            } catch {
              // ignore download fallback failure
            }
          }
        }

        return res;
      },
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
