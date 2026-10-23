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
      if (!canceled) stateRef.current(status.phase === "syncing", status.hasConnections);
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
    const valid = () => alive.current && latest.current.enabled && latest.current.fileKey === key && latest.current.canCheck();
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
  useEffect(() => {
    if (!options.enabled || !options.fileKey) return;
    let canceled = false;
    const report = (error: any) => {
      if (!canceled && !["ENOENT", "NOT_FOUND", "VAULT_CHANGED", "SYNC_BUSY", "FILE_BUSY"].includes(error.code)) latest.current.report(error);
    };
    const tick = () => { if (!canceled) void checkLocal().catch(report); };
    // 네트워크 동기화는 공통 스케줄러가 맡고, 여기서는 열린 편집기의 내용만 비교한다.
    tick();
    const off = window.lof.onChange(() => { if (!canceled) void checkLocal().catch(report); });
    return () => { canceled = true; off(); };
  }, [options.enabled, options.fileKey, checkLocal]);
  return checkLocal;
}
