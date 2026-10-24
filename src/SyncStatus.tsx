import { useEffect, useState } from "react";
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

// 짧은 연속 전송 사이의 깜빡임만 줄이고 전송이 끝나면 빠르게 표시를 해제한다.
const REALTIME_SETTLE_MS = 150;
const FILE_SETTLE_MS = 650;

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
  const realtimeTransferring = Boolean(
    realtime?.hasConnections && realtime.phase === "syncing" &&
      (realtime.activity === "uploading" || realtime.activity === "downloading"),
  );
  const realtimeUnavailable = !realtime?.hasConnections ||
    realtime.phase === "pending" || realtime.phase === "error";
  const currentTransferActivity =
    realtimeTransferring &&
    (realtime?.activity === "uploading" || realtime?.activity === "downloading")
      ? realtime.activity
      : undefined;

  const [heldRealtimeActivity, setHeldRealtimeActivity] = useState<
    "uploading" | "downloading" | null
  >(currentTransferActivity ?? null);
  const [holdingRealtime, setHoldingRealtime] = useState(realtimeTransferring);

  useEffect(() => {
    if (realtimeUnavailable) {
      setHoldingRealtime(false);
      setHeldRealtimeActivity(null);
      return;
    }
    if (realtimeTransferring) {
      setHoldingRealtime(true);
      if (currentTransferActivity) {
        setHeldRealtimeActivity(currentTransferActivity);
      }
      return;
    }
    if (!holdingRealtime) return;
    const timer = window.setTimeout(() => {
      setHoldingRealtime(false);
      setHeldRealtimeActivity(null);
    }, REALTIME_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [
    realtimeUnavailable,
    realtimeTransferring,
    currentTransferActivity,
    holdingRealtime,
  ]);

  const filesSyncing = Boolean(
    files &&
      files.hasConnections !== false &&
      (status.channels ? files.hasConnections : available) &&
      (files.phase === "syncing" || (checking && files.phase === "idle")),
  );
  const [holdingFiles, setHoldingFiles] = useState(filesSyncing);

  useEffect(() => {
    if (!files || files.hasConnections === false || files.phase === "pending" || files.phase === "error") {
      setHoldingFiles(false);
      return;
    }
    if (filesSyncing) {
      setHoldingFiles(true);
      return;
    }
    if (!holdingFiles) return;
    const timer = window.setTimeout(() => setHoldingFiles(false), FILE_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [files?.hasConnections, files?.phase, filesSyncing, holdingFiles]);

  const effectiveRealtimeSyncing = realtimeTransferring || holdingRealtime;
  const effectiveRealtimePhase: AutoSyncStatus["phase"] | undefined = realtime
    ? effectiveRealtimeSyncing
      ? "syncing"
      : realtime.phase === "syncing"
        ? "idle"
        : realtime.phase
    : undefined;
  const effectiveRealtimeActivity = effectiveRealtimeSyncing
    ? currentTransferActivity ?? heldRealtimeActivity ?? undefined
    : undefined;

  const effectiveFilesPhase: AutoSyncStatus["phase"] | undefined = files
    ? filesSyncing || holdingFiles
      ? "syncing"
      : files.phase
    : undefined;

  const showRealtime = Boolean(
    realtime?.hasConnections && (!activeOnly || effectiveRealtimePhase === "syncing"),
  );
  const showFiles = Boolean(
    files &&
      files.hasConnections !== false &&
      (status.channels ? files.hasConnections : available) &&
      (!activeOnly || effectiveFilesPhase === "syncing"),
  );
  if (!showRealtime && !showFiles) return null;

  // 집필화면에서는 오류를 따로 드러내지 않고 재시도 대기로만 보여준다.
  const visible = (phase: AutoSyncStatus["phase"]) => (phase === "error" ? "pending" : phase);
  const detail = (progress: { phase: AutoSyncStatus["phase"]; message: string }) =>
    progress.phase !== "error" && progress.message ? ` · ${progress.message}` : "";

  const activity = effectiveRealtimeActivity
    ? realtimeActivities[effectiveRealtimeActivity]
    : undefined;
  const RealtimeIcon = activity?.icon ?? (effectiveRealtimePhase === "syncing" ? RefreshCw : Cloud);
  const realtimeLabel =
    activity?.label ?? (effectiveRealtimePhase ? realtimeLabels[effectiveRealtimePhase] : "");
  const realtimeDesc =
    realtime && effectiveRealtimePhase
      ? `실시간 동기화 · ${realtimeLabel}${detail({ phase: effectiveRealtimePhase, message: realtime.message })}`
      : "";

  const fileLabel =
    files && checking && files.phase === "idle" && !filesSyncing
      ? "동기화 확인 중"
      : effectiveFilesPhase
        ? fileLabels[effectiveFilesPhase]
        : "";
  const fileDesc =
    files && effectiveFilesPhase
      ? `파일 동기화 · ${fileLabel}${detail({ phase: effectiveFilesPhase, message: files.message })}`
      : "";

  return (
    <>
      {showRealtime && realtime && effectiveRealtimePhase && (
        <span
          className={`auto-sync-status realtime ${effectiveRealtimePhase === "idle" || effectiveRealtimePhase === "syncing" ? effectiveRealtimePhase : "disconnected"}${editing ? " editing" : ""}`}
          role="status"
          aria-live="off"
          aria-label={realtimeDesc}
          title={realtimeDesc}
        >
          <RealtimeIcon size={14} aria-hidden="true" />
        </span>
      )}
      {showFiles && files && effectiveFilesPhase && (
        <span
          className={`auto-sync-status files ${visible(effectiveFilesPhase)}${editing ? " editing" : ""}`}
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
