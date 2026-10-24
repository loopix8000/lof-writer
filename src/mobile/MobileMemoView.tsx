import {
  Archive,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Copy,
  Edit3,
  FilePlus,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  MoreVertical,
  Plus,
  Search,
  StickyNote,
  Trash2,
  X,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { normalizeEditorStyle, replaceManuscriptSymbols, resolveKindPrefs } from "../../core/typesetting.mjs";
import { normalizeTextReplacements } from "../../core/typing.mjs";
import { plainText } from "../../core/text.mjs";
import { useConfirm } from "../ConfirmDialog";
import EditorScroll, { type EditorScrollPositions } from "../EditorScroll";
import HistoryDialog from "../HistoryDialog";
import MemoArchiveDialog from "../MemoArchiveDialog";
import { useUndoState } from "../useUndoState";
import SyncStatus from "../SyncStatus";
import { call, type AutoSyncStatus, type Doc } from "../types";
import { autoSaveCondition } from "../app/auto-save";
import { memoImageScope, useImages } from "../app/useDocumentImages";
import { clearMemoDraft, readMemoDraft, saveMemoDraft } from "../memo-drafts";
import { notifyRemoteUpdate, resolveSyncedFile, saveRecoveryCopy } from "../sync-recovery";
import SyncIssueBanner from "../SyncIssueBanner";
import { useSyncFileUpdates } from "../useSyncFileUpdates";
import Writer from "../Writer";
import MobileEditorToolbar, { MobileEditorMenuActions } from "./MobileEditorToolbar";
import {
  MobileActionSheet,
  MobileFolderPickerSheet,
  MobilePromptSheet,
  type MobileActionItem,
} from "./MobileActionSheet";

type Space = { id: string; title: string; root: string };
type Entry = {
  path: string;
  name: string;
  type: "file" | "folder";
  updatedAt?: string;
  kind?: "plot" | "memo";
  episodeId?: string;
};
type EntryChange = (entries: Entry[]) => Entry[];

type Memo = {
  id?: string;
  space: string;
  path: string;
  title: string;
  body: string;
  revision: string;
  updatedAt: string;
  manualLineBreak?: boolean;
  historyWarning?: string;
};

const COMMON = "common";
const parentOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")));
const tabName = (path: string) => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
const memoKey = (m: { space: string; path: string }) => `${m.space}\n${m.path}`;
const sameMemo = (a: { space: string; path: string }, b: { space: string; path: string } | null) =>
  !!b && a.space === b.space && a.path === b.path;

export default function MobileMemoView({
  active,
  syncStatus,
  syncChecking,
  syncAvailable,
  prefs,
  apiRef,
  flushRef,
  onOpenLink,
  message,
  report,
  onDetailStateChange,
  documents,
  openDoc,
}: {
  documents: Doc[];
  openDoc: (id: string) => Promise<void>;
  active: boolean;
  syncStatus: AutoSyncStatus;
  syncChecking: boolean;
  syncAvailable: boolean;
  prefs: Record<string, any>;
  apiRef?: React.MutableRefObject<{
    open: (space: string, path: string, pinned?: boolean) => Promise<void>;
  } | null>;
  flushRef: React.MutableRefObject<((options?: { closing?: boolean }) => Promise<void>) | null>;
  onOpenLink: (href: string, quote: string) => void;
  message: (text: string, action?: { label: string; run: () => void }, duration?: number) => void;
  report: (e: any) => void;
  onDetailStateChange?: (inEditor: boolean, closeEditor: () => void) => void;
}) {
  const images = useImages(report);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [space, setSpace] = useState<string>(COMMON);
  const [entries, setEntries] = useState<Entry[]>([]);
  // 처리 중인 목록 변경. 처리 도중 다시 읽은 목록에도 덧씌운다.
  const entryChanges = useRef(new Set<EntryChange>());
  const treeSeq = useRef(0);
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => new Set());
  const [filterQuery, setFilterQuery] = useState<string>("");
  const [memo, setMemo] = useState<Memo | null>(null);
  const [titleInput, setTitleInput] = useState<string>("");
  const [historyTarget, setHistoryTarget] = useState<(Memo & { id: string }) | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const { undoState, onUndoStateChange } = useUndoState(memo ? `${memo.space}\n${memo.path}` : "");
  const [status, setStatus] = useState<string>("저장됨");

  const [spaceSheetOpen, setSpaceSheetOpen] = useState(false);
  const [entrySheet, setEntrySheet] = useState<Entry | null>(null);
  const [editorMenuOpen, setEditorMenuOpen] = useState(false);
  const [moveTargetEntry, setMoveTargetEntry] = useState<{ path: string; name: string } | null>(
    null,
  );
  const [promptTarget, setPromptTarget] = useState<{
    mode: "newMemo" | "newFolder" | "rename";
    folder?: string;
    path?: string;
    initialValue: string;
  } | null>(null);

  const [confirm, confirmDialog] = useConfirm();
  const scrollPositions = useRef<EditorScrollPositions>(new Map());
  const memoRef = useRef<Memo | null>(null);
  const spaceRef = useRef<string>(space);
  spaceRef.current = space;

  const dirty = useRef({ seq: 0, saved: 0 });
  const timer = useRef<number | undefined>(undefined);
  const draftTimer = useRef<number | undefined>(undefined);
  const chain = useRef<Promise<void>>(Promise.resolve());
  // 마지막으로 저장하거나 읽은 본문과 그 시각. 자동 저장 조건을 여기서부터 잰다.
  const lastSaved = useRef({ body: "", at: 0 });
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const markSaved = (body: string) => {
    lastSaved.current = { body, at: Date.now() };
  };

  const setCurrentMemo = (m: Memo | null) => {
    memoRef.current = m;
    setMemo(m);
    setTitleInput(m?.title ?? "");
  };

  // 다른 기기에서 바뀐 메모를 받아 정리하는 상태. 정리하지 못한 메모는 복구 사본으로만 저장한다.
  const [conflict, setConflict] = useState(false);
  const conflictRef = useRef(false);
  const [syncIssues, setSyncIssues] = useState<Record<string, string>>({});
  const issueRef = useRef<Record<string, string>>({});
  const syncTokens = useRef(new Map<string, string>());
  const activeRef = useRef(active);
  activeRef.current = active;
  const messageRef = useRef(message);
  messageRef.current = message;
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const setConflictState = (value: boolean) => {
    conflictRef.current = value;
    setConflict(value);
  };
  function memoSyncIssue(key: string, text?: string) {
    const next = { ...issueRef.current };
    if (text) next[key] = text;
    else delete next[key];
    issueRef.current = next;
    setSyncIssues(next);
  }
  const recoveryDocument = (m: Memo) => ({
    ...m,
    kind: entriesRef.current.find((e) => e.path === m.path)?.kind ?? "memo",
    projectId: m.space === COMMON ? undefined : m.space,
  });
  async function adoptSyncedMemo(m: Memo, discard = false) {
    const before = sameMemo(m, memoRef.current) ? memoRef.current : null;
    const key = memoKey(m);
    const syncToken = syncTokens.current.get(key) ?? crypto.randomUUID();
    syncTokens.current.set(key, syncToken);
    let preserved = false;
    const result = await resolveSyncedFile({
      current: () => {
        const now = memoRef.current;
        if (!now || !sameMemo(m, now)) return null;
        const stored = readMemoDraft(m.space, m.path);
        return { memo: now, seq: dirty.current.seq, body: dirty.current.seq !== dirty.current.saved ? now.body : stored?.body };
      },
      unchanged: ({ memo: snapshot, seq }) => memoRef.current === snapshot && dirty.current.seq === seq,
      adopt: async ({ memo: snapshot, body }, drop) => {
        clearTimeout(timer.current);
        clearTimeout(draftTimer.current);
        // 공용 메모는 최신본을 그대로 쓰고, 이 기기의 저장 전 입력은 복구 사본으로 남긴다.
        if (m.space === COMMON) {
          const fresh = await call<Memo>("memoRead", { space: m.space, path: m.path });
          if (!drop && body !== undefined && body !== fresh.body) {
            await saveRecoveryCopy(recoveryDocument({ ...snapshot, body }));
            preserved = true;
          }
          return fresh;
        }
        return call<Memo>("adoptMemo", {
          space: m.space, path: m.path, syncToken, discardDraft: drop,
          ...(body !== undefined ? { draftBody: body } : {}),
        });
      },
      apply: async (fresh) => {
        dirty.current = { seq: 0, saved: 0 };
        markSaved(fresh.body);
        clearMemoDraft(m.space, m.path);
        setConflictState(false);
        setStatus("저장됨");
        setCurrentMemo(fresh);
        if (m.space === COMMON || !fresh.id) return true;
        return call<boolean>("finishDocumentSync", { id: fresh.id, revision: fresh.revision, syncToken });
      },
      preserve: ({ memo: snapshot, body }) => saveRecoveryCopy(recoveryDocument({ ...snapshot, body: body ?? snapshot.body })),
    }, discard);
    if (result.status === "resolved") {
      memoSyncIssue(key);
      if (activeRef.current && sameMemo(m, memoRef.current)) notifyRemoteUpdate(before, memoRef.current, messageRef.current);
      if (preserved || result.recoverySaved)
        messageRef.current("이 기기의 저장 전 입력은 복구 사본으로 보관했습니다.");
    } else if (result.status === "failed") {
      const error = result.error;
      memoSyncIssue(key, error instanceof Error ? error.message : "충돌 정리를 완료하지 못했습니다.");
      if (sameMemo(m, memoRef.current)) setStatus("이 문서 확인 필요");
    }
  }
  const adoptInChain = (m: Memo, discard = false) => {
    const task = chain.current.then(() => adoptSyncedMemo(m, discard));
    chain.current = task.catch(() => {});
    return task;
  };

  const loadSpaces = useCallback(async () => {
    const list = await call<Space[]>("memoSpaces");
    setSpaces(list);
    if (!list.some((s) => s.id === spaceRef.current)) {
      setSpace(COMMON);
    }
  }, []);

  const loadTree = useCallback(async (targetSpace = spaceRef.current) => {
    const seq = ++treeSeq.current;
    const r = await call<{ entries: Entry[] }>("memoTree", { space: targetSpace });
    if (seq === treeSeq.current && targetSpace === spaceRef.current) {
      let next = r.entries;
      for (const change of entryChanges.current) next = change(next);
      setEntries(next);
    }
  }, []);

  // 목록을 먼저 바꾸고, 백엔드 처리가 끝나면 실제 목록을 다시 읽는다.
  const changeEntries = async <T,>(change: EntryChange, run: () => Promise<T>): Promise<T> => {
    const targetSpace = spaceRef.current;
    entryChanges.current.add(change);
    setEntries(change);
    try {
      return await run();
    } finally {
      entryChanges.current.delete(change);
      await loadTree(targetSpace).catch(report);
    }
  };

  useEffect(() => {
    loadSpaces().catch(report);
    loadTree(space).catch(report);
  }, [space, loadSpaces, loadTree, report]);

  const save = useCallback((auto = false) => {
    const run = async () => {
      const m = memoRef.current;
      if (!m) return;
      if (issueRef.current[memoKey(m)]) {
        if (dirty.current.seq !== dirty.current.saved) {
          await saveRecoveryCopy(recoveryDocument(m));
          setStatus("복구 사본 보관됨");
        }
        return;
      }
      if (dirty.current.seq === dirty.current.saved) return;
      if (auto && conflictRef.current) return;
      if (auto) {
        const cond = autoSaveCondition(prefsRef.current, lastSaved.current.body, m.body, lastSaved.current.at);
        if (!cond.met) {
          if (cond.chars >= cond.minChars) timer.current = window.setTimeout(() => save(true).catch(report), cond.delay);
          return;
        }
      }
      const seq = dirty.current.seq;
      setStatus("저장 중");
      try {
        const saved = await call<Memo>("memoSave", {
          space: m.space,
          path: m.path,
          body: m.body,
          expectedRevision: m.revision,
          forceHistory: !auto,
        });
        dirty.current.saved = seq;
        markSaved(m.body);
        if (dirty.current.seq === seq) {
          clearTimeout(draftTimer.current);
          clearMemoDraft(m.space, m.path);
        }
        if (memoRef.current && memoRef.current.path === m.path && memoRef.current.space === m.space) {
          memoRef.current = {
            ...memoRef.current,
            revision: saved.revision,
            updatedAt: saved.updatedAt,
          };
          setMemo(memoRef.current);
        }
        setStatus(dirty.current.seq === dirty.current.saved ? "저장됨" : "저장 대기");
        if (saved.historyWarning) report(Error(saved.historyWarning));
        if (!auto) void call("requestSyncNow").catch(() => {});
      } catch (e: any) {
        // 다른 곳에서 먼저 바뀐 메모는 최신본과 정리한다.
        if (e.code === "CONFLICT") { await adoptSyncedMemo(m); return; }
        setStatus("저장 안 됨");
        throw e;
      }
    };
    const task = chain.current.then(run);
    chain.current = task.catch(() => {});
    return task;
  }, []);

  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    await save(false);
  }, [save]);

  useEffect(() => {
    flushRef.current = async () => {
      await flush();
    };
    return () => {
      flushRef.current = null;
    };
  }, [flush, flushRef]);

  const openMemoFile = useCallback(
    async (targetSpace: string, path: string) => {
      await flush();
      if (targetSpace !== spaceRef.current) {
        spaceRef.current = targetSpace;
        setSpace(targetSpace);
        await loadTree(targetSpace);
      }
      const loaded = await call<Memo>("memoRead", { space: targetSpace, path });
      dirty.current = { seq: 0, saved: 0 };
      markSaved(loaded.body);
      setConflictState(false);
      setStatus("저장됨");
      setCurrentMemo(loaded);
      restoreDraft(loaded);
      if (loaded.historyWarning) report(Error(loaded.historyWarning));
    },
    [flush, loadTree],
  );

  useEffect(() => {
    if (apiRef) {
      apiRef.current = {
        open: async (targetSpace: string, path: string) => {
          await openMemoFile(targetSpace, path);
        },
      };
    }
  }, [apiRef, openMemoFile]);

  const closeMemoEditor = useCallback(async () => {
    await flush().catch(report);
    setCurrentMemo(null);
    setConflictState(false);
    await loadTree().catch(report);
  }, [flush, loadTree, report]);

  useEffect(() => {
    onDetailStateChange?.(!!memo, () => {
      if (historyTarget) {
        setHistoryTarget(null);
        return;
      }
      void closeMemoEditor();
    });
  }, [memo, historyTarget, closeMemoEditor, onDetailStateChange]);

  // 열린 메모가 다른 곳에서 바뀌면 최신본을 반영한다. 공용 메모를 고치던 중이면 정리 안내만 띄운다.
  const checkOpenMemo = useSyncFileUpdates({
    fileKey: memo ? memoKey(memo) : "",
    enabled: !!memo,
    automatic: true,
    canCheck: () => activeRef.current && !(memoRef.current && issueRef.current[memoKey(memoRef.current)]),
    current: () => {
      const m = memoRef.current;
      return m ? { doc: m, version: `${dirty.current.seq}:${m.revision}` } : null;
    },
    beforeRead: () => chain.current,
    read: (m: Memo) => call<Memo>("memoRead", { space: m.space, path: m.path }),
    apply: (fresh) => {
      const now = memoRef.current;
      if (now && now.space === COMMON && sameMemo(fresh, now) && dirty.current.seq !== dirty.current.saved) {
        clearTimeout(timer.current);
        setConflictState(true);
        setStatus("외부 변경 있음");
        return;
      }
      return adoptInChain(fresh);
    },
    report,
  });
  // 다른 화면에 있는 동안 들어온 변경은 메모 화면으로 돌아왔을 때 확인한다.
  useEffect(() => {
    if (!active || !memoRef.current) return;
    void checkOpenMemo().catch((e) => {
      if (!["ENOENT", "NOT_FOUND", "VAULT_CHANGED", "SYNC_BUSY", "FILE_BUSY"].includes(e?.code)) report(e);
    });
  }, [active, checkOpenMemo, report]);

  // 설정한 최소 글자 수를 채우면 남은 주기 뒤 자동 저장을 확인한다.
  function schedule() {
    clearTimeout(timer.current);
    const m = memoRef.current;
    if (!m) return;
    const cond = autoSaveCondition(prefsRef.current, lastSaved.current.body, m.body, lastSaved.current.at);
    if (cond.chars < cond.minChars) return;
    timer.current = window.setTimeout(() => save(true).catch(report), cond.delay);
  }

  // 새로 연 메모에 이 기기에 남은 저장 전 입력이 있으면 이어서 쓴다.
  function restoreDraft(m: Memo) {
    const draft = readMemoDraft(m.space, m.path);
    if (!draft) return;
    // 다른 곳에서 바뀐 메모면 남은 입력을 버리지 않고 최신본과 정리한다.
    if (draft.revision !== m.revision) {
      void adoptInChain(m).catch(report);
      return;
    }
    if (draft.body === m.body) return clearMemoDraft(m.space, m.path);
    memoRef.current = { ...m, body: draft.body };
    setMemo(memoRef.current);
    dirty.current.seq++;
    setStatus("저장 대기");
    schedule();
  }

  const editBody = (body: string) => {
    const m = memoRef.current;
    if (!m || body === m.body) return;
    const updated = { ...m, body };
    memoRef.current = updated;
    setMemo(updated);
    dirty.current.seq++;
    clearTimeout(draftTimer.current);
    // 마지막 저장 내용으로 되돌아왔다면 저장할 것이 없으므로 저장됨으로 두고 임시본도 지운다.
    if (body === lastSaved.current.body) {
      dirty.current.saved = dirty.current.seq;
      clearMemoDraft(m.space, m.path);
      setStatus("저장됨");
      return;
    }
    setStatus("저장 대기");
    draftTimer.current = window.setTimeout(() => {
      const now = memoRef.current;
      if (now && dirty.current.seq !== dirty.current.saved) saveMemoDraft(now.space, now.path, now.body, now.revision);
    }, 300);
    schedule();
  };

  const replaceMemoSymbols = () => {
    const current = memoRef.current;
    if (!current) return;
    const ellipsisRule = prefs.autoSymbolReplacement !== false
      ? normalizeTextReplacements(prefs.textReplacements).find(
          (rule) => rule.enabled && rule.from === "..." && rule.from !== rule.to,
        )
      : undefined;
    const { body, count } = replaceManuscriptSymbols(current.body, {
      doubleQuotes: prefs.quoteStyle === "curly",
      singleQuotes: prefs.quoteStyle === "curly",
      ellipsis: !!ellipsisRule,
      ellipsisChar: ellipsisRule?.to,
    });
    if (!count || body === current.body) {
      message("교정할 직선 따옴표나 마침표 말줄임표가 없습니다.");
      return;
    }
    editBody(body);
    message(`기호 일괄 교정 완료 (${count}건 변환)`);
  };

  const commitTitleRename = async (newName: string) => {
    const m = memoRef.current;
    const trimmed = newName.trim();
    if (!m || !trimmed || trimmed === m.title) {
      setTitleInput(m?.title ?? "");
      return;
    }
    await changeEntries(
      (list) => list.map((e) => (e.path === m.path ? { ...e, name: trimmed } : e)),
      async () => {
        await flush();
        const r = await call<{ path: string }>("memoRename", {
          space: m.space,
          path: m.path,
          name: trimmed,
        });
        const nextMemo = await call<Memo>("memoRead", { space: m.space, path: r.path });
        setCurrentMemo(nextMemo);
      },
    );
  };

  const manualSaveMemo = async () => {
    await commitTitleRename(titleInput);
    await flush();
    const current = memoRef.current;
    if (current?.space === COMMON) {
      await call("checkpointDocument", { id: current.id, space: COMMON, path: current.path, force: true });
    }
    message("메모를 저장했습니다.", undefined, 1500);
  };

  const showMemoHistory = async () => {
    await commitTitleRename(titleInput);
    await flush();
    const current = memoRef.current;
    if (!current) return;
    const target = await call<Memo>("memoRead", { space: current.space, path: current.path });
    if (!target.id) throw Error("메모의 변경 이력을 찾을 수 없습니다.");
    setHistoryTarget({ ...target, id: target.id });
  };

  const createNewMemo = async (folder: string, name: string) => {
    await flush();
    const created = await call<Memo>("memoCreate", {
      space,
      folder,
      title: name.trim() || "새 메모",
    });
    if (folder) {
      setOpenFolders((prev) => new Set([...prev, folder]));
    }
    setEntries((list) =>
      list.some((e) => e.path === created.path)
        ? list
        : [...list, { path: created.path, name: created.title, type: "file" }],
    );
    void loadTree(space).catch(report);
    await openMemoFile(space, created.path);
  };

  const createNewFolder = async (parent: string, name: string) => {
    const r = await call<{ path: string }>("memoCreateFolder", {
      space,
      parent,
      name: name.trim() || "새 폴더",
    });
    if (parent) {
      setOpenFolders((prev) => new Set([...prev, parent, r.path]));
    } else if (r?.path) {
      setOpenFolders((prev) => new Set([...prev, r.path]));
    }
    if (r?.path)
      setEntries((list) =>
        list.some((e) => e.path === r.path)
          ? list
          : [...list, { path: r.path, name: r.path.slice(r.path.lastIndexOf("/") + 1), type: "folder" }],
      );
    message(`'${name.trim()}' 폴더를 만들었습니다.`);
    await loadTree(space);
  };

  const renameEntry = async (path: string, newName: string) => {
    if (!newName.trim()) return;
    if (memoRef.current?.path === path) {
      await commitTitleRename(newName);
      return;
    }
    const name = newName.trim();
    const saving = changeEntries(
      (list) => list.map((e) => (e.path === path ? { ...e, name } : e)),
      () => call("memoRename", { space, path, name }),
    );
    message("이름을 변경했습니다.");
    await saving;
  };

  const moveEntry = async (path: string, targetFolder: string) => {
    if (path === targetFolder || parentOf(path) === targetFolder || targetFolder.startsWith(path + "/")) {
      return;
    }
    const moved = (targetFolder ? targetFolder + "/" : "") + path.slice(path.lastIndexOf("/") + 1);
    const relocate = (p: string) => (p === path || p.startsWith(path + "/") ? moved + p.slice(path.length) : p);
    const moving = changeEntries(
      (list) => list.map((e) => ({ ...e, path: relocate(e.path) })),
      async () => {
        await flush();
        const r = await call<{ path: string }>("memoMove", {
          space,
          path,
          to: targetFolder,
        });
        if (memoRef.current?.path === path) {
          const previous = memoRef.current;
          const fresh = await call<Memo>("memoRead", { space: previous.space, path: r.path });
          setCurrentMemo(fresh);
        }
      },
    );
    if (targetFolder) setOpenFolders((prev) => new Set([...prev, targetFolder]));
    message(targetFolder ? `'${targetFolder}' 폴더로 이동했습니다.` : "최상위 위치로 이동했습니다.");
    await moving;
  };

  const removeEntry = async (entry: Entry) => {
    const ok = await confirm({
      title: entry.type === "folder" ? "폴더 삭제" : "메모 삭제",
      message: `'${entry.name}' ${entry.type === "folder" ? "폴더와 내부 메모를" : "메모를"} 휴지통으로 옮길까요?`,
      confirmLabel: "삭제",
      danger: true,
    });
    if (!ok) return;
    const inside = (p: string) => p === entry.path || p.startsWith(entry.path + "/");
    const removing = changeEntries(
      (list) => list.filter((e) => !inside(e.path)),
      async () => {
        await flush();
        await call("memoRemove", { space, path: entry.path });
        if (memoRef.current && inside(memoRef.current.path)) setCurrentMemo(null);
      },
    );
    message("삭제했습니다.");
    await removing;
  };

  const allFolderEntries = useMemo(
    () =>
      entries
        .filter((e) => e.type === "folder")
        .sort((a, b) => a.name.localeCompare(b.name, "ko", { numeric: true })),
    [entries],
  );

  const allFolders = useMemo(
    () => allFolderEntries.map((e) => e.path),
    [allFolderEntries],
  );

  const filteredFiles = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    return entries.filter((e) => {
      if (e.type !== "file") return false;
      if (q) {
        return e.name.toLowerCase().includes(q) || e.path.toLowerCase().includes(q);
      }
      return true;
    });
  }, [entries, filterQuery]);

  const toggleFolder = (path: string) => {
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const currentSpaceTitle =
    spaces.find((s) => s.id === space)?.title || (space === COMMON ? "공용 메모" : "작품 메모");

  const spaceSheetItems: MobileActionItem[] = spaces.map((s) => ({
    label: s.id === COMMON ? "공용 메모 (모든 작품 공통)" : `${s.title} 메모`,
    icon: s.id === COMMON ? <FolderOpen size={18} /> : <StickyNote size={18} />,
    checked: s.id === space,
    action: () => {
      setSpace(s.id);
      setOpenFolders(new Set());
      setFilterQuery("");
    },
  }));

  const getEntrySheetItems = (entry: Entry): MobileActionItem[] => {
    if (entry.type === "folder") {
      return [
        {
          label: openFolders.has(entry.path) ? "폴더 접기" : "폴더 펼치기",
          icon: openFolders.has(entry.path) ? <Folder size={18} /> : <FolderOpen size={18} />,
          action: () => toggleFolder(entry.path),
        },
        {
          label: "이 폴더에 새 메모 작성",
          icon: <FilePlus size={18} />,
          action: () =>
            setPromptTarget({
              mode: "newMemo",
              folder: entry.path,
              initialValue: "새 메모",
            }),
        },
        {
          label: "하위 폴더 만들기",
          icon: <FolderPlus size={18} />,
          action: () =>
            setPromptTarget({
              mode: "newFolder",
              folder: entry.path,
              initialValue: "새 폴더",
            }),
        },
        "separator",
        {
          label: "폴더 이름 바꾸기",
          icon: <Edit3 size={18} />,
          action: () =>
            setPromptTarget({
              mode: "rename",
              path: entry.path,
              initialValue: entry.name,
            }),
        },
        {
          label: "폴더 위치 이동...",
          icon: <FolderInput size={18} />,
          action: () => setMoveTargetEntry({ path: entry.path, name: entry.name }),
        },
        "separator",
        {
          label: "폴더 삭제",
          icon: <Trash2 size={18} />,
          danger: true,
          action: () => void removeEntry(entry),
        },
      ];
    }

    return [
      {
        label: "메모 열기",
        icon: <StickyNote size={18} />,
        action: () => void openMemoFile(space, entry.path).catch(report),
      },
      {
        label: "메모 이름 바꾸기",
        icon: <Edit3 size={18} />,
        action: () =>
          setPromptTarget({
            mode: "rename",
            path: entry.path,
            initialValue: entry.name,
          }),
      },
      {
        label: "폴더 이동...",
        icon: <FolderInput size={18} />,
        action: () => setMoveTargetEntry({ path: entry.path, name: entry.name }),
      },
      "separator",
      {
        label: "메모 삭제",
        icon: <Trash2 size={18} />,
        danger: true,
        action: () => void removeEntry(entry),
      },
    ];
  };

  if (!active) return null;

  const kindPrefs = resolveKindPrefs(prefs, "memo");
  const normStyle = normalizeEditorStyle(prefs, "memo");

  // 2단계: 메모 상세 편집 화면 (100% 전체 화면)
  if (memo) {
    return (
      <div className="m-screen m-memo-editor-screen">
        <header className="m-topbar">
          <button
            type="button"
            className="m-back-btn"
            onClick={() => void closeMemoEditor()}
          >
            <ArrowLeft size={18} />
            <span>메모 목록</span>
          </button>
          <div className="m-editor-status-wrap">
            <span className={`save-indicator ${status !== "저장됨" ? "pending" : ""}`}>
              <span />
              {status}
            </span>
            <SyncStatus
              status={syncStatus}
              checking={syncChecking}
              available={syncAvailable}
              editing={status !== "저장됨"}
              activeOnly
            />
          </div>
          <div className="m-topbar-actions">
            <button
              type="button"
              className="m-icon-btn"
              aria-label="본문 복사"
              onClick={() => {
                void navigator.clipboard
                  .writeText(plainText(memo.body))
                  .then(() => message("메모 본문을 복사했습니다."));
              }}
            >
              <Copy size={18} />
            </button>
            <button
              type="button"
              className="m-icon-btn"
              aria-label="메모 메뉴"
              onClick={() => setEditorMenuOpen(true)}
            >
              <MoreVertical size={19} />
            </button>
          </div>
        </header>

        {(syncIssues[memoKey(memo)] || conflict) && (
          <SyncIssueBanner
            issue={syncIssues[memoKey(memo)] || "다른 곳에서 바뀐 메모와 이 기기의 임시본을 정리합니다."}
            retry={(discard) => adoptInChain(memo, discard)}
          />
        )}

        <EditorScroll
          key={`${memo.space}:${memo.path}`}
          documentId={`${memo.space}:${memo.path}`}
          scope={`mobile-memo:${memo.space}`}
          positions={scrollPositions.current}
          visible={true}
        >
          <article className="m-manuscript-sheet">
            <div className="m-memo-meta-line">
              <span>{currentSpaceTitle}</span>
              {parentOf(memo.path) && (
                <>
                  <i>·</i>
                  <span>{parentOf(memo.path)}</span>
                </>
              )}
            </div>
            <input
              type="text"
              className="m-document-title-input"
              value={titleInput}
              placeholder="메모 제목"
              onChange={(e) => setTitleInput(e.target.value)}
              onBlur={() => void commitTitleRename(titleInput).catch(report)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  (e.currentTarget as HTMLInputElement).blur();
                }
              }}
            />
            <Writer
              key={`${memo.space}:${memo.path}`}
              id={`memo:${memo.space}:${memo.path}`}
              revision={memo.revision}
              body={memo.body}
              onUndoStateChange={onUndoStateChange}
              source={false}
              manualLineBreak={!!memo.manualLineBreak}
              copyWithBlankLines={prefs.copyWithBlankLines === true}
              tables={true}
              links={true}
              onOpenLink={onOpenLink}
              onChange={(body) => editBody(body)}
              fontSize={normStyle.fontSize}
              lineHeight={normStyle.lineHeight}
              editorStyle={kindPrefs}
              typingOptions={{
                autoCloseQuotes: prefs.autoCloseQuotes,
                autoCloseBrackets: prefs.autoCloseBrackets,
                smartBrackets: prefs.smartBrackets,
                autoSymbolReplacement: prefs.autoSymbolReplacement,
                autoDividerReplacement: prefs.autoDividerReplacement,
                quoteStyle: prefs.quoteStyle,
                textReplacements: prefs.textReplacements,
              }}
              lineBreak={{
                def: false,
                defaultLabel: "기본값",
                onChange: (manualLineBreak) => {
                  if (!memoRef.current) return;
                  const updated = { ...memoRef.current, manualLineBreak };
                  memoRef.current = updated;
                  setMemo(updated);
                },
              }}
              onReplaceSymbols={replaceMemoSymbols}
              contextMenu={false}
              images={images(memoImageScope(memo.space, memo.path), true)}
            />
          </article>
        </EditorScroll>

        <MobileEditorToolbar
          canUndo={undoState.canUndo}
          canRedo={undoState.canRedo}
          saveDisabled={status === "저장 중" || (
            dirty.current.seq === dirty.current.saved &&
            (!titleInput.trim() || titleInput.trim() === memo.title)
          )}
          moreOpen={editorMenuOpen}
          onToggleMore={() => setEditorMenuOpen((open) => !open)}
          onReplaceSymbols={replaceMemoSymbols}
          onHistory={() => void showMemoHistory().catch(report)}
          onSave={() => void manualSaveMemo().catch(report)}
          onCopy={() => {
            void navigator.clipboard
              .writeText(plainText(memo.body))
              .catch(report);
          }}
        />

        {/* 메모 하단 툴바 우측 더보기(⋮) 플로팅 팝업 메뉴 */}
        {editorMenuOpen && (
          <div
            className="m-floating-popup-backdrop"
            onClick={() => setEditorMenuOpen(false)}
            role="presentation"
          >
            <div
              className="m-floating-popup-menu"
              role="menu"
              aria-label="메모 더보기 메뉴"
              onClick={(e) => e.stopPropagation()}
            >
              <MobileEditorMenuActions
                tables={true}
                manualLineBreak={!!memo.manualLineBreak}
                onClose={() => setEditorMenuOpen(false)}
              />

              <div className="m-floating-popup-divider" />

              <div className="m-floating-popup-section">
                <button
                  type="button"
                  className="m-floating-popup-item"
                  role="menuitem"
                  onClick={() => {
                    setEditorMenuOpen(false);
                    setPromptTarget({ mode: "newMemo", folder: parentOf(memo.path), initialValue: "새 메모" });
                  }}
                >
                  <FilePlus size={16} />
                  <span>새 메모</span>
                </button>
                <button
                  type="button"
                  className="m-floating-popup-item"
                  role="menuitem"
                  onClick={() => {
                    setEditorMenuOpen(false);
                    setPromptTarget({
                      mode: "rename",
                      path: memo.path,
                      initialValue: memo.title,
                    });
                  }}
                >
                  <Edit3 size={16} />
                  <span>메모 이름 바꾸기</span>
                </button>

                <button
                  type="button"
                  className="m-floating-popup-item"
                  role="menuitem"
                  onClick={() => {
                    setEditorMenuOpen(false);
                    setMoveTargetEntry({ path: memo.path, name: memo.title });
                  }}
                >
                  <FolderInput size={16} />
                  <span>폴더 위치 이동</span>
                </button>
              </div>

              <div className="m-floating-popup-divider" />

              <div className="m-floating-popup-section">
                <button
                  type="button"
                  className="m-floating-popup-item danger"
                  role="menuitem"
                  onClick={() => {
                    setEditorMenuOpen(false);
                    void removeEntry({
                      path: memo.path,
                      name: memo.title,
                      type: "file",
                    });
                  }}
                >
                  <Trash2 size={16} />
                  <span>메모 삭제</span>
                </button>
              </div>
            </div>
          </div>
        )}

        <MobileFolderPickerSheet
          open={!!moveTargetEntry}
          title={`'${moveTargetEntry?.name || "메모"}' 폴더 이동`}
          currentFolder={moveTargetEntry ? parentOf(moveTargetEntry.path) : ""}
          folders={allFolders}
          onSelect={(targetFolder) => {
            if (moveTargetEntry) {
              void moveEntry(moveTargetEntry.path, targetFolder).catch(report);
            }
          }}
          onClose={() => setMoveTargetEntry(null)}
        />

        <MobilePromptSheet
          open={!!promptTarget}
          title={promptTarget?.mode === "newMemo" ? "새 메모" : "메모 이름 바꾸기"}
          initialValue={promptTarget?.initialValue || ""}
          confirmLabel={promptTarget?.mode === "newMemo" ? "만들기" : "변경"}
          onConfirm={(val) => {
            if (promptTarget?.mode === "newMemo") {
              void createNewMemo(promptTarget.folder || "", val).catch(report);
            } else if (promptTarget?.path) {
              void renameEntry(promptTarget.path, val).catch(report);
            }
          }}
          onClose={() => setPromptTarget(null)}
        />
        {historyTarget && (
          <div className="m-dialog-page" role="dialog" aria-modal="true" aria-label="메모 변경 이력">
            <header className="m-topbar m-topbar-centered">
              <button type="button" className="m-back-btn" onClick={() => setHistoryTarget(null)}>
                <ArrowLeft size={18} /><span>메모</span>
              </button>
              <div className="m-topbar-title"><h1>변경 이력</h1></div>
            </header>
            <div className="m-dialog-body">
              <HistoryDialog
                documentId={historyTarget.id}
                memoContext={historyTarget.space === COMMON ? { space: COMMON, path: historyTarget.path } : undefined}
                report={report}
                onRestore={async (id, name) => {
                  await flush();
                  const current = memoRef.current;
                  if (!current || current.space !== historyTarget.space || current.path !== historyTarget.path)
                    throw Error("열린 메모가 변경되었습니다. 이력을 다시 열어 주세요.");
                  const restored = await call<{ historyWarning?: string }>("restore", {
                    id, name, expectedRevision: historyTarget.revision,
                    ...(historyTarget.space === COMMON ? { space: COMMON, path: historyTarget.path } : {}),
                  });
                  const fresh = await call<Memo>("memoRead", { space: current.space, path: current.path });
                  dirty.current = { seq: 0, saved: 0 };
                  markSaved(fresh.body);
                  setCurrentMemo(fresh);
                  setConflictState(false);
                  setStatus("저장됨");
                  setHistoryTarget(null);
                  await loadTree(current.space);
                  message(restored.historyWarning ?? "이전 메모를 복원했습니다.");
                }}
              />
            </div>
          </div>
        )}
        {confirmDialog}
      </div>
    );
  }

  // 옵시디언 / 노션 스타일 계층형 메모 트리 렌더링
  const renderMemoTreeLevel = (parentPath: string, depth: number): React.ReactNode => {
    const q = filterQuery.trim();
    const subFolders = allFolderEntries.filter((f) => {
      if (parentOf(f.path) !== parentPath) return false;
      if (!q) return true;
      return (
        f.name.toLowerCase().includes(q.toLowerCase()) ||
        filteredFiles.some((file) => file.path.startsWith(f.path + "/")) ||
        allFolderEntries.some(
          (sub) =>
            sub.path.startsWith(f.path + "/") &&
            sub.name.toLowerCase().includes(q.toLowerCase()),
        )
      );
    });

    const filesHere = filteredFiles.filter((file) => parentOf(file.path) === parentPath);

    return (
      <>
        {subFolders.map((folder) => {
          const isOpen = !!q || openFolders.has(folder.path);
          const countInside = entries.filter(
            (e) => e.type === "file" && e.path.startsWith(folder.path + "/"),
          ).length;

          return (
            <div key={`folder:${folder.path}`} className="m-tree-node">
              <div className={`m-tree-row m-tree-folder ${isOpen ? "is-open" : ""}`}>
                <button
                  type="button"
                  className="m-tree-row-main"
                  onClick={() => toggleFolder(folder.path)}
                >
                  <span className="m-tree-chevron">
                    {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  </span>
                  <span className="m-tree-icon folder">
                    {isOpen ? <FolderOpen size={16} /> : <Folder size={16} />}
                  </span>
                  <span className="m-tree-label">{folder.name}</span>
                  <span className="m-tree-count">{countInside}</span>
                </button>
                <button
                  type="button"
                  className="m-tree-action-btn"
                  aria-label={`${folder.name}에 새 메모 추가`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setPromptTarget({
                      mode: "newMemo",
                      folder: folder.path,
                      initialValue: "새 메모",
                    });
                  }}
                >
                  <Plus size={16} />
                </button>
                <button
                  type="button"
                  className="m-tree-action-btn"
                  aria-label={`${folder.name} 메뉴`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setEntrySheet(folder);
                  }}
                >
                  <MoreVertical size={17} />
                </button>
              </div>
              {isOpen && (
                <div className="m-tree-children">
                  {renderMemoTreeLevel(folder.path, depth + 1)}
                </div>
              )}
            </div>
          );
        })}

        {filesHere.map((file) => (
          <div key={`file:${file.path}`} className="m-tree-row m-doc-tree-item">
            <button
              type="button"
              className="m-tree-row-main"
              onClick={() => void openMemoFile(space, file.path).catch(report)}
            >
              <span className={`m-tree-icon ${file.kind === "plot" ? "plot" : "memo"}`}>
                {file.kind === "plot" ? <FilePlus size={16} /> : <StickyNote size={16} />}
              </span>
              <span className="m-tree-label">{file.name}</span>
              {file.updatedAt && (
                <span className="m-tree-meta">
                  {new Date(file.updatedAt).toLocaleDateString("ko-KR")}
                </span>
              )}
            </button>
            <button
              type="button"
              className="m-tree-action-btn"
              aria-label={`${file.name} 메뉴`}
              onClick={(e) => {
                e.stopPropagation();
                setEntrySheet(file);
              }}
            >
              <MoreVertical size={17} />
            </button>
          </div>
        ))}
      </>
    );
  };

  // 1단계: 전체 화면 메모 트리 화면 (2026 옵시디언/노션 스타일)
  return (
    <div className="m-screen m-modern-workspace">
      <header className="m-modern-header">
        <div className="m-modern-header-top">
          <button
            type="button"
            className="m-modern-title-btn"
            onClick={() => setSpaceSheetOpen(true)}
          >
            <span className="m-modern-title-text" title={currentSpaceTitle}>{currentSpaceTitle}</span>
            <ChevronDown size={18} className="m-modern-title-chevron" />
          </button>
          <div className="m-topbar-actions">
            <button type="button" className="m-icon-btn" aria-label="메모 보관함 열기" title="보관함"
              onClick={() => setArchiveOpen(true)}><Archive size={18} /></button>
            <button
              type="button"
              className="m-btn-secondary m-btn-sm"
              onClick={() =>
                setPromptTarget({
                  mode: "newFolder",
                  folder: "",
                  initialValue: "새 폴더",
                })
              }
            >
              <FolderPlus size={15} />
              <span>폴더</span>
            </button>
            <button
              type="button"
              className="m-btn-primary m-btn-sm"
              onClick={() =>
                setPromptTarget({
                  mode: "newMemo",
                  folder: "",
                  initialValue: "새 메모",
                })
              }
            >
              <Plus size={15} />
              <span>새 메모</span>
            </button>
          </div>
        </div>

        {/* 메모 검색 바 */}
        <div className="m-modern-toolbar">
          <div className="m-soft-search">
            <Search size={15} className="m-filter-icon" />
            <input
              type="text"
              className="m-filter-input"
              placeholder="메모·폴더 이름으로 찾기..."
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
            />
            {filterQuery && (
              <button
                type="button"
                className="m-filter-clear"
                aria-label="검색어 지우기"
                onClick={() => setFilterQuery("")}
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>
      </header>

      {/* 옵시디언 / 노션 스타일 계층형 메모 트리 (구분선 없음) */}
      <div className="m-scroll-body m-tree-scroll">
        <div className="m-tree-container">
          {renderMemoTreeLevel("", 0)}

          {allFolderEntries.length === 0 && filteredFiles.length === 0 && (
            <div className="m-empty-state">
              <StickyNote size={32} />
              <h3>
                {filterQuery.trim()
                  ? "일치하는 메모가 없습니다"
                  : `${currentSpaceTitle}가 비어 있습니다`}
              </h3>
              <p>떠오른 아이디어나 세계관·캐릭터 설정을 트리 구조로 정리해 보세요.</p>
              {!filterQuery.trim() && (
                <button
                  type="button"
                  className="m-btn-primary"
                  onClick={() =>
                    setPromptTarget({
                      mode: "newMemo",
                      folder: "",
                      initialValue: "새 메모",
                    })
                  }
                >
                  <Plus size={17} />
                  <span>새 메모 작성하기</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {archiveOpen && <MemoArchiveDialog mobile space={space} title={currentSpaceTitle} documents={documents}
        onClose={() => setArchiveOpen(false)} openDoc={openDoc} openMemo={openMemoFile} />}

      {/* 메모 공간 전환 시트 (내부 경로 표시 제거) */}
      <MobileActionSheet
        open={spaceSheetOpen}
        title="메모 공간 선택"
        subtitle="공용 메모 또는 작품별 전용 문서 공간"
        items={spaceSheetItems}
        onClose={() => setSpaceSheetOpen(false)}
      />

      {/* 항목 더보기 시트 (내부 경로 표시 제거) */}
      <MobileActionSheet
        open={!!entrySheet}
        title={entrySheet?.name || "메모 메뉴"}
        items={entrySheet ? getEntrySheetItems(entrySheet) : []}
        onClose={() => setEntrySheet(null)}
      />

      {/* 폴더 이동 시트 */}
      <MobileFolderPickerSheet
        open={!!moveTargetEntry}
        title={`'${moveTargetEntry?.name || "항목"}' 위치 이동`}
        currentFolder={moveTargetEntry ? parentOf(moveTargetEntry.path) : ""}
        folders={allFolders.filter(
          (f) =>
            !moveTargetEntry ||
            (f !== moveTargetEntry.path && !f.startsWith(moveTargetEntry.path + "/")),
        )}
        onSelect={(targetFolder) => {
          if (moveTargetEntry) {
            void moveEntry(moveTargetEntry.path, targetFolder).catch(report);
          }
        }}
        onClose={() => setMoveTargetEntry(null)}
      />

      {/* 새 메모 / 새 폴더 / 이름 변경 모달 */}
      <MobilePromptSheet
        open={!!promptTarget}
        title={
          promptTarget?.mode === "newMemo"
            ? "새 메모 만들기"
            : promptTarget?.mode === "newFolder"
              ? "새 폴더 만들기"
              : "이름 바꾸기"
        }
        initialValue={promptTarget?.initialValue || ""}
        placeholder="이름을 입력하세요"
        confirmLabel={promptTarget?.mode === "rename" ? "변경" : "만들기"}
        onConfirm={(val) => {
          if (!promptTarget) return;
          if (promptTarget.mode === "newMemo") {
            void createNewMemo(promptTarget.folder || "", val).catch(report);
          } else if (promptTarget.mode === "newFolder") {
            void createNewFolder(promptTarget.folder || "", val).catch(report);
          } else if (promptTarget.mode === "rename" && promptTarget.path) {
            void renameEntry(promptTarget.path, val).catch(report);
          }
        }}
        onClose={() => setPromptTarget(null)}
      />

      {confirmDialog}
    </div>
  );
}
