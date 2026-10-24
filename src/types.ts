export type Kind = "episode" | "plot" | "memo";
export type DaemonUpdateNotice = { id: string; name: string };
export type SyncProgress = { phase: "idle" | "pending" | "syncing" | "error"; message: string; hasConnections?: boolean; activity?: "comparing" | "uploading" | "downloading"; daemonUpdates?: DaemonUpdateNotice[] };
export type AutoSyncStatus = SyncProgress & { channels?: Partial<Record<"files" | "realtime", SyncProgress>> };
export type SyncConnection = {
  id: string;
  name: string;
  type: "folder" | "webdav" | "ftp";
  folder?: string;
  url?: string;
  host?: string;
  libraryId?: string;
  libraryName?: string;
  conflictPolicy?: "keepBoth" | "latest";
};
export type WritingRules = {
  version?: number;
  platform: string;
  rule: "noSpace" | "spaces" | "all" | "collapsed" | "novelpia";
  unit: "codepoint" | "utf16";
  punctuation?: "include" | "ascii" | "unicode";
  excludeSpecial?: boolean;
  ellipsisWeight?: number;
  goal: number;
  customName: string;
};
export type Project = {
  id: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  tags?: string[];
  cover?: string | null;
  coverData?: string | null;
  writing?: WritingRules;
  // 이 작품에서 새로 만드는 회차의 줄바꿈 방식. 없으면 공통 설정을 따른다.
  manualLineBreak?: boolean;
  // 내 서재 목록에서 숨긴 작품. 파일과 원고는 그대로 둔다.
  hidden?: boolean;
  // 작품 번호(폴더 이름 앞의 001)와 도서관 안의 작품 폴더 이름.
  index?: number;
  folder?: string;
};
export type Doc = {
  id: string;
  projectId: string;
  kind: Kind;
  title: string;
  // 회차 상태(뮤블과 같은 값): in_progress·revision·completed. 예전 planned는 in_progress로 읽는다.
  status: string;
  // 회차 유형: 0 일반·2 프롤로그·3 에필로그·4 특별편·6 단편.
  episodeType?: number;
  description?: string;
  authorComment?: string;
  tags?: string[];
  // 줄바꿈 관리 방식. true 수동 관리, false 자동 관리.
  manualLineBreak?: boolean;
  order: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  revision: string;
  body: string;
  characters?: number;
  platformCharacters?: number;
  // 디스크의 절대 경로와 작품 폴더 기준 상대 경로('/' 구분).
  path?: string;
  relPath?: string;
  // 플롯·메모 문서가 연결된 회차. 저장할 때 null이면 연결을 푼다.
  episodeId?: string | null;
  fingerprint?: string;
  // Markdown YAML에 기록하는 사용자 속성.
  properties?: Record<string, unknown>;
  // 원고 북마크: 본문 맨 위 단계 문단의 순서와 그 문단의 앞부분 글.
  bookmarks?: Bookmark[];
};
export type Bookmark = { index: number; text: string };
export type UserFontFile = {
  file: string;
  format: string;
  weight?: number;
  italic?: boolean;
  variable?: boolean;
  originalName?: string;
};
export type UserFont = {
  id: string;
  label: string;
  family: string;
  familyEn?: string | null;
  value: string;
  source: "file" | "system";
  files?: UserFontFile[];
};
export type SystemFontOption = {
  label: string;
  family: string;
  familyEn?: string | null;
  value: string;
};
export type Library = {
  platform?: string;
  localGit?: { ready: boolean; message: string; head: string; importedHistory: number; path: string };
  root: string;
  internalRoot?: string;
  isInternal?: boolean;
  projects: Project[];
  documents: Doc[];
  warnings: string[];
  // 회차·플롯 폴더에 있지만 project.json에 연결되지 않은 Markdown 파일.
  unlinked?: { projectId: string; path: string }[];
  // project.json에는 있지만 파일을 찾을 수 없는 회차·플롯.
  missing?: { projectId: string; id: string; kind: Kind; title: string; path: string }[];
  drafts: Partial<Doc>[];
  preferences: Record<string, any>;
  version: string;
};
declare global {
  interface Window {
    lof: Record<string, (args?: any) => Promise<any>> & {
      onChange: (fn: () => void) => () => void;
      onFlush: (fn: () => Promise<void>) => () => void;
      onAutoSync?: (fn: (status: AutoSyncStatus) => void) => () => void;
      windowMinimize?: () => Promise<void>;
      windowToggleMaximize?: () => Promise<boolean>;
      windowIsMaximized?: () => Promise<boolean>;
      windowClose?: () => Promise<void>;
      windowStartDragging?: () => Promise<void>;
    };
  }
}
export async function call<T = any>(name: string, args?: any): Promise<T> {
  const r = await window.lof[name](args);
  if (!r.ok) {
    const e = Object.assign(new Error(r.error), { code: r.code });
    throw e;
  }
  return r.data;
}
