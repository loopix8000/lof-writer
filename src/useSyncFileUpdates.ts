import { useCallback, useEffect, useRef } from "react";
import { call, type AutoSyncStatus } from "./types";

// 닫기 직전에 외부 저장이 진행 중이면 완료된 파일을 짧게 재확인한다.
export async function readFileForClose<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await read(); }
    catch (error: any) {
      if (error.code !== "FILE_BUSY" || attempt >= 2) throw error;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 1000));
    }
  }
}

export function useProjectSyncUpdates(projectKey: string, report: (error: any) => void,
  onState: (checking: boolean, available?: boolean) => void) {
  const reportRef = useRef(report); reportRef.current = report;
  const stateRef = useRef(onState); stateRef.current = onState;
  useEffect(() => {
    if (!projectKey) return;
    let canceled = false, receivedStatus = false;
    const update = (status: AutoSyncStatus) => {
      if (!canceled) {
        const files = status.channels?.files;
        const realtime = status.channels?.realtime;
        const syncing = status.channels
          ? files?.phase === "syncing" || (realtime?.phase === "syncing" && realtime.activity !== "comparing")
          : status.phase === "syncing";
        stateRef.current(syncing, status.hasConnections);
      }
    };
    // 화면은 공통 스케줄러의 상태만 구독하며 별도 네트워크 동기화를 실행하지 않는다.
    const off = window.lof.onAutoSync?.((status) => { receivedStatus = true; update(status); });
    call<AutoSyncStatus>("autoSyncStatus").then((status) => {
      if (!receivedStatus) update(status);
    }).catch((error) => { if (!canceled) reportRef.current(error); });
    return () => { canceled = true; off?.(); stateRef.current(false); };
  }, [projectKey]);
}

type SyncedFile = { revision: string };
type Snapshot<T> = { doc: T; version: string | number };
type Options<T> = {
  fileKey: string;
  enabled: boolean;
  automatic?: boolean;
  canCheck: () => boolean;
  current: () => Snapshot<T> | null;
  read: (doc: T) => Promise<T>;
  beforeRead?: () => Promise<unknown>;
  pending?: () => void;
  // 본문을 바꾸지 않는 위치·순서 변경을 안전하게 반영한 경우 안내를 생략한다.
  reconcile?: (doc: T) => boolean;
  apply: (doc: T) => Promise<void> | void;
  report: (error: any) => void;
};

export function useSyncFileUpdates<T extends SyncedFile>(options: Options<T>) {
  const latest = useRef(options); latest.current = options;
  const checking = useRef(false);
  const recheck = useRef(false);
  const noticed = useRef(new Map<string, string>());
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const checkLocal = useCallback(async (loadLatest = false): Promise<void> => {
    const start = latest.current;
    if (!start.enabled || !start.fileKey || !start.canCheck() ||
        document.documentElement.dataset.pinLocked === "true") return;
    if (checking.current) { recheck.current = true; return; }
    checking.current = true;
    const key = start.fileKey;
    const valid = () => alive.current && latest.current.enabled && latest.current.fileKey === key && latest.current.canCheck() &&
      document.documentElement.dataset.pinLocked !== "true";
    try {
      await start.beforeRead?.();
      if (!valid()) return;
      const snapshot = latest.current.current();
      if (!snapshot) return;
      const fresh = await start.read(snapshot.doc);
      if (!valid()) return;
      const current = latest.current.current();
      if (!current || (!start.automatic && current.version !== snapshot.version)) return;
      if (fresh.revision === current.doc.revision) { noticed.current.delete(key); return; }
      if (!loadLatest && latest.current.reconcile?.(fresh)) { noticed.current.delete(key); return; }
      if (!loadLatest && !start.automatic) {
        // 자동 확인에서는 본문을 유지하고, 안내줄을 눌렀을 때만 새 내용을 불러온다.
        const change = `${current.doc.revision}\n${fresh.revision}`;
        if (noticed.current.get(key) !== change) {
          noticed.current.set(key, change);
          latest.current.pending?.();
        }
        return;
      }
      await latest.current.apply(fresh);
      noticed.current.delete(key);
    } finally {
      checking.current = false;
      if (recheck.current && alive.current) {
        recheck.current = false;
        void checkLocal().catch(error => latest.current.report(error));
      }
    }
  }, []);
  const available = options.enabled && options.canCheck();
  useEffect(() => {
    if (!available || !options.fileKey) return;
    let canceled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;
    const report = (error: any) => {
      if (!canceled && !["ENOENT", "NOT_FOUND", "VAULT_CHANGED", "SYNC_BUSY", "FILE_BUSY"].includes(error.code)) latest.current.report(error);
    };
    const run = () => {
      if (canceled) return;
      void checkLocal().catch((error) => {
        if (!canceled && ["SYNC_BUSY", "FILE_BUSY"].includes(error.code) && retries < 3) {
          retryTimer = setTimeout(run, 250 * ++retries);
        } else report(error);
      });
    };
    const tick = () => {
      clearTimeout(retryTimer);
      retries = 0;
      run();
    };
    // 네트워크 동기화는 공통 스케줄러가 맡고, 여기서는 열린 편집기의 내용만 비교한다.
    tick();
    const off = window.lof.onChange(tick);
    // 파일 알림이 저장 중에 도착했더라도 동기화 완료 시 최신 원고를 다시 읽는다.
    let syncing = false;
    const offSync = window.lof.onAutoSync?.((status) => {
      const next = status.phase === "syncing" || Object.values(status.channels ?? {}).some(channel => channel?.phase === "syncing");
      const completed = syncing && !next;
      syncing = next;
      if (completed) tick();
    });
    const onVisible = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("lof:unlocked", tick);
    return () => {
      canceled = true;
      clearTimeout(retryTimer);
      off();
      offSync?.();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("lof:unlocked", tick);
    };
  }, [available, options.fileKey, checkLocal]);
  return checkLocal;
}
