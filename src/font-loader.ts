import { normalizeEditorStyle, normalizeUserFonts } from "../core/typesetting.mjs";
import { call, type UserFont } from "./types";

const cacheKey = "lof-writer.editor-fonts.v1";
const styleElementId = "lof-user-fonts";
const bundledFamilies = new Set(["RIDIBatang", "Pretendard Variable", "Noto Sans KR"]);
const loading = new Map<string, Promise<FontFace[]>>();
const blobUrls = new Map<string, string>();
const blobLoading = new Map<string, Promise<string | null>>();
let rememberedFonts: string | undefined;
let lastCssText = "";

type FontRequest = { family: string; weight: number };

function cssEscapeString(value: string): string {
  return value.replace(/[\r\n"\\]/g, " ").trim();
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function ensureFontBlobUrl(fileName: string): Promise<string | null> {
  const cached = blobUrls.get(fileName);
  if (cached) return Promise.resolve(cached);
  const inflight = blobLoading.get(fileName);
  if (inflight) return inflight;
  if (typeof window === "undefined" || !window.lof?.readUserFont) {
    return Promise.resolve(null);
  }
  const task = call<{ data: string; mime: string; format: string }>("readUserFont", { file: fileName })
    .then((res) => {
      if (!res?.data) return null;
      const bytes = base64ToBytes(res.data);
      const blob = new Blob([bytes.buffer as ArrayBuffer], { type: res.mime || "font/ttf" });
      const url = URL.createObjectURL(blob);
      blobUrls.set(fileName, url);
      return url;
    })
    .catch(() => null)
    .finally(() => {
      blobLoading.delete(fileName);
    });
  blobLoading.set(fileName, task);
  return task;
}

function renderUserFontStyles(userFonts: UserFont[]) {
  if (typeof document === "undefined") return;
  const rules: string[] = [];
  for (const font of userFonts) {
    if (font.source !== "file" || !font.files?.length) continue;
    const readyFiles = font.files.filter((f) => blobUrls.has(f.file));
    if (!readyFiles.length) continue;
    const singleFile = readyFiles.length === 1;
    const names = [font.family];
    if (font.familyEn && font.familyEn.toLowerCase() !== font.family.toLowerCase()) {
      names.push(font.familyEn);
    }
    for (const familyName of names) {
      const safeFamily = cssEscapeString(familyName);
      if (!safeFamily) continue;
      for (const fileInfo of readyFiles) {
        const url = blobUrls.get(fileInfo.file);
        if (!url) continue;
        const format = cssEscapeString(fileInfo.format || "truetype");
        const weight = singleFile || fileInfo.variable
          ? "100 900"
          : String(fileInfo.weight || 400);
        const fontStyle = singleFile ? "normal" : fileInfo.italic ? "italic" : "normal";
        rules.push(
          `@font-face {\n  font-family: "${safeFamily}";\n  src: url("${url}") format("${format}");\n  font-style: ${fontStyle};\n  font-weight: ${weight};\n  font-display: swap;\n}`,
        );
      }
    }
  }
  const nextCss = rules.join("\n\n");
  if (nextCss === lastCssText) return;
  lastCssText = nextCss;
  let styleEl = document.getElementById(styleElementId) as HTMLStyleElement | null;
  if (!nextCss) {
    styleEl?.remove();
    return;
  }
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = styleElementId;
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = nextCss;
}

export async function syncUserFonts(rawUserFonts: unknown): Promise<UserFont[]> {
  const userFonts = normalizeUserFonts(rawUserFonts) as UserFont[];
  if (typeof document === "undefined") return userFonts;

  const activeFiles = new Set<string>();
  for (const font of userFonts) {
    if (font.source === "file" && font.files) {
      for (const f of font.files) activeFiles.add(f.file);
    }
  }

  for (const [file, url] of blobUrls.entries()) {
    if (!activeFiles.has(file)) {
      URL.revokeObjectURL(url);
      blobUrls.delete(file);
      loading.clear();
    }
  }

  const missingFiles = [...activeFiles].filter((file) => !blobUrls.has(file));
  if (missingFiles.length > 0) {
    await Promise.all(missingFiles.map((file) => ensureFontBlobUrl(file)));
  }
  renderUserFontStyles(userFonts);
  return userFonts;
}

function preloadFonts(requests: FontRequest[], customFamilies?: Set<string>) {
  if (typeof document === "undefined" || !document.fonts) return;
  for (const { family, weight } of requests) {
    const known = bundledFamilies.has(family) || customFamilies?.has(family);
    if (!known || !Number.isFinite(weight) || weight < 100 || weight > 900) continue;
    const key = `${family}:${weight}`;
    if (loading.has(key)) continue;
    // 화면에 원고가 배치되기 전부터 선택한 글꼴의 읽기와 디코딩을 시작한다.
    const pending = document.fonts.load(`${weight} 18px "${family}"`, "가나다 Aa");
    loading.set(key, pending);
    void pending.then(
      (faces) => {
        if (!faces.length) loading.delete(key);
      },
      () => {
        loading.delete(key);
      },
    );
  }
}

export function preloadRememberedFonts() {
  try {
    const cached = localStorage.getItem(cacheKey) || "[]";
    const requests: unknown = JSON.parse(cached);
    if (!Array.isArray(requests)) return;
    rememberedFonts = cached;
    preloadFonts(
      requests
        .slice(0, 2)
        .filter(
          (item): item is FontRequest =>
            !!item && typeof item.family === "string" && typeof item.weight === "number",
        ),
    );
  } catch {
    /* 캐시를 읽지 못해도 서재 설정에서 글꼴을 다시 준비한다. */
  }
}

export function prepareEditorFonts(prefs: Record<string, any>) {
  const userFonts = normalizeUserFonts(prefs?.userFonts) as UserFont[];
  const customFamilies = new Set(userFonts.map((f) => f.family));
  const requests: FontRequest[] = [];
  for (const kind of ["episode", "document"]) {
    const style = normalizeEditorStyle(prefs, kind);
    const family = style.fontFamily
      .split(",")[0]
      .trim()
      .replace(/^["']|["']$/g, "");
    if (bundledFamilies.has(family) || customFamilies.has(family)) {
      requests.push({ family, weight: style.fontWeight });
    }
  }
  void syncUserFonts(userFonts).then(() => {
    preloadFonts(requests, customFamilies);
  });
  const bundledRequests = requests.filter((r) => bundledFamilies.has(r.family));
  preloadFonts(bundledRequests);
  const cached = JSON.stringify(bundledRequests);
  if (cached === rememberedFonts) return;
  rememberedFonts = cached;
  try {
    // 다음 실행에서 서재를 읽는 동안 미리 준비할 글꼴 이름과 굵기만 보관한다.
    localStorage.setItem(cacheKey, cached);
  } catch {
    /* 캐시 저장이 제한되어도 현재 글꼴은 그대로 사용한다. */
  }
}
