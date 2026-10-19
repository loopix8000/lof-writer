import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { editorDropZone } from "../editor-groups";
import { call, type Doc } from "../types";
import { useSyncFileUpdates } from "../useSyncFileUpdates";
import { placeTab, withoutTab, type EditorGroup, type EditorTab, type Side } from "./model";

type Options = {
  active: Doc | null;
  documents: Doc[];
  workspaceOpen: boolean;
  visible: boolean;
  currentId: () => string;
  currentDocument: () => Doc | null;
  flush: (options?: { closing?: boolean; skipMemo?: boolean }) => Promise<void>;
  // 저장과 읽기를 마친 뒤 beforeCommit과 편집 문서 변경을 같은 렌더에 반영한다.
  navigate: (id: string, pinned: boolean, beforeCommit?: () => void) => Promise<void>;
  // 저장 후 문서 초기화와 commit을 함께 반영한다. 다른 이동이 시작되면 commit을 호출하지 않는다.
  closeLastDocument: (commit: () => void) => Promise<void>;
  report: (error: unknown) => void;
};

export function useEditorGroups(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  // 포커스된 그룹은 tabs, 나머지 그룹은 split에 보관하고 전환 시 두 값을 맞바꾼다.
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [split, setSplit] = useState<EditorGroup | null>(null);
  const [focusedSide, setFocusedSide] = useState<Side>("left");
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [sideDoc, setSideDocState] = useState<Doc | null>(null);
  const [sideSyncKey, setSideSyncKey] = useState("");
  const tabsRef = useRef<EditorTab[]>([]);
  const splitRef = useRef<EditorGroup | null>(null);
  const focusedSideRef = useRef(focusedSide);
  focusedSideRef.current = focusedSide;
  const groupsRef = useRef<HTMLDivElement>(null);
  const retainedDocuments = useRef(new Map<string, Doc>());
  const stopResizing = useRef<(() => void) | null>(null);

  const updateTabs = useCallback((update: (tabs: EditorTab[]) => EditorTab[]) => {
    const next = update(tabsRef.current);
    if (next === tabsRef.current) return;
    tabsRef.current = next;
    setTabs(next);
  }, []);

  const updateSplit = useCallback((update: (group: EditorGroup | null) => EditorGroup | null) => {
    const next = update(splitRef.current);
    if (next === splitRef.current) return;
    splitRef.current = next;
    setSplit(next);
    if (!next) setFocusedSide("left");
  }, []);

  const retainDocument = useCallback((doc: Doc) => {
    retainedDocuments.current.set(doc.id, doc);
  }, []);
  const getRetainedDocument = useCallback((id: string) => retainedDocuments.current.get(id), []);
  const clearRetainedDocuments = useCallback(() => retainedDocuments.current.clear(), []);
  const setSideDoc = useCallback((doc: Doc | null) => {
    if (doc) retainDocument(doc);
    setSideDocState(doc);
  }, [retainDocument]);
  const clearSideDocument = useCallback(() => setSideDoc(null), [setSideDoc]);

  useEffect(() => {
    const open = new Set([...tabs, ...(split?.tabs ?? [])].map((tab) => tab.id));
    for (const id of retainedDocuments.current.keys())
      if (!open.has(id)) retainedDocuments.current.delete(id);
  }, [tabs, split]);

  const pruneDocuments = useCallback((ids: Set<string>) => {
    updateTabs((tabs) => tabs.every((tab) => ids.has(tab.id)) ? tabs : tabs.filter((tab) => ids.has(tab.id)));
    updateSplit((group) => {
      if (!group || group.tabs.every((tab) => ids.has(tab.id))) return group;
      const tabs = group.tabs.filter((tab) => ids.has(tab.id));
      if (!tabs.length) return null;
      return { tabs, docId: ids.has(group.docId) ? group.docId : tabs[0].id };
    });
  }, [updateTabs, updateSplit]);

  const resetGroups = useCallback(() => {
    updateTabs(() => []);
    updateSplit(() => null);
  }, [updateTabs, updateSplit]);

  const commitOpenDocument = useCallback((doc: Doc, { sameProject, pinned, after }: {
    sameProject: boolean;
    pinned: boolean;
    after: string;
  }) => {
    if (!sameProject) updateSplit(() => null);
    updateTabs((tabs) => placeTab(sameProject ? tabs : [], doc.id, pinned, after));
  }, [updateTabs, updateSplit]);

  const pinTab = useCallback((id: string) => {
    updateTabs((tabs) => tabs.some((tab) => tab.id === id && !tab.pinned) ? placeTab(tabs, id, true, "") : tabs);
  }, [updateTabs]);

  const replaceDocumentId = useCallback((oldId: string, newId: string) => {
    const swap = (id: string) => id === oldId ? newId : id;
    updateTabs((tabs) => tabs.some((tab) => tab.id === oldId)
      ? tabs.map((tab) => ({ ...tab, id: swap(tab.id) })) : tabs);
    updateSplit((group) => group && (group.docId === oldId || group.tabs.some((tab) => tab.id === oldId))
      ? { docId: swap(group.docId), tabs: group.tabs.map((tab) => ({ ...tab, id: swap(tab.id) })) }
      : group);
  }, [updateTabs, updateSplit]);

  const openDoc = useCallback(async (id: string, pinned = false) => {
    await latest.current.navigate(id, pinned);
  }, []);

  async function closeLastTab() {
    await latest.current.closeLastDocument(() => updateTabs(() => []));
  }

  async function closeTab(id: string) {
    const tabs = tabsRef.current, index = tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    if (latest.current.workspaceOpen && id === latest.current.currentId()) {
      await latest.current.flush({ closing: true, skipMemo: true });
      const rest = tabs.filter((tab) => tab.id !== id), next = rest[index] || rest[index - 1];
      if (next) await openDoc(next.id, false);
      else if (splitRef.current) return closeGroup();
      else return closeLastTab();
    }
    updateTabs((tabs) => tabs.filter((tab) => tab.id !== id));
  }

  // 저장한 원고를 유지하고, 읽기에 성공한 뒤 그룹을 전환한다.
  async function focusOther(openId?: string, pinned = false) {
    const other = splitRef.current;
    if (!other) return;
    await latest.current.navigate(openId ?? other.docId, pinned, () => {
      const mine = { tabs: tabsRef.current, docId: latest.current.currentId() };
      tabsRef.current = other.tabs;
      setTabs(other.tabs);
      splitRef.current = mine;
      setSplit(mine);
      setFocusedSide((side) => side === "left" ? "right" : "left");
      keepSideDoc();
    });
  }

  function keepSideDoc() {
    const doc = latest.current.currentDocument();
    if (doc) setSideDoc(doc);
  }

  async function focusSide(side: Side) {
    if (splitRef.current && side !== focusedSideRef.current) await focusOther();
  }

  async function openInGroup(id: string, side: Side, moveTab = false) {
    if (splitRef.current) {
      if (side === focusedSideRef.current) await openDoc(id, true);
      else {
        await focusOther(id, true);
        if (moveTab) updateSplit((group) => withoutTab(group, id));
      }
      return;
    }
    if (!latest.current.currentId() || !tabsRef.current.length) {
      await openDoc(id, true);
      return;
    }
    await latest.current.navigate(id, true, () => {
      const mine = { tabs: tabsRef.current, docId: latest.current.currentId() };
      tabsRef.current = [];
      setTabs([]);
      updateSplit(() => moveTab && mine.tabs.length > 1 ? withoutTab(mine, id) : mine);
      setFocusedSide(side);
      keepSideDoc();
    });
  }

  async function openInTabs(id: string, side: Side) {
    if (splitRef.current) await openInGroup(id, side);
    else await openDoc(id, true);
  }

  async function splitTo(id: string) {
    await openInGroup(id, "right", true);
  }

  async function closeGroup() {
    if (!splitRef.current) return;
    await latest.current.flush({ closing: true, skipMemo: true });
    await focusOther();
    updateSplit(() => null);
  }

  const closeOtherGroup = useCallback(() => updateSplit(() => null), [updateSplit]);

  async function moveToOther(id: string) {
    await focusOther(id, true);
    updateSplit((group) => withoutTab(group, id));
  }

  function closeSideTab(id: string) {
    updateSplit((group) => withoutTab(group, id));
    if (sideDoc?.id === id) setSideDoc(null);
  }

  async function closeTabs(keep: (tab: EditorTab, index: number) => boolean, focusId?: string) {
    const kept = tabsRef.current.filter(keep);
    if (latest.current.workspaceOpen && !kept.some((tab) => tab.id === latest.current.currentId())) {
      await latest.current.flush({ closing: true, skipMemo: true });
      if (focusId && kept.some((tab) => tab.id === focusId)) await openDoc(focusId, false);
      else if (splitRef.current) return closeGroup();
      else if (!kept.length) return closeLastTab();
      else await openDoc(kept[0].id, false);
    }
    updateTabs((tabs) => tabs.filter((tab) => kept.some((keptTab) => keptTab.id === tab.id)));
  }

  async function cycleTab(direction: number) {
    const tabs = tabsRef.current, index = tabs.findIndex((tab) => tab.id === latest.current.currentId());
    if (tabs.length < 2 || index < 0) return;
    await openDoc(tabs[(index + direction + tabs.length) % tabs.length].id, false);
  }

  const moveTab = useCallback((from: string, to: string) => {
    updateTabs((tabs) => {
      const a = tabs.findIndex((tab) => tab.id === from), b = tabs.findIndex((tab) => tab.id === to);
      if (a < 0 || b < 0 || a === b) return tabs;
      const next = [...tabs];
      next.splice(b, 0, ...next.splice(a, 1));
      return next;
    });
  }, [updateTabs]);

  const currentTabId = options.active?.id;
  useEffect(() => {
    document
      .querySelector<HTMLElement>(".editor-group.focused .editor-tab.current, .editor-groups:not(.split) .editor-tab.current")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [currentTabId, tabs.length]);

  const sideId = split?.docId || "";
  const sideRevision = options.documents.find((doc) => doc.id === sideId)?.revision;
  const checkSideDocument = useSyncFileUpdates({
    fileKey: sideDoc?.id ?? "",
    enabled: !!sideId && sideDoc?.id === sideId && sideId !== options.active?.id,
    canCheck: () => latest.current.visible,
    current: () => sideDoc ? { doc: sideDoc, version: sideDoc.revision } : null,
    read: (doc: Doc) => call<Doc>("readDocument", { id: doc.id }),
    pending: () => setSideSyncKey(sideDoc ? `${sideDoc.id}:${sideDoc.revision}` : ""),
    apply: (doc) => { setSideDoc(doc); setSideSyncKey(""); },
    report: options.report,
  });
  useEffect(() => {
    if (!sideId || sideId === options.active?.id) return;
    if (sideDoc?.id === sideId) {
      void checkSideDocument().catch(options.report);
      return;
    }
    const retained = getRetainedDocument(sideId);
    if (retained) { setSideDoc(retained); return; }
    let canceled = false;
    call<Doc>("readDocument", { id: sideId })
      .then((doc) => { if (!canceled) setSideDoc(doc); })
      .catch(options.report);
    return () => { canceled = true; };
  }, [sideId, sideRevision, sideDoc?.id, options.active?.id, options.report, checkSideDocument, getRetainedDocument, setSideDoc]);

  const shownSide = !split ? null : split.docId === options.active?.id ? options.active
    : sideDoc?.id === split.docId ? sideDoc : null;

  function groupStyle(side: Side): CSSProperties | undefined {
    if (!split) return undefined;
    return side === "left" ? { flex: `0 0 calc(${splitRatio * 100}% - 2px)` } : { flex: "1 1 0" };
  }

  function getDropZone(target: EventTarget | null, clientX: number, fromTree: boolean) {
    return editorDropZone(target, clientX, groupsRef.current, !!splitRef.current, fromTree);
  }

  function startSash(event: PointerEvent) {
    event.preventDefault();
    const box = groupsRef.current?.getBoundingClientRect();
    if (!box) return;
    stopResizing.current?.();
    const move = (event: globalThis.PointerEvent) =>
      setSplitRatio(Math.min(0.8, Math.max(0.2, (event.clientX - box.left) / box.width)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("sash-dragging");
      stopResizing.current = null;
    };
    stopResizing.current = up;
    document.body.classList.add("sash-dragging");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  useEffect(() => () => stopResizing.current?.(), []);
  const resetSplitRatio = useCallback(() => setSplitRatio(0.5), []);

  return {
    tabs, split, focusedSide, shownSide, sideSyncKey, groupsRef,
    retainDocument, getRetainedDocument, clearRetainedDocuments, clearSideDocument,
    pruneDocuments, resetGroups, commitOpenDocument, replaceDocumentId,
    openDoc, pinTab, closeTab, closeTabs, cycleTab, moveTab,
    focusOther, focusSide, openInGroup, openInTabs, splitTo, closeGroup, closeOtherGroup, moveToOther, closeSideTab,
    checkSideDocument, groupStyle, getDropZone, startSash, resetSplitRatio,
  };
}
