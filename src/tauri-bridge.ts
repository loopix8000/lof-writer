import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AutoSyncStatus } from "./types";

const methods = [
  "realtimeStatus", "realtimeInvite", "realtimePair", "realtimeRemove", "realtimeSync",
  "realtimeCancelPair", "realtimeValidateCode", "realtimeClipboard", "realtimeRename",
  "realtimeLeave", "realtimeResetNotice", "realtimeDismissReset",
  "countManuscript",
  "autoSyncStatus",
  "appLifecycle",
  "gitEditing",
  "backupStorage",
  "backupGitHistory",
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

function pickAndroidFolderModal(options: {
  title: string;
  description: string;
  defaultFolder: string;
  placeholder: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.style.cssText =
      "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:18px;";
    const card = document.createElement("div");
    card.style.cssText =
      "width:100%;max-width:380px;background:var(--surface,#fff);color:var(--text,#111);border:1px solid var(--border,#ddd);border-radius:16px;padding:18px;box-shadow:0 12px 36px rgba(0,0,0,0.25);display:flex;flex-direction:column;gap:12px;";
    const h3 = document.createElement("h3");
    h3.textContent = options.title;
    h3.style.cssText = "margin:0;font-size:16px;font-weight:700;";
    const p = document.createElement("p");
    p.textContent = options.description;
    p.style.cssText = "margin:0;font-size:13px;line-height:1.5;color:var(--muted,#666);";
    const input = document.createElement("input");
    input.type = "text";
    input.value = options.defaultFolder;
    input.placeholder = options.placeholder;
    input.style.cssText =
      "width:100%;min-height:42px;padding:0 12px;border-radius:10px;border:1px solid var(--border,#ccc);background:var(--bg,#f8f9fa);color:var(--text,#111);font-size:14px;box-sizing:border-box;";
    const presetRow = document.createElement("div");
    presetRow.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;";
    const presets =
      options.defaultFolder === "CommonMemo"
        ? [
            { label: "기본 공용 메모 (CommonMemo)", value: "CommonMemo" },
            { label: "보조 공용 메모 (CommonMemo2)", value: "CommonMemo2" },
          ]
        : [
            { label: "기본 서재 (LofWriter)", value: "LofWriter" },
            { label: "제2 서재 (LofWriter2)", value: "LofWriter2" },
          ];
    for (const preset of presets) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.textContent = preset.label;
      chip.style.cssText =
        "padding:6px 10px;border-radius:8px;border:1px solid var(--border,#ccc);background:var(--sidebar,#f1f3f5);color:var(--text,#111);font-size:12px;font-weight:600;";
      chip.onclick = () => {
        input.value = preset.value;
        input.focus();
      };
      presetRow.appendChild(chip);
    }
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:4px;";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "취소";
    cancelBtn.style.cssText =
      "min-height:40px;padding:0 14px;border-radius:10px;border:1px solid var(--border,#ccc);background:transparent;color:var(--text,#111);font-size:13.5px;font-weight:600;";
    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.textContent = "변경";
    okBtn.style.cssText =
      "min-height:40px;padding:0 16px;border-radius:10px;border:none;background:var(--accent,#2563eb);color:#fff;font-size:13.5px;font-weight:600;";

    let done = false;
    const finish = (val: string | null) => {
      if (done) return;
      done = true;
      backdrop.remove();
      resolve(val);
    };
    cancelBtn.onclick = () => finish(null);
    okBtn.onclick = () => {
      const trimmed = input.value.trim();
      finish(trimmed || null);
    };
    backdrop.onclick = (e) => {
      if (e.target === backdrop) finish(null);
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        okBtn.click();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelBtn.click();
      }
    };
    actions.append(cancelBtn, okBtn);
    card.append(h3, p, presetRow, input, actions);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
    setTimeout(() => input.focus(), 30);
  });
}

function pickBrowserFiles(options: {
  accept: string;
  multiple?: boolean;
}): Promise<Array<{ name: string; data: string }> | null> {
  return new Promise((resolve) => {
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
  });
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
          if (name === "chooseVault" && !payload.path) {
            const folder = await pickAndroidFolderModal({
              title: "서재 폴더 변경",
              description: "사용할 서재 이름을 입력하거나 기본 서재를 선택하세요. 새 이름을 입력하면 새 서재가 생성됩니다.",
              defaultFolder: "LofWriter",
              placeholder: "서재 이름 (예: LofWriter, 내 소설 서재)",
            });
            if (!folder) return { ok: true, data: false };
            return invoke("lof_invoke", {
              method: name,
              args: { ...payload, path: folder },
            });
          }
          if (name === "chooseCommonMemo" && !payload.path) {
            const folder = await pickAndroidFolderModal({
              title: "공용 메모 폴더 변경",
              description: "공용 메모를 보관할 폴더 이름을 입력하거나 선택하세요.",
              defaultFolder: "CommonMemo",
              placeholder: "폴더 이름 (예: CommonMemo)",
            });
            if (!folder) return { ok: true, data: null };
            return invoke("lof_invoke", {
              method: name,
              args: { ...payload, path: folder },
            });
          }
          if (name === "chooseCover" && !payload.data) {
            const picked = await pickBrowserFiles({
              accept: "image/png,image/jpeg,image/webp",
              multiple: false,
            });
            if (!picked || picked.length === 0) return { ok: true, data: null };
            return invoke("lof_invoke", {
              method: name,
              args: { ...payload, data: picked[0].data },
            });
          }
          if (name === "saveImage" && !payload.data) {
            const picked = await pickBrowserFiles({
              accept: "image/png,image/jpeg,image/gif,image/webp",
              multiple: false,
            });
            if (!picked || picked.length === 0) return { ok: true, data: null };
            return invoke("lof_invoke", {
              method: name,
              args: { ...payload, name: picked[0].name, data: picked[0].data },
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
