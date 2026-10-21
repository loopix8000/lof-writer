import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorScrollPositions } from "../EditorScroll";
import { call, type Doc } from "../types";
import { useGitActivity } from "../useGitActivity";
import { readFileForClose, useSyncFileUpdates } from "../useSyncFileUpdates";
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
  clearSideDocument: () => void;
  pinTab: (id: string) => void;
  onDocumentIdChanged: (oldId: string, newId: string, location?: Doc) => void;
  refresh: () => Promise<unknown>;
  openDoc: (id: string, pinned: boolean) => Promise<void>;
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

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
function codePoints(text: string, from: number, to: number) {
  let count = 0;
  for (let i = from; i < to; i++) {
    if (isHighSurrogate(text.charCodeAt(i)) && i + 1 < to && isLowSurrogate(text.charCodeAt(i + 1))) i++;
    count++;
  }
  return count;
}
// 앞뒤로 같은 부분을 뺀 가운데 구간의 글자(코드 포인트) 수. 긴 원고에서도 글자 배열을 만들지 않도록
// 같은 구간은 큰 묶음으로 비교해 건너뛰고, 서로게이트 쌍은 쪼개지 않는다.
const SKIP = 4096;
function changedChars(before: string, after: string): number {
  if (before === after) return 0;
  const min = Math.min(before.length, after.length);
  let pre = 0;
  while (pre + SKIP <= min && before.slice(pre, pre + SKIP) === after.slice(pre, pre + SKIP)) pre += SKIP;
  while (pre < min && before.charCodeAt(pre) === after.charCodeAt(pre)) pre++;
  if (pre > 0 && pre < min && isHighSurrogate(before.charCodeAt(pre - 1))) pre--;
  let endA = before.length, endB = after.length;
  while (endA - SKIP >= pre && endB - SKIP >= pre && before.slice(endA - SKIP, endA) === after.slice(endB - SKIP, endB)) {
    endA -= SKIP;
    endB -= SKIP;
  }
  while (endA > pre && endB > pre && before.charCodeAt(endA - 1) === after.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  if (endA < before.length && endA > pre && isLowSurrogate(before.charCodeAt(endA))) {
    endA++;
    endB++;
  }
  return Math.max(codePoints(before, pre, endA), codePoints(after, pre, endB));
}

// 원고와 저장 버전은 이 훅 안에서만 변경한다. 화면 이동은 저장 완료 뒤 commitDocument를 호출한다.
export function useDocumentSession(options: Options) {
  const latest = useRef(options); latest.current = options;
  const [active, setActiveState] = useState<Doc | null>(null);
  const [saveStatus, setSaveStatus] = useState("저장됨");
  const [conflict, setConflict] = useState(false);
  const draft = useRef<DraftState | null>(null);
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

  const isMobileEnv = () =>
    typeof window !== "undefined" &&
    (window.innerWidth <= 768 || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent));

  const autoSaveCondition = useCallback((d: DraftState) => {
    const mobile = isMobileEnv();
    const maxMinutes = Math.max(1, Number(latest.current.prefs?.historyMaxMinutes ?? 1));
    const minChars = mobile ? 1 : Math.max(0, Number(latest.current.prefs?.historyMinChars ?? 200));
    const intervalMs = mobile ? 2500 : maxMinutes * 60_000;
    const elapsed = Date.now() - d.lastSavedAt;
    const chars = changedChars(d.base.body, d.doc.body);
    const metaChanged =
      d.base.title !== d.doc.title ||
      d.base.description !== d.doc.description ||
      d.base.authorComment !== d.doc.authorComment;
    return {
      intervalMs,
      elapsed,
      chars,
      minChars,
      met: (chars >= minChars || (mobile && metaChanged)) && elapsed >= intervalMs,
    };
  }, []);

  const persistDraftNow = useCallback((target = draft.current) => {
    if (draftTimer.current) {
      clearTimeout(draftTimer.current);
      draftTimer.current = null;
    }
    if (!target || target.seq === target.saved || target.draftSaved === target.seq) return;
    const seq = target.seq;
    const payload = { ...target.doc, expectedRevision: target.doc.revision };
    void call("saveDraft", payload)
      .then(() => {
        if (draft.current === target && target.seq === seq && target.seq !== target.saved && !conflictRef.current) {
          target.draftSaved = seq;
          setSaveStatus("편집 중");
        }
      })
      .catch(report);
  }, [report]);

  const scheduleDraftSave = useCallback(() => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      draftTimer.current = null;
      persistDraftNow();
    }, 150);
  }, [persistDraftNow]);

  const flushRef = useRef<(options?: FlushOptions) => Promise<void>>(async () => {});

  const scheduleAutoSave = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const d = draft.current;
    if (!d || d.seq === d.saved || conflictRef.current) return;
    const mobile = isMobileEnv();
    const { intervalMs, elapsed, chars, minChars } = autoSaveCondition(d);
    if (!mobile && chars < minChars) return;
    const delay = mobile ? 2500 : Math.max(650, intervalMs - elapsed);
    timer.current = setTimeout(() => {
      timer.current = null;
      void flushRef.current({ auto: true }).catch(report);
    }, delay);
  }, [autoSaveCondition, report]);

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
      const loadExternalOnClose = async (onlyIfChanged = false) => {
        const seq = d.seq;
        const fresh = await readFileForClose(() => call<Doc>("readDocument", { id: d.doc.id }));
        if (draft.current !== d || d.seq !== seq)
          throw Error("닫는 동안 원고가 변경되었습니다. 다시 닫아 주세요.");
        if (onlyIfChanged && !conflictRef.current && fresh.revision === d.doc.revision) return false;
        await call("clearDraft", { id: d.doc.id });
        if (draft.current !== d || d.seq !== seq)
          throw Error("닫는 동안 원고가 변경되었습니다. 다시 닫아 주세요.");
        d.doc = fresh;
        d.base = fresh;
        d.saved = seq;
        d.draftSaved = seq;
        d.lastSavedAt = Date.now();
        d.edited = false;
        conflictRef.current = false;
        setConflict(false);
        setActive(fresh);
        setSaveStatus("저장됨");
        return true;
      };
      // 닫기는 파일의 최신 내용을 채택하며, 일반 저장은 기존 충돌 처리를 유지한다.
      if (closing && await loadExternalOnClose(true)) return;
      if (d.seq === d.saved) {
        if (!auto && !manual && d.edited) {
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
      await call("saveDraft", { ...d.doc, expectedRevision: d.doc.revision });
      d.draftSaved = seq;
      if (conflictRef.current) {
        if (closing) { await loadExternalOnClose(); return; }
        if (auto) return;
        throw Error(
          "변경 충돌을 해결해 주세요. 입력한 원고는 임시 저장되어 있습니다.",
        );
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
          if (draft.current !== d || !sameDocumentContent(d.base, fresh)) throw error;
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
        if (closing && e.code === "CONFLICT") { await loadExternalOnClose(); return; }
        setSaveStatus(e.code === "CONFLICT" ? "변경 충돌" : "저장 실패");
        if (e.code === "CONFLICT") {
          conflictRef.current = true;
          setConflict(true);
        }
        throw e;
      }
    };
    const task = saveChain.current.then(run);
    saveChain.current = task.catch(() => {});
    return task;
  }, [autoSaveCondition, scheduleAutoSave, scheduleDraftSave, setActive]);
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
    canCheck: () => latest.current.visible && !latest.current.pendingDocumentMove(),
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
    pending: () => {
      if (timer.current) clearTimeout(timer.current);
      if (draftTimer.current) clearTimeout(draftTimer.current);
      conflictRef.current = true;
      setConflict(true);
      const d = draft.current;
      if (d) {
        if (d.seq === d.saved) d.seq++;
        void call("saveDraft", { ...d.doc, expectedRevision: d.doc.revision }).catch(report);
      }
      setSaveStatus("외부 변경 있음");
    },
    apply: async (doc) => {
      const previous = draft.current;
      if (previous?.doc.id !== doc.id) return;
      const previousSeq = previous.seq;
      await call("clearDraft", { id: doc.id });
      if (draft.current !== previous || previous.seq !== previousSeq) return;
      draft.current = { doc, base: doc, seq: 0, saved: 0, draftSaved: 0, lastSavedAt: Date.now(), edited: false };
      conflictRef.current = false;
      setActive(doc);
      setConflict(false);
      setSaveStatus("저장됨");
      message("동기화된 새 내용을 불러왔습니다.");
    },
    report,
  });
  // 직접 저장은 현재 문서의 Git 기록에 수동 저장 표시를 남기고 즉시 동기화한다.
  const manualSave = useCallback(async () => {
    const memoOpen = latest.current.memoOpen;
    await flush({ manual: true });
    if (memoOpen) {
      await latest.current.saveMemoManually();
    } else {
      const id = draft.current?.doc.id;
      if (id) await call("checkpointDocument", { id, force: true });
    }
    await call("requestSyncNow");
  }, [flush]);
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

  async function resolveConflict() {
    const d = draft.current;
    if (!d) return;
    const copy = await call<Doc>("createDocument", {
      projectId: d.doc.projectId,
      kind: d.doc.kind,
      title: d.doc.title + " (내 편집 사본)",
      body: d.doc.body,
    });
    await call("clearDraft", { id: d.doc.id });
    draft.current = null;
    conflictRef.current = false;
    setConflict(false);
    await latest.current.refresh();
    await latest.current.openDoc(copy.id, true);
    message("내 편집을 새 문서로 보존했습니다. 기존 문서도 유지됩니다.");
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
    latest.current.clearSideDocument();
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
    currentId, currentDocument, waitForSave, flush, flushForClose, manualSave, prepareForInstall,
    edit, checkOpenDocument, reconcileDocuments, commitDocument,
    discardDraft, detachDocument, closeDocument, resetVault, replaceDocId, writeMeta,
    remapDocuments, resolveConflict, restoreHistory, recordBaseline, sessionDelta,
  };
}
