// 조판(Typesetting) 및 원고 기호 대치 모듈.
// 1) 에디터 시각 조판 스타일 및 용지·기기·플랫폼 프리셋
// 2) 원고 기호 일괄 대치(직선 따옴표 → 곡선 따옴표, 마침표 연속 → 말줄임표)

const DEFAULT_DESKTOP_EDITOR_STYLE = {
  fontFamily: "",
  fontSize: 18,
  fontWeight: 400,
  letterSpacing: 0,
  lineHeight: 2,
  blockGap: 1.05,
  indent: 1,
  hardBreakIndent: false,
  textAlign: "left",
  editorMaxWidth: 760,
  editorPaddingX: 5,
  textareaBgColor: "",
  editorTextColor: "",
};

export const DEFAULT_EDITOR_STYLE = {
  ...DEFAULT_DESKTOP_EDITOR_STYLE,
  serifSymbols: true,
  dividerStyle: "solid",
  dividerPaddingY: 2,
  pageViewEnabled: false,
  pageViewFlow: "vertical",
};

export const FONT_FAMILY_PRESETS = [
  { id: "", label: "기본 글꼴 (시스템)", value: "" },
  {
    id: "pretendard",
    label: "고딕 (Pretendard / 맑은 고딕)",
    value: '"Pretendard Variable", Pretendard, "Malgun Gothic", "Apple SD Gothic Neo", sans-serif',
  },
  {
    id: "noto-sans",
    label: "본고딕 (Noto Sans KR)",
    value: '"Noto Sans KR", "Malgun Gothic", sans-serif',
  },
  {
    id: "kopub-batang",
    label: "바탕 (KoPubWorld바탕 / 바탕체)",
    value: '"KoPubWorldBatang", "바탕", "바탕체", Batang, Georgia, serif',
  },
  {
    id: "ridi-batang",
    label: "리디바탕 (RIDIBatang)",
    value: '"RIDIBatang", "KoPubWorldBatang", "바탕", Batang, serif',
  },
  {
    id: "batang",
    label: "바탕체 (시스템 명조)",
    value: "바탕, 바탕체, Batang, NanumMyeongjo, serif",
  },
  {
    id: "gulim",
    label: "굴림체",
    value: '"굴림", Gulim, sans-serif',
  },
];

export const WIDTH_PRESETS = [
  {
    group: "기본 및 용지",
    items: [
      { id: "compact-600", label: "집중형 좁은 폭 (600px)", width: 600 },
      { id: "lof", label: "기본 (760px)", width: 760 },
      { id: "a5", label: "A5 인쇄용지 (559px)", width: 559 },
      { id: "b5", label: "B5 신국판/JIS (688px)", width: 688 },
      { id: "a4", label: "A4 인쇄용지 (794px)", width: 794 },
      { id: "letter", label: "Letter (816px)", width: 816 },
      { id: "a3", label: "A3 인쇄용지 (1123px)", width: 1123 },
    ],
  },
  {
    group: "모바일 기기",
    items: [
      { id: "iphone-13-mini", label: "iPhone 13 mini / Galaxy S8+ (360px)", width: 360 },
      { id: "iphone-14", label: "iPhone 14 (390px)", width: 390 },
      { id: "pixel-8", label: "Pixel 8 / Galaxy S20 Ultra (412px)", width: 412 },
      { id: "iphone-15-pro-max", label: "iPhone 15 Pro Max (430px)", width: 430 },
    ],
  },
  {
    group: "태블릿 기기",
    items: [
      { id: "galaxy-tab-s4", label: "Galaxy Tab S4 (712px)", width: 712 },
      { id: "ipad-mini", label: "iPad mini (744px)", width: 744 },
      { id: "ipad-air-11", label: "iPad Air 11 (820px)", width: 820 },
      { id: "ipad-pro-11", label: "iPad Pro 11 (834px)", width: 834 },
      { id: "ipad-pro-13", label: "iPad Pro 13 (1032px)", width: 1032 },
    ],
  },
];

