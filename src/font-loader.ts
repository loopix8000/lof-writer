import { normalizeEditorStyle } from "../core/typesetting.mjs";

const cacheKey = "lof-writer.editor-fonts.v1";
const bundledFamilies = new Set(["RIDIBatang", "Pretendard Variable", "Noto Sans KR"]);
const loading = new Map<string, Promise<FontFace[]>>();
let rememberedFonts: string | undefined;
type FontRequest = { family: string; weight: number };

function preloadFonts(requests: FontRequest[]) {
  if (typeof document === "undefined" || !document.fonts) return;
  for (const { family, weight } of requests) {
    if (!bundledFamilies.has(family) || !Number.isFinite(weight) || weight < 100 || weight > 900) continue;
    const key = `${family}:${weight}`;
    if (loading.has(key)) continue;
    // 화면에 원고가 배치되기 전부터 선택한 글꼴의 읽기와 디코딩을 시작한다.
    const pending = document.fonts.load(`${weight} 18px "${family}"`, "가나다 Aa");
    loading.set(key, pending);
    void pending.then((faces) => {
      if (!faces.length) loading.delete(key);
    }, () => { loading.delete(key); });
  }
}

export function preloadRememberedFonts() {
  try {
    const cached = localStorage.getItem(cacheKey) || "[]";
    const requests: unknown = JSON.parse(cached);
    if (!Array.isArray(requests)) return;
    rememberedFonts = cached;
    preloadFonts(requests.slice(0, 2).filter((item): item is FontRequest =>
      !!item && typeof item.family === "string" && typeof item.weight === "number"));
  } catch { /* 캐시를 읽지 못해도 서재 설정에서 글꼴을 다시 준비한다. */ }
}

export function prepareEditorFonts(prefs: Record<string, any>) {
  const requests: FontRequest[] = [];
  for (const kind of ["episode", "document"]) {
    const style = normalizeEditorStyle(prefs, kind);
    const family = style.fontFamily.split(",")[0].trim().replace(/^["']|["']$/g, "");
    if (bundledFamilies.has(family)) requests.push({ family, weight: style.fontWeight });
  }
  preloadFonts(requests);
  const cached = JSON.stringify(requests);
  if (cached === rememberedFonts) return;
  rememberedFonts = cached;
  try {
    // 다음 실행에서 서재를 읽는 동안 미리 준비할 글꼴 이름과 굵기만 보관한다.
    localStorage.setItem(cacheKey, cached);
  } catch { /* 캐시 저장이 제한되어도 현재 글꼴은 그대로 사용한다. */ }
}
