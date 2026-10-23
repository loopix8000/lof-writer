import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorScrollPositions } from "../EditorScroll";
import { call, type Doc } from "../types";
import { resolveSyncedFile, saveRecoveryCopy } from "../sync-recovery";
import { useGitActivity } from "../useGitActivity";
import { readFileForClose, useSyncFileUpdates } from "../useSyncFileUpdates";
import { autoSaveCondition as checkAutoSave } from "./auto-save";
import { cloneDocument, editDocument, relocateDocument, sameDocumentContent, updateDocumentLocation } from "./model";

type FlushOptions = { auto?: boolean; closing?: boolean; skipMemo?: boolean; manual?: boolean };
type Options = {
  loaded: boolean;
  visible: boolean;
  memoOpen: boolean;
  prefs?: Record<string, any>;
  flushMemo: (options: { closing?: boolean }) => Promise<void> | undefined;
  waitForWriting: () => Promise<void>;
  pendingDocumentMove: () => Promise<void> | null;
  saveMemoManually: () => Promise<void> | undefined;
  retainDocument: (doc: Doc) => void;
  clearRetainedDocuments: () => void;
  pinTab: (id: string) => void;
  onDocumentIdChanged: (oldId: string, newId: string, location?: Doc) => void;
  message: (text: string) => void;
  report: (error: any) => void;
};

type DraftState = {
  doc: Doc;
  base: Doc;
  seq: number;
  saved: number;
  draftSaved: number;
  lastSavedAt: number;
  edited: boolean;
};

