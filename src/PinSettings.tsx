import { useEffect, useState } from "react";
import { LockKeyhole } from "lucide-react";
import { call } from "./types";

export type PinStatus = {
  enabled: boolean;
  locked: boolean;
  generation: number;
  theme?: string;
  colorTheme?: string;
};

export const pinDigits = (value: string) => value.replace(/\D/g, "").slice(0, 12);

export default function PinSettings() {
  const [status, setStatus] = useState<PinStatus | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let alive = true;
    call<PinStatus>("pinStatus").then((value) => { if (alive) setStatus(value); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, []);
  async function save(disable = false) {
    setError("");
    setNotice("");
    if (!disable && (!/^[0-9]{4,12}$/.test(next) || next !== confirm)) {
      setError(next !== confirm ? "새 PIN과 확인 번호가 일치하지 않습니다." : "PIN은 4~12자리 숫자로 입력해 주세요.");
      return;
    }
    setBusy(true);
    try {
      setStatus(await call<PinStatus>("pinSave", {
        currentPin: current, newPin: disable ? null : next, confirmPin: disable ? null : confirm,
      }));
      setCurrent(""); setNext(""); setConfirm("");
      setNotice(disable ? "PIN 잠금을 해제했습니다." : "PIN을 저장했습니다. 다음 앱 시작과 트레이 복원부터 적용됩니다.");
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }
  return <>
    <h3><LockKeyhole size={18} />PIN 잠금</h3>
    <p className="settings-description">PIN을 설정하면 앱을 시작하거나 트레이에서 다시 열 때 인증합니다. 최소화 후 복원할 때는 다시 묻지 않습니다.</p>
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
  </>;
}
