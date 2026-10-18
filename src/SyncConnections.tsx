import { useState, type Dispatch, type SetStateAction } from "react";
import { Link, RefreshCw, X } from "lucide-react";
import { call, type AutoSyncStatus, type SyncConnection } from "./types";

const autoSyncLabels = { idle: "동기화 완료", pending: "동기화 대기", syncing: "동기화 중", error: "동기화 재시도 대기" };

// 연결 정보와 동작은 공유하고 파일 저장소와 서버의 화면·전송 정책은 분리한다.
export default function SyncConnections({ mode, connections, setConnections, autoSync, intervalSeconds,
  onIntervalChange, busy, setBusy, onSync, message, report }: {
  mode: "files" | "server";
  connections: SyncConnection[];
  setConnections: Dispatch<SetStateAction<SyncConnection[]>>;
  autoSync: AutoSyncStatus;
  intervalSeconds: number;
  onIntervalChange: (seconds: number) => Promise<unknown>;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onSync: (id: string) => Promise<void>;
  message: (message: string) => void;
  report: (error: any) => void;
}) {
  const server = mode === "server";
  const [connectionType, setConnectionType] = useState("folder");
  const [libraryChoices, setLibraryChoices] = useState<Record<string, { id: string; name: string }[]>>({});
  const visibleConnections = connections.filter((connection) => (connection.type === "library") === server);
  const status = autoSync.channels?.[mode] ?? { phase: "idle", message: "" };
  const attempt = (action: () => Promise<unknown>) => () => { void action().catch(report); };
  async function reloadConnections() {
    setConnections((await call("settings")).connections);
  }
  return <fieldset className="sync-connections" disabled={busy}>
    {server ? (
      <div className="sync-schedule">
        <strong>변경이 있을 때만 5초 간격으로 전송</strong>
        <p>저장된 파일의 변경을 감지해 다음 전송 시점에 반영합니다. 변경이 없으면 파일을 재검사하거나 동기화 요청을 보내지 않습니다. 다른 기기의 변경은 서버 알림을 받으면 바로 확인합니다.</p>
      </div>
    ) : (
      <>
        <p className="settings-description">로컬 폴더·WebDAV·FTP 저장소와 파일을 동기화합니다. 앱 실행 시와 트레이에서 열 때, 설정한 주기마다 변경을 확인합니다.</p>
        <label className="connection-conflict-policy">
          자동 동기화 주기
          <select aria-label="파일 자동 동기화 주기" value={intervalSeconds}
            onChange={(event) => onIntervalChange(Number(event.target.value)).catch(report)}>
            <option value={60}>1분 (기본)</option>
            <option value={300}>5분</option>
            <option value={600}>10분</option>
            <option value={900}>15분</option>
            <option value={1800}>30분</option>
            <option value={3600}>1시간</option>
          </select>
        </label>
        <p className="settings-note">파일 저장소에만 적용됩니다. 원고를 수동 저장하거나 ‘동기화’를 누르면 바로 실행합니다.</p>
      </>
    )}
    <aside className="sync-notice" aria-label="동기화 이용 안내">
      <strong>동기화는 아직 불안정할 수 있으니 중요한 원고는 따로 백업해 주세요.</strong>
      <p>모든 기기를 최신 버전으로 업데이트해야 하며, 수정 이력은 기기마다 따로 보관합니다.</p>
    </aside>
    {visibleConnections.length > 0 && <p role="status" aria-live="off" className={status.phase === "error" ? "pin-error" : "muted"}>
      {autoSyncLabels[status.phase]}{status.message && ` · ${status.message}`}
    </p>}
    {visibleConnections.length === 0 && <p className="sync-empty">{server ? "연결된 서버가 없습니다. 아래에서 서버를 연결하세요." : "연결된 파일 저장소가 없습니다."}</p>}
    {visibleConnections.map((c) => (
      <div className="connection" key={c.id}>
        <div>
          <b>{c.name}</b>
          <small>
            {c.type === "folder" ? c.folder
              : c.type === "library" ? `${c.url} · ${c.libraryName || "서재 선택 필요"}`
              : c.url || c.host}
          </small>
          {c.type === "library" && !c.libraryId && (
            <form className="row gap library-choice" onSubmit={(event) => {
              event.preventDefault();
              const choice = String(new FormData(event.currentTarget).get("library") ?? "");
              attempt(async () => {
                setBusy(true);
                try {
                  const updated = await call("libraryChoose", choice === "__new__" ? { id: c.id, create: true } : { id: c.id, libraryId: choice });
                  setConnections((current) => current.map((connection) => connection.id === c.id ? updated : connection));
                  message(`서버의 ‘${updated.libraryName}’ 서재와 동기화를 시작합니다.`);
                } finally { setBusy(false); }
              })();
            }}>
              <select name="library" aria-label={`${c.name} 서버 서재`} disabled={busy}
                onFocus={() => {
                  if (libraryChoices[c.id]) return;
                  call("libraryList", { id: c.id })
                    .then((list) => setLibraryChoices((current) => ({ ...current, [c.id]: list })))
                    .catch(report);
                }}>
                {(libraryChoices[c.id] ?? []).map((library) => <option key={library.id} value={library.id}>{library.name}</option>)}
                <option value="__new__">이 서재 이름으로 새로 만들기</option>
              </select>
              <button type="submit" disabled={busy}>서재 연결</button>
            </form>
          )}
          <label className="connection-conflict-policy">
            충돌 사본 처리
            <select aria-label={`${c.name} 충돌 사본 처리`} value={c.conflictPolicy ?? "keepBoth"}
              disabled={busy || autoSync.phase === "syncing"}
              onChange={(event) => {
                const conflictPolicy = event.target.value;
                attempt(async () => {
                  setBusy(true);
                  try {
                    const updated = await call("setSyncConflictPolicy", { id: c.id, conflictPolicy });
                    setConnections((current) => current.map((connection) => connection.id === c.id ? updated : connection));
                  } finally { setBusy(false); }
                })();
              }}>
              <option value="latest">최신본으로 덮어쓰기</option>
              <option value="keepBoth">파일명을 바꿔 둘 다 보존</option>
            </select>
          </label>
        </div>
        <button disabled={busy || autoSync.phase === "syncing"} onClick={() => onSync(c.id)}>
          <RefreshCw size={15} />
          {busy ? "진행 중" : "동기화"}
        </button>
        <button
          disabled={busy}
          title="연결 제거 (원격 파일 보존)"
          aria-label={`${c.name} 연결 제거`}
          onClick={attempt(async () => {
            await call("removeConnection", { id: c.id });
            await reloadConnections();
          })}
        >
          <X size={15} />
        </button>
      </div>
    ))}
    <form
      className="connection-form"
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const data = Object.fromEntries(
          new FormData(form),
        );
        (async () => {
          setBusy(true);
          try {
            if (server) {
              // 서버에서 발급한 연결 정보나 서버 주소·연결 코드로 이 기기를 등록한다.
              const result = await call("libraryPair", data);
              await reloadConnections();
              if (result.connection.libraryId) {
                message(`서버의 ‘${result.connection.libraryName}’ 서재와 연결했습니다. 자동 동기화를 시작합니다.`);
              } else {
                setLibraryChoices((current) => ({ ...current, [result.connection.id]: result.libraries }));
                message("서버에 연결했습니다. 동기화할 서버의 서재를 선택해 주세요.");
              }
              form.reset();
              return;
            }
            await call("saveConnection", {
              ...data,
              type: connectionType,
              secure: data.secure === "on",
            });
            await reloadConnections();
            message(
              "연결을 추가했습니다. 자동 동기화를 시작합니다.",
            );
          } finally {
            setBusy(false);
          }
        })().catch(report);
      }}
    >
      <div className="row gap">
        {!server && <select
          aria-label="파일 저장소 연결 방식"
          disabled={busy}
          value={connectionType}
          onChange={(e) => setConnectionType(e.target.value)}
        >
          <option value="folder">로컬 폴더</option>
          <option value="webdav">WebDAV</option>
          <option value="ftp">FTP / FTPS</option>
        </select>}
        <input
          name="name"
          aria-label="연결 이름"
          placeholder="연결 이름"
          disabled={busy}
        />
      </div>
      {server && (
        <>
          <input
            name="connection"
            aria-label="연결 정보 또는 서버 주소"
            required
            autoComplete="off"
            placeholder="연결 정보(lof-library://…) 또는 서버 주소(http://192.168.0.10:8787)"
          />
          <input
            name="code"
            aria-label="연결 코드"
            autoComplete="off"
            placeholder="연결 코드 (연결 정보를 붙여넣었으면 비워 두세요)"
          />
          <p className="settings-note">Lof Library Daemon의 ‘기기 추가’에서 발급한 연결 정보나 코드를 입력합니다. 코드는 10분 동안 한 번만 쓸 수 있습니다.</p>
        </>
      )}
      {!server && (connectionType === "webdav" || connectionType === "ftp") && (
        <>
          <input
            name={connectionType === "webdav" ? "url" : "host"}
            aria-label="서버 주소"
            required
            placeholder={
              connectionType === "webdav"
                ? "https://nas.example.com/dav"
                : "FTP 호스트"
            }
          />
          <div className="row gap">
            <input
              name="username"
              aria-label="사용자 이름"
              placeholder="사용자 이름"
              autoComplete="off"
            />
            <input
              name="password"
              aria-label="비밀번호"
              type="password"
              placeholder="비밀번호"
              autoComplete="off"
            />
          </div>
          <input
            name="remotePath"
            aria-label="원격 폴더"
            placeholder="원격 폴더 (예: /writing)"
          />
          {connectionType === "ftp" && (
            <div className="row gap">
              <input
                name="port"
                aria-label="FTP 포트"
                type="number"
                placeholder="포트 (기본 21)"
              />
              <label className="checkbox">
                <input
                  type="checkbox"
                  name="secure"
                  defaultChecked
                />
                FTPS
              </label>
            </div>
          )}
        </>
      )}
      <button disabled={busy} type="submit">
        <Link size={15} />
        {server ? "서버에 연결" : connectionType === "folder"
          ? "동기화 폴더 선택"
          : "연결 추가"}
      </button>
    </form>
  </fieldset>;
}