// 원고와 저장 버전은 이 훅 안에서만 변경한다. 화면 이동은 저장 완료 뒤 commitDocument를 호출한다.
export function useDocumentSession(options: Options) {
  const latest = useRef(options); latest.current = options;
  const [active, setActiveState] = useState<Doc | null>(null);
  const [saveStatus, setSaveStatus] = useState("저장됨");
  const [conflict, setConflict] = useState(false);
  const [syncIssues, setSyncIssues] = useState<Record<string, string>>({});
  const issues = useRef<Record<string, string>>({});
  const setSyncIssue = useCallback((id: string, text?: string) => {
    const next = { ...issues.current };
    if (text) next[id] = text; else delete next[id];
    issues.current = next;
    setSyncIssues(next);
  }, []);
  const draft = useRef<DraftState | null>(null);
  const syncClient = useRef(crypto.randomUUID());
  const saveChain = useRef(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const conflictRef = useRef(false);
  const activeId = useRef("");
  // 앱에서 문서를 처음 열었을 때의 글자 수를 문서별로 유지한다.
  const sessionStarts = useRef(new Map<string, number>());
  const scrollPositions = useRef<EditorScrollPositions>(new Map());
  const report = useCallback((error: any) => latest.current.report(error), []);
  const message = useCallback((text: string) => latest.current.message(text), []);
  const pinTab = (id: string) => latest.current.pinTab(id);
  // 본문 입력은 앱 화면 갱신을 잠깐 모아서 한다(키를 누르고 있으면 초당 수십 번 들어온다).
  // 그동안 다른 이유로 화면을 그려도 pendingActive로 최신 원고를 보여 준다.
  const pendingActive = useRef<Doc | null>(null);
  const renderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setActive = useCallback((doc: Doc | null) => {
    if (renderTimer.current) clearTimeout(renderTimer.current);
    renderTimer.current = null;
    pendingActive.current = null;
    if (doc) latest.current.retainDocument(doc);
    setActiveState(doc);
  }, []);
  const setActiveSoon = useCallback((doc: Doc) => {
    pendingActive.current = doc;
    latest.current.retainDocument(doc);
    renderTimer.current ??= setTimeout(() => {
      renderTimer.current = null;
      if (pendingActive.current) setActive(pendingActive.current);
    }, 80);
  }, [setActive]);
  useEffect(() => () => { if (renderTimer.current) clearTimeout(renderTimer.current); }, []);
  const shownActive = pendingActive.current ?? active;

  // 자동 저장은 기기와 관계없이 설정한 주기와 최소 변경 글자 수를 모두 채울 때만 한다.
  // 그 사이 입력은 임시본으로 남는다.
  const autoSaveCondition = useCallback(
    (d: DraftState) => checkAutoSave(latest.current.prefs, d.base.body, d.doc.body, d.lastSavedAt),
    [],
  );

  const persistDraftNow = useCallback((target = draft.current) => {
    if (draftTimer.current) {
      clearTimeout(draftTimer.current);
      draftTimer.current = null;
    }
    if (!target || target.seq === target.saved || target.draftSaved === target.seq) return;
    const seq = target.seq;
    const payload = { ...target.doc, expectedRevision: target.doc.revision, recoveryOnly: !!issues.current[target.doc.id] };
    void call("saveDraft", payload)
      .then(() => {
        if (draft.current === target && target.seq === seq && target.seq !== target.saved && !conflictRef.current) {
          target.draftSaved = seq;
          setSaveStatus("편집 중");
        }
      })
      .catch(async (error: any) => {
        setSyncIssue(target.doc.id, error.message || "임시 저장을 완료하지 못했습니다.");
        try { await saveRecoveryCopy(target.doc); }
        catch (backupError: any) { setSyncIssue(target.doc.id, `복구 사본 저장 실패: ${backupError.message}`); }
      });
  }, [setSyncIssue]);

  const scheduleDraftSave = useCallback(() => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      draftTimer.current = null;
      persistDraftNow();
    }, issues.current[draft.current?.doc.id ?? ""] ? 1500 : 150);
  }, [persistDraftNow]);

  const flushRef = useRef<(options?: FlushOptions) => Promise<void>>(async () => {});

  const scheduleAutoSave = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const d = draft.current;
    if (!d || d.seq === d.saved || conflictRef.current || issues.current[d.doc.id]) return;
    const { chars, minChars, delay } = autoSaveCondition(d);
    if (chars < minChars) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void flushRef.current({ auto: true }).catch(report);
    }, delay);
  }, [autoSaveCondition, report]);

  const applySyncedDocument = useCallback(async (doc: Doc, discard = false) => {
    const syncToken = `${syncClient.current}:${doc.id}`;
    const result = await resolveSyncedFile({
      current: () => {
        const state = draft.current;
        return state?.doc.id === doc.id ? { state, seq: state.seq, doc: state.doc, dirty: state.seq !== state.saved } : null;
      },
      unchanged: ({ state, seq }) => draft.current === state && state.seq === seq,
      adopt: ({ dirty, doc: snapshot }, drop) => {
        if (timer.current) clearTimeout(timer.current);
        if (draftTimer.current) clearTimeout(draftTimer.current);
        return call<Doc>("adoptDocument", {
          id: doc.id, syncToken, discardDraft: drop,
          ...(dirty ? { draft: snapshot } : {}),
        });
      },
      apply: async (fresh) => {
        draft.current = { doc: fresh, base: fresh, seq: 0, saved: 0, draftSaved: 0, lastSavedAt: Date.now(), edited: false };
        conflictRef.current = false;
        setConflict(false);
        setActive(fresh);
        setSaveStatus("저장됨");
        return call<boolean>("finishDocumentSync", { id: doc.id, revision: fresh.revision, syncToken });
      },
      preserve: ({ doc: snapshot }) => saveRecoveryCopy(snapshot),
    }, discard);
    if (result.recoverySaved) message("편집 내용을 보관함의 복구 사본에 저장했습니다.");
    if (result.status === "resolved") setSyncIssue(doc.id);
    else if (result.status === "failed") {
      const error = result.error;
      setSyncIssue(doc.id, error instanceof Error ? error.message : "충돌 정리를 완료하지 못했습니다.");
      if (draft.current?.doc.id === doc.id) setSaveStatus("이 문서 확인 필요");
    }
  }, [setActive, setSyncIssue, message]);

  const flush = useCallback(async ({ auto = false, closing = false, skipMemo = false, manual = false }: FlushOptions = {}) => {
    if (!auto && !skipMemo) await latest.current.flushMemo({ closing });
    await latest.current.waitForWriting();
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!auto && draftTimer.current) {
      clearTimeout(draftTimer.current);
      draftTimer.current = null;
    }
    const run = async () => {
      const moving = latest.current.pendingDocumentMove();
      if (moving) await moving;
      const d = draft.current;
      if (!d) return;
      if (issues.current[d.doc.id]) {
        // 실패한 문서만 별도 보관하고 다른 문서로 이동할 수 있게 한다.
        try { await saveRecoveryCopy(d.doc); }
        catch { await call("saveDraft", { ...d.doc, recoveryOnly: true }); }
        return;
      }
      const loadExternalOnClose = async (onlyIfChanged = false) => {
        const seq = d.seq;
        const fresh = await readFileForClose(() => call<Doc>("readDocument", { id: d.doc.id }));
        if (draft.current !== d || d.seq !== seq)
          throw Error("닫는 동안 원고가 변경되었습니다. 다시 닫아 주세요.");
        if (onlyIfChanged && !conflictRef.current && fresh.revision === d.doc.revision) return false;
        await applySyncedDocument(fresh);
        return true;
      };
      // 닫을 때도 임시본을 보관하고 파일의 최신 내용을 채택한다.
      if (closing) {
        try { if (await loadExternalOnClose(true)) return; }
        catch (error: any) {
          await saveRecoveryCopy(d.doc);
          setSyncIssue(d.doc.id, error.message || "문서를 확인하지 못했습니다.");
          return;
        }
      }
      if (d.seq === d.saved) {
        if (manual) {
          await call("checkpointDocument", { id: d.doc.id, force: true });
          d.edited = false;
        } else if (!auto && d.edited) {
          d.edited = false;
          await call("checkpointDocument", { id: d.doc.id, force: false }).catch(() => {});
          void call("requestSyncNow").catch(() => {});
        }
        return;
      }
      if (auto) {
        const cond = autoSaveCondition(d);
        if (!cond.met) {
          if (cond.chars >= cond.minChars) scheduleAutoSave();
          return;
        }
      }
      const seq = d.seq,
        payload = {
          ...d.doc,
          expectedRevision: d.doc.revision,
          forceHistory: true,
          ...(manual ? { manualHistory: true } : {}),
        };
      try { await call("saveDraft", { ...d.doc, expectedRevision: d.doc.revision }); }
      catch (error: any) {
        await saveRecoveryCopy(d.doc);
        setSyncIssue(d.doc.id, error.message || "임시 저장을 완료하지 못했습니다.");
        setSaveStatus("복구 사본 보관됨");
        return;
      }
      d.draftSaved = seq;
      if (conflictRef.current) {
        await applySyncedDocument(d.doc);
        return;
      }
      setSaveStatus("저장 중");
      try {
        let saved: Doc;
        try {
          saved = await call<Doc>("saveDocument", payload);
        } catch (error: any) {
          if (error.code !== "CONFLICT") throw error;
          // 변경 알림보다 저장이 먼저 도착한 경우도 마지막 저장 원고로 확인한다.
          const fresh = await call<Doc>("readDocument", { id: d.doc.id });
          if (draft.current !== d) return;
          if (!sameDocumentContent(d.base, fresh)) {
            await applySyncedDocument(fresh);
            return;
          }
          d.base = fresh;
          d.doc = updateDocumentLocation(d.doc, fresh);
          conflictRef.current = false;
          setConflict(false);
          saved = await call<Doc>("saveDocument", {
            ...updateDocumentLocation(payload, fresh),
            expectedRevision: fresh.revision,
            forceHistory: true,
            ...(manual ? { manualHistory: true } : {}),
          });
        }
        if (draft.current === d) {
          d.saved = seq;
          d.draftSaved = seq;
          d.lastSavedAt = Date.now();
          if (!auto) d.edited = false;
          d.base = saved;
          // 메모는 이름이 바뀌면 파일 경로로 만든 ID도 바뀐다.
          if (saved.id !== d.doc.id) replaceDocId(d.doc.id, saved.id);
          d.doc = cloneDocument(d.doc, {
            id: saved.id,
            path: saved.path,
            relPath: saved.relPath,
            revision: saved.revision,
            fingerprint: saved.fingerprint,
            updatedAt: saved.updatedAt,
          });
          setActive(cloneDocument(d.doc));
          setSaveStatus(d.seq === seq ? "저장됨" : "편집 중");
          if (d.seq === seq) await call("clearDraft", { id: d.doc.id });
          else {
            scheduleDraftSave();
            scheduleAutoSave();
          }
          if (!auto && !manual) {
            void call("requestSyncNow").catch(() => {});
          }
        }
      } catch (e: any) {
        if (e.code === "CONFLICT") { await applySyncedDocument(d.doc); return; }
        try {
          await saveRecoveryCopy(d.doc);
          setSaveStatus("복구 사본 보관됨");
          setSyncIssue(d.doc.id, e.message || "원고 저장을 완료하지 못했습니다.");
        } catch (backupError: any) {
          setSyncIssue(d.doc.id, `복구 사본 저장 실패: ${backupError.message}`);
          setSaveStatus("임시본 확인 필요");
          // 이 경로에서는 saveDraft가 이미 성공했다. 이동할 때 보관을 다시 시도한다.
          if (d.draftSaved !== d.seq) throw backupError;
        }
      }
    };
    const task = saveChain.current.then(run);
    saveChain.current = task.catch(() => {});
    return task;
  }, [autoSaveCondition, scheduleAutoSave, scheduleDraftSave, setActive, applySyncedDocument, setSyncIssue]);
  flushRef.current = flush;

  useEffect(() => {
    scheduleAutoSave();
  }, [options.prefs?.historyMaxMinutes, options.prefs?.historyMinChars, scheduleAutoSave]);

  const prevVisible = useRef(options.visible);
  useEffect(() => {
    if (prevVisible.current && !options.visible) {
      void flush().catch(report);
    }
    prevVisible.current = options.visible;
  }, [options.visible, flush, report]);

  const gitActivity = useGitActivity(async () => true, report);
  const checkOpenDocument = useSyncFileUpdates({
    fileKey: shownActive?.id ?? "",
    enabled: options.loaded && !!shownActive,
    automatic: true,
    canCheck: () => latest.current.visible && !latest.current.pendingDocumentMove() && !issues.current[draft.current?.doc.id ?? ""],
    current: () => {
      const d = draft.current;
      return d ? { doc: d.doc, version: `${d.seq}:${d.doc.revision}` } : null;
    },
    beforeRead: () => saveChain.current,
    read: (doc: Doc) => call<Doc>("readDocument", { id: doc.id }),
    reconcile: (doc) => {
      const d = draft.current;
      // 마지막 저장 원고와 비교해 위치만 갱신하고, 저장하지 않은 입력은 그대로 남긴다.
      if (!d || !sameDocumentContent(d.base, doc)) return false;
      d.base = doc;
      d.doc = updateDocumentLocation(d.doc, doc);
      conflictRef.current = false;
      setConflict(false);
      setActive(cloneDocument(d.doc));
      setSaveStatus(d.seq === d.saved ? "저장됨" : "편집 중");
      if (d.seq !== d.saved) {
        scheduleDraftSave();
        scheduleAutoSave();
      }
      return true;
    },
    apply: (doc) => {
      const task = saveChain.current.then(() => applySyncedDocument(doc));
      saveChain.current = task.catch(() => {});
      return task;
    },
    report: (error) => {
      const d = draft.current;
      if (d) void applySyncedDocument(d.doc);
      else report(error);
    },
  });
  // 변경된 원고의 수동 이력은 saveDocument가 기록한다. 동기화 요청은 저장 완료를 지연시키지 않는다.
  const manualSave = useCallback(async () => {
    const memoOpen = latest.current.memoOpen;
    await flush({ manual: !memoOpen });
    if (memoOpen) {
      await latest.current.saveMemoManually();
    }
    void call("requestSyncNow").catch(report);
  }, [flush, report]);
  function edit(patch: Partial<Doc>, markdownCopy?: boolean) {
    const d = draft.current;
    if (!d) return;
    gitActivity();
    d.doc = editDocument(d.doc, patch, markdownCopy);
    d.seq++;
    d.edited = true;
    pinTab(d.doc.id);
    // 제목 같은 입력란은 바로 그려야 커서가 튀지 않는다. 본문은 편집기가 직접 그리므로 앱 화면 갱신을 모은다.
    const bodyOnly = Object.keys(patch).every((key) => key === "body");
    if (bodyOnly) setActiveSoon(cloneDocument(d.doc));
    else setActive(cloneDocument(d.doc));
    // 마지막 저장 내용으로 되돌아왔다면 저장할 것이 없으므로 저장됨으로 두고 임시본도 지운다.
    if (!conflictRef.current && sameDocumentContent(d.base, d.doc)) {
      d.saved = d.seq;
      d.draftSaved = d.seq;
      d.edited = false;
      if (draftTimer.current) {
        clearTimeout(draftTimer.current);
        draftTimer.current = null;
      }
      setSaveStatus("저장됨");
      void call("clearDraft", { id: d.doc.id }).catch(report);
      return;
    }
    setSaveStatus("편집 중");
    scheduleDraftSave();
    scheduleAutoSave();
  }
  const reconcileDocuments = useCallback((documents: Doc[]) => {
    const d = draft.current;
    if (d) {
      const meta = documents.find((x) => x.id === d.doc.id);
      if (meta && (meta.revision !== d.doc.revision ||
          (meta.fingerprint !== d.doc.fingerprint && d.seq === d.saved))) {
        void checkOpenDocument().catch(report);
      } else if (meta && d.seq === d.saved &&
          (meta.title !== d.doc.title || meta.path !== d.doc.path || meta.relPath !== d.doc.relPath)) {
        // 본문은 그대로인데 이름만 바뀐 경우(회차 번호가 바뀌어 '003화 …' 이름이 따라 바뀐 경우 등).
        // 편집 중인 원고에도 반영해야 다음 저장 때 예전 이름으로 되돌리지 않는다.
        d.doc = cloneDocument(d.doc, { title: meta.title, path: meta.path, relPath: meta.relPath });
        setActive(cloneDocument(d.doc));
      }
    }
  }, [checkOpenDocument, report, setActive]);

  function replaceDocId(oldId: string, newId: string, location?: Doc) {
    const sessionStart = sessionStarts.current.get(oldId);
    if (oldId !== newId && sessionStart !== undefined) {
      sessionStarts.current.set(newId, sessionStart);
      sessionStarts.current.delete(oldId);
    }
    if (oldId !== newId)
      for (const [key, position] of [...scrollPositions.current])
        if (key === oldId || key.endsWith(`\n${oldId}`)) {
          scrollPositions.current.set(key.slice(0, -oldId.length) + newId, position);
          scrollPositions.current.delete(key);
        }
    if (activeId.current === oldId) activeId.current = newId;
    latest.current.onDocumentIdChanged(oldId, newId, location);
  }

  // 열려 있는 문서는 편집 중인 원고에 반영하고, 아니면 파일에 바로 저장한다.
  async function writeMeta(id: string, patch: Partial<Doc>) {
    if (draft.current?.doc.id === id) {
      edit(patch);
      await flush();
    } else {
      await flush();
      const doc = await call<Doc>("readDocument", { id });
      const saved = await call<Doc>("saveDocument", { id, ...patch, expectedRevision: doc.revision });
      if (saved.id !== id) replaceDocId(id, saved.id);
    }
  }
  // 트리가 파일을 옮기고 서재를 다시 읽은 뒤 열린 원고의 위치 정보를 갱신한다.
  function remapDocuments(before: Doc[], from: string, to: string, documents: Doc[], projectId: string) {
    for (const d of before) {
      const rel = to + d.relPath!.slice(from.length),
        next = documents.find(
          (x) => x.projectId === projectId && x.relPath === rel,
        );
      if (!next) continue;
      replaceDocId(d.id, next.id, next);
      if (draft.current?.doc.id === d.id) {
        draft.current.doc = relocateDocument(draft.current.doc, next);
        draft.current.base = relocateDocument(draft.current.base, next);
        setActive(cloneDocument(draft.current.doc));
      }
    }
  }

  function commitDocument(doc: Doc, keepOlder: boolean) {
    if (timer.current) clearTimeout(timer.current);
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draft.current = {
      doc,
      base: doc,
      seq: keepOlder ? 1 : 0,
      saved: 0,
      draftSaved: 0,
      lastSavedAt: Date.now(),
      edited: keepOlder,
    };
    if (keepOlder) void call("saveDraft", { ...doc, expectedRevision: doc.revision }).catch(report);
    activeId.current = doc.id;
    setActive(doc);
    setSaveStatus(keepOlder ? "외부 변경 있음" : "저장됨");
    setConflict(keepOlder);
    conflictRef.current = keepOlder;
  }

  function discardDraft(id?: string) {
    if (id !== undefined && draft.current?.doc.id !== id) return;
    if (timer.current) clearTimeout(timer.current);
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draft.current = null;
    conflictRef.current = false;
    setConflict(false);
  }

  function detachDocument() {
    discardDraft();
    setActive(null);
  }

  function closeDocument() {
    detachDocument();
    activeId.current = "";
  }

  function resetVault() {
    issues.current = {}; setSyncIssues({});
    sessionStarts.current.clear();
    scrollPositions.current.clear();
    if (timer.current) clearTimeout(timer.current);
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draft.current = null;
    activeId.current = "";
    setActive(null);
  }

  const waitForSave = useCallback(() => saveChain.current, []);
  const currentId = useCallback(() => activeId.current, []);
  const currentDocument = useCallback(() => draft.current?.doc ?? null, []);

  const flushForClose = useCallback(async () => {
    await flush({ closing: true });
    // 트레이에서 돌아오거나 다른 탭을 다시 열 때도 예전 본문을 되살리지 않는다.
    latest.current.clearRetainedDocuments();
    if (draft.current) setActive(draft.current.doc);
  }, [flush, setActive]);

  async function prepareForInstall() {
    await flush();
    const pending = draft.current;
    if (pending && pending.seq !== pending.saved)
      throw Error("원고 저장을 완료한 뒤 다시 시도해 주세요.");
  }

  async function restoreHistory(id: string, name: string, afterCommit: () => void) {
    await flush();
    const current = draft.current;
    if (!current || current.doc.id !== id) throw Error("열린 문서가 바뀌었습니다. 이력을 다시 열어 주세요.");
    const restored = await call<Doc & { historyWarning?: string }>("restore", {
      id, name, expectedRevision: current.doc.revision,
    });
    if (restored.id !== id) replaceDocId(id, restored.id);
    draft.current = {
      doc: restored,
      base: restored,
      seq: 0,
      saved: 0,
      draftSaved: 0,
      lastSavedAt: Date.now(),
      edited: false,
    };
    setActive(restored);
    afterCommit();
    return restored;
  }

  function recordBaseline(id: string, count: number) {
    if (!sessionStarts.current.has(id)) sessionStarts.current.set(id, count);
  }

  function sessionDelta(id: string, count: number) {
    return Math.max(0, count - (sessionStarts.current.get(id) ?? count));
  }

  return {
    active: shownActive, saveStatus, conflict, scrollPositions: scrollPositions.current,
    syncIssue: syncIssues[shownActive?.id ?? ""],
    retrySync: async (discard = false) => {
      const doc = draft.current?.doc;
      if (!doc) return;
      const task = saveChain.current.then(() => applySyncedDocument(doc, discard));
      saveChain.current = task.catch(() => {});
      await task;
    },
    currentId, currentDocument, waitForSave, flush, flushForClose, manualSave, prepareForInstall,
    edit, reconcileDocuments, commitDocument,
    discardDraft, detachDocument, closeDocument, resetVault, replaceDocId, writeMeta,
    remapDocuments, restoreHistory, recordBaseline, sessionDelta,
  };
}
