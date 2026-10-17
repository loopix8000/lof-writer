import { useCallback, useEffect, useRef } from "react";
import { call } from "./types";
import type { ConfirmOptions } from "./ConfirmDialog";

type SyncCheck = { changed: boolean; busy: boolean; hasConnections: boolean };
let remoteCheck: Promise<SyncCheck> | null = null;

// 작품을 전환하는 동안에도 진행 중인 네트워크 동기화는 중복 실행하지 않는다.
function checkForSyncUpdates(): Promise<SyncCheck> {
  if (remoteCheck) return remoteCheck;
  remoteCheck = call<SyncCheck>("checkSyncUpdates").finally(() => { remoteCheck = null; });
  return remoteCheck;
}

export function useProjectSyncUpdates(projectKey: string, report: (error: any) => void,
  onState: (checking: boolean, available?: boolean) => void) {
  const reportRef = useRef(report); reportRef.current = report;
  const stateRef = useRef(onState); stateRef.current = onState;
  useEffect(() => {
    if (!projectKey) return;
    let canceled = false, checking = false;
    const tick = async () => {
      if (checking || canceled || document.documentElement.dataset.pinLocked === "true") return;
      checking = true;
      stateRef.current(true);
      try {
        const result = await checkForSyncUpdates();
        if (!canceled) stateRef.current(false, result.hasConnections);
      }
      catch (error) { if (!canceled) reportRef.current(error); }
      finally { checking = false; if (!canceled) stateRef.current(false); }
    };
    // 작품 페이지 진입 즉시 확인하며, 원고를 열지 않아도 같은 주기로 확인한다.
    void tick();
    const interval = window.setInterval(() => { void tick(); }, 3000);
    return () => { canceled = true; clearInterval(interval); stateRef.current(false); };
  }, [projectKey]);
}

type SyncedFile = { title: string; revision: string };
function confirmSyncedReplacement(confirm: (options: ConfirmOptions) => Promise<boolean>,
  title: string, dirty = false) {
  return confirm({
    title: "동기화된 새 내용이 있습니다",
    message: `‘${title || "제목 없음"}’ 파일이 다른 곳에서 변경되었습니다. 열린 파일을 새 내용으로 덮어쓸까요?`,
    detail: dirty ? "아직 저장하지 않은 편집 내용도 새 내용으로 바뀝니다." : "현재 화면의 내용을 유지하거나 동기화된 내용을 불러올 수 있습니다.",
    confirmLabel: "새 내용으로 덮어쓰기",
    cancelLabel: "현재 내용 유지",
    danger: dirty,
  });
}
type Snapshot<T> = { doc: T; version: string | number; dirty: boolean };
type Options<T> = {
  fileKey: string;
  enabled: boolean;
  canCheck: () => boolean;
  current: () => Snapshot<T> | null;
  read: (doc: T) => Promise<T>;
  beforeRead?: () => Promise<unknown>;
  pending?: () => void;
  decline?: () => void;
  apply: (doc: T) => Promise<void> | void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  report: (error: any) => void;
};

export function useSyncFileUpdates<T extends SyncedFile>(options: Options<T>) {
  const latest = useRef(options); latest.current = options;
  const prompting = useRef(false);
  const dismissed = useRef(new Map<string, string>());
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const checkLocal = useCallback(async (askAgain = false) => {
    const start = latest.current;
    if (!start.enabled || !start.fileKey || !start.canCheck() || prompting.current ||
        document.documentElement.dataset.pinLocked === "true" || document.querySelector('[role="alertdialog"]')) return;
    prompting.current = true;
    const key = start.fileKey;
    const valid = () => alive.current && latest.current.enabled && latest.current.fileKey === key && latest.current.canCheck();
    try {
      await start.beforeRead?.();
      if (!valid()) return;
      const snapshot = latest.current.current();
      if (!snapshot) return;
      const fresh = await start.read(snapshot.doc);
      if (!valid()) return;
      const current = latest.current.current();
      if (!current || current.version !== snapshot.version || fresh.revision === current.doc.revision ||
          (!askAgain && dismissed.current.get(key) === fresh.revision)) return;
      start.pending?.();
      const accepted = await confirmSyncedReplacement(start.confirm, fresh.title, current.dirty);
      if (!alive.current) return;
      if (!accepted) {
        dismissed.current.set(key, fresh.revision);
        if (valid()) latest.current.decline?.();
        return;
      }
      if (!valid()) return;
      await latest.current.beforeRead?.();
      if (!valid()) return;
      const now = latest.current.current();
      if (!now || now.version !== current.version) return;
      const newest = await latest.current.read(now.doc);
      // 확인 창이 떠 있는 동안 새 변경이 도착했다면 다음 확인 주기에 다시 묻는다.
      if (!valid() || newest.revision !== fresh.revision || latest.current.current()?.version !== current.version) return;
      await latest.current.apply(newest);
      dismissed.current.delete(key);
    } finally {
      prompting.current = false;
    }
  }, []);
  useEffect(() => {
    if (!options.enabled || !options.fileKey) return;
    let canceled = false;
    const report = (error: any) => {
      if (!canceled && !["ENOENT", "NOT_FOUND", "VAULT_CHANGED", "SYNC_BUSY"].includes(error.code)) latest.current.report(error);
    };
    const tick = () => { if (!canceled) void checkLocal().catch(report); };
    // 네트워크 확인은 작품 페이지가 맡고, 여기서는 열린 편집기의 내용만 비교한다.
    tick();
    const interval = window.setInterval(() => { void tick(); }, 3000);
    const off = window.lof.onChange(() => { if (!canceled) void checkLocal().catch(report); });
    return () => { canceled = true; clearInterval(interval); off(); };
  }, [options.enabled, options.fileKey, checkLocal]);
  return checkLocal;
}
