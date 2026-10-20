import { Cloud, CloudUpload, FolderSync } from "lucide-react";
import type { AutoSyncStatus } from "./types";

const fileLabels = {
  idle: "동기화 완료",
  pending: "동기화 대기",
  syncing: "동기화 중",
  error: "동기화 재시도 대기",
};

const realtimeLabels = {
  idle: "동기화 완료",
  pending: "연결된 장치 없음",
  syncing: "동기화 중",
  error: "연결된 장치 없음",
};

export default function SyncStatus({
  status,
  checking,
  available,
  editing = false,
}: {
  status: AutoSyncStatus;
  checking: boolean;
  available: boolean;
  editing?: boolean;
}) {
  const realtime = status.channels?.realtime;
  const files = status.channels ? status.channels.files : available ? status : undefined;
  const showRealtime = Boolean(realtime?.hasConnections);
  const showFiles = Boolean(
    files && files.hasConnections !== false && (status.channels ? files.hasConnections : available),
  );
  if (!showRealtime && !showFiles) return null;

  // 집필화면에서는 오류를 따로 드러내지 않고 재시도 대기로만 보여준다.
  const visible = (phase: AutoSyncStatus["phase"]) => (phase === "error" ? "pending" : phase);
  const detail = (progress: { phase: AutoSyncStatus["phase"]; message: string }) =>
    progress.phase !== "error" && progress.message ? ` · ${progress.message}` : "";

  const RealtimeIcon = realtime?.phase === "syncing" ? CloudUpload : Cloud;
  const realtimeLabel = realtime ? realtimeLabels[realtime.phase] : "";
  const realtimeDesc = realtime ? `실시간 동기화 · ${realtimeLabel}${detail(realtime)}` : "";

  const fileLabel =
    files && checking && files.phase === "idle"
      ? "동기화 확인 중"
      : files
        ? fileLabels[files.phase]
        : "";
  const fileDesc = files ? `파일 동기화 · ${fileLabel}${detail(files)}` : "";

  return (
    <>
      {showRealtime && realtime && (
        <span
          className={`auto-sync-status realtime ${realtime.phase === "idle" || realtime.phase === "syncing" ? realtime.phase : "disconnected"}${editing ? " editing" : ""}`}
          role="status"
          aria-live="off"
          aria-label={realtimeDesc}
          title={realtimeDesc}
        >
          <RealtimeIcon size={14} aria-hidden="true" />
        </span>
      )}
      {showFiles && files && (
        <span
          className={`auto-sync-status files ${visible(files.phase)}${editing ? " editing" : ""}`}
          role="status"
          aria-live="off"
          aria-label={fileDesc}
          title={fileDesc}
        >
          <FolderSync size={13} aria-hidden="true" />
        </span>
      )}
    </>
  );
}
