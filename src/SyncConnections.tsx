import { useState, type Dispatch, type SetStateAction } from "react";
import { Link, RefreshCw, X } from "lucide-react";
import SettingsToggle from "./app/SettingsToggle";
import { call, type AutoSyncStatus, type SyncConnection } from "./types";
const labels = { idle: "동기화 완료", pending: "동기화 대기", syncing: "동기화 중", error: "동기화 재시도 대기" };
const PRESET_SECONDS = [60, 180, 300, 600, 900, 1800, 3600];
export default function SyncConnections({
  connections,
  setConnections,
  autoSync,
  intervalSeconds,
  onIntervalChange,
  backgroundEnabled = true,
  backgroundIntervalSeconds = 300,
  onBackgroundSyncChange,
  busy,
  setBusy,
  onSync,
  message,
  report,
}: {
  connections: SyncConnection[];
  setConnections: Dispatch<SetStateAction<SyncConnection[]>>;
  autoSync: AutoSyncStatus;
  intervalSeconds: number;
  onIntervalChange: (seconds: number) => Promise<unknown>;
  backgroundEnabled?: boolean;
  backgroundIntervalSeconds?: number;
  onBackgroundSyncChange?: (patch: { backgroundSyncEnabled?: boolean; backgroundSyncIntervalSeconds?: number }) => Promise<unknown>;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onSync: (id: string) => Promise<void>;
  message: (message: string) => void;
  report: (error: any) => void;
}) {
  const isAndroid = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
  const [connectionType, setConnectionType] = useState(isAndroid ? "webdav" : "folder");
  const status = autoSync.channels?.files ?? { phase: "idle", message: "" };
  const attempt = (action: () => Promise<unknown>) => () => { void action().catch(report); };
  const reload = async () => { setConnections((await call("settings")).connections); };
  const bgMinutes = Math.max(1, Math.min(60, Math.round(backgroundIntervalSeconds / 60)));
  const hasCustomBgInterval = backgroundEnabled && !PRESET_SECONDS.includes(backgroundIntervalSeconds);
  return <fieldset className="sync-connections" disabled={busy}>
    <p className="settings-description">로컬 폴더·WebDAV·FTP 저장소와 서재의 Markdown 원본, 작품 정보, 이미지·첨부 파일을 폴더 구조 그대로 동기화합니다. 앱 실행 시와 트레이에서 열 때, 설정한 주기마다 변경을 확인합니다.</p>
    <div className="settings-grid">
      <label className="connection-conflict-policy">자동 동기화 주기<select aria-label="파일 자동 동기화 주기" value={intervalSeconds} onChange={event => onIntervalChange(Number(event.target.value)).catch(report)}>
        <option value={60}>1분</option><option value={180}>3분</option><option value={300}>5분 (기본)</option><option value={600}>10분</option><option value={900}>15분</option><option value={1800}>30분</option><option value={3600}>1시간</option>
      </select></label>
      {onBackgroundSyncChange && (
        <label className="connection-conflict-policy">
          백그라운드 동기화 주기
          <select
            aria-label="백그라운드 동기화 주기"
            value={backgroundEnabled ? String(backgroundIntervalSeconds) : "off"}
            onChange={event => {
              const val = event.target.value;
              if (val === "off") {
                onBackgroundSyncChange({ backgroundSyncEnabled: false }).catch(report);
              } else {
                onBackgroundSyncChange({
                  backgroundSyncEnabled: true,
                  backgroundSyncIntervalSeconds: Number(val),
                }).catch(report);
              }
            }}
          >
            <option value="off">끄기 (사용 안 함)</option>
            <option value="60">1분</option>
            <option value="180">3분</option>
            <option value="300">5분 (기본)</option>
            <option value="600">10분</option>
            <option value="900">15분</option>
            <option value="1800">30분</option>
            <option value="3600">1시간 (60분)</option>
            {hasCustomBgInterval && (
              <option value={String(backgroundIntervalSeconds)}>{bgMinutes}분 (직접 설정)</option>
            )}
          </select>
        </label>
      )}
      {onBackgroundSyncChange && backgroundEnabled && (
        <label className="connection-conflict-policy">
          백그라운드 주기 직접 입력 (1~60분)
          <input
            type="number"
            aria-label="백그라운드 동기화 주기 (분)"
            min={1}
            max={60}
            value={bgMinutes}
            onChange={event => {
              const mins = Number(event.target.value);
              if (Number.isFinite(mins) && mins >= 1 && mins <= 60) {
                onBackgroundSyncChange({
                  backgroundSyncEnabled: true,
                  backgroundSyncIntervalSeconds: Math.round(mins) * 60,
                }).catch(report);
              }
            }}
          />
        </label>
      )}
    </div>
    {onBackgroundSyncChange && (
      <div className="settings-toggles" style={{ marginTop: 10, marginBottom: 10 }}>
        <SettingsToggle
          label="백그라운드 동기화 사용"
          description="앱이 백그라운드 상태일 때도 설정한 주기(1분~1시간, 기본값 5분)마다 동기화합니다. 끄면 백그라운드에서 주기적 동기화를 수행하지 않습니다."
          checked={backgroundEnabled}
          onChange={checked => onBackgroundSyncChange({ backgroundSyncEnabled: checked }).catch(report)}
        />
      </div>
    )}
    <p className="settings-note">원고를 수동 저장하거나 ‘동기화’를 누르면 주기를 기다리지 않고 바로 실행합니다.</p>
    {connections.length > 0 && <p role="status" aria-live="off" className={status.phase === "error" ? "pin-error" : "muted"}>{labels[status.phase]}{status.message && ` · ${status.message}`}</p>}
    {connections.length === 0 && <p className="sync-empty">연결된 파일 저장소가 없습니다.</p>}
    {connections.map(connection => <div className="connection" key={connection.id}>
      <div><b>{connection.name}</b><small>{connection.type === "folder" ? connection.folder : connection.url || connection.host}</small>
        <label className="connection-conflict-policy">충돌 사본 처리<select aria-label={`${connection.name} 충돌 사본 처리`} value={connection.conflictPolicy ?? "keepBoth"} disabled={busy || autoSync.phase === "syncing"} onChange={event => {
          const conflictPolicy = event.target.value;
          attempt(async () => { setBusy(true); try { const updated = await call("setSyncConflictPolicy", { id: connection.id, conflictPolicy }); setConnections(current => current.map(item => item.id === connection.id ? updated : item)); } finally { setBusy(false); } })();
        }}><option value="latest">최신본으로 덮어쓰기</option><option value="keepBoth">파일명을 바꿔 둘 다 보존</option></select></label>
      </div>
      <button disabled={busy || autoSync.phase === "syncing"} onClick={() => onSync(connection.id)}><RefreshCw size={15} />{busy ? "진행 중" : "동기화"}</button>
      <button disabled={busy} title="연결 제거 (원격 파일 보존)" aria-label={`${connection.name} 연결 제거`} onClick={attempt(async () => { await call("removeConnection", { id: connection.id }); await reload(); })}><X size={15} /></button>
    </div>)}
    <form className="connection-form" onSubmit={event => {
      event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget));
      void (async () => { setBusy(true); try { await call("saveConnection", { ...data, type: connectionType, secure: data.secure === "on" }); await reload(); message("연결을 추가했습니다. 자동 동기화를 시작합니다."); } finally { setBusy(false); } })().catch(report);
    }}>
      <div className="row gap"><select aria-label="파일 저장소 연결 방식" disabled={busy} value={connectionType} onChange={event => setConnectionType(event.target.value)}><option value="folder">로컬 폴더</option><option value="webdav">WebDAV</option><option value="ftp">FTP / FTPS</option></select><input name="name" aria-label="연결 이름" placeholder="연결 이름" disabled={busy} /></div>
      {(connectionType === "webdav" || connectionType === "ftp") && <>
        <input name={connectionType === "webdav" ? "url" : "host"} aria-label="서버 주소" required placeholder={connectionType === "webdav" ? "https://nas.example.com/dav" : "FTP 호스트"} />
        <div className="row gap"><input name="username" aria-label="사용자 이름" placeholder="사용자 이름" autoComplete="off" /><input name="password" aria-label="비밀번호" type="password" placeholder="비밀번호" autoComplete="off" /></div>
        <input name="remotePath" aria-label="원격 폴더" placeholder="원격 폴더 (예: /writing)" />
        {connectionType === "ftp" && <div className="row gap"><input name="port" aria-label="FTP 포트" type="number" placeholder="포트 (기본 21)" /><label className="checkbox"><input type="checkbox" name="secure" defaultChecked />FTPS</label></div>}
      </>}
      <button disabled={busy} type="submit"><Link size={15} />{connectionType === "folder" ? "동기화 폴더 선택" : "연결 추가"}</button>
    </form>
  </fieldset>;
}
