import {
  Code2,
  Copy,
  Download,
  FolderOpen,
  FolderSync,
  HardDrive,
  History,
  Sparkles,
  StickyNote
} from "lucide-react";
import type * as React from "react";
import {
  lineBreakLabel
} from "../../core/episode.mjs";
import { normalizeWriting } from "../../core/platforms.mjs";
import OpenSourceLicenses from "../OpenSourceLicenses";
import PinSettings from "../PinSettings";
import PlatformPicker from "../PlatformPicker";
import PropertyPresetSettings from "../PropertyPresetSettings";
import {
  call,
  type Doc,
  type Kind,
  type Library
} from "../types";
import type { useAppUpdater } from "../Updater";
import { UpdateSettings } from "../Updater";
import AutocompleteSettings from "./AutocompleteSettings";
import { settingPages, type SettingsPage } from "./settings-pages";

import SettingsToggle from "./SettingsToggle";
import TypesettingSettings from "./TypesettingSettings";

type Props = {
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
};

export default function SettingsContent({
  settingsPage,
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
}: Props) {

  return (
    <>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="설정 분류">
          {settingPages.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" aria-pressed={settingsPage === id}
              aria-controls={`settings-${id}`} onClick={() => setSettingsPage(id)}>
              <Icon size={16} /><span>{label}</span>
            </button>
          ))}
          <p>변경한 설정은<br />바로 저장됩니다.</p>
        </nav>
        <div className="settings-content" key={settingsPage}>
          <section id="settings-updates" className="settings-section" hidden={settingsPage !== "updates"}>
            <UpdateSettings updater={updater} version={lib.version}
              autoCheck={prefs.checkUpdatesOnStartup !== false}
              onAutoCheck={(checked) => savePrefs({ checkUpdatesOnStartup: checked }).catch(report)} />
            <OpenSourceLicenses />
          </section>
          <section id="settings-security" className="settings-section" hidden={settingsPage !== "security"}>
            {settingsPage === "security" && <PinSettings />}
          </section>
          <section id="settings-editor" className="settings-section" hidden={settingsPage !== "editor"}>
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
            <PropertyPresetSettings presets={prefs.propertyPresets} tags={prefs.favoriteTags} onChange={savePrefs} />
          </section>
          <section id="settings-typesetting" className="settings-section" hidden={settingsPage !== "typesetting"}>
            {<TypesettingSettings
              prefs={prefs}
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
            <h3>
              <StickyNote size={17} />
              공용 메모
            </h3>
            <div className="connection">
              <div>
                <b>공용 메모 폴더</b>
                <small>{commonMemoPath}</small>
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
              여러 작품에서 함께 쓰는 메모를 이 폴더에 Markdown 파일로 보관합니다.
              기존 폴더를 고르면 안의 파일을 그대로 메모로 보여줍니다.
            </p>
          </section>
          <section className="settings-section" hidden={settingsPage !== "storage"}>
            <h3>
              <History size={17} />
              로컬 Git 기록
            </h3>
            <p role="status" className={lib.localGit?.message ? "pin-error" : "muted"}>
              {lib.localGit?.message ? `로컬 Git 기록 대기 · ${lib.localGit.message}`
                : lib.localGit?.ready ? "로컬 Git 기록 사용 중"
                  : `기존 이력을 로컬 Git으로 옮기는 중 · ${lib.localGit?.importedHistory ?? 0}개 완료`}
            </p>
            <p className="settings-description">입력이 10초간 멈추고 원고 저장이 완료되면 로컬 Git에 기록합니다. 인터넷 연결이나 별도 Git 설치 없이 작동하며, 기존 원고와 변경 이력은 보존합니다.</p>
            <p className="settings-description">수동 저장 기록은 별도로 표시합니다. 모든 기록은 기간과 개수에 관계없이 그대로 보관하며, 자동으로 합치거나 삭제하지 않습니다. 이전 원고를 복원하면 현재 원고를 먼저 보존한 뒤 복원 결과를 새 기록으로 남깁니다.</p>
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
        <span title={lib.root}>내 서재 · {lib.root}</span>
      </footer>
    </>
  );
}