// 플랫폼 및 환경별 조판 스타일 프리셋
export const PLATFORM_STYLE_PRESETS = [
  {
    id: "lof-default",
    name: "기본",
    environment: "데스크톱",
    description: "기본 집필 조판 (폭 760px · 줄간격 2.0 · 들여쓰기 1em)",
    style: {
      ...DEFAULT_DESKTOP_EDITOR_STYLE,
    },
  },
  {
    id: "lof-compact",
    name: "집중형",
    environment: "데스크톱",
    description: "좁은 단폭 집필 조판 (폭 600px · 줄간격 1.8 · 들여쓰기 1em)",
    style: {
      fontFamily: '"Pretendard Variable", Pretendard, "Malgun Gothic", sans-serif',
      fontSize: 18,
      fontWeight: 400,
      letterSpacing: 0,
      lineHeight: 1.8,
      blockGap: 0.9,
      indent: 1,
      hardBreakIndent: false,
      textAlign: "left",
      editorMaxWidth: 600,
      editorPaddingX: 5,
      textareaBgColor: "",
      editorTextColor: "",
    },
  },
  {
    id: "lof-mobile",
    name: "모바일",
    environment: "모바일",
    description: "모바일 화면 폭 기준 조판 (폭 460px · 줄간격 1.8 · 들여쓰기 1em)",
    style: {
      fontFamily: '"Pretendard Variable", Pretendard, "Malgun Gothic", sans-serif',
      fontSize: 18,
      fontWeight: 400,
      letterSpacing: 0,
      lineHeight: 1.8,
      blockGap: 0.9,
      indent: 1,
      hardBreakIndent: false,
      textAlign: "left",
      editorMaxWidth: 460,
      editorPaddingX: 5,
      textareaBgColor: "",
      editorTextColor: "",
    },
  },
  {
    id: "notepad",
    name: "메모장",
    environment: "일반 문서 기본",
    description: "들여쓰기·단락 여백·자동 줄바꿈 없는 노트 조판 (폭 920px · 줄간격 1.65)",
    style: {
      fontFamily: "",
      fontSize: 16,
      fontWeight: 400,
      letterSpacing: 0,
      lineHeight: 1.65,
      blockGap: 0,
      indent: 0,
      hardBreakIndent: false,
      textAlign: "left",
      editorMaxWidth: 920,
      editorPaddingX: 2,
      textareaBgColor: "",
      editorTextColor: "",
      serifSymbols: false,
      pageViewEnabled: false,
    },
  },
  {
    id: "munpia-desktop",
    name: "문피아",
    environment: "데스크톱",
    description: "바탕체 · 들여쓰기 1em · 청록 원고지 배경 · 폭 450px",
    style: {
      fontFamily: "바탕, 바탕체, Batang, serif",
      fontSize: 18,
      fontWeight: 400,
      letterSpacing: 0,
      lineHeight: 2,
      blockGap: 0.9,
      indent: 1,
      hardBreakIndent: false,
      textAlign: "left",
      editorMaxWidth: 450,
      editorPaddingX: 5,
      textareaBgColor: "#e3efee",
      editorTextColor: "#000000",
    },
  },
  {
    id: "novelpia-desktop",
    name: "노벨피아",
    environment: "데스크톱",
    description: "노벨피아 PC 뷰어 폭 기준 (폭 930px · 들여쓰기 1em)",
    style: {
      fontFamily: '"Noto Sans KR", "Pretendard Variable", "Malgun Gothic", sans-serif',
      fontSize: 18,
      fontWeight: 400,
      letterSpacing: 0,
      lineHeight: 1.8,
      blockGap: 0.9,
      indent: 1,
      hardBreakIndent: false,
      textAlign: "left",
      editorMaxWidth: 930,
      editorPaddingX: 5,
      textareaBgColor: "",
      editorTextColor: "",
    },
  },
  {
    id: "novelpia-mobile",
    name: "노벨피아",
    environment: "모바일",
    description: "노벨피아 모바일 뷰어 기준 (폭 460px · 줄간격 2.0 · 들여쓰기 1em)",
    style: {
      fontFamily: '"Noto Sans KR", "Pretendard Variable", "Malgun Gothic", sans-serif',
      fontSize: 18,
      fontWeight: 400,
      letterSpacing: 0,
      lineHeight: 2,
      blockGap: 0.9,
      indent: 1,
      hardBreakIndent: false,
      textAlign: "left",
      editorMaxWidth: 460,
      editorPaddingX: 5,
      textareaBgColor: "",
      editorTextColor: "",
    },
  },
  {
    id: "kakaopage-desktop",
    name: "카카오페이지",
    environment: "데스크톱",
    description: "KoPubWorld바탕 · 세련된 좁은 단폭 (폭 400px · 줄간격 2.0)",
    style: {
      fontFamily: '"KoPubWorldBatang", "바탕", Batang, serif',
      fontSize: 18,
      fontWeight: 300,
      letterSpacing: 0,
      lineHeight: 2,
      blockGap: 0.9,
      indent: 0,
      hardBreakIndent: false,
      textAlign: "left",
      editorMaxWidth: 400,
      editorPaddingX: 5,
      textareaBgColor: "",
      editorTextColor: "",
    },
  },
  {
    id: "joara-desktop",
    name: "조아라",
    environment: "데스크톱",
    description: "연녹색 뷰어 배경 · 16px · 줄간격 2.0 · 폭 930px",
    style: {
      fontFamily: '"Pretendard Variable", "Malgun Gothic", sans-serif',
      fontSize: 16,
      fontWeight: 400,
      letterSpacing: 0,
      lineHeight: 2,
      blockGap: 0.9,
      indent: 0,
      hardBreakIndent: false,
      textAlign: "left",
      editorMaxWidth: 930,
      editorPaddingX: 5,
      textareaBgColor: "#c3dda8",
      editorTextColor: "#343434",
    },
  },
  {
    id: "naver-series-desktop",
    name: "네이버 시리즈",
    environment: "데스크톱",
    description: "굴림 14px · 들여쓰기 1em · 폭 420px",
    style: {
      fontFamily: '"굴림", Gulim, sans-serif',
      fontSize: 14,
      fontWeight: 400,
      letterSpacing: 0,
      lineHeight: 1.8,
      blockGap: 0.9,
      indent: 1,
      hardBreakIndent: false,
      textAlign: "left",
      editorMaxWidth: 420,
      editorPaddingX: 5,
      textareaBgColor: "",
      editorTextColor: "",
    },
  },
];

