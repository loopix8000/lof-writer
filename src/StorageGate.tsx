import { useCallback, useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FolderOpen } from "lucide-react";
import type { PinStatus } from "./PinSettings";
import { isAndroidApp } from "./tauri-bridge";
import { call } from "./types";

type Phase = "checking" | "access" | "preparing" | "notice" | "ready";

// Android 서재는 기기 폴더에만 두므로 모든 파일 접근 권한을 받은 뒤 서재를 열고 앱을 시작한다.
export default function StorageGate({ children }: { children: ReactNode }) {
  const android = isAndroidApp();
  const [phase, setPhase] = useState<Phase>(android ? "checking" : "ready");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [theme, setTheme] = useState<Pick<PinStatus, "theme" | "colorTheme"> | null>(null);

  const open = useCallback(async (request: boolean) => {
    setError("");
    try {
      const access = await invoke<{ granted?: boolean }>("android_storage_access", { request });
      if (!access?.granted) {
        setPhase("access");
        if (request) setError("모든 파일 접근을 허용해야 서재를 열 수 있습니다.");
        return;
      }
      setPhase("preparing");
      const result = await call<{ notice?: string | null }>("prepareAndroidLibrary");
      if (result?.notice) {
        setNotice(result.notice);
        setPhase("notice");
      } else {
        setPhase("ready");
      }
    } catch (e: any) {
      setError(e?.message || String(e));
      setPhase("access");
    }
  }, []);

  useEffect(() => {
    if (!android) return;
    void call<PinStatus>("pinStatus").then(setTheme).catch(() => {});
    void open(false);
  }, [android, open]);

  if (phase === "ready") return <>{children}</>;
  return (
    <div className={`app pin-screen ${theme?.theme === "dark" ? "dark" : ""} ${theme?.colorTheme === "bakery" ? "bakery" : ""}`}>
      <main className="pin-screen-main">
        <div className="pin-card" aria-live="polite">
          <div className="pin-symbol"><FolderOpen size={28} /></div>
          {phase === "notice" ? <>
            <h1>서재를 열었습니다</h1>
            <p>{notice}</p>
            <button className="primary" type="button" onClick={() => setPhase("ready")}>계속</button>
          </> : phase === "access" ? <>
            <h1>저장공간 접근 허용</h1>
            <p>
              원고는 기기의 Documents 폴더에 Markdown 파일로 보관됩니다.
              앱을 삭제해도 남고, 파일 관리자와 다른 앱에서도 열 수 있습니다.
              다음 화면에서 Lof Writer의 "모든 파일 접근"을 허용해 주세요.
            </p>
            <button className="primary" type="button" onClick={() => void open(true)}>권한 허용하기</button>
          </> : <>
            <h1>서재를 여는 중…</h1>
            <p>앱에 보관하던 서재가 있으면 기기 폴더로 옮깁니다. 잠시 기다려 주세요.</p>
          </>}
          {error && <p className="pin-error" role="alert">{error}</p>}
        </div>
      </main>
    </div>
  );
}
