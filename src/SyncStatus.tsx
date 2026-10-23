import { Cloud, CloudDownload, CloudUpload, FolderSync, RefreshCw } from "lucide-react";
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

// 파일 비교 단계는 아이콘을 표시하지 않는다.
const realtimeActivities = {
  uploading: { icon: CloudUpload, label: "파일 보내는 중" },
  downloading: { icon: CloudDownload, label: "파일 받는 중" },
};

export default function SyncStatus({
  status,
  checking,
  available,
  editing = false,
  activeOnly = false,
}: {
  status: AutoSyncStatus;
  checking: boolean;
  available: boolean;
  editing?: boolean;
  activeOnly?: boolean;
}) {
  const realtime = status.channels?.realtime;
  const files = status.channels ? status.channels.files : available ? status : undefined;
  const comparing = realtime?.phase === "syncing" && realtime.activity === "comparing";
  const showRealtime = Boolean(realtime?.hasConnections && !comparing && (!activeOnly || realtime.phase === "syncing"));
  const showFiles = Boolean(
    files && files.hasConnections !== false && (status.channels ? files.hasConnections : available)
      && (!activeOnly || files.phase === "syncing" || (checking && files.phase === "idle")),
  );
  if (!showRealtime && !showFiles) return null;

  // 집필화면에서는 오류를 따로 드러내지 않고 재시도 대기로만 보여준다.
  const visible = (phase: AutoSyncStatus["phase"]) => (phase === "error" ? "pending" : phase);
  const detail = (progress: { phase: AutoSyncStatus["phase"]; message: string }) =>
    progress.phase !== "error" && progress.message ? ` · ${progress.message}` : "";

  const activity = realtime?.phase === "syncing" && realtime.activity && realtime.activity !== "comparing" ? realtimeActivities[realtime.activity] : undefined;
  const RealtimeIcon = activity?.icon ?? (realtime?.phase === "syncing" ? RefreshCw : Cloud);
  const realtimeLabel = activity?.label ?? (realtime ? realtimeLabels[realtime.phase] : "");
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
