// 회차의 상태·유형·속성. 값은 뮤블(Muvel)의 에피소드와 같은 키와 값을 쓴다.
// 뮤블에서 넘어온 사용자가 같은 이름과 선택지를 그대로 보도록 화면 문구도 여기에 둔다.

// 상태: 집필 예정 → 집필 중 → 퇴고 중 → 집필 완료(원고 보호: 제목과 본문을 고칠 수 없다).
export const STATUSES = ["planned", "in_progress", "revision", "completed"];
export const STATUS_LABELS = {
  planned: "집필 예정",
  in_progress: "집필 중",
  revision: "퇴고 중",
  completed: "집필 완료",
};
export const STATUS_SHORT = { planned: "예정", in_progress: "진행", revision: "퇴고", completed: "완료" };
// 예전 lof의 상태(초안·진행·완료). 상태가 없던 회차는 쓰던 중으로 본다.
const LEGACY_STATUS = { 초안: "in_progress", 진행: "in_progress", 완료: "completed" };
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

// 수위(이용 등급).
export const RESTRICTION_LEVELS = [
  "ALL_AGES",
  "AGE_12_PLUS",
  "AGE_15_PLUS",
  "AGE_19_PLUS",
  "RESTRICTED",
  "PROHIBITED",
];
export const RESTRICTIONS = {
  ALL_AGES: {
    label: "전체 이용가",
    color: "green",
    description:
      "모든 연령층이 안전하게 볼 수 있는 콘텐츠. 선정성, 폭력성, 욕설, 사회적 이슈 등 자극적인 요소가 없음.",
  },
  AGE_12_PLUS: {
    label: "12세 이상",
    color: "blue",
    description:
      "약간의 긴장감, 모험, 약한 수준의 갈등 요소 포함 가능. 경미한 공포/위험 묘사, 약한 욕설 허용. 성적 암시나 폭력은 거의 없음.",
  },
  AGE_15_PLUS: {
    label: "15세 이상",
    color: "yellow",
    description:
      "다소 자극적인 소재 사용 가능. 성적 암시, 폭력 표현, 범죄 요소, 사회적 이슈를 다루되 묘사가 직접적이지 않음.",
  },
  AGE_19_PLUS: {
    label: "19세 이상",
    color: "orange",
    description:
      "뚜렷한 성적 묘사, 강한 언어, 폭력/범죄 표현이 포함될 수 있음. 선정적/자극적 내용이 주요 테마인 경우 해당.",
  },
  RESTRICTED: {
    label: "제한 관람가",
    color: "red",
    description:
      "법적 성인 등급 이상의 수위 포함. 유료 인증 절차 혹은 별도 플랫폼 필요. 실제 성행위 유사 묘사, 강도 높은 폭력, 마약, 자살 등 직접적이고 충격적인 표현 포함.",
  },
  PROHIBITED: {
    label: "등급분류 거부",
    color: "gray",
    description:
      "국내 법률 및 플랫폼 가이드라인 위반. 아동 성적 대상화, 범죄 미화, 극단적인 혐오·차별 표현, 기타 불법 콘텐츠 포함.",
  },
};

// 서술 시점.
export const POINTS_OF_VIEW = [
  "FIRST_PERSON_PROTAGONIST",
  "FIRST_PERSON_OBSERVER",
  "SECOND_PERSON_OBSERVER",
  "THIRD_PERSON_OBJECTIVE",
  "OMNISCIENT_NARRATOR",
  "SELECTIVE_NARRATION",
  "MULTIPLE_POV",
  "STREAM_OF_CONSCIOUSNESS",
  "INDETERMINATE",
];
export const POV = {
  FIRST_PERSON_PROTAGONIST: {
    label: "1인칭 주인공 시점",
    description: "주인공이 직접 '나'로서 이야기를 서술합니다. 화자가 모르는 정보는 독자도 알 수 없습니다.",
  },
  FIRST_PERSON_OBSERVER: {
    label: "1인칭 관찰자 시점",
    description: "주인공이 아닌 인물이 '나'로 등장해 주인공과 사건을 관찰하고 서술합니다.",
  },
  SECOND_PERSON_OBSERVER: {
    label: "2인칭 관찰자 시점",
    description: "독자를 '너'나 '당신'으로 부르며 이야기 속 인물로 끌어들입니다.",
  },
  THIRD_PERSON_OBJECTIVE: {
    label: "3인칭 관찰자 시점",
    description: "서술자가 인물의 속마음 없이 겉으로 드러난 말과 행동만 전합니다.",
  },
  OMNISCIENT_NARRATOR: {
    label: "전지적 작가 시점",
    description: "서술자가 모든 인물의 생각과 사건의 전모를 알고 서술합니다.",
  },
  SELECTIVE_NARRATION: {
    label: "선택적 시점",
    description: "3인칭으로 서술하되 한 인물의 생각과 감정만 따라갑니다.",
  },
  MULTIPLE_POV: {
    label: "복합 시점",
    description: "장면에 따라 여러 인물의 시점을 오가며 서술합니다.",
  },
  STREAM_OF_CONSCIOUSNESS: {
    label: "의식의 흐름",
    description: "인물의 생각과 감각이 떠오르는 대로 이어지게 서술합니다.",
  },
  INDETERMINATE: {
    label: "분석 불가",
    description: "시점을 하나로 정하기 어렵습니다.",
  },
};

// 회차 속성의 기본값과 정규화.
const text = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
export const META_FIELDS = [
  "episodeType",
  "description",
  "authorComment",
  "tags",
  "contentRestrictionLevel",
  "pointOfView",
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
    contentRestrictionLevel: RESTRICTION_LEVELS.includes(e?.contentRestrictionLevel)
      ? e.contentRestrictionLevel
      : null,
    pointOfView: POINTS_OF_VIEW.includes(e?.pointOfView) ? e.pointOfView : null,
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
  if (k === "contentRestrictionLevel")
    return v === null || RESTRICTION_LEVELS.includes(v) ? null : "잘못된 수위";
  if (k === "pointOfView") return v === null || POINTS_OF_VIEW.includes(v) ? null : "잘못된 시점";
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
