import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Fingerprint, LockKeyhole } from "lucide-react";
import { useConfirm } from "./ConfirmDialog";
import { isAndroidApp } from "./tauri-bridge";
import { call } from "./types";

export type PinStatus = {
  enabled: boolean;
  locked: boolean;
  generation: number;
  biometricEnabled?: boolean;
  theme?: string;
  colorTheme?: string;
};

export const pinDigits = (value: string) => value.replace(/\D/g, "").slice(0, 12);
type BiometricStatus = { available: boolean; reason: string };

export default function PinSettings() {
  const [status, setStatus] = useState<PinStatus | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [biometric, setBiometric] = useState<BiometricStatus | null>(null);
  const [askBiometric, biometricDialog] = useConfirm();
  const mounted = useRef(false);
  const saving = useRef(false);
  const android = isAndroidApp();
  useEffect(() => {
    let alive = true;
    mounted.current = true;
    call<PinStatus>("pinStatus").then((value) => { if (alive) setStatus(value); })
      .catch((e) => { if (alive) setError(e.message); });
    const refreshBiometric = () => {
      if (!android || document.visibilityState !== "visible") return;
      void invoke<BiometricStatus>("android_biometric_status")
      .then((value) => { if (alive) setBiometric(value); })
      .catch(() => { if (alive) setBiometric({ available: false, reason: "지문 사용 가능 여부를 확인하지 못했습니다." }); });
    };
    refreshBiometric();
    document.addEventListener("visibilitychange", refreshBiometric);
    return () => { alive = false; mounted.current = false; document.removeEventListener("visibilitychange", refreshBiometric); };
  }, [android]);
  async function saveBiometric(enabled: boolean) {
    const updated = await invoke<PinStatus | null>("android_biometric_set_enabled", { enabled });
    if (updated && mounted.current) {
      setStatus(updated);
      setNotice(enabled ? "지문 잠금 해제를 켰습니다. PIN으로도 잠금을 해제할 수 있습니다." : "지문 잠금 해제를 껐습니다.");
    }
  }
  async function toggleBiometric() {
    if (saving.current) return;
    saving.current = true;
    setBusy(true); setError(""); setNotice("");
    try { await saveBiometric(!status?.biometricEnabled); }
    catch (e: any) { if (mounted.current) setError(e.message || String(e)); }
    finally { saving.current = false; if (mounted.current) setBusy(false); }
  }
  async function save(disable = false) {
    if (saving.current) return;
    setError("");
    setNotice("");
    if (!disable && (!/^[0-9]{4,12}$/.test(next) || next !== confirm)) {
      setError(next !== confirm ? "새 PIN과 확인 번호가 일치하지 않습니다." : "PIN은 4~12자리 숫자로 입력해 주세요.");
      return;
    }
    saving.current = true; setBusy(true);
    try {
      const firstPin = !status?.enabled && !disable;
      const saved = await call<PinStatus>("pinSave", {
        currentPin: current, newPin: disable ? null : next, confirmPin: disable ? null : confirm,
      });
      if (!mounted.current) return;
      setStatus(saved);
      setCurrent(""); setNext(""); setConfirm("");
      setNotice(disable ? "PIN 잠금을 해제했습니다." : android ? "PIN을 저장했습니다." : "PIN을 저장했습니다. 다음 앱 시작과 트레이 복원부터 적용됩니다.");
      if (firstPin && android && !saved.locked && document.visibilityState === "visible") {
        (document.activeElement as HTMLElement | null)?.blur();
        const capability = await invoke<BiometricStatus>("android_biometric_status").catch(() => null);
        if (!mounted.current || document.visibilityState !== "visible") return;
        if (capability) setBiometric(capability);
        if (capability?.available && await askBiometric({
          title: "지문도 사용할까요?",
          message: "지문으로 더 간편하게 잠금을 해제할 수 있습니다. PIN도 계속 사용할 수 있습니다.",
          confirmLabel: "지문 사용", cancelLabel: "나중에", icon: <Fingerprint size={18} />,
        }) && mounted.current && document.visibilityState === "visible") await saveBiometric(true);
      }
    } catch (e: any) {
      if (mounted.current) setError(e.message || String(e));
    } finally {
      saving.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return <>
    <h3><LockKeyhole size={18} />PIN 잠금</h3>
    <p className="settings-description">{android ? "PIN을 설정하면 앱을 시작하거나 다른 앱에서 돌아올 때 인증합니다." : "PIN을 설정하면 앱을 시작하거나 트레이에서 다시 열 때 인증합니다. 최소화 후 복원할 때는 다시 묻지 않습니다."}</p>
    <p className="settings-note">앱 화면을 잠그는 편의 기능입니다. 로컬 원고 파일을 암호화하거나 MCP / API 접근을 제한하지 않습니다.</p>
    <p className="muted">{status ? (status.enabled ? "PIN 잠금 사용 중" : "PIN 잠금 사용 안 함") : "PIN 설정 확인 중…"}</p>
    <form className="pin-settings-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      {status?.enabled && <label>현재 PIN
        <input type="password" inputMode="numeric" autoComplete="off" maxLength={12} required
          aria-label="현재 PIN" value={current} disabled={busy} onChange={(e) => setCurrent(pinDigits(e.target.value))} />
      </label>}
      <label>{status?.enabled ? "새 PIN" : "PIN"}
        <input type="password" inputMode="numeric" autoComplete="new-password" minLength={4} maxLength={12} required
          aria-label="새 PIN" placeholder="4~12자리 숫자" value={next} disabled={busy}
          onChange={(e) => setNext(pinDigits(e.target.value))} />
      </label>
      <label>PIN 확인
        <input type="password" inputMode="numeric" autoComplete="new-password" minLength={4} maxLength={12} required
          aria-label="PIN 확인" value={confirm} disabled={busy} onChange={(e) => setConfirm(pinDigits(e.target.value))} />
      </label>
      {error && <p className="pin-error" role="alert">{error}</p>}
      {notice && <p className="muted" role="status">{notice}</p>}
      <div className="row gap">
        <button className="primary" type="submit" disabled={busy || !status}>{busy ? "처리 중…" : status?.enabled ? "PIN 변경" : "PIN 설정"}</button>
        {status?.enabled && <button type="button" disabled={busy || !current} onClick={() => void save(true)}>PIN 잠금 해제</button>}
      </div>
    </form>
    {android && <div className="pin-biometric-settings">
      <label className="settings-toggle">
        <span><Fingerprint size={18} /> 지문으로 잠금 해제</span>
        <input type="checkbox" role="switch" checked={Boolean(status?.enabled && status.biometricEnabled)}
          disabled={busy || !status?.enabled || (!status.biometricEnabled && !biometric?.available)}
          onChange={() => void toggleBiometric()} />
      </label>
      <p className="settings-description">{!status?.enabled ? "PIN을 설정한 뒤 사용할 수 있습니다." : biometric?.reason || "기기에 등록된 지문 등 생체 인증을 사용합니다. PIN으로도 잠금을 해제할 수 있습니다."}</p>
    </div>}
    {biometricDialog}
  </>;
}
