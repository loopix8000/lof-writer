import { Cloud, FolderSync } from "lucide-react";
import type { AutoSyncStatus } from "./types";
import { LIBRARY_SYNC_ENABLED } from "./features";

const labels = { idle: "동기화 완료", pending: "동기화 대기", syncing: "동기화 중", error: "동기화 재시도 대기" };

export default function SyncStatus({ status, checking, available }: {
  status: AutoSyncStatus;
  checking: boolean;
  available: boolean;
}) {
  if (!available) return null;
  if (status.channels) return <>{(["files", "server"] as const).map((mode) => {
    if (mode === "server" && !LIBRARY_SYNC_ENABLED) return null;
    const channel = status.channels![mode];
    if (!channel.hasConnections) return null;
    const description = `${mode === "server" ? "서버 동기화" : "파일 동기화"} · ${labels[channel.phase]}${channel.message ? ` · ${channel.message}` : ""}`;
    const Icon = mode === "server" ? Cloud : FolderSync;
    return <span key={mode} className={`auto-sync-status ${channel.phase === "error" ? "error" : ""}`}
      role="status" aria-live="off" aria-label={description} title={description}>
      <Icon size={13} aria-hidden="true" />
    </span>;
  })}</>;
  const label = checking && status.phase === "idle" ? "동기화 확인 중" : labels[status.phase];
  const description = status.message ? `${label} · ${status.message}` : label;
  return <span className={`auto-sync-status ${status.phase === "error" ? "error" : ""}`}
    role="status" aria-live="off" aria-label={description} title={description}>
    <Cloud size={13} aria-hidden="true" />
  </span>;
}