export const DIVIDER_STYLES = [
  { id: "solid", label: "긴 구분선", description: "단락 전체 너비의 기본 실선" },
  { id: "short", label: "짧은 구분선", description: "가운데 정렬된 짧은 실선" },
  { id: "ornament", label: "장식 구분선", description: "선 가운데에 별표 장식 배치" },
  { id: "stars", label: "3-별표 장식 (⁂)", description: "선 없이 가운데 3-별표 문양만 표시" },
];

export const DEFAULT_NOTE_EDITOR_STYLE = {
  fontFamily: "",
  fontSize: 16,
  fontWeight: 400,
  letterSpacing: 0,
  lineHeight: 1.65,
  blockGap: 0,
  indent: 0,
  hardBreakIndent: false,
  textAlign: "left",
  editorMaxWidth: 920,
  editorPaddingX: 2,
  textareaBgColor: "",
  editorTextColor: "",
  serifSymbols: false,
  dividerStyle: "solid",
  dividerPaddingY: 1,
  pageViewEnabled: false,
  pageViewFlow: "vertical",
};

export const TYPESETTING_KINDS = [
  {
    id: "episode",
    label: "에피소드 원고",
    shortLabel: "에피소드",
    description: "연재·단행본 본문 회차 원고의 조판 형식",
  },
  {
    id: "document",
    label: "일반 문서",
    shortLabel: "일반 문서",
    description: "플롯·메모 등 들여쓰기·자동 줄바꿈이 없는 메모장 조판",
  },
];

const isNoteKindId = (kind) => kind === "plot" || kind === "memo" || kind === "document";

export function resolveKindPrefs(prefs = {}, kind = "episode") {
  const base = prefs && typeof prefs === "object" ? prefs : {};
  const isNote = isNoteKindId(kind);
  const allByKind =
    base.typesettingByKind && typeof base.typesettingByKind === "object"
      ? base.typesettingByKind
      : {};
  const byKind = isNote
    ? (allByKind.document && typeof allByKind.document === "object"
        ? allByKind.document
        : allByKind.plot && typeof allByKind.plot === "object"
          ? allByKind.plot
          : allByKind.memo && typeof allByKind.memo === "object"
            ? allByKind.memo
            : null)
    : allByKind.episode && typeof allByKind.episode === "object"
      ? allByKind.episode
      : null;
  if (isNote) {
    const noteDefaults = DEFAULT_NOTE_EDITOR_STYLE;
    return { ...noteDefaults, ...byKind };
  }
  const episodeDefaults = DEFAULT_EDITOR_STYLE;
  return byKind ? { ...episodeDefaults, ...base, ...byKind } : { ...episodeDefaults, ...base };
}

