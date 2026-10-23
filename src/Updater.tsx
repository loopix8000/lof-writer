import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { Update } from "@tauri-apps/plugin-updater";
import { Download, RefreshCw, X } from "lucide-react";
import { ReleaseNotesForVersion } from "./ReleaseNotes";

type Phase = "idle" | "checking" | "current" | "available" | "downloading" | "saving" | "installing" | "error";
type UpdateHandle = Pick<Update, "version" | "download" | "install" | "close">;
export type UpdateChannel = "stable" | "rc" | "beta";
export const updateChannel = (value: unknown): UpdateChannel => value === "rc" || value === "beta" ? value : "stable";

async function checkAndroidUpdate(channel: UpdateChannel): Promise<UpdateHandle | null> {
  const result = await invoke<{ available: boolean; version?: string }>("android_update_check", { channel });
  if (!result.available || !result.version) return null;
  return {
    version: result.version,
    download: async () => { await invoke("android_update_download", { channel, version: result.version }); },
    install: async () => { await invoke("android_update_install", { channel, version: result.version }); },
    close: async () => {},
  };
}

export function useAppUpdater({ loaded, autoCheck, channel, beforeInstall }: {
  loaded: boolean;
  autoCheck: boolean;
  channel: UpdateChannel;
  beforeInstall: () => Promise<void>;
}) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [platform, setPlatform] = useState("windows");
  const platformRef = useRef("windows");
  const [phase, setPhase] = useState<Phase>("idle");
  const [available, setAvailable] = useState<{ version: string } | null>(null);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const updateRef = useRef<UpdateHandle | null>(null);
  const selectedChannel = useRef(channel);
  selectedChannel.current = channel;
  const candidateChannel = useRef<UpdateChannel | null>(null);
  const running = useRef<number | null>(null);
  const generation = useRef(0);
  const autoChecked = useRef(false);
  const lockRef = useRef(false);
  const lockOwner = useRef<number | null>(null);
  const prepareRef = useRef(beforeInstall);
  prepareRef.current = beforeInstall;

  useEffect(() => {
    const current = ++generation.current;
    running.current = null;
    autoChecked.current = false;
    setAvailable(null); setError(""); setPhase("idle"); setProgress(null);
    if (loaded) {
      invoke<{ configured: boolean; supported: boolean; platform?: string }>("updater_status")
        .then((status) => {
          if (current === generation.current) {
            platformRef.current = status.platform || "windows";
            setPlatform(platformRef.current);
            setConfigured(status.configured && status.supported);
          }
        })
        .catch(() => {
          if (current === generation.current) setConfigured(false);
        });
    }
    return () => {
      generation.current++;
      const update = updateRef.current;
      updateRef.current = null;
      candidateChannel.current = null;
      void update?.close().catch(() => {});
    };
  }, [loaded, channel]);

  // 설정 화면에서 직접 확인하면 결과가 그 화면에 표시되므로 오른쪽 아래 알림은 띄우지 않는다.
  const checkNow = useCallback(async (manual = false) => {
    if (!configured || running.current !== null) return;
    const current = generation.current;
    running.current = current;
    autoChecked.current = true;
    setPhase("checking");
    setError("");
    setAvailable(null);
    setDismissed(manual);
    const previous = updateRef.current;
    updateRef.current = null;
    try {
      await previous?.close();
      let update: UpdateHandle | null;
      if (platformRef.current === "android") update = await checkAndroidUpdate(channel);
      else {
        const metadata = await invoke<ConstructorParameters<typeof Update>[0] | null>("desktop_update_check", { channel });
        update = metadata ? new Update(metadata) : null;
      }
      if (current !== generation.current || channel !== selectedChannel.current) {
        await update?.close();
        return;
      }
      updateRef.current = update;
      candidateChannel.current = update ? channel : null;
      setAvailable(update ? { version: update.version } : null);
      setPhase(update ? "available" : "current");
    } catch (e) {
      if (current === generation.current) {
        setError(String(e instanceof Error ? e.message : e));
        setPhase("error");
      }
    } finally {
      if (running.current === current) running.current = null;
    }
  }, [configured, channel]);

  useEffect(() => {
    if (loaded && configured && autoCheck && !autoChecked.current) {
      void checkNow();
    }
  }, [loaded, configured, autoCheck, checkNow, channel]);

  const install = useCallback(async () => {
    const update = updateRef.current;
    const channel = candidateChannel.current;
    if (!update || !channel || channel !== selectedChannel.current || running.current !== null) return;
    const current = generation.current;
    running.current = current;
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
      if (current !== generation.current || channel !== selectedChannel.current) return;
      // 다운로드 중에는 집필을 허용하고, 저장부터 설치 종료까지 입력을 잠근다.
      lockRef.current = true;
      lockOwner.current = current;
      flushSync(() => setPhase("saving"));
      await prepareRef.current();
      if (current !== generation.current || channel !== selectedChannel.current) return;
      setPhase("installing");
      await update.install({ restartAfterInstall: true });
      if (current === generation.current && platformRef.current === "android") setPhase("available");
    } catch (e) {
      if (current === generation.current) {
        setError(String(e instanceof Error ? e.message : e));
        setPhase("error");
      }
    } finally {
      if (lockOwner.current === current) { lockRef.current = false; lockOwner.current = null; }
      if (running.current === current) running.current = null;
      if (current !== generation.current) await update.close().catch(() => {});
    }
  }, []);

  return {
    configured, platform, phase, available, error, progress, dismissed, lockRef,
    locked: phase === "saving" || phase === "installing",
    busy: ["checking", "downloading", "saving", "installing"].includes(phase),
    checkNow, install, dismiss: () => setDismissed(true),
  };
}

type Updater = ReturnType<typeof useAppUpdater>;

export function UpdateSettings({ updater, version, autoCheck, onAutoCheck, channel, onChannelChange }: {
  updater: Updater;
  version: string;
  autoCheck: boolean;
  onAutoCheck: (checked: boolean) => void;
  channel: UpdateChannel;
  onChannelChange: (channel: UpdateChannel) => void;
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
    <label className="update-channel-select">업데이트 채널
      <select value={channel} disabled={updater.busy} onChange={(event) => onChannelChange(updateChannel(event.target.value))}>
        <option value="stable">정식</option>
        <option value="rc">RC</option>
        <option value="beta">베타</option>
      </select>
    </label>
    <p className="settings-description">{channel === "stable" ? "확정 정식 버전만 받습니다." : channel === "rc" ? "정식과 RC(출시 후보) 중 최신 버전을 받습니다." : "정식·RC·베타 중 최신 버전을 받습니다."} 채널을 바꿔도 이전 버전으로 내려가지 않습니다.</p>
    <div className="updater-actions">
      <button type="button" disabled={!updater.configured || updater.busy} onClick={() => void updater.checkNow(true)}>
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
      <p className="settings-note">{updater.platform === "android"
        ? "설치 전에 원고와 메모를 저장합니다. Android 설치 화면에서 업데이트를 확인해 주세요. 처음에는 이 앱의 설치 허용이 필요할 수 있습니다."
        : "설치 전에 열린 원고와 메모를 저장합니다. 저장에 실패하면 설치를 중단합니다. 설치가 시작되면 앱이 종료되고 완료 후 다시 실행됩니다."}</p>
      <ReleaseNotesForVersion key={updater.available.version} version={updater.available.version} />
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
