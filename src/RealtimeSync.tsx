import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertCircle, ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronDown, ChevronRight, Clock3, Cloud, Copy, Link, Loader2, LogOut, Monitor, Pencil, QrCode, RefreshCw, ScanLine, Server, Smartphone, Users, X } from "lucide-react";
import SettingsToggle from "./app/SettingsToggle";
import { isAndroidApp } from "./tauri-bridge";
import { call } from "./types";

const PRESET_BG_SECONDS = [60, 180, 300, 600, 900, 1800, 3600];

type Peer = { id: string; name: string; endpoint: string; storage: boolean; status?: { phase: string; message?: string; conflicts?: number; lastSync?: string } };
type InviteInfo = { id: string; remainingMs: number; durationMs: number; phase: "waiting" | "expired" | "connected"; peer?: Peer };
type InviteData = InviteInfo & { code: string; qr: string };
type Pairing = { id: string; phase: "connecting" | "connected" | "cancelled" | "error"; peer?: Peer; error?: string; code?: string };
type Group = { id: string; members: number };
type Status = { uxVersion?: number; scope?: string; endpoint?: string; device?: { name: string }; group?: Group | null; peers: Peer[]; error: string; invite?: InviteInfo | null; pairing?: Pairing | null };
type Problem = { message: string; code?: string };
const tabs = [
  { id: "devices", label: "동기화 그룹", desc: "연결된 장치 상태 확인 및 그룹 관리", icon: Users },
  { id: "invite", label: "초대 코드", desc: "QR 코드·페어링 코드로 다른 기기 초대", icon: QrCode },
  { id: "connect", label: "그룹 가입", desc: "다른 기기에서 만든 페어링 코드로 연결", icon: Link },
] as const;
const copied = "페어링 코드를 복사했습니다.";
const OWN_DEVICE = "own-device";
const groupLabel = (id: string) => id.slice(0, 8).toUpperCase().replace(/(.{4})/, "$1-");
type Tab = typeof tabs[number]["id"];
const labels: Record<string, string> = { connecting: "연결 중", connected: "연결됨", pending: "동기화 대기", syncing: "동기화 중", offline: "오프라인", error: "재연결 대기" };
const problem = (error: unknown): Problem => ({ message: error instanceof Error ? error.message : String(error), code: (error as { code?: string })?.code });
const time = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

