import { useCallback, useEffect, useRef } from "react";
import { call } from "./types";

type SyncCheck = { changed: boolean; busy: boolean; hasConnections: boolean };
let remoteCheck: Promise<SyncCheck> | null = null;

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

type SyncedFile = { revision: string };
type Snapshot<T> = { doc: T; version: string | number };
type Options<T> = {
  fileKey: string;
  enabled: boolean;
  canCheck: () => boolean;
  current: () => Snapshot<T> | null;
  read: (doc: T) => Promise<T>;
  beforeRead?: () => Promise<unknown>;
  pending?: () => void;
  apply: (doc: T) => Promise<void> | void;
  report: (error: any) => void;
};

export function useSyncFileUpdates<T extends SyncedFile>(options: Options<T>) {
  const latest = useRef(options); latest.current = options;
  const checking = useRef(false);
  const noticed = useRef(new Map<string, string>());
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const checkLocal = useCallback(async (loadLatest = false) => {
    const start = latest.current;
    if (!start.enabled || !start.fileKey || !start.canCheck() || checking.current ||
        document.documentElement.dataset.pinLocked === "true") return;
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
      if (!current || current.version !== snapshot.version) return;
      if (fresh.revision === current.doc.revision) { noticed.current.delete(key); return; }
      if (!loadLatest) {
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
    }
  }, []);
  useEffect(() => {
    if (!options.enabled || !options.fileKey) return;
    let canceled = false;
    const report = (error: any) => {
      if (!canceled && !["ENOENT", "NOT_FOUND", "VAULT_CHANGED", "SYNC_BUSY", "FILE_BUSY"].includes(error.code)) latest.current.report(error);
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