const clampNum = (val, min, max, fallback) => {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

export function normalizeEditorStyle(prefs = {}, kind) {
  const isNoteKind = isNoteKindId(kind);
  const def = isNoteKind ? DEFAULT_NOTE_EDITOR_STYLE : DEFAULT_EDITOR_STYLE;
  const target = kind ? resolveKindPrefs(prefs, kind) : prefs || {};
  return {
    fontFamily: typeof target.fontFamily === "string" ? target.fontFamily : def.fontFamily,
    fontSize: clampNum(target.fontSize, 6, 64, def.fontSize),
    fontWeight: clampNum(target.fontWeight, 100, 900, def.fontWeight),
    letterSpacing: Math.round(clampNum(target.letterSpacing, -0.1, 0.5, def.letterSpacing) * 100) / 100,
    lineHeight: Math.round(clampNum(target.lineHeight, 1.0, 2.5, def.lineHeight) * 100) / 100,
    blockGap: Math.round(clampNum(target.blockGap, 0, 3, def.blockGap) * 100) / 100,
    indent: Math.round(clampNum(target.indent, 0, 2, def.indent) * 10) / 10,
    hardBreakIndent: target.hardBreakIndent === true,
    textAlign: ["left", "center", "right", "justify"].includes(target.textAlign)
      ? target.textAlign
      : def.textAlign,
    editorMaxWidth: Math.round(clampNum(target.editorMaxWidth, 350, 3000, def.editorMaxWidth)),
    editorPaddingX: Math.round(clampNum(target.editorPaddingX, 0, 10, def.editorPaddingX)),
    textareaBgColor: typeof target.textareaBgColor === "string" ? target.textareaBgColor.trim() : "",
    editorTextColor: typeof target.editorTextColor === "string" ? target.editorTextColor.trim() : "",
    serifSymbols:
      typeof target.serifSymbols === "boolean" ? target.serifSymbols : def.serifSymbols,
    dividerStyle: ["solid", "short", "ornament", "stars"].includes(target.dividerStyle)
      ? target.dividerStyle
      : def.dividerStyle,
    dividerPaddingY: Math.round(clampNum(target.dividerPaddingY, 0, 4, def.dividerPaddingY) * 100) / 100,
    pageViewEnabled: target.pageViewEnabled === true,
    pageViewFlow: ["vertical", "responsive"].includes(target.pageViewFlow) ? target.pageViewFlow : "vertical",
  };
}

// 원고 기호 일괄 대치 기능
// 직선 따옴표(" ')를 곡선 따옴표(“ ” ‘ ’)로, 점 세 개(...)를 지정한 대치어로 일괄 변환한다.
export function replaceManuscriptSymbols(markdown, options = {}) {
  const {
    doubleQuotes = true,
    singleQuotes = true,
    ellipsis = true,
    ellipsisChar = "…",
    emDash = false,
  } = options;

  let count = 0;
  const source = String(markdown || "");

  // 코드 블록이나 인라인 코드는 건드리지 않도록 라인 단위로 처리한다.
  let inFence = null;
  const lines = source.split("\n");
  const transformed = lines.map((line) => {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (!inFence) inFence = fenceMatch[1];
      else if (fenceMatch[1][0] === inFence[0] && fenceMatch[1].length >= inFence.length) inFence = null;
      return line;
    }
    if (inFence) return line;

    let next = line;
    if (doubleQuotes) {
      next = next.replace(/(^|[\s(\[{「『《〈—\-])"/g, (_, pre) => {
        count++;
        return `${pre}“`;
      });
      next = next.replace(/"/g, () => {
        count++;
        return "”";
      });
    }
    if (singleQuotes) {
      next = next.replace(/(^|[\s(\[{“"「『《〈—\-])'/g, (_, pre) => {
        count++;
        return `${pre}‘`;
      });
      next = next.replace(/'/g, () => {
        count++;
        return "’";
      });
    }
    if (ellipsis) {
      next = next.replace(/\.{3}/g, () => {
        count++;
        return ellipsisChar;
      });
    }
    if (emDash) {
      next = next.replace(/--+/g, () => {
        count++;
        return "—";
      });
    }
    return next;
  });

  return {
    body: transformed.join("\n"),
    count,
  };
}