export default function RealtimeSync({
  onClose,
  embedded = false,
  prefs,
  savePrefs,
  report,
  mobileDetailOpen: controlledDetailOpen,
  onMobileDetailChange,
  onTabChange,
}: {
  onClose: () => void;
  embedded?: boolean;
  prefs?: Record<string, any>;
  savePrefs?: (patch: Record<string, any>) => Promise<void>;
  report?: (error: any) => void;
  mobileDetailOpen?: boolean;
  onMobileDetailChange?: (open: boolean) => void;
  onTabChange?: (tab: "devices" | "invite" | "connect", label: string) => void;
}) {
  const [status, setStatus] = useState<Status>({ peers: [], error: "" });
  const [tab, setTab] = useState<Tab>("devices");
  const [internalDetailOpen, setInternalDetailOpen] = useState(false);
  const mobileDetailOpen = controlledDetailOpen ?? internalDetailOpen;
  const setMobileDetailOpen = (open: boolean) => {
    setInternalDetailOpen(open);
    onMobileDetailChange?.(open);
  };
  const [invite, setInvite] = useState<InviteData | null>(null);
  const [deadline, setDeadline] = useState(0);
  const [now, setNow] = useState(performance.now());
  const [code, setCode] = useState("");
  const [validation, setValidation] = useState<"empty" | "checking" | "valid" | "invalid">("empty");
  const [codeVisible, setCodeVisible] = useState(true);
  const [codeDetails, setCodeDetails] = useState(false);
  const [pairProblem, setPairProblem] = useState<Problem | null>(null);
  const [actionProblem, setActionProblem] = useState<Problem | null>(null);
  const [statusProblem, setStatusProblem] = useState("");
  const [notice, setNotice] = useState("");
  const [action, setAction] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [alias, setAlias] = useState("");
  const alive = useRef(false);
  const scope = useRef<string | undefined>(undefined);
  const request = useRef(0);
  const ownedPair = useRef<string | null>(null);
  const ignoredPair = useRef<string | null>(null);
  const cancelRequested = useRef(false);
  const codeInput = useRef<HTMLTextAreaElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const previousPhase = useRef<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    const sequence = ++request.current;
    try {
      const next = await call<Status>("realtimeStatus");
      if (!alive.current || sequence !== request.current) return;
      if (next.uxVersion !== 2) next.error ="실시간 동기화 화면이 업데이트되었습니다. 앱을 다시 시작해 주세요.";
      if (scope.current && scope.current !== next.scope) {
        const previous = ownedPair.current;
        if (previous) void call("realtimeCancelPair", { id: previous, dismiss: true }).catch(() => {});
        ownedPair.current = null; ignoredPair.current = null; cancelRequested.current = true;
        setInvite(null); setCode(""); setValidation("empty"); setCodeVisible(true); setTab("devices");
        setRenaming(null); setLeaving(false); setNotice(""); setPairProblem(null); setActionProblem(null);
      }
      scope.current = next.scope;
      if (next.pairing?.id === ignoredPair.current) next.pairing = null;
      if (next.pairing) ownedPair.current = next.pairing.id;
      setStatus(next); setStatusProblem("");
      if (next.invite) { setDeadline(performance.now() + next.invite.remainingMs); setNow(performance.now()); }
    } catch (error) { if (alive.current && sequence === request.current) setStatusProblem(problem(error).message); }
  }, []);

  useEffect(() => {
    alive.current = true;
    let active = true;
    let timer: number;
    const poll = async () => { await refresh(); if (active) timer = window.setTimeout(poll, 1000); };
    void poll();
    const resume = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", resume);
    return () => {
      active = false; alive.current = false; request.current++;
      window.clearTimeout(timer); document.removeEventListener("visibilitychange", resume);
      const id = ownedPair.current;
      if (id) void call("realtimeCancelPair", { id, dismiss: true }).catch(() => {});
    };
  }, [refresh]);

  useEffect(() => {
    const id = status.invite?.id;
    if (!id || id === invite?.id) return;
    let active = true;
    void call<InviteData | null>("realtimeInvite", { reuse: true }).then(value => {
      if (active && value?.id === id) setInvite(value);
    }).catch(error => { if (active) setActionProblem(problem(error)); });
    return () => { active = false; };
  }, [status.invite?.id, invite?.id]);

  useEffect(() => {
    if (tab !== "invite" || status.invite?.phase !== "waiting") return;
    const timer = window.setInterval(() => setNow(performance.now()), 250);
    return () => window.clearInterval(timer);
  }, [tab, status.invite?.phase]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!code.trim()) { setValidation("empty"); return; }
    let active = true;
    setValidation("checking");
    const timer = window.setTimeout(() => {
      void call("realtimeValidateCode", { code }).then(() => {
        if (active) {
          const focusNext = document.activeElement?.closest("#realtime-pair-form");
          setValidation("valid"); setPairProblem(null);
          if (focusNext) window.requestAnimationFrame(() => document.getElementById("realtime-connect-submit")?.focus());
        }
      }).catch(error => {
        if (active) { setValidation("invalid"); setPairProblem(problem(error)); }
      });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [code]);

  const job = status.pairing;
  const connecting = starting || job?.phase === "connecting";
  const failure = pairProblem ?? (job?.phase === "error" ? { message: job.error || "연결하지 못했습니다. 다시 시도해 주세요.", code: job.code } : null);
  const paired = job?.phase === "connected" ? job.peer : undefined;
  const invitedPeer = status.invite?.phase === "connected" ? status.invite.peer : undefined;
  const seconds = status.invite ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0;
  const expired = !!status.invite && status.invite.phase !== "connected" && (status.invite.phase === "expired" || seconds === 0);
  const inviteReady = !!status.invite && status.invite.phase === "waiting" && !expired && invite?.id === status.invite.id;
  const ready = status.uxVersion === 2 && !!status.endpoint && !status.error;

  useEffect(() => { setActionProblem(null); setNotice(""); }, [paired?.id, invitedPeer?.id]);

  useEffect(() => {
    const phase = connecting ? "connecting" : paired ? "connected" : failure ? "error" : "input";
    if (previousPhase.current && previousPhase.current !== phase && tab === "connect") heading.current?.focus({ preventScroll: true });
    previousPhase.current = phase;
  }, [connecting, paired?.id, !!failure, tab]);

  const selectTab = (next: Tab) => {
    setTab(next);
    setMobileDetailOpen(true);
    onTabChange?.(next, tabs.find(item => item.id === next)?.label ?? "실시간 동기화");
    setNotice(""); setActionProblem(null); setRenaming(null); setLeaving(false);
    if (content.current) content.current.scrollTop = 0;
  };
  const run = async (name: string, operation: () => Promise<void>) => {
    if (action) return;
    const origin = scope.current;
    setAction(name); setActionProblem(null); setNotice(""); request.current++;
    try { await operation(); if (alive.current && scope.current === origin) await refresh(); }
    catch (error) { if (alive.current && scope.current === origin) setActionProblem(problem(error)); }
    finally { if (alive.current) setAction(null); }
  };
  const dismissPair = () => {
    const id = ownedPair.current;
    if (id) { ignoredPair.current = id; void call("realtimeCancelPair", { id, dismiss: true }).catch(() => {}); }
    ownedPair.current = null; request.current++;
    setStatus(current => ({ ...current, pairing: null })); setPairProblem(null);
  };
  const updateCode = (value: string) => { dismissPair(); setCode(value); setNotice(""); setActionProblem(null); };
  // 그룹 장치의 초대 화면에 표시된 QR 코드를 읽어 페어링 코드로 입력한다.
  const scanCode = async () => {
    setActionProblem(null);
    try {
      const result = await invoke<{ text?: string | null }>("android_scan_qr");
      const text = result?.text?.trim();
      if (!text || !alive.current) return;
      updateCode(text); setCodeVisible(false);
    } catch (error) { if (alive.current) setActionProblem(problem(error)); }
  };
  const cancelPair = async () => {
    cancelRequested.current = true; setCancelling(true);
    const id = ownedPair.current;
    if (!id) return;
    request.current++;
    try {
      const result = await call<Pairing | null>("realtimeCancelPair", { id });
      if (!alive.current) return;
      if (result?.phase === "connected") setStatus(current => ({ ...current, pairing: result }));
      else { dismissPair(); setNotice("연결을 취소했습니다."); }
    } catch (error) { if (alive.current) setActionProblem(problem(error)); }
    finally { if (alive.current) setCancelling(false); }
  };
  const pair = async () => {
    if (validation !== "valid" || connecting || !ready || failure?.code === "PAIR_CODE_EXPIRED") return;
    dismissPair(); cancelRequested.current = false; setStarting(true); setNotice(""); setActionProblem(null);
    request.current++;
    try {
      const result = await call<Pairing>("realtimePair", { code: code.trim() });
      ownedPair.current = result.id;
      if (!alive.current) { void call("realtimeCancelPair", { id: result.id, dismiss: true }).catch(() => {}); return; }
      setStatus(current => ({ ...current, pairing: result }));
      if (cancelRequested.current) await cancelPair(); else await refresh();
    } catch (error) { if (alive.current) setPairProblem(problem(error)); }
    finally { if (alive.current) { setStarting(false); setCancelling(false); } }
  };
  const createInvite = () => void run("invite", async () => {
    const value = await call<InviteData>("realtimeInvite");
    if (!alive.current) return;
    setInvite(value); setCodeDetails(false); setDeadline(performance.now() + value.remainingMs); setNow(performance.now());
    setStatus(current => ({ ...current, invite: value }));
  });
  const copyInvite = () => void run("copy", async () => {
    if (!inviteReady || !invite) return;
    await call("realtimeClipboard", { action: "write", text: invite.code }); setNotice(copied);
  });
  const leaveGroup = () => void run("leave", async () => {
    await call("realtimeLeave"); setLeaving(false); setInvite(null); setNotice("그룹에서 나갔습니다.");
  });
  const showDevices = () => { dismissPair(); selectTab("devices"); };
  const resolvePeer = (peer: Peer) => status.peers.find(value => value.id === peer.id) ?? peer;
  // 장치 이름 입력란과 저장·취소 버튼을 한 줄로 묶어 좁은 화면에서도 버튼이 흩어지지 않게 한다.
  const nameField = (id: string, name: string, save: (name: string) => Promise<void>, enabled: boolean) => renaming === id
    ? <form className="realtime-name-form" onSubmit={event => {
      event.preventDefault(); void run("rename", async () => { await save(alias); setRenaming(null); });
    }}>
      <label className="realtime-sr-only" htmlFor="realtime-device-name">장치 이름</label>
      <input id="realtime-device-name" value={alias} onChange={event => setAlias(event.target.value)} maxLength={100} autoFocus disabled={!!action} />
      <div className="realtime-name-actions">
        <button type="submit" className="primary" disabled={!!action || !enabled || !alias.trim()}>저장</button>
        <button type="button" disabled={!!action} onClick={() => setRenaming(null)}>취소</button>
      </div>
    </form>
    : <div className="realtime-device-title"><strong>{name}</strong>
      {id === OWN_DEVICE && <span className="realtime-device-tag">이 장치</span>}
      <button className="realtime-text-button" disabled={!!action || !enabled} onClick={() => { setAlias(name); setRenaming(id); setActionProblem(null); }}><Pencil size={12} />이름 변경</button>
    </div>;
  const ownDevice = (name: string) => {
    const Icon = isAndroidApp() ? Smartphone : Monitor;
    return <div className={`realtime-device is-own ${renaming === OWN_DEVICE ? "is-renaming" : ""}`}>
      <div className="realtime-device-icon"><Icon size={22} aria-hidden="true" /></div>
      <div className="realtime-device-info">
        {nameField(OWN_DEVICE, name, async value => {
          const updated = await call<{ name: string }>("realtimeRenameDevice", { name: value });
          setStatus(current => ({ ...current, device: { name: updated.name } }));
        }, true)}
        <span className="realtime-device-status">그룹의 다른 장치에 이 이름으로 표시됩니다.</span>
      </div>
    </div>;
  };
  const device = (snapshot: Peer, controls = false) => {
    const peer = resolvePeer(snapshot); const Icon = peer.storage ? Server : Monitor;
    return <div className={`realtime-device ${renaming === peer.id ? "is-renaming" : ""}`} key={peer.id}>
      <div className="realtime-device-icon"><Icon size={22} aria-hidden="true" /></div>
      <div className="realtime-device-info">
        {nameField(peer.id, peer.name, async value => {
          const updated = await call<Peer>("realtimeRename", { id: peer.id, name: value });
          setStatus(current => ({ ...current, peers: current.peers.map(item => item.id === peer.id ? { ...item, name: updated.name } : item) }));
        }, ready)}
        {controls && <span className={`realtime-device-status ${peer.status?.phase === "error" ? "is-warning" : ""}`}>
          <span className="realtime-dot" />{labels[peer.status?.phase ?? ""] ?? "연결 대기"}
          {peer.status?.lastSync && ` · ${new Date(peer.status.lastSync).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
        </span>}
        {controls && peer.status?.message && <p className="realtime-inline-error">{peer.status.message}</p>}
        {controls && !!peer.status?.conflicts && <p className="settings-note">충돌 사본 {peer.status.conflicts}개를 보관했습니다.</p>}
      </div>
      {controls && <div className="realtime-device-actions">
        <button disabled={!!action} title="변경 다시 확인" aria-label={`${peer.name} 변경 다시 확인`} onClick={() => void run("sync", async () => { await call("realtimeSync"); setNotice("변경 확인을 요청했습니다."); })}><RefreshCw size={15} /></button>
        <button disabled={!!action} title="그룹에서 제거" aria-label={`${peer.name} 그룹에서 제거`} onClick={() => void run("remove", async () => { await call("realtimeRemove", { id: peer.id }); })}><X size={15} /></button>
      </div>}
    </div>;
  };
  const success = (snapshot: Peer, title: string) => {
    const peer = resolvePeer(snapshot); const completed = !!peer.status?.lastSync;
    const failed = peer.status?.phase === "error";
    const pending = peer.status?.phase === "pending";
    const syncing = peer.status?.phase === "syncing";
    const others = status.peers.length - 1;
    return <div className="realtime-success">
      <div className="realtime-state-icon is-success"><Check size={30} /></div>
      <h3 ref={heading} tabIndex={-1}>{title}</h3>
      {device(peer)}
      {others > 0 && <p className="settings-note">그룹의 다른 장치 {others}대와도 자동으로 연결합니다.</p>}
      <div className="realtime-first-sync" role="status" aria-live="polite">
        <span>{failed ? "동기화 재시도 대기" : pending ? "동기화 대기" : syncing ? (completed ? "변경 내용을 동기화하는 중…" : "첫 동기화 중…") : completed ? "동기화 완료" : "첫 동기화를 기다리는 중…"}</span>
        {failed ? <p className="realtime-inline-error">{peer.status?.message}</p>
          : pending || syncing || !completed ? <div className="realtime-indeterminate" role="progressbar" aria-label={pending ? "동기화 대기" : "동기화 진행 중"}><span /></div>
          : <CheckCircle2 size={16} aria-hidden="true" />}
      </div>
    </div>;
  };

  const currentTab = tabs.find(item => item.id === tab);
  const bgEnabled = prefs?.backgroundSyncEnabled !== false;
  const bgIntervalSeconds = prefs?.backgroundSyncIntervalSeconds ?? 300;
  const bgMinutes = Math.max(1, Math.min(60, Math.round(bgIntervalSeconds / 60)));
  const hasCustomBgInterval = bgEnabled && !PRESET_BG_SECONDS.includes(bgIntervalSeconds);
  const handlePrefPatch = (patch: Record<string, any>) => {
    if (!savePrefs) return;
    savePrefs(patch).catch(err => report?.(err));
  };

  return <div className={`settings-layout realtime-layout realtime-sync ${embedded ? "is-embedded mobile-detail-open" : mobileDetailOpen ? "mobile-detail-open" : "mobile-menu-list"}`} aria-label="실시간 장치 동기화">
    <nav className={`settings-nav realtime-nav ${embedded ? "realtime-embedded-tabs" : ""}`} role="tablist" aria-label="실시간 동기화 분류" aria-orientation={embedded ? "horizontal" : "vertical"} onKeyDown={event => {
      const index = tabs.findIndex(item => item.id === tab);
      const next = (event.key === "ArrowDown" || event.key === "ArrowRight") ? (index + 1) % tabs.length : (event.key === "ArrowUp" || event.key === "ArrowLeft") ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault(); selectTab(tabs[next].id); event.currentTarget.querySelector<HTMLButtonElement>(`#realtime-tab-${tabs[next].id}`)?.focus();
    }}>
      {tabs.map(({ id, label, desc, icon: Icon }) => <button key={id} type="button" role="tab" id={`realtime-tab-${id}`} aria-controls={`realtime-panel-${id}`} aria-selected={tab === id} tabIndex={tab === id ? 0 : -1} onClick={() => selectTab(id)}>
        <Icon size={17} />
        <span className="settings-nav-item-text">
          <span>{label}</span>
          {!embedded && <small className="mobile-menu-desc">{desc}</small>}
        </span>
        {id === "connect" && connecting && <Loader2 className="realtime-spinner" size={13} aria-label="연결 중" />}
        {!embedded && <ChevronRight className="mobile-menu-chevron" size={17} aria-hidden="true" />}
      </button>)}
    </nav>
    <div className="settings-content realtime-content" ref={content}>
      {!embedded && (
        <div className="mobile-settings-subhead">
          <button
            type="button"
            className="mobile-back-to-menu"
            onClick={() => setMobileDetailOpen(false)}
          >
            <ArrowLeft size={16} />
            <span>동기화 메뉴</span>
          </button>
          <strong>{currentTab?.label}</strong>
        </div>
      )}
      {(status.error || statusProblem) && <div className="realtime-alert" role="alert"><AlertCircle size={17} /><span>{status.error || statusProblem}</span></div>}
      {!status.endpoint && !status.error && !statusProblem && <p className="realtime-preparing" role="status"><Loader2 className="realtime-spinner" size={16} />연결을 준비 중입니다…</p>}
      <section className="settings-section realtime-panel" role="tabpanel" id={`realtime-panel-${tab}`} aria-labelledby={`realtime-tab-${tab}`} tabIndex={0}>
        {tab === "devices" && <>
          <h3>동기화 그룹</h3>
          <p className="settings-description">페어링 코드로 가입한 장치끼리 P2P 방식으로 서로를 찾아 변경 내용을 동기화합니다.</p>
          {status.group && <div className="realtime-group">
            <Users size={16} aria-hidden="true" /><span>그룹 <code>{groupLabel(status.group.id)}</code></span><span>장치 <strong>{status.group.members}</strong>/10대</span>
            <div className="realtime-group-actions">
              {leaving ? <><span>이 장치를 그룹에서 뺄까요?</span>
                <button type="button" disabled={!!action} onClick={leaveGroup}>{action === "leave" ? <Loader2 className="realtime-spinner" size={13} /> : <LogOut size={13} />}나가기</button>
                <button type="button" disabled={!!action} onClick={() => setLeaving(false)}>취소</button></>
                : <button type="button" disabled={!!action || !ready} onClick={() => { setLeaving(true); setActionProblem(null); }}><LogOut size={13} />그룹 나가기</button>}
            </div>
          </div>}
          {status.device && <div className="realtime-device-list realtime-own-device">{ownDevice(status.device.name)}</div>}
          {status.peers.length ? <div className="realtime-device-list">{status.peers.map(peer => device(peer, true))}</div>
            : <div className="realtime-empty"><Cloud size={38} /><strong>아직 그룹에 다른 장치가 없습니다</strong><p>초대 코드를 만들어 다른 장치를 그룹에 추가하거나, 다른 장치의 코드로 그룹에 가입해 보세요.</p></div>}
          {savePrefs && (
            <div className="realtime-bg-sync-box">
              <h4>백그라운드 동기화 설정</h4>
              <p className="settings-description">앱이 백그라운드에 있을 때 그룹 기기 및 저장소와 변경 내용을 동기화할 주기를 설정합니다 (1분~1시간, 기본값 5분).</p>
              <div className="settings-toggles" style={{ marginBottom: 10 }}>
                <SettingsToggle
                  label="백그라운드 동기화 사용"
                  description="끄면 앱이 백그라운드에 있는 동안 주기적 동기화를 수행하지 않습니다."
                  checked={bgEnabled}
                  onChange={checked => handlePrefPatch({ backgroundSyncEnabled: checked })}
                />
              </div>
              {bgEnabled && <div className="settings-grid">
                <label>
                  백그라운드 동기화 주기
                  <select
                    aria-label="백그라운드 동기화 주기"
                    value={bgEnabled ? String(bgIntervalSeconds) : "off"}
                    onChange={event => {
                      const val = event.target.value;
                      if (val === "off") {
                        handlePrefPatch({ backgroundSyncEnabled: false });
                      } else {
                        handlePrefPatch({
                          backgroundSyncEnabled: true,
                          backgroundSyncIntervalSeconds: Number(val),
                        });
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
                      <option value={String(bgIntervalSeconds)}>{bgMinutes}분 (직접 설정)</option>
                    )}
                  </select>
                </label>
                <label>
                  주기 직접 설정 (1~60분)
                  <input
                    type="number"
                    aria-label="백그라운드 동기화 주기 직접 설정 (분)"
                    min={1}
                    max={60}
                    value={bgMinutes}
                    onChange={event => {
                      const mins = Number(event.target.value);
                      if (Number.isFinite(mins) && mins >= 1 && mins <= 60) {
                        handlePrefPatch({
                          backgroundSyncEnabled: true,
                          backgroundSyncIntervalSeconds: Math.round(mins) * 60,
                        });
                      }
                    }}
                  />
                </label>
              </div>}
            </div>
          )}
        </>}
        {tab === "invite" && (invitedPeer ? success(invitedPeer, "장치가 그룹에 가입했습니다") : <>
          <h3 ref={heading} tabIndex={-1}>{expired ? "페어링 코드가 만료되었어요" : "다른 장치를 그룹에 초대하세요"}</h3>
          <p className="settings-description">{expired ? "새 코드를 만들어 다시 초대해 주세요." : "페어링 코드로 가입한 장치는 그룹의 다른 장치와도 자동으로 연결됩니다."}</p>
          {!status.invite ? <div className="realtime-empty"><QrCode size={44} /><strong>일회용 페어링 코드를 만들어 주세요</strong><p>코드는 10분 동안 한 번만 사용할 수 있어요.<br />그룹이 없으면 이 서재로 새 그룹을 만듭니다.</p></div> : <>
            <div className={`realtime-invite-grid ${expired ? "is-expired" : ""}`}>
              <div className="realtime-qr-card">
                {invite?.id === status.invite.id ? <img src={invite.qr} width={228} height={228} alt={expired ? "" : "다른 장치에 보여 줄 그룹 페어링 QR 코드"} aria-hidden={expired || undefined} /> : <QrCode size={100} aria-hidden="true" />}
                {expired && <div className="realtime-qr-expired"><Clock3 size={28} /><strong>00:00</strong></div>}
              </div>
              <div className="realtime-invite-guide">
                <div className="realtime-timer-card">
                  <span className="realtime-timer-label"><Clock3 size={18} />{expired ? "유효 시간이 끝났어요" : "남은 시간"}</span>
                  <output className="realtime-countdown" role="timer" aria-live="off" aria-label="페어링 코드 남은 시간">{time(seconds)}</output>
                  <div className="realtime-time-bar" role="progressbar" aria-label="페어링 코드 남은 유효 시간" aria-valuemin={0} aria-valuemax={Math.ceil(status.invite.durationMs / 1000)} aria-valuenow={seconds} aria-live="off"><span style={{ width: `${Math.min(100, seconds * 100_000 / status.invite.durationMs)}%` }} /></div>
                  <p>10분 동안 한 번만 사용할 수 있어요.</p>
                </div>
                {!expired && <ol className="realtime-steps"><li>다른 장치의 구름 메뉴 열기</li><li>그룹 가입 선택</li><li>페어링 코드 붙여넣기</li></ol>}
              </div>
            </div>
            <p className={`realtime-waiting ${expired ? "is-expired" : ""}`} role="status"><span className="realtime-dot" />{expired ? "기존 코드는 더 이상 사용할 수 없습니다." : "다른 장치의 가입을 기다리는 중…"}</p>
            {!expired && invite?.id === status.invite.id && <details className="realtime-code-details" open={codeDetails} onToggle={event => setCodeDetails(event.currentTarget.open)}>
              <summary><ChevronDown size={15} />페어링 코드 직접 보기</summary>
              <textarea readOnly rows={3} aria-label="그룹 페어링 코드" value={invite.code} onFocus={event => event.currentTarget.select()} />
            </details>}
          </>}
        </>)}
        {tab === "connect" && (paired ? success(paired, "그룹에 가입했습니다") : connecting ? <div className="realtime-connecting" role="status" aria-live="polite">
          <Loader2 size={50} className="realtime-spinner" /><h3 ref={heading} tabIndex={-1}>{cancelling ? "가입을 취소하는 중…" : "그룹에 가입하는 중…"}</h3><p>잠시만 기다려 주세요.</p>
        </div> : <>
          <h3 ref={heading} tabIndex={-1}>{failure?.code === "PAIR_CODE_EXPIRED" ? "페어링 코드가 만료되었어요" : "동기화 그룹에 가입하기"}</h3>
          <p className="settings-description">{failure?.code === "PAIR_CODE_EXPIRED" ? "그룹의 장치에서 새 코드를 만들어 주세요." : `그룹의 장치 하나에서 만든 ${isAndroidApp() ? "QR 코드를 스캔하거나 " : ""}페어링 코드를 붙여넣으면 나머지 장치도 자동으로 찾아 연결합니다.`}</p>
          <form id="realtime-pair-form" className="realtime-pair-form" onSubmit={event => { event.preventDefault(); void pair(); }}>
            {isAndroidApp() && <button type="button" className="realtime-scan-button" onClick={() => void scanCode()}><ScanLine size={17} />QR 코드 스캔</button>}
            <label htmlFor="realtime-code-input">페어링 코드</label>
            {validation === "valid" && !codeVisible ? <div className="realtime-code-ready">
              <CheckCircle2 size={19} /><span>페어링 코드가 입력되었습니다</span>
              <button type="button" className="realtime-text-button" onClick={() => { setCodeVisible(true); window.setTimeout(() => codeInput.current?.focus(), 0); }}>내용 보기</button>
              <button type="button" className="realtime-clear" aria-label="페어링 코드 지우기" onClick={() => { updateCode(""); setCodeVisible(true); window.setTimeout(() => codeInput.current?.focus(), 0); }}><X size={16} /></button>
            </div> : <textarea ref={codeInput} id="realtime-code-input" aria-label="그룹 장치의 페어링 코드" aria-invalid={!!failure || validation === "invalid"} aria-describedby={failure ? "realtime-pair-error" : "realtime-code-help"} placeholder="페어링 코드를 붙여넣으세요" value={code} onChange={event => updateCode(event.target.value)} maxLength={16384} rows={codeVisible && code ? 3 : 2} spellCheck={false} autoCapitalize="off" autoCorrect="off" />}
            {validation === "checking" && <span className="realtime-validation" role="status"><Loader2 className="realtime-spinner" size={13} />코드 확인 중…</span>}
            {failure && <div id="realtime-pair-error" className="realtime-field-error" role="alert"><AlertCircle size={16} /><span>{failure.message}</span></div>}
            {!failure && <p id="realtime-code-help" className="realtime-code-help"><Cloud size={17} /><span>그룹 장치의 구름 메뉴 <ArrowRight size={12} /> 초대 코드 만들기</span></p>}
          </form>
        </>)}
      </section>
      {actionProblem && <div className="realtime-alert" role="alert"><AlertCircle size={17} /><span>{actionProblem.message}</span></div>}
      {notice && <p className="realtime-notice" role="status">{notice}</p>}
    </div>
    <footer className="realtime-footer">
      {tab === "connect" && connecting ? <button disabled={cancelling} onClick={() => void cancelPair()}>취소</button>
        : !embedded ? <button onClick={onClose}>{tab === "connect" && !paired ? "취소" : "닫기"}</button> : <span />}
      <div className="realtime-footer-actions">
        {tab === "devices" && <button className="primary" disabled={!!action || !ready} onClick={() => { selectTab("invite"); createInvite(); }}><Link size={16} />장치 초대</button>}
        {tab === "invite" && (invitedPeer ? <><button disabled={!!action || !ready} onClick={createInvite}>새 코드 만들기</button><button className="primary" onClick={showDevices}>그룹 보기</button></>
          : <>{status.invite && <button disabled={!!action || !inviteReady} className={expired ? "" : "primary"} onClick={copyInvite}>{action === "copy" ? <Loader2 className="realtime-spinner" size={16} /> : notice === copied ? <Check size={16} /> : <Copy size={16} />}{notice === copied ? "복사됨" : "페어링 코드 복사"}</button>}
            <button className={!status.invite || expired ? "primary" : ""} disabled={!!action || !ready} onClick={createInvite}>{action === "invite" ? <Loader2 className="realtime-spinner" size={16} /> : <RefreshCw size={16} />}{status.invite ? "새 코드 만들기" : "QR·페어링 코드 만들기"}</button></>)}
        {tab === "connect" && paired && <button className="primary" onClick={showDevices}>그룹 보기</button>}
        {tab === "connect" && !paired && !connecting && <button id="realtime-connect-submit" type="submit" form="realtime-pair-form" className="primary" disabled={!!action || !ready || validation !== "valid" || failure?.code === "PAIR_CODE_EXPIRED"}>가입하기</button>}
      </div>
    </footer>
  </div>;
}
