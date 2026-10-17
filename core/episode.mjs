// 회차의 상태·유형·속성. 값은 뮤블(Muvel)의 에피소드와 같은 키와 값을 쓴다.
// 뮤블에서 넘어온 사용자가 같은 이름과 선택지를 그대로 보도록 화면 문구도 여기에 둔다.

// 상태: 집필 중 → 퇴고 중 → 집필 완료(원고 보호: 제목과 본문을 고칠 수 없다).
export const STATUSES = ["in_progress", "revision", "completed"];
export const STATUS_LABELS = {
  in_progress: "집필 중",
  revision: "퇴고 중",
  completed: "집필 완료",
};
export const STATUS_SHORT = { in_progress: "진행", revision: "퇴고", completed: "완료" };
// 예전 상태. lof의 초안·진행·완료와, 없앤 집필 예정(planned)은 집필 중으로 본다. 상태가 없던 회차도 집필 중이다.
export const LEGACY_STATUSES = ["planned", "초안", "진행", "완료"];
const LEGACY_STATUS = { planned: "in_progress", 초안: "in_progress", 진행: "in_progress", 완료: "completed" };
export const normalizeStatus = (s) =>
  STATUSES.includes(s) ? s : (LEGACY_STATUS[s] ?? "in_progress");
// 동기화 지문에 넣는 상태 값. 예전 값과 뜻이 같으면 예전 글자를 그대로 써서 지문이 바뀌지 않게 한다.
const STATUS_TOKEN = { in_progress: "초안", completed: "완료" };
export const statusToken = (s) => {
  const v = normalizeStatus(s);
  return STATUS_TOKEN[v] ?? v;
};

// 유형: 뮤블의 episodeType 숫자. 1(플롯 캔버스)과 5(메모)는 뮤블에서도 고를 수 없고 표시만 한다.
export const EPISODE_TYPES = [0, 1, 2, 3, 4, 5, 6];
export const TYPE_CHOICES = [0, 2, 3, 4, 6];
export const TYPE_LABELS = {
  0: "일반 에피소드",
  1: "플롯 캔버스",
  2: "프롤로그",
  3: "에필로그",
  4: "특별편",
  5: "메모",
  6: "단편",
};
export const TYPE_ACTIONS = {
  0: "일반 에피소드로 지정",
  2: "프롤로그로 지정",
  3: "에필로그로 지정",
  4: "특별편으로 지정",
  6: "단편으로 지정",
};
export const normalizeType = (t) => {
  const n = typeof t === "string" ? Number.parseInt(t, 10) : t;
  return EPISODE_TYPES.includes(n) ? n : 0;
};

// 회차 속성의 기본값과 정규화.
const text = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
export const META_FIELDS = [
  "episodeType",
  "description",
  "authorComment",
  "tags",
  "manualLineBreak",
];
export function normalizeMeta(e) {
  const tags = Array.isArray(e?.tags)
    ? [...new Set(e.tags.filter((t) => typeof t === "string").map((t) => t.trim().slice(0, 40)).filter(Boolean))].slice(0, 30)
    : [];
  return {
    episodeType: normalizeType(e?.episodeType),
    description: text(e?.description, 2000),
    authorComment: text(e?.authorComment, 10000),
    tags,
    // 줄바꿈 관리 방식. false 자동 관리(Enter 단락·Shift+Enter 단락 안 줄바꿈), true 수동 관리(Enter 줄바꿈).
    manualLineBreak: e?.manualLineBreak === true,
  };
}
const isDefault = (k, v) =>
  v === null || v === "" || v === false || (k === "episodeType" && v === 0) || (Array.isArray(v) && !v.length);
// 동기화와 변경 지문에 사용할 기본값이 아닌 속성만 남긴다.
export function storedMeta(e) {
  const m = normalizeMeta(e);
  return Object.fromEntries(META_FIELDS.filter((k) => !isDefault(k, m[k])).map((k) => [k, m[k]]));
}
// 이전 문서의 전용 속성 값도 일반 사용자 속성으로 넘긴다.
export function customProperties(e) {
  return {
    ...Object.fromEntries(["contentRestrictionLevel", "pointOfView"]
      .filter((key) => e?.[key] != null).map((key) => [key, e[key]])),
    ...(e?.properties || {}),
  };
}
// 플롯·메모는 회차 유형과 분리하고 태그·줄바꿈만 공유한다.
export const DOCUMENT_META_FIELDS = ["tags", "manualLineBreak"];
export function normalizeDocumentMeta(e) {
  const m = normalizeMeta(e);
  return Object.fromEntries(DOCUMENT_META_FIELDS.map((k) => [k, m[k]]));
}
export function storedDocumentMeta(e) {
  const m = normalizeDocumentMeta(e);
  return Object.fromEntries(DOCUMENT_META_FIELDS.filter((k) => !isDefault(k, m[k])).map((k) => [k, m[k]]));
}
// 패치 값이 올바른지 확인하고 정리한다. 잘못된 값이면 메시지를 돌려준다.
export function checkMetaPatch(k, v) {
  if (k === "episodeType") return EPISODE_TYPES.includes(v) ? null : "잘못된 유형";
  if (k === "description" || k === "authorComment")
    return typeof v === "string" ? null : "속성 값은 문자열이어야 합니다.";
  if (k === "tags")
    return Array.isArray(v) && v.every((t) => typeof t === "string") ? null : "태그는 문자열 목록이어야 합니다.";
  if (k === "manualLineBreak") return typeof v === "boolean" ? null : "줄바꿈 방식은 true나 false여야 합니다.";
  return null;
}

// 줄바꿈 방식 이름(뮤블과 같은 이름).
export const lineBreakLabel = (manual) => (manual ? "수동 관리" : "자동 관리");
// 새 회차의 줄바꿈 방식: 작품 설정이 있으면 그것, 없으면 공통 설정의 기본값.
export const lineBreakDefault = (project, common) =>
  typeof project?.manualLineBreak === "boolean" ? project.manualLineBreak : common === true;

// 목록과 원고 머리에 쓰는 번호: 일반 에피소드는 순번(001), 나머지는 유형 이름(프롤로그 등).
// 뮤블처럼 프롤로그·외전은 일반 에피소드 번호를 차지하지 않는다.
export function episodeNumbers(episodes) {
  const out = new Map();
  let n = 0;
  for (const d of episodes) {
    const t = normalizeType(d.episodeType);
    out.set(d.id, t === 0 ? String(++n).padStart(3, "0") : TYPE_LABELS[t]);
  }
  return out;
}
