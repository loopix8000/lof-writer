import {
  ArrowLeft,
  ChevronRight,
  Cloud,
  Code2,
  Copy,
  Download,
  FolderInput,
  FolderOpen,
  FolderSync,
  HardDrive,
  History,
  Sparkles,
  StickyNote
} from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type * as React from "react";
import {
  lineBreakLabel
} from "../../core/episode.mjs";
import { normalizeWriting } from "../../core/platforms.mjs";
import { useConfirm } from "../ConfirmDialog";
import OpenSourceLicenses from "../OpenSourceLicenses";
import PinSettings from "../PinSettings";
import PlatformPicker from "../PlatformPicker";
import PropertyPresetSettings from "../PropertyPresetSettings";
import RealtimeSync from "../RealtimeSync";
import {
  call,
  type Doc,
  type Kind,
  type Library
} from "../types";
import type { useAppUpdater } from "../Updater";
import { UpdateSettings, updateChannel } from "../Updater";
import { ReleaseHistory } from "../ReleaseNotes";
import AutocompleteSettings from "./AutocompleteSettings";
import { settingPages, type SettingsPage } from "./settings-pages";

import SettingsToggle from "./SettingsToggle";
import TypesettingSettings from "./TypesettingSettings";

type Props = {
  isMobile?: boolean;
  settingsPage: SettingsPage;
  setSettingsPage: React.Dispatch<React.SetStateAction<SettingsPage>>;
  updater: ReturnType<typeof useAppUpdater>;
  lib: Library;
  prefs: Record<string, any>;
  savePrefs: (p: Record<string, any>) => Promise<void>;
  report: (e: any) => void;
  saveKindPrefs: (kind: Kind | "document", patch: Record<string, any>) => Promise<void>;
  message: (text: string, action?: { label: string; run: () => void; }) => void;
  setTypesettingKind: React.Dispatch<React.SetStateAction<"episode" | "document">>;
  typesettingKind: "episode" | "document";
  newRepFrom: string;
  newRepTo: string;
  newRepLabel: string;
  setNewRepFrom: React.Dispatch<React.SetStateAction<string>>;
  setNewRepTo: React.Dispatch<React.SetStateAction<string>>;
  setNewRepLabel: React.Dispatch<React.SetStateAction<string>>;
  active: Doc | null;
  isProtected: boolean;
  replaceActiveSymbols: () => void;
  commonMemoPath: string;
  attempt: (fn: () => Promise<any>) => () => Promise<any>;
  setCommonMemoPath: React.Dispatch<React.SetStateAction<string>>;
  busy: boolean;
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;
  flush: ({ auto, closing, skipMemo }?: { auto?: boolean | undefined; closing?: boolean | undefined; skipMemo?: boolean | undefined; }) => Promise<void>;
  renderSyncConnections: () => React.JSX.Element;
  skillDownloading: boolean;
  setSkillDownloading: React.Dispatch<React.SetStateAction<boolean>>;
  onOpenExport: () => void;
  chooseVault?: (options?: { internal?: boolean }) => Promise<void>;
  moveVault?: (options?: { internal?: boolean }) => Promise<void>;
  mobileDetailOpen?: boolean;
  onMobileDetailChange?: (open: boolean) => void;
};

function formatStoragePath(rawPath: string | undefined, fallbackLabel: string): string {
  if (!rawPath) return fallbackLabel;
  return rawPath;
}

