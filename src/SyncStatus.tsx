import { Cloud } from "lucide-react";
import type { AutoSyncStatus } from "./types";

const labels = { idle: "동기화 완료", pending: "동기화 대기", syncing: "동기화 중", error: "동기화 재시도 대기" };

export default function SyncStatus({ status, checking, available }: {
  status: AutoSyncStatus;
  checking: boolean;
  available: boolean;
}) {
  if (!available) return null;
  const label = checking && status.phase === "idle" ? "동기화 확인 중" : labels[status.phase];
  const description = status.message ? `${label} · ${status.message}` : label;
  return <span className={`auto-sync-status ${status.phase === "error" ? "error" : ""}`}
    role="status" aria-live="off" aria-label={description} title={description}>
    <Cloud size={13} aria-hidden="true" />
  </span>;
}
