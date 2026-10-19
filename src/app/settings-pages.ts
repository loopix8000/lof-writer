import {
  BookOpen,
  Code2,
  Download,
  FolderSync,
  HardDrive,
  LockKeyhole,
  Pilcrow,
  Settings,
  Sparkles
} from "lucide-react";

export const settingPages = [
  { id: "editor", label: "기본 설정", icon: Settings },
  { id: "typesetting", label: "조판 형식", icon: Pilcrow },
  { id: "autocomplete", label: "자동 완성", icon: Sparkles },
  { id: "defaults", label: "작품 기본값", icon: BookOpen },
  { id: "storage", label: "보관 및 이력", icon: HardDrive },
  { id: "connections", label: "파일 동기화", icon: FolderSync },
  { id: "api", label: "MCP / API", icon: Code2 },
  { id: "security", label: "앱 잠금", icon: LockKeyhole },
  { id: "updates", label: "앱 업데이트", icon: Download },
] as const;
export type SettingsPage = (typeof settingPages)[number]["id"];
