import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Fingerprint, LockKeyhole, Minus, X } from "lucide-react";
import App from "./App";
import { pinDigits, type PinStatus } from "./PinSettings";
import { isAndroidApp } from "./tauri-bridge";
import { call } from "./types";

export default function PinGate() {
  const [status, setStatus] = useState<PinStatus | null>(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const authBusy = useRef(false);
  const latestStatus = useRef(status);
  latestStatus.current = status;
  const biometricAttempt = useRef<number | null>(null);
  const [visible, setVisible] = useState(document.visibilityState === "visible");
  const locked = status?.locked ?? true;
  const updateStatus = useCallback((next: PinStatus) => {
    setStatus((previous) => {
      if (previous && (next.generation < previous.generation ||
        (next.generation === previous.generation && !previous.locked && next.locked))) return previous;
      return next;
    });
  }, []);
  useEffect(() => {
    let alive = true;
    let off: (() => void) | undefined;
    void (async () => {
      const unlisten = await listen<PinStatus>("lof:pin-state", (event) => {
        if (alive) updateStatus(event.payload);
      });
      if (!alive) { unlisten(); return; }
      off = unlisten;
      const initial = await call<PinStatus>("pinStatus");
      if (alive) updateStatus(initial);
    })().catch((e) => { if (alive) setError(e.message || String(e)); });
    return () => { alive = false; off?.(); };
  }, [updateStatus]);
  useLayoutEffect(() => {
    document.documentElement.dataset.pinLocked = String(locked);
    if (locked) {
      if (!(isAndroidApp() && status?.biometricEnabled)) input.current?.focus();
    }
    else window.dispatchEvent(new Event("resize"));
  }, [locked, status?.generation]);
  useEffect(() => {
    const update = () => {
      const visible = document.visibilityState === "visible";
      if (!visible) { biometricAttempt.current = null; setPin(""); }
      setVisible(visible);
    };
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const unlockBiometric = useCallback(async () => {
    if (authBusy.current || !latestStatus.current?.locked) return;
    authBusy.current = true;
    const generation = latestStatus.current.generation;
    let usePin = false;
    setBusy(true); setError("");
    try {
      const result = await invoke<PinStatus | null>("android_biometric_unlock");
      if (result) updateStatus(result);
      else usePin = true;
    } catch (e: any) {
      if (latestStatus.current?.generation === generation) setError(e.message || String(e));
      usePin = true;
    } finally {
      authBusy.current = false;
      setBusy(false);
      // disabled 중인 입력칸은 focus를 받지 못하므로 렌더링이 끝난 뒤 옮긴다.
      if (usePin) requestAnimationFrame(() => {
        if (!authBusy.current && document.visibilityState === "visible" && latestStatus.current?.locked &&
            latestStatus.current.generation === generation) input.current?.focus();
      });
    }
  }, [updateStatus]);
  useEffect(() => {
    if (!isAndroidApp() || !status?.locked || !status.biometricEnabled || !visible || busy ||
        biometricAttempt.current === status.generation) return;
    biometricAttempt.current = status.generation;
    void unlockBiometric();
  }, [status, visible, busy, unlockBiometric]);
  useEffect(() => {
    setPin(""); setError("");
  }, [locked, status?.generation]);
  useEffect(() => {
    // 잠금 화면이 DOM에 반영된 다음 숨겨진 창을 다시 표시한다.
    if (status?.locked) void call("pinReady", { generation: status.generation }).catch((e) => setError(e.message));
  }, [status]);
  async function unlock() {
    if (!status || authBusy.current) return;
    authBusy.current = true;
    const generation = status.generation;
    setBusy(true); setError("");
    try {
      updateStatus(await call<PinStatus>("pinUnlock", { pin }));
    } catch (e: any) {
      if (latestStatus.current?.generation === generation) setError(e.message || String(e));
    } finally {
      authBusy.current = false;
      setPin(""); setBusy(false);
      requestAnimationFrame(() => {
        if (!authBusy.current && document.visibilityState === "visible" && latestStatus.current?.locked &&
            latestStatus.current.generation === generation) input.current?.focus();
      });
    }
  }
  return <>
    <div hidden={locked} inert={locked} aria-hidden={locked}><App /></div>
    {(status?.locked || (!status && error)) && <div className={`app pin-screen ${status?.theme === "dark" ? "dark" : ""} ${status?.colorTheme === "bakery" ? "bakery" : ""}`}
      onKeyDown={(e) => e.stopPropagation()}>
      {/* Android는 시스템이 창을 관리하므로 PC 창 제목 막대를 두지 않는다. */}
      {!isAndroidApp() && <header className="pin-titlebar" data-tauri-drag-region onMouseDown={(e) => {
        if (e.button === 0 && !(e.target as HTMLElement).closest("button")) void window.lof.windowStartDragging?.();
      }}>
        <span data-tauri-drag-region>Lof Writer</span>
        <div className="window-controls">
          <button className="window-control" type="button" aria-label="최소화" onClick={() => void window.lof.windowMinimize?.()}><Minus size={14} /></button>
          <button className="window-control close" type="button" aria-label="트레이로 숨기기" onClick={() => void window.lof.windowClose?.()}><X size={14} /></button>
        </div>
      </header>}
      <main className="pin-screen-main">
        <form className="pin-card" onSubmit={(e) => { e.preventDefault(); void unlock(); }} aria-labelledby="pin-heading">
          {status?.locked && <div className="pin-symbol"><LockKeyhole size={28} /></div>}
          <h1 id="pin-heading">{status?.locked ? "잠금 해제" : "Lof Writer"}</h1>
          <p>{status?.locked ? status.biometricEnabled && isAndroidApp() ? "지문 또는 PIN으로 잠금을 해제해 주세요." : "계속하려면 설정한 PIN을 입력해 주세요." : "잠금 설정을 불러오지 못했습니다."}</p>
          {status?.locked && <>
            {isAndroidApp() && status.biometricEnabled && <button type="button" disabled={busy}
              onClick={() => void unlockBiometric()}><Fingerprint size={20} />지문으로 잠금 해제</button>}
            <label className="pin-input-label">PIN
              <input ref={input} type="password" inputMode="numeric" autoComplete="off" minLength={4} maxLength={12} required
                value={pin} disabled={busy} onChange={(e) => setPin(pinDigits(e.target.value))} aria-label="잠금 해제 PIN" />
            </label>
            <button className="primary" disabled={busy || pin.length < 4} type="submit">{busy ? "확인 중…" : "잠금 해제"}</button>
          </>}
          {error && <p className="pin-error" role="alert">{error}</p>}
        </form>
      </main>
    </div>}
  </>;
}
