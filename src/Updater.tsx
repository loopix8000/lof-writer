import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { Download, RefreshCw, X } from "lucide-react";

type Phase = "idle" | "checking" | "current" | "available" | "downloading" | "saving" | "installing" | "error";

export function useAppUpdater({ loaded, autoCheck, beforeInstall }: {
  loaded: boolean;
  autoCheck: boolean;
  beforeInstall: () => Promise<void>;
}) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [available, setAvailable] = useState<{ version: string; notes: string } | null>(null);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const updateRef = useRef<Update | null>(null);
  const running = useRef(false);
  const generation = useRef(0);
  const autoChecked = useRef(false);
  const lockRef = useRef(false);
  const prepareRef = useRef(beforeInstall);
  prepareRef.current = beforeInstall;

  useEffect(() => {
    const current = ++generation.current;
    if (loaded) {
      invoke<{ configured: boolean; supported: boolean }>("updater_status")
        .then((status) => {
          if (current === generation.current) setConfigured(status.configured && status.supported);
        })
        .catch(() => {
          if (current === generation.current) setConfigured(false);
        });
    }
    return () => {
      generation.current++;
      const update = updateRef.current;
      updateRef.current = null;
      void update?.close().catch(() => {});
    };
  }, [loaded]);

  const checkNow = useCallback(async () => {
    if (!configured || running.current) return;
    running.current = true;
    const current = generation.current;
    setPhase("checking");
    setError("");
    setAvailable(null);
    setDismissed(false);
    const previous = updateRef.current;
    updateRef.current = null;
    try {
      await previous?.close();
      const update = await check({ timeout: 15000 });
      if (current !== generation.current) {
        await update?.close();
        return;
      }
      updateRef.current = update;
      setAvailable(update ? { version: update.version, notes: update.body || "" } : null);
      setPhase(update ? "available" : "current");
    } catch (e) {
      if (current === generation.current) {
        setError(String(e instanceof Error ? e.message : e));
        setPhase("error");
      }
    } finally {
      running.current = false;
    }
  }, [configured]);

  useEffect(() => {
    if (loaded && configured && autoCheck && !autoChecked.current) {
      autoChecked.current = true;
      void checkNow();
    }
  }, [loaded, configured, autoCheck, checkNow]);

  const install = useCallback(async () => {
    const update = updateRef.current;
    if (!update || running.current) return;
    running.current = true;
    const current = generation.current;
    setError("");
    setProgress(null);
    setPhase("downloading");
    try {
      let received = 0;
      let total = 0;
      await update.download((event) => {
        if (current !== generation.current) return;
        if (event.event === "Started") total = event.data.contentLength || 0;
        if (event.event === "Progress") received += event.data.chunkLength;
        setProgress(total > 0 ? Math.min(100, Math.round(received / total * 100)) : null);
      }, { timeout: 120000 });
      if (current !== generation.current) return;
      // 다운로드 중에는 집필을 허용하고, 저장부터 설치 종료까지 입력을 잠근다.
      lockRef.current = true;
      flushSync(() => setPhase("saving"));
      await prepareRef.current();
      setPhase("installing");
      await update.install({ restartAfterInstall: true });
    } catch (e) {
      if (current === generation.current) {
        setError(String(e instanceof Error ? e.message : e));
        setPhase("error");
      }
    } finally {
      lockRef.current = false;
      running.current = false;
    }
  }, []);

  return {
    configured, phase, available, error, progress, dismissed, lockRef,
    locked: phase === "saving" || phase === "installing",
    busy: ["checking", "downloading", "saving", "installing"].includes(phase),
    checkNow, install, dismiss: () => setDismissed(true),
  };
}

type Updater = ReturnType<typeof useAppUpdater>;

export function UpdateSettings({ updater, version, autoCheck, onAutoCheck }: {
  updater: Updater;
  version: string;
  autoCheck: boolean;
  onAutoCheck: (checked: boolean) => void;
}) {
  return <>
    <h3>앱 업데이트</h3>
    <p className="settings-description">현재 버전 {version}</p>
    <div className="settings-toggles">
      <label className="settings-toggle">
        <span>앱 시작 시 업데이트 확인<small>새 버전을 알려드립니다. 다운로드와 설치는 직접 시작할 수 있습니다.</small></span>
        <input type="checkbox" role="switch" aria-label="앱 시작 시 업데이트 확인"
          checked={autoCheck} onChange={(e) => onAutoCheck(e.target.checked)} />
      </label>
    </div>
    <div className="updater-actions">
      <button type="button" disabled={!updater.configured || updater.busy} onClick={() => void updater.checkNow()}>
        <RefreshCw size={14} />업데이트 확인
      </button>
      {updater.available && <button type="button" className="primary" disabled={updater.busy} onClick={() => void updater.install()}>
        <Download size={14} />다운로드·설치
      </button>}
    </div>
    <div className="updater-status" role="status" aria-live="polite">
      {updater.configured === null && "업데이트 설정을 확인하고 있습니다."}
      {updater.configured === false && "업데이트 배포가 아직 준비되지 않았습니다."}
      {updater.configured && updater.phase === "idle" && "새 버전을 확인할 수 있습니다."}
      {updater.phase === "checking" && "새 버전을 확인하고 있습니다."}
      {updater.phase === "current" && "최신 버전입니다."}
      {updater.available && !updater.busy && `새 버전 ${updater.available.version}을 설치할 수 있습니다.`}
      {updater.phase === "downloading" && <>
        업데이트 다운로드 중{updater.progress !== null ? ` · ${updater.progress}%` : ""}
        <progress max={100} value={updater.progress ?? undefined} />
      </>}
    </div>
    {updater.error && <p className="updater-error" role="alert">업데이트를 완료하지 못했습니다. {updater.error}</p>}
    {updater.available && <>
      <p className="settings-note">설치 전에 열린 원고와 메모를 저장합니다. 저장에 실패하면 설치를 중단합니다. 설치가 시작되면 앱이 종료되고 완료 후 다시 실행됩니다.</p>
      {updater.available.notes && <div className="updater-notes">{updater.available.notes}</div>}
    </>}
  </>;
}

export function UpdateNotice({ updater, onOpen }: { updater: Updater; onOpen: () => void }) {
  if (!updater.available || updater.dismissed || updater.busy) return null;
  return <aside className="updater-notice" aria-label="새 업데이트">
    <span>새 버전 {updater.available.version}이 있습니다.</span>
    <button type="button" onClick={onOpen}>업데이트 보기</button>
    <button type="button" aria-label="업데이트 알림 닫기" onClick={updater.dismiss}><X size={14} /></button>
  </aside>;
}

export function UpdateLock({ phase }: { phase: Phase }) {
  if (phase !== "saving" && phase !== "installing") return null;
  return <div className="updater-lock" role="alertdialog" aria-modal="true" aria-label="업데이트 설치 중">
    <div><strong>{phase === "saving" ? "원고를 저장하고 있습니다." : "업데이트를 설치하고 있습니다."}</strong>
      <p>잠시 기다려 주세요.</p></div>
  </div>;
}