export default function SettingsContent({
  isMobile = false,
  settingsPage: requestedSettingsPage,
  setSettingsPage,
  updater,
  lib,
  prefs,
  savePrefs,
  report,
  saveKindPrefs,
  message,
  setTypesettingKind,
  typesettingKind,
  newRepFrom,
  newRepTo,
  newRepLabel,
  setNewRepFrom,
  setNewRepTo,
  setNewRepLabel,
  active,
  isProtected,
  replaceActiveSymbols,
  commonMemoPath,
  attempt,
  setCommonMemoPath,
  busy,
  setBusy,
  flush,
  renderSyncConnections,
  skillDownloading,
  setSkillDownloading,
  onOpenExport,
  chooseVault,
  moveVault,
  mobileDetailOpen: controlledDetailOpen,
  onMobileDetailChange,
}: Props) {
  const visibleSettingPages = settingPages.filter((item) => isMobile || item.id !== "realtime");
  const settingsPage = visibleSettingPages.some((item) => item.id === requestedSettingsPage)
    ? requestedSettingsPage
    : "editor";
  const [internalDetailOpen, setInternalDetailOpen] = useState(false);
  const [movingVault, setMovingVault] = useState<false | "folder" | "internal">(false);
  const [startupSaving, setStartupSaving] = useState(false);
  const saveStartup = (key: "launchAtStartup" | "startInTray", checked: boolean) => {
    setStartupSaving(true);
    void savePrefs({ [key]: checked }).catch(report).finally(() => setStartupSaving(false));
  };
  const mobileDetailOpen = controlledDetailOpen ?? internalDetailOpen;
  const setMobileDetailOpen = (open: boolean) => {
    setInternalDetailOpen(open);
    onMobileDetailChange?.(open);
  };
  const currentSetting = settingPages.find((item) => item.id === settingsPage);
  // 설정 영역을 다시 만들지 않고 메뉴를 바꿀 때 스크롤만 처음으로 되돌린다.
  const contentRef = useRef<HTMLDivElement>(null);
  const [confirm, confirmDialog] = useConfirm();
  useLayoutEffect(() => { if (contentRef.current) contentRef.current.scrollTop = 0; }, [settingsPage]);

  return (
    <>
      <div className={`settings-layout ${mobileDetailOpen ? "mobile-detail-open" : "mobile-menu-list"}`}>
        <nav className="settings-nav" aria-label="설정 분류">
          {visibleSettingPages.map(({ id, label, desc, icon: Icon }) => (
            <button
              key={id}
              type="button"
              aria-pressed={settingsPage === id}
              aria-controls={`settings-${id}`}
              onClick={() => {
                setSettingsPage(id);
                setMobileDetailOpen(true);
              }}
            >
              <Icon size={17} />
              <span className="settings-nav-item-text">
                <span>{label}</span>
                <small className="mobile-menu-desc">{desc}</small>
              </span>
              <ChevronRight className="mobile-menu-chevron" size={17} aria-hidden="true" />
            </button>
          ))}
          <p>변경한 설정은<br />바로 저장됩니다.</p>
        </nav>
        <div className="settings-content" ref={contentRef}>
          <div className="mobile-settings-subhead">
            <button
              type="button"
              className="mobile-back-to-menu"
              onClick={() => setMobileDetailOpen(false)}
            >
              <ArrowLeft size={16} />
              <span>설정 메뉴</span>
            </button>
            <strong>{currentSetting?.label}</strong>
          </div>
          <section id="settings-updates" className="settings-section" hidden={settingsPage !== "updates"}>
            <UpdateSettings updater={updater} version={lib.version}
              channel={updateChannel(prefs.updateChannel)}
              onChannelChange={(channel) => savePrefs({ updateChannel: channel }).catch(report)}
              autoCheck={prefs.checkUpdatesOnStartup !== false}
              onAutoCheck={(checked) => savePrefs({ checkUpdatesOnStartup: checked }).catch(report)} />
            <ReleaseHistory version={lib.version} />
            <OpenSourceLicenses />
          </section>
          <section id="settings-security" className="settings-section" hidden={settingsPage !== "security"}>
            {settingsPage === "security" && <PinSettings />}
          </section>
          <section id="settings-editor" className="settings-section" hidden={settingsPage !== "editor"}>
            {lib.platform === "windows" && <>
              <h3>앱 시작</h3>
              <div className="settings-toggles" aria-busy={startupSaving}>
                <SettingsToggle label="Windows 시작 시 실행"
                  description="Windows에 로그인하면 Lof Writer를 자동으로 실행합니다."
                  checked={prefs.launchAtStartup === true} disabled={startupSaving}
                  onChange={(checked) => saveStartup("launchAtStartup", checked)} />
                <SettingsToggle label="트레이로 시작"
                  description="다음에 앱을 실행할 때 창을 띄우지 않고 트레이에 표시합니다. 트레이 아이콘을 누르면 창이 열립니다."
                  checked={prefs.startInTray === true} disabled={startupSaving}
                  onChange={(checked) => saveStartup("startInTray", checked)} />
              </div>
            </>}
            <h3>화면과 글꼴</h3>
            <p className="settings-description">편하게 읽고 쓸 수 있도록 집필 화면을 조정하세요.</p>
            <div className="settings-grid">
              <label>
                글자 크기
                <select
                  aria-label="글자 크기"
                  value={prefs.fontSize}
                  onChange={(e) =>
                    savePrefs({ fontSize: Number(e.target.value) }).catch(
                      report,
                    )
                  }
                >
                  {[14, 16, 18, 20, 22, 24].map((n) => (
                    <option key={n} value={n}>
                      {n}px
                    </option>
                  ))}
                </select>
              </label>
              <label>
                줄 간격
                <select
                  aria-label="줄 간격"
                  value={prefs.lineHeight}
                  onChange={(e) =>
                    savePrefs({
                      lineHeight: Number(e.target.value),
                    }).catch(report)
                  }
                >
                  {[1.5, 1.8, 2, 2.2, 2.5].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                색 테마
                <select aria-label="색 테마" value={prefs.colorTheme || "modern"}
                  onChange={e => savePrefs({ colorTheme: e.target.value }).catch(report)}>
                  <option value="modern">Light Modern</option>
                  <option value="bakery">Bakery</option>
                </select>
              </label>
              <label>
                화면
                <select
                  aria-label="화면"
                  value={prefs.theme}
                  onChange={(e) =>
                    savePrefs({ theme: e.target.value }).catch(report)
                  }
                >
                  <option value="light">밝게</option>
                  <option value="dark">어둡게</option>
                </select>
              </label>
            </div>
            <div className="settings-toggles" style={{ marginTop: 14 }}>
              <SettingsToggle
                label="표지 숨기기"
                description="내 서재와 작품 화면에서 작품 표지를 표시하지 않습니다. 등록한 표지는 지우지 않습니다."
                checked={prefs.hideCovers === true}
                onChange={(checked) => savePrefs({ hideCovers: checked }).catch(report)}
              />
            </div>
            <h3 style={{ marginTop: 24 }}>내 서재</h3>
            <div className="settings-grid">
              <label>
                작품 클릭 시 이동할 화면
                <select
                  aria-label="작품 클릭 시 이동할 화면"
                  value={prefs.libraryProjectOpenTarget === "project" ? "project" : "workspace"}
                  onChange={(e) => savePrefs({ libraryProjectOpenTarget: e.target.value }).catch(report)}
                >
                  <option value="workspace">마지막 집필 화면</option>
                  <option value="project">작품 정보 화면</option>
                </select>
              </label>
            </div>
            {prefs.libraryProjectOpenTarget !== "project" && (
              <p className="settings-note">집필 기록이 없는 작품은 작품 정보 화면으로 이동합니다.</p>
            )}
            <PropertyPresetSettings presets={prefs.propertyPresets} tags={prefs.favoriteTags} onChange={savePrefs} />
          </section>
          <section id="settings-typesetting" className="settings-section" hidden={settingsPage !== "typesetting"}>
            {<TypesettingSettings
              prefs={prefs}
              savePrefs={savePrefs}
              saveKindPrefs={saveKindPrefs}
              report={report}
              message={message}
              setTypesettingKind={setTypesettingKind}
              targetKind={typesettingKind}
              inPanel={false}
            />}
          </section>
          <section id="settings-autocomplete" className="settings-section" hidden={settingsPage !== "autocomplete"}>
            <AutocompleteSettings
              prefs={prefs}
              savePrefs={savePrefs}
              report={report}
              message={message}
              active={active}
              isProtected={isProtected}
              replaceActiveSymbols={replaceActiveSymbols}
              newRepFrom={newRepFrom}
              newRepTo={newRepTo}
              newRepLabel={newRepLabel}
              setNewRepFrom={setNewRepFrom}
              setNewRepTo={setNewRepTo}
              setNewRepLabel={setNewRepLabel}
            />
          </section>
          <section id="settings-storage" className="settings-section" hidden={settingsPage !== "storage"}>
            {chooseVault && (
              <div className="vault-location-block" style={{ marginBottom: 22 }}>
                <h3>
                  <FolderOpen size={17} />
                  서재 위치
                </h3>
                <div className="connection vault-location-connection">
                  <div>
                    <b>{isMobile ? (lib.isInternal ? "앱 내부 저장소" : "공유 저장소") : "현재 서재 폴더"}</b>
                    <small title={lib.root}>{lib.root || "앱 기본 서재 폴더"}</small>
                  </div>
                </div>
                {/* 서재 옮기기는 지금 서재를 새 위치로 가져가고, 다른 서재 열기는 파일을 그대로 둔 채 열 서재만 바꾼다. */}
                {moveVault && (
                  <div className="vault-action">
                    <div className="vault-action-text">
                      <b>서재 옮기기</b>
                      <p>지금 서재의 작품·메모·변경 이력·동기화 연결을 그대로 새 위치로 옮깁니다.</p>
                    </div>
                    <div className="vault-action-buttons">
                      {isMobile && (
                        <button
                          className={lib.isInternal ? undefined : "primary"}
                          disabled={busy || Boolean(lib.isInternal)}
                          onClick={attempt(async () => {
                            setMovingVault("internal");
                            try { await moveVault({ internal: true }); } finally { setMovingVault(false); }
                          })}
                        >
                          <HardDrive size={15} />
                          {movingVault === "internal" ? "옮기는 중…" : lib.isInternal ? "내부 저장소 사용 중" : "내부 저장소로 전환"}
                        </button>
                      )}
                      <button disabled={busy || (isMobile && Boolean(lib.isInternal))} onClick={attempt(async () => {
                        setMovingVault("folder");
                        try { await moveVault(); } finally { setMovingVault(false); }
                      })}>
                        <FolderInput size={15} />
                        {movingVault === "folder" ? "옮기는 중…" : isMobile ? "공유 저장소로 옮기기" : "다른 폴더로 옮기기"}
                      </button>
                    </div>
                  </div>
                )}
                <div className="vault-action">
                  <div className="vault-action-text">
                    <b>다른 서재 열기</b>
                    <p>파일을 옮기지 않고 다른 폴더에 있는 서재로 바꿔 엽니다. 지금 서재는 원래 위치에 그대로 남습니다.</p>
                  </div>
                  <div className="vault-action-buttons">
                    <button disabled={busy || (isMobile && Boolean(lib.isInternal))} onClick={attempt(async () => {
                      if (!await confirm({
                        title: "다른 서재 열기",
                        message: "파일은 옮기지 않고, 다음 화면에서 고른 폴더의 서재로 바꿔 엽니다. 지금 서재는 지워지지 않고 원래 위치에 그대로 남습니다.",
                        detail: `지금 서재: ${lib.root}`,
                        confirmLabel: "폴더 고르기",
                      })) return;
                      await chooseVault();
                    })}>
                      <FolderOpen size={15} />
                      다른 서재 열기
                    </button>
                  </div>
                </div>
                {isMobile && (
                  <p className="muted">
                    내부 저장소는 저장이 빠르지만 파일 관리자나 다른 앱에서 보이지 않고, 앱을 삭제하면 함께 삭제됩니다.
                    공유 저장소는 파일 관리자에서 직접 볼 수 있지만 저장이 느릴 수 있습니다.
                  </p>
                )}
              </div>
            )}
            <h3>
              <StickyNote size={17} />
              공용 메모
            </h3>
            <div className="connection common-memo-connection">
              <div>
                <b>공용 메모 폴더</b>
                <small>{formatStoragePath(commonMemoPath, "앱 기본 공용 메모 폴더")}</small>
              </div>
              <button
                onClick={attempt(async () => {
                  const next = await call<string | null>("chooseCommonMemo");
                  if (next) {
                    setCommonMemoPath(next);
                    message("공용 메모 폴더를 바꿨습니다.");
                  }
                })}
              >
                <FolderOpen size={15} />
                위치 변경
              </button>
            </div>
            <p className="muted">
              여러 작품에서 함께 쓰는 메모를 공용 메모 공간에 Markdown 파일로 보관합니다.
            </p>
          </section>
          <section className="settings-section" hidden={settingsPage !== "storage"}>
            <h3>
              <Download size={17} />
              서재 내보내기
            </h3>
            <p className="settings-description">
              서재의 모든 작품 원고, 플롯·메모, 공용 메모를 내부 관리용 메타 정보 없이 바로 열람할 수 있는 텍스트(.txt) 또는 마크다운(.md) 파일로 내보냅니다.
            </p>
            <div className="history-actions">
              <button disabled={busy} onClick={onOpenExport}>
                <Download size={16} /> 서재 내보내기
              </button>
            </div>
          </section>
          <section className="settings-section" hidden={settingsPage !== "storage"}>
            <h3>
              <History size={17} />
              자동 저장 및 변경 이력
            </h3>
            <p role="status" className={lib.localGit?.message ? "pin-error" : "muted"}>
              {lib.localGit?.message ? `로컬 Git 기록 대기 · ${lib.localGit.message}`
                : lib.localGit?.ready ? "로컬 Git 기록 사용 중"
                  : `기존 이력을 로컬 Git으로 옮기는 중 · ${lib.localGit?.importedHistory ?? 0}개 완료`}
            </p>
            <p className="settings-description">집필 중 설정한 주기와 최소 변경 글자 수가 모두 충족될 때만 자동 저장과 변경 이력을 생성합니다. 입력 중인 임시 저장본은 데이터베이스에 실시간으로 저장되며, 수동 저장(Ctrl+S)하거나 집필 화면을 나가면 즉시 이력 저장과 동기화가 실행됩니다.</p>
            <div className="settings-grid">
              <label>
                자동 저장 주기 (분)
                <input
                  type="number"
                  aria-label="자동 저장 주기 (분)"
                  min={1}
                  max={1440}
                  value={prefs.historyMaxMinutes ?? 1}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v) && v >= 1 && v <= 1440)
                      savePrefs({ historyMaxMinutes: Math.round(v) }).catch(report);
                  }}
                />
              </label>
              <label>
                최소 변경 글자 수 (자)
                <input
                  type="number"
                  aria-label="최소 변경 글자 수 (자)"
                  min={0}
                  max={100000}
                  step={10}
                  value={prefs.historyMinChars ?? 200}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v) && v >= 0 && v <= 100000)
                      savePrefs({ historyMinChars: Math.round(v) }).catch(report);
                  }}
                />
              </label>
              <label>
                이력 보관 기간 (일)
                <input
                  type="number"
                  aria-label="이력 보관 기간 (일)"
                  min={1}
                  max={3650}
                  value={prefs.historyKeepDays ?? 30}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v) && v >= 1 && v <= 3650)
                      savePrefs({ historyKeepDays: Math.round(v) }).catch(report);
                  }}
                />
              </label>
              <label>
                문서당 최대 보관 개수 (개)
                <input
                  type="number"
                  aria-label="문서당 최대 보관 개수 (개)"
                  min={1}
                  max={10000}
                  value={prefs.historyKeepCount ?? 100}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v) && v >= 1 && v <= 10000)
                      savePrefs({ historyKeepCount: Math.round(v) }).catch(report);
                  }}
                />
              </label>
            </div>
            <p className="settings-description">수동 저장 기록은 별도로 표시합니다. 이전 원고를 복원하면 현재 원고를 먼저 보존한 뒤 복원 결과를 새 기록으로 남깁니다.</p>
            <div className="history-actions">
              <button disabled={busy || !lib.localGit?.ready} onClick={attempt(async () => {
                setBusy(true);
                try {
                  await flush();
                  const result = await call<{ path: string }>("backupGitHistory");
                  message("Git 이력 백업을 저장했습니다: " + result.path);
                } finally { setBusy(false); }
              })}>
                <HardDrive size={16} /> Git 이력 백업
              </button>
            </div>
          </section>
          <section id="settings-defaults" className="settings-section" hidden={settingsPage !== "defaults"}>
            <h3>새 작품의 기본 설정</h3>
            <p className="settings-description">새 작품을 만들 때 사용할 플랫폼과 목표 분량입니다.</p>
            <PlatformPicker
              value={normalizeWriting(prefs.defaultWriting)}
              onChange={(writing) =>
                savePrefs({ defaultWriting: writing }).catch(report)
              }
            />
          </section>
          <section className="settings-section" hidden={settingsPage !== "defaults"}>
            <fieldset className="linebreak-options">
              <legend>새 에피소드 줄바꿈</legend>
              <p className="settings-description">작품에서 별도로 지정하지 않으면 이 방식을 사용합니다.</p>
              <div className="linebreak-choices">
                {[false, true].map((manual) => (
                  <label key={String(manual)} className={`linebreak-choice${(prefs.defaultManualLineBreak === true) === manual ? " selected" : ""}`}>
                    <input type="radio" name="defaultLineBreak" value={String(manual)}
                      checked={(prefs.defaultManualLineBreak === true) === manual}
                      onChange={() => savePrefs({ defaultManualLineBreak: manual }).catch(report)} />
                    <span>
                      <strong>{lineBreakLabel(manual)}{!manual && <small>기본</small>}</strong>
                      <span>{manual ? "단락 사이에 간격을 두지 않습니다." : "단락 사이에 간격을 둡니다."}</span>
                      <span className="linebreak-keys"><kbd>Enter</kbd> {manual ? "줄바꿈" : "새 단락"}</span>
                      {!manual && <span className="linebreak-keys"><kbd>Shift + Enter</kbd> 단락 안 줄바꿈</span>}
                    </span>
                  </label>
                ))}
              </div>
              <p className="settings-note">새로 만드는 에피소드에 적용됩니다. 기존 회차는 에피소드 속성에서 개별 변경할 수 있습니다.</p>
            </fieldset>
          </section>
          <section className="settings-section" hidden={settingsPage !== "defaults"}>
            <fieldset className="linebreak-options">
              <legend>자동 관리 본문 복사</legend>
              <p className="settings-description">자동 관리 중인 본문을 복사할 때 문단 사이에 빈 줄을 넣을지 선택합니다.</p>
              <div className="linebreak-choices">
                {[false, true].map((blankLines) => (
                  <label key={String(blankLines)} className={`linebreak-choice${(prefs.copyWithBlankLines === true) === blankLines ? " selected" : ""}`}>
                    <input type="radio" name="copyWithBlankLines" value={String(blankLines)}
                      checked={(prefs.copyWithBlankLines === true) === blankLines}
                      onChange={() => savePrefs({ copyWithBlankLines: blankLines }).catch(report)} />
                    <span>
                      <strong>{blankLines ? "빈 줄을 추가해 복사" : "기존 방식으로 복사"}{!blankLines && <small>기본</small>}</strong>
                      <span>{blankLines ? "문단 사이에 빈 줄 한 줄을 넣어 복사합니다." : "문단 사이에 빈 줄을 추가하지 않고 복사합니다."}</span>
                    </span>
                  </label>
                ))}
              </div>
              <p className="settings-note">본문 전체 복사, 우클릭 복사와 Ctrl+C에 적용됩니다.</p>
            </fieldset>
          </section>
          {isMobile && <section id="settings-realtime" className="settings-section m-realtime-section" hidden={settingsPage !== "realtime"}>
            <h3><Cloud size={18} />실시간 동기화</h3>
            {settingsPage === "realtime" && (
              <RealtimeSync
                embedded
                onClose={() => setMobileDetailOpen(false)}
                prefs={prefs}
                savePrefs={savePrefs}
                report={report}
              />
            )}
          </section>}
          <section id="settings-connections" className="settings-section" hidden={settingsPage !== "connections"}>
            <h3><FolderSync size={18} />파일 동기화</h3>
            {settingsPage === "connections" && renderSyncConnections()}
          </section>
          <section id="settings-api" className="settings-section" hidden={settingsPage !== "api"}>
            <h3>
              <Code2 size={18} />
              MCP / API
            </h3>
            <p className="muted">연결할 때 앱을 켜 두세요.</p>
            <div className="row gap">
              <button
                onClick={attempt(async () => {
                  await call("mcpConfig");
                  message("MCP 설정 JSON을 복사했습니다.");
                })}
              >
                <Copy size={15} />
                MCP 설정 복사
              </button>
              <button
                onClick={attempt(async () => {
                  await call("copyApi");
                  message("API 주소와 인증 키를 복사했습니다.");
                })}
              >
                <Copy size={15} />
                API 연결 정보 복사
              </button>
            </div>
            <div className="settings-subsection">
              <h3><Sparkles size={18} />AI 스킬</h3>
              <p className="settings-description">
                AI가 Lof Writer의 작품과 원고를 다룰 때 사용하는 스킬입니다.
                문서 조회·수정 방법과 API 안내를 함께 제공합니다.
              </p>
              <button disabled={skillDownloading} onClick={attempt(async () => {
                if (skillDownloading) return;
                setSkillDownloading(true);
                try {
                  const path = await call<string | null>("downloadSkill");
                  if (path) message("Lof Writer 스킬을 저장했습니다.");
                } finally {
                  setSkillDownloading(false);
                }
              })}>
                <Download size={15} />
                {skillDownloading ? "저장 중…" : "스킬 다운로드"}
              </button>
              <p className="muted">
                ZIP 압축을 풀어 lof-writer 폴더를 사용하는 AI 도구의 스킬 폴더에 추가하세요.
                MCP 연결은 위의 설정으로 별도로 등록해 주세요.
              </p>
            </div>
          </section>
        </div>
      </div>
      <footer className="settings-footer">
        <span>Lof Writer {lib.version}</span>
        <span className="settings-footer-root" title={lib.root}>내 서재 · {lib.root}</span>
      </footer>
      {confirmDialog}
    </>
  );
}
