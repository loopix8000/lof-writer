import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertCircle, Battery } from "lucide-react";
import SettingsToggle from "./app/SettingsToggle";
import { useConfirm } from "./ConfirmDialog";
import { openBackgroundBatterySettings } from "./tauri-bridge";
import { call } from "./types";

function Minutes({ label, value, min, max, hint, onSave }: {
  label: string; value: number; min: number; max: number; hint: string;
  onSave: (value: number) => Promise<void>;
}) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState("");
  useEffect(() => { setDraft(String(value)); setError(""); }, [value]);
  const commit = async () => {
    const number = Number(draft);
    if (!draft.trim() || !Number.isInteger(number) || number < min || number > max) {
      setError(`${min}~${max} 사이의 정수를 입력해 주세요.`);
      return;
    }
    if (number !== value) {
      try { await onSave(number); }
      catch { setError("설정이 저장되지 않았습니다. 다시 시도해 주세요."); }
    }
  };
  return <label>{label}
    <span className="background-sync-number">
      <input type="number" inputMode="numeric" aria-label={label} aria-invalid={!!error}
        min={min} max={max} step={1} value={draft}
        onChange={event => { setDraft(event.target.value); setError(""); }}
        onBlur={() => void commit()}
        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} />
      <span>분</span>
    </span>
    <small className={error ? "pin-error" : "settings-note"}>{error || hint}</small>
  </label>;
}

export default function BackgroundSyncSettings({ prefs, savePrefs, report }: {
  prefs: Record<string, any>; savePrefs: (patch: Record<string, any>) => Promise<void>;
  report?: (error: any) => void;
}) {
  const enabled = prefs.backgroundSyncEnabled !== false;
  const always = prefs.backgroundLiveMode === "always";
  const minutes = Number.isInteger(prefs.backgroundLiveMinutes) && prefs.backgroundLiveMinutes >= 1
    ? Math.min(prefs.backgroundLiveMinutes, 120) : 30;
  const interval = Math.max(15, Math.min(60, Math.round((prefs.backgroundSyncIntervalSeconds ?? 900) / 60)));
  const notification = prefs.backgroundKeepAlive === "off" ? "off"
    : always || prefs.backgroundKeepAlive === "always" ? "always" : "live";
  const [exempt, setExempt] = useState<boolean | null>(null);
  const [confirm, dialog] = useConfirm();
  const mounted = useRef(false);
  const enabling = useRef(false);
  const query = async () => {
    const result = await invoke<{ exempt: boolean }>("android_background_battery", { open: false });
    if (mounted.current) setExempt(result.exempt);
    return result.exempt;
  };
  useEffect(() => {
    mounted.current = true;
    const refresh = () => {
      if (document.visibilityState === "visible") void query().catch(() => { if (mounted.current) setExempt(null); });
    };
    refresh();
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      mounted.current = false;
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  const save = async (patch: Record<string, any>) => {
    try { await savePrefs(patch); } catch (error) { report?.(error); throw error; }
  };
  const openBattery = async () => {
    const result = await openBackgroundBatterySettings();
    if (mounted.current) setExempt(result.exempt);
  };
  const enable = async (checked: boolean) => {
    if (enabling.current) return;
    enabling.current = true;
    try {
      await savePrefs({ backgroundSyncEnabled: checked });
      if (checked && mounted.current && !await query() && mounted.current) {
        const open = await confirm({ title: "배터리 절전 예외 설정",
          message: "백그라운드 동기화가 멈추지 않도록 Lof Writer를 배터리 절전 예외로 설정해 주세요.",
          detail: "다음 시스템 화면에서 배터리 최적화 해제를 허용해 주세요. 앱 설정이 열리면 배터리 제한을 해제해 주세요. 나중에 설정해도 동기화는 켜집니다.",
          confirmLabel: "설정 열기", cancelLabel: "나중에", icon: <Battery size={20} /> });
        if (open && mounted.current) await openBattery();
      }
      if (checked && mounted.current && notification !== "off") await call("backgroundNotifications");
    } catch (error) { report?.(error); }
    finally { enabling.current = false; }
  };
  return <div className="realtime-bg-sync-box">
    <h4>백그라운드 동기화 설정</h4>
    <p className="settings-description">앱을 벗어난 뒤 즉시 동기화를 유지할 시간과 상태 알림을 설정합니다.</p>
    <div className="settings-toggles">
      <SettingsToggle label="백그라운드 동기화 사용" description="끄면 앱을 벗어난 동안 동기화를 멈춥니다."
        checked={enabled} onChange={checked => void enable(checked)} />
    </div>
    {enabled && <div className="background-sync-options">
      <label>즉시 동기화 유지
        <select value={always ? "always" : "timed"} onChange={event => void save({ backgroundLiveMode: event.target.value }).catch(() => {})}>
          <option value="timed">시간 지정</option><option value="always">계속 유지</option>
        </select>
      </label>
      {!always && <div className="settings-grid">
        <Minutes label="유지 시간" value={minutes} min={1} max={120} hint="1~120분 · 기본값 30분"
          onSave={value => save({ backgroundLiveMinutes: value })} />
        <Minutes label="이후 확인 주기" value={interval} min={15} max={60} hint="15~60분 · 기본값 15분"
          onSave={value => save({ backgroundSyncIntervalSeconds: value * 60 })} />
      </div>}
      <p className="settings-note">{always
        ? "앱에서 연결을 자동으로 종료하지 않고 변경 내용을 바로 동기화합니다. 배터리 사용량이 늘어날 수 있습니다."
        : `처음 ${minutes}분 동안 변경 내용을 바로 동기화하고, 이후에는 ${interval}분마다 확인합니다.`}</p>
      <label>동기화 상태 알림
        <select value={notification} onChange={event => {
          const value = event.target.value;
          void save({ backgroundKeepAlive: value }).then(() => {
            if (value !== "off") return call("backgroundNotifications");
          }).catch(() => {});
        }}>
          {!always && <option value="live">유지 시간 동안 표시 ({minutes}분)</option>}
          <option value="always">{always ? "켜두기" : "계속 켜두기"}</option>
          <option value="off">끄기</option>
        </select>
      </label>
      {notification === "off" && <p className="background-sync-warning" role="note"><AlertCircle size={16} />
        <span>알림을 끄면 Android가 앱을 중지해 동기화가 지연되거나 멈출 수 있습니다.</span>
      </p>}
      {!always && notification === "always" && <p className="settings-note">알림을 계속 켜도 유지 시간 뒤에는 주기 동기화로 전환합니다.</p>}
      <div className="background-sync-battery">
        <div><strong>배터리 절전 예외</strong><small>{exempt === true ? "절전 예외가 허용되어 있습니다." : exempt === false ? "Lof Writer의 배터리 제한을 해제해 주세요." : "기기 설정에서 배터리 제한을 확인할 수 있습니다."}</small></div>
        <button type="button" onClick={() => void openBattery().catch(error => report?.(error))}>
          <Battery size={15} />설정 열기
        </button>
      </div>
      <p className="settings-note">기기의 절전·실행 제한에 따라 연결이 중단되거나 확인 시각이 늦어질 수 있습니다.</p>
    </div>}
    {dialog}
  </div>;
}
