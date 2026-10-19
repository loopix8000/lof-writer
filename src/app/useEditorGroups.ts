import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { editorDropZone, editorGridStyle, editorGroupStyle, editorSides, isEditorSide, oppositeSide, verticalSide } from "../editor-groups";
import { call, type Doc } from "../types";
import { useSyncFileUpdates } from "../useSyncFileUpdates";
import { readWorkspaceState, saveWorkspaceState, workspaceKey } from "../workspace-state";
import { placeTab, relocateDocument, sameDocumentContent, withoutTab, type EditorGroup, type EditorTab, type Side } from "./model";

type Options = {
  active: Doc | null;
  documents: Doc[];
  root: string;
  workspaceOpen: boolean;
  visible: boolean;
  currentId: () => string;
  currentDocument: () => Doc | null;
  pendingDocumentMove: () => Promise<void> | null;
  flush: (options?: { closing?: boolean; skipMemo?: boolean }) => Promise<void>;
  navigate: (id: string, pinned: boolean, beforeCommit?: () => void) => Promise<void>;
  closeLastDocument: (commit: () => void) => Promise<void>;
  report: (error: unknown) => void;
};
type Groups = Partial<Record<Side, EditorGroup>>;
type Layout = { groups: Groups; focusedSide: Side; x: number; y: number };

