import { useRef, useState } from "react";
import { DEFAULT_EDITOR_STYLE } from "../../core/typesetting.mjs";
import { call, type Kind } from "../types";
import { prepareEditorFonts } from "../font-loader";

export function usePreferences() {
  const [prefs, setPrefs] = useState<Record<string, any>>({
    ...DEFAULT_EDITOR_STYLE,
    goal: 3000,
    theme: "light",
    colorTheme: "modern",
    copyWithBlankLines: false,
    hideCovers: false,
    libraryProjectOpenTarget: "workspace",
    autoCloseQuotes: true,
    autoCloseBrackets: true,
    smartBrackets: true,
    autoSymbolReplacement: true,
    autoDividerReplacement: true,
    quoteStyle: "straight",
    historyMaxMinutes: 1,
    historyMinChars: 200,
    historyKeepCount: 100,
    historyKeepDays: 30,
  });
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  async function savePrefs(p: Record<string, any>) {
    let payload = p;
    if (
      !p.typesettingByKind &&
      (p.fontSize !== undefined || p.lineHeight !== undefined) &&
      prefsRef.current.typesettingByKind?.episode
    ) {
      const epSync: Record<string, any> = {};
      if (p.fontSize !== undefined) epSync.fontSize = p.fontSize;
      if (p.lineHeight !== undefined) epSync.lineHeight = p.lineHeight;
      payload = {
        ...p,
        typesettingByKind: {
          ...prefsRef.current.typesettingByKind,
          episode: {
            ...prefsRef.current.typesettingByKind.episode,
            ...epSync,
          },
        },
      };
    }
    const persistFirst = "launchAtStartup" in payload || "startInTray" in payload;
    if (persistFirst) await call("setPreferences", payload);
    const next = { ...prefsRef.current, ...payload };
    prefsRef.current = next;
    prepareEditorFonts(next);
    setPrefs((old) => ({ ...old, ...payload }));
    if (!persistFirst) await call("setPreferences", payload);
  }
  async function saveKindPrefs(kind: Kind | "document", patch: Record<string, any>) {
    const targetKey = kind === "episode" ? "episode" : "document";
    const currentByKind =
      prefsRef.current.typesettingByKind && typeof prefsRef.current.typesettingByKind === "object"
        ? prefsRef.current.typesettingByKind
        : {};
    const prevForKind =
      targetKey === "document"
        ? currentByKind.document && typeof currentByKind.document === "object"
          ? currentByKind.document
          : currentByKind.plot && typeof currentByKind.plot === "object"
            ? currentByKind.plot
            : currentByKind.memo && typeof currentByKind.memo === "object"
              ? currentByKind.memo
              : {}
        : currentByKind.episode && typeof currentByKind.episode === "object"
          ? currentByKind.episode
          : {};
    const nextByKind = {
      ...currentByKind,
      [targetKey]: {
        ...prevForKind,
        ...patch,
      },
    };
    const fullPatch: Record<string, any> =
      targetKey === "episode"
        ? { ...patch, typesettingByKind: nextByKind }
        : { typesettingByKind: nextByKind };
    await savePrefs(fullPatch);
  }

  return { prefs, setPrefs, prefsRef, savePrefs, saveKindPrefs };
}
