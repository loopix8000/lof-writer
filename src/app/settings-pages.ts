import {
  BookOpen,
  Cloud,
  Code2,
  Download,
  FolderSync,
  HardDrive,
  LockKeyhole,
  Pilcrow,
  Settings,
  Sparkles,
} from "lucide-react";

export const settingPages = [
  { id: "editor", label: "기본 설정", desc: "앱 시작, 테마, 화면 표시 및 에디터 동작", icon: Settings },
  { id: "typesetting", label: "조판 형식", desc: "글꼴, 글자 크기, 줄 간격 및 문단 여백", icon: Pilcrow },
  { id: "autocomplete", label: "자동 완성", desc: "자주 쓰는 단어·문장 추천 및 입력 보조", icon: Sparkles },
  { id: "defaults", label: "작품 기본값", desc: "새 작품 기본 플랫폼, 줄바꿈 및 사용자 속성", icon: BookOpen },
  { id: "storage", label: "보관 및 이력", desc: "서재 위치, 원고 내보내기 및 변경 이력 보존", icon: HardDrive },
  { id: "realtime", label: "실시간 동기화", desc: "기기 간 P2P 그룹 연결, 초대 코드 및 백그라운드 동기화", icon: Cloud },
  { id: "connections", label: "파일 동기화", desc: "WebDAV, FTP 등 외부 저장소 자동 및 백그라운드 동기화", icon: FolderSync },
  { id: "api", label: "MCP / API", desc: "외부 도구 연동을 위한 로컬 API 및 MCP 설정", icon: Code2 },
  { id: "security", label: "앱 잠금", desc: "앱 실행 시 PIN 번호 잠금 및 보호", icon: LockKeyhole },
  { id: "updates", label: "앱 업데이트", desc: "버전 정보, 변경 내역 및 오픈소스 라이선스", icon: Download },
] as const;
export type SettingsPage = (typeof settingPages)[number]["id"];
