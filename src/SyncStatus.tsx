import { FolderSync } from "lucide-react";
import type { AutoSyncStatus } from "./types";
const labels = { idle: "동기화 완료", pending: "동기화 대기", syncing: "동기화 중", error: "동기화 재시도 대기" };
export default function SyncStatus({ status, checking, available }: { status: AutoSyncStatus; checking: boolean; available: boolean }) {
  if (!available) return null;
  const channel = status.channels?.files ?? status;
  if (channel.hasConnections === false) return null;
  const label = checking && channel.phase === "idle" ? "동기화 확인 중" : labels[channel.phase];
  const description = `파일 동기화 · ${label}${channel.message ? ` · ${channel.message}` : ""}`;
  return <span className={`auto-sync-status ${channel.phase === "error" ? "error" : ""}`} role="status" aria-live="off" aria-label={description} title={description}><FolderSync size={13} aria-hidden="true" /></span>;
}
