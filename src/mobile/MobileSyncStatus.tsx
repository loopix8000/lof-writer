import { useEffect, useState } from "react";
import SyncStatus from "../SyncStatus";
import type { AutoSyncStatus } from "../types";

export default function MobileSyncStatus({ status, checking, available, editing, belowHeader = false }: {
  status: AutoSyncStatus;
  checking: boolean;
  available: boolean;
  editing: boolean;
  belowHeader?: boolean;
}) {
  const realtime = status.channels?.realtime;
  const files = status.channels?.files;
  const busy = checking || (status.channels
    ? files?.phase === "syncing" || (realtime?.phase === "syncing" && realtime.activity !== "comparing")
    : status.phase === "syncing");
  const [shown, setShown] = useState(busy);
  useEffect(() => {
    if (busy) {
      setShown(true);
      return;
    }
    const timer = window.setTimeout(() => setShown(false), 2400);
    return () => window.clearTimeout(timer);
  }, [busy]);

  return <div className={`m-editor-sync-anchor${belowHeader ? " below-header" : ""}`}>
    <div className={`m-editor-sync-status ${shown ? "" : "quiet"}`} aria-hidden={!shown}>
      <SyncStatus status={status} checking={checking} available={available} editing={editing} />
    </div>
  </div>;
}