export function useEditorGroups(options: Options) {
  const latest = useRef(options); latest.current = options;
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [groups, setGroups] = useState<Groups>({});
  const [focusedSide, setFocusedSide] = useState<Side>("left");
  const [ratios, setRatios] = useState({ x: 0.5, y: 0.5 });
  const [, renderDocuments] = useState(0);
  const [pending, setPending] = useState<Partial<Record<Side, string>>>({});
  const tabsRef = useRef<EditorTab[]>([]), groupsState = useRef<Groups>({});
  const focusedSideRef = useRef<Side>("left");
  const groupsRef = useRef<HTMLDivElement>(null);
  const retainedDocuments = useRef(new Map<string, Doc>());
  const projectKey = useRef("");
  const linkedOpenSeq = useRef(0);
  const stopResizing = useRef<(() => void) | null>(null);
  const ratiosRef = useRef(ratios); ratiosRef.current = ratios;
  const updateTabs = useCallback((update: (tabs: EditorTab[]) => EditorTab[]) => {
    const next = update(tabsRef.current);
    if (next === tabsRef.current) return;
    tabsRef.current = next; setTabs(next);
  }, []);
  const updateGroups = useCallback((update: (groups: Groups) => Groups) => {
    const next = update(groupsState.current);
    if (next === groupsState.current) return;
    groupsState.current = next; setGroups(next);
  }, []);
  const focus = (side: Side) => { focusedSideRef.current = side; setFocusedSide(side); };
  const retainDocument = useCallback((doc: Doc) => { retainedDocuments.current.set(doc.id, doc); }, []);
  const getRetainedDocument = useCallback((id: string) => retainedDocuments.current.get(id), []);
  const clearRetainedDocuments = useCallback(() => retainedDocuments.current.clear(), []);
  const clearSideDocument = useCallback(() => setPending({}), []);
  const setSideDoc = useCallback((doc: Doc) => {
    retainedDocuments.current.set(doc.id, doc); renderDocuments(value => value + 1);
  }, []);
  function currentLayout(): Layout {
    const all = { ...groupsState.current };
    if (tabsRef.current.length && latest.current.currentId())
      all[focusedSideRef.current] = { tabs: tabsRef.current, docId: latest.current.currentId() };
    return { groups: all, focusedSide: focusedSideRef.current, ...ratiosRef.current };
  }
  function rememberLayout() {
    if (!projectKey.current) return;
    saveWorkspaceState(projectKey.current, { layout: currentLayout() });
  }
  const getProjectDocument = useCallback((projectId: string): string | undefined => {
    const key = workspaceKey(latest.current.root, projectId);
    // 현재 작품은 최신 상태를 사용해 방금 닫은 탭을 저장 대기 중인 옛 배치에서 되살리지 않는다.
    const layout = key === projectKey.current ? currentLayout() : readWorkspaceState(key).layout as Layout | undefined;
    if (!layout) return;
    const available = new Set(latest.current.documents.filter(doc => doc.projectId === projectId).map(doc => doc.id));
    const focused = isEditorSide(layout.focusedSide) ? layout.focusedSide : "left";
    for (const side of [focused, ...editorSides.filter(side => side !== focused)]) {
      const group = layout.groups?.[side];
      if (!group || !Array.isArray(group.tabs)) continue;
      const tabs = group.tabs.filter(tab => tab && available.has(tab.id));
      if (tabs.length) return tabs.some(tab => tab.id === group.docId) ? group.docId : tabs[0].id;
    }
  }, []);
  useEffect(rememberLayout, [tabs, groups, focusedSide, ratios, options.active?.id]);
  useEffect(() => {
    const open = new Set([...tabs, ...Object.values(groups).flatMap(group => group?.tabs ?? [])].map(tab => tab.id));
    for (const id of retainedDocuments.current.keys()) if (!open.has(id)) retainedDocuments.current.delete(id);
  }, [tabs, groups]);
  const pruneDocuments = useCallback((ids: Set<string>) => {
    updateTabs(tabs => tabs.every(tab => ids.has(tab.id)) ? tabs : tabs.filter(tab => ids.has(tab.id)));
    updateGroups(groups => Object.values(groups).every(group => group!.tabs.every(tab => ids.has(tab.id))) ? groups : Object.fromEntries(Object.entries(groups).flatMap(([side, group]) => {
      const tabs = group!.tabs.filter(tab => ids.has(tab.id));
      return tabs.length ? [[side, { tabs, docId: ids.has(group!.docId) ? group!.docId : tabs[0].id }]] : [];
    })));
  }, [updateTabs, updateGroups]);
  const resetGroups = useCallback(() => {
    projectKey.current = "";
    updateTabs(() => []); updateGroups(() => ({}));
    focusedSideRef.current = "left"; setFocusedSide("left");
  }, [updateTabs, updateGroups]);
  const commitOpenDocument = useCallback((doc: Doc, { pinned, after }: { sameProject: boolean; pinned: boolean; after: string }) => {
    const key = workspaceKey(latest.current.root, doc.projectId);
    if (projectKey.current !== key) {
      rememberLayout();
      projectKey.current = key;
      const saved = readWorkspaceState(key).layout as Layout | undefined;
      const available = new Set(latest.current.documents.filter(d => d.projectId === doc.projectId).map(d => d.id));
      const restored: Groups = {};
      for (const side of editorSides) {
        const group = saved?.groups?.[side];
        if (!group || !Array.isArray(group.tabs)) continue;
        const kept = group.tabs.filter(t => t && available.has(t.id)).map(t => ({ id: t.id, pinned: t.pinned !== false }));
        if (kept.length) restored[side] = { tabs: kept, docId: kept.some(t => t.id === group.docId) ? group.docId : kept[0].id };
      }
      const previousSide = isEditorSide(saved?.focusedSide) ? saved.focusedSide : "left";
      const already = restored[previousSide]?.tabs.some(t => t.id === doc.id) ? previousSide
        : editorSides.find(side => restored[side]?.tabs.some(t => t.id === doc.id));
      const side = already ?? (isEditorSide(saved?.focusedSide) ? saved.focusedSide : "left");
      const mine = restored[side]; delete restored[side];
      updateGroups(() => restored); focus(side);
      const clamp = (n: number | undefined) => Number.isFinite(n) ? Math.min(0.8, Math.max(0.2, n!)) : 0.5;
      setRatios({ x: clamp(saved?.x), y: clamp(saved?.y) });
      updateTabs(() => placeTab(mine?.tabs ?? [], doc.id, pinned, ""));
    } else updateTabs(tabs => placeTab(tabs, doc.id, pinned, after));
  }, [updateTabs, updateGroups]);
  const pinTab = useCallback((id: string) => updateTabs(tabs => placeTab(tabs, id, true, "")), [updateTabs]);
  const replaceDocumentId = useCallback((oldId: string, newId: string, location?: Doc) => {
    if (oldId !== newId && projectKey.current) {
      const scroll = { ...readWorkspaceState(projectKey.current).scroll };
      for (const side of editorSides) {
        const oldKey = `${side}\n${oldId}`, newKey = `${side}\n${newId}`;
        if (scroll[oldKey]) { scroll[newKey] = scroll[oldKey]; delete scroll[oldKey]; }
      }
      saveWorkspaceState(projectKey.current, { scroll });
    }
    const retained = retainedDocuments.current.get(oldId);
    if (retained) {
      retainedDocuments.current.delete(oldId);
      retainedDocuments.current.set(newId, relocateDocument(retained, location ?? { ...retained, id: newId }));
    }
    const swap = (id: string) => id === oldId ? newId : id;
    updateTabs(tabs => tabs.map(tab => ({ ...tab, id: swap(tab.id) })));
    updateGroups(groups => Object.fromEntries(Object.entries(groups).map(([side, group]) =>
      [side, { docId: swap(group!.docId), tabs: group!.tabs.map(tab => ({ ...tab, id: swap(tab.id) })) }])));
  }, [updateTabs, updateGroups]);
  const openDoc = useCallback(async (id: string, pinned = false) => { await latest.current.navigate(id, pinned); }, []);
  const otherSide = () => {
    const opposite = oppositeSide(focusedSideRef.current);
    return groupsState.current[opposite] ? opposite : editorSides.find(side => groupsState.current[side]);
  };
  async function focusOther(openId?: string, pinned = false, targetSide = otherSide()) {
    if (!targetSide || targetSide === focusedSideRef.current) return;
    const other = groupsState.current[targetSide];
    if (!other && !openId) return;
    await latest.current.navigate(openId ?? other!.docId, pinned, () => {
      const mine = { tabs: tabsRef.current, docId: latest.current.currentId() }, oldSide = focusedSideRef.current;
      const doc = latest.current.currentDocument(); if (doc) retainDocument(doc);
      updateTabs(() => other?.tabs ?? []);
      updateGroups(groups => {
        const next = { ...groups }; delete next[targetSide];
        if (mine.tabs.length) next[oldSide] = mine;
        return next;
      });
      focus(targetSide);
    });
  }
  async function focusSide(side: Side) { if (groupsState.current[side]) await focusOther(undefined, false, side); }
  async function openInGroup(id: string, side: Side, moveTab = false, sourceSide = focusedSideRef.current) {
    const splitting = sourceSide === focusedSideRef.current && !groupsState.current[side] && side !== focusedSideRef.current;
    if (!latest.current.currentId() || !tabsRef.current.length) { await openDoc(id, true); return; }
    if (side === focusedSideRef.current) await openDoc(id, true);
    else await focusOther(id, true, side);
    if (moveTab && sourceSide !== side && focusedSideRef.current === side)
      updateGroups(groups => {
        const next = { ...groups }, source = groups[sourceSide];
        // 마지막 탭을 나누면 원래 그룹에도 남겨 두어 두 원고를 나란히 볼 수 있다.
        if (source && (!splitting || source.tabs.length > 1)) {
          const remaining = withoutTab(source, id);
          if (remaining) next[sourceSide] = remaining; else delete next[sourceSide];
        }
        return next;
      });
  }
  async function openLinked(id: string, pinned = false) {
    const seq = ++linkedOpenSeq.current, key = projectKey.current;
    await latest.current.flush();
    const fresh = await call<Doc>("readDocument", { id });
    if (seq !== linkedOpenSeq.current || key !== projectKey.current) return;
    const side = editorSides.find(side => side !== focusedSideRef.current && groupsState.current[side]?.tabs.some(t => t.id === id))
      ?? oppositeSide(focusedSideRef.current);
    const retained = getRetainedDocument(id);
    setSideDoc(retained && !sameDocumentContent(retained, fresh) ? retained : fresh);
    updateGroups(groups => ({ ...groups, [side]: {
      tabs: placeTab(groups[side]?.tabs ?? [], id, pinned, groups[side]?.docId ?? ""), docId: id,
    } }));
  }
  async function splitTo(id: string, direction: "right" | "down" = "right", fromSide?: Side) {
    if (fromSide && fromSide !== focusedSideRef.current) await focusOther(id, false, fromSide);
    if (fromSide && fromSide !== focusedSideRef.current) return;
    await openInGroup(id, direction === "down" ? verticalSide(focusedSideRef.current) : oppositeSide(focusedSideRef.current), true);
  }
  async function closeGroup() {
    const side = focusedSideRef.current;
    if (!otherSide()) return;
    await latest.current.flush({ closing: true, skipMemo: true });
    await focusOther();
    if (focusedSideRef.current !== side) closeOtherGroup(side);
  }
  function closeOtherGroup(side = otherSide()) {
    if (!side) return;
    updateGroups(groups => { const next = { ...groups }; delete next[side]; return next; });
  }
  async function closeTab(id: string) {
    const list = tabsRef.current, index = list.findIndex(tab => tab.id === id);
    if (index < 0) return;
    if (latest.current.workspaceOpen && id === latest.current.currentId()) {
      await latest.current.flush({ closing: true, skipMemo: true });
      const rest = list.filter(tab => tab.id !== id), next = rest[index] ?? rest[index - 1];
      if (next) await openDoc(next.id);
      else if (otherSide()) return closeGroup();
      else return latest.current.closeLastDocument(() => updateTabs(() => []));
    }
    updateTabs(tabs => tabs.filter(tab => tab.id !== id));
  }
  async function closeTabs(keep: (tab: EditorTab, index: number) => boolean, focusId?: string) {
    const kept = tabsRef.current.filter(keep);
    if (latest.current.workspaceOpen && !kept.some(tab => tab.id === latest.current.currentId())) {
      await latest.current.flush({ closing: true, skipMemo: true });
      if (focusId && kept.some(tab => tab.id === focusId)) await openDoc(focusId);
      else if (otherSide()) return closeGroup();
      else if (!kept.length) return latest.current.closeLastDocument(() => updateTabs(() => []));
      else await openDoc(kept[0].id);
    }
    updateTabs(tabs => tabs.filter(tab => kept.some(kept => kept.id === tab.id)));
  }
  async function moveToOther(id: string) {
    const source = focusedSideRef.current;
    await focusOther(id, true);
    if (source !== focusedSideRef.current) closeSideTab(id, source);
  }
  function closeSideTab(id: string, side?: Side) {
    updateGroups(groups => Object.fromEntries(Object.entries(groups).flatMap(([key, group]) => {
      const next = !side || side === key ? withoutTab(group!, id) : group;
      return next ? [[key, next]] : [];
    })));
  }
  async function cycleTab(direction: number) {
    const tabs = tabsRef.current, index = tabs.findIndex(tab => tab.id === latest.current.currentId());
    if (tabs.length > 1 && index >= 0) await openDoc(tabs[(index + direction + tabs.length) % tabs.length].id);
  }
  const moveTab = useCallback((from: string, to: string) => updateTabs(tabs => {
    const a = tabs.findIndex(tab => tab.id === from), b = tabs.findIndex(tab => tab.id === to);
    if (a < 0 || b < 0 || a === b) return tabs;
    const next = [...tabs]; next.splice(b, 0, ...next.splice(a, 1)); return next;
  }), [updateTabs]);
  useEffect(() => {
    document.querySelector<HTMLElement>(".editor-group.focused .editor-tab.current")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [options.active?.id, tabs.length]);

  // 각 그룹의 외부 변경 안내와 읽기는 독립적으로 유지한다.
  function useSideDocument(side: Side) {
    const id = groups[side]?.docId ?? "", doc = getRetainedDocument(id);
    const revision = options.documents.find(d => d.id === id)?.revision;
    const check = useSyncFileUpdates({
      fileKey: id, enabled: !!id && !!doc && id !== options.active?.id,
      canCheck: () => latest.current.visible && !latest.current.pendingDocumentMove(),
      current: () => { const doc = getRetainedDocument(id); return doc ? { doc, version: doc.revision } : null; },
      read: (doc: Doc) => call<Doc>("readDocument", { id: doc.id }),
      reconcile: fresh => {
        const current = getRetainedDocument(id);
        if (!current || !sameDocumentContent(current, fresh)) return false;
        setSideDoc(fresh); setPending(p => ({ ...p, [side]: undefined })); return true;
      },
      pending: () => setPending(p => ({ ...p, [side]: `${id}:${doc?.revision}` })),
      apply: fresh => { setSideDoc(fresh); setPending(p => ({ ...p, [side]: undefined })); },
      report: options.report,
    });
    useEffect(() => {
      if (!id || id === latest.current.active?.id) return;
      if (getRetainedDocument(id)) { void check().catch(latest.current.report); return; }
      let canceled = false;
      call<Doc>("readDocument", { id }).then(doc => { if (!canceled) setSideDoc(doc); }).catch(latest.current.report);
      return () => { canceled = true; };
    }, [id, revision, !!doc, check]);
    return check;
  }
  const leftCheck = useSideDocument("left"), rightCheck = useSideDocument("right");
  const bottomLeftCheck = useSideDocument("bottom-left"), bottomRightCheck = useSideDocument("bottom-right");
  const checks = { left: leftCheck, right: rightCheck, "bottom-left": bottomLeftCheck, "bottom-right": bottomRightCheck };
  const sides = editorSides.filter(side => side === focusedSide || groups[side]);
  function getDropZone(target: EventTarget | null, x: number, fromTree: boolean, y: number, sourceSide?: Side) {
    return editorDropZone(target, x, groupsRef.current, sides.length > 1, fromTree, y, sides, sourceSide);
  }
  function startSash(event: PointerEvent, axis: "x" | "y" = "x") {
    event.preventDefault();
    const box = groupsRef.current?.getBoundingClientRect(); if (!box) return;
    stopResizing.current?.();
    const move = (event: globalThis.PointerEvent) => setRatios(ratios => ({ ...ratios,
      [axis]: Math.min(0.8, Math.max(0.2, axis === "x" ? (event.clientX - box.left) / box.width : (event.clientY - box.top) / box.height)),
    }));
    const up = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      document.body.classList.remove("sash-dragging", "sash-dragging-horizontal"); stopResizing.current = null;
    };
    stopResizing.current = up;
    document.body.classList.add(axis === "x" ? "sash-dragging" : "sash-dragging-horizontal");
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  }
  useEffect(() => () => stopResizing.current?.(), []);
  return {
    tabs, groups, sides, split: sides.length > 1, focusedSide, groupsRef, pending, checks,
    retainDocument, getRetainedDocument, clearRetainedDocuments, clearSideDocument,
    pruneDocuments, resetGroups, commitOpenDocument, replaceDocumentId, getProjectDocument,
    openDoc, openLinked, pinTab, closeTab, closeTabs, cycleTab, moveTab,
    focusOther, focusSide, openInGroup, splitTo, closeGroup, closeOtherGroup, moveToOther, closeSideTab,
    gridStyle: editorGridStyle(sides, ratios.x, ratios.y), groupStyle: (side: Side) => editorGroupStyle(side, sides),
    getDropZone, startSash, resetSplitRatio: (axis: "x" | "y" = "x") => setRatios(r => ({ ...r, [axis]: 0.5 })),
  };
}
