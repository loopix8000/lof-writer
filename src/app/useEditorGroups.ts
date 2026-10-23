import { useCallback, useEffect, useRef, useState } from "react";
import { groupIds, isGroupId, resolveLayout, type SplitDirection, type SplitLayout } from "../split/layout";
import type { SplitGroups } from "../split/controller";
import { useSplitGroups } from "../split/useSplitGroups";
import { call, type Doc } from "../types";
import { useSyncFileUpdates } from "../useSyncFileUpdates";
import { notifyRemoteUpdate, type SyncMessage } from "../sync-recovery";
import { copyWorkspaceScroll, readWorkspaceState, saveWorkspaceState, workspaceKey } from "../workspace-state";
import { placeTab, relocateDocument, sameDocumentContent, type EditorTab, type Side } from "./model";

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
  navigate: (id: string, pinned: boolean, beforeCommit?: () => boolean | void) => Promise<void>;
  closeLastDocument: (commit: () => boolean | void) => Promise<void>;
  report: (error: unknown) => void;
  message: SyncMessage;
};
// 작품별로 저장하는 배치. 예전 버전과 같게 그룹의 현재 문서를 docId로 둔다.
type SavedGroup = { tabs: EditorTab[]; docId: string };
type Layout = { groups: Partial<Record<Side, SavedGroup>>; focusedSide: Side; tree?: SplitLayout; x?: number; y?: number };
const tabFor = (id: string): EditorTab => ({ id, pinned: true });

// 집필 화면의 분할 그룹. 분할 규칙은 공통 컨트롤러가 맡고, 여기서는 문서 열기·작품별 저장·다른 그룹의 문서 동기화를 잇는다.
export function useEditorGroups(options: Options) {
  const latest = useRef(options); latest.current = options;
  const [, renderDocuments] = useState(0);
  const retainedDocuments = useRef(new Map<string, Doc>());
  const projectKey = useRef("");
  const linkedOpenSeq = useRef(0);
  const retainDocument = useCallback((doc: Doc) => { retainedDocuments.current.set(doc.id, doc); }, []);
  const getRetainedDocument = useCallback((id: string) => retainedDocuments.current.get(id), []);
  const clearRetainedDocuments = useCallback(() => retainedDocuments.current.clear(), []);
  const setSideDoc = useCallback((doc: Doc) => {
    retainedDocuments.current.set(doc.id, doc); renderDocuments(value => value + 1);
  }, []);
  const split = useSplitGroups<EditorTab>({
    key: tab => tab.id,
    currentKey: () => latest.current.currentId(),
    place: (tabs, tab, pinned, after) => placeTab(tabs, tab.id, pinned, after),
    // 포커스를 떠나는 문서는 다른 그룹에서 계속 보이도록 붙잡아 둔다.
    activate: (tab, pinned, commit) => latest.current.navigate(tab.id, pinned, () => {
      if (!commit()) return false;
      const doc = latest.current.currentDocument(); if (doc) retainDocument(doc);
    }),
    closeLast: commit => latest.current.closeLastDocument(commit),
    flush: () => latest.current.flush({ closing: true, skipMemo: true }),
    copyScroll: (from, to, tabs) => {
      if (projectKey.current) copyWorkspaceScroll(projectKey.current, from, to, tabs.map(tab => tab.id));
    },
    epoch: () => projectKey.current,
    interactive: () => latest.current.workspaceOpen,
  });
  const { mapTabs, updateTabs, reset, snapshot, state } = split;
  function currentLayout(): Layout {
    const all = snapshot(), { focused, layout } = state();
    return {
      groups: Object.fromEntries(Object.entries(all).map(([id, group]) => [id, { tabs: group!.tabs, docId: group!.current }])),
      focusedSide: focused,
      tree: resolveLayout(layout, groupIds.filter(id => all[id])),
    };
  }
  function rememberLayout() {
    if (projectKey.current) saveWorkspaceState(projectKey.current, { layout: currentLayout() });
  }
  const getProjectDocument = useCallback((projectId: string): string | undefined => {
    const key = workspaceKey(latest.current.root, projectId);
    // 현재 작품은 최신 상태를 사용해 방금 닫은 탭을 저장 대기 중인 옛 배치에서 되살리지 않는다.
    const layout = key === projectKey.current ? currentLayout() : readWorkspaceState(key).layout as Layout | undefined;
    if (!layout) return;
    const available = new Set(latest.current.documents.filter(doc => doc.projectId === projectId).map(doc => doc.id));
    const focused = isGroupId(layout.focusedSide) ? layout.focusedSide : groupIds[0];
    for (const side of [focused, ...groupIds.filter(side => side !== focused)]) {
      const group = layout.groups?.[side];
      if (!group || !Array.isArray(group.tabs)) continue;
      const tabs = group.tabs.filter(tab => tab && available.has(tab.id));
      if (tabs.length) return tabs.some(tab => tab.id === group.docId) ? group.docId : tabs[0].id;
    }
  }, []);
  useEffect(rememberLayout, [split.groups, split.focused, split.layout, options.active?.id]);
  useEffect(() => {
    const open = new Set(Object.values(split.groups).flatMap(group => group?.tabs ?? []).map(tab => tab.id));
    for (const id of retainedDocuments.current.keys()) if (!open.has(id)) retainedDocuments.current.delete(id);
  }, [split.groups]);
  const pruneDocuments = useCallback((ids: Set<string>) => mapTabs(tab => ids.has(tab.id) ? tab : null), [mapTabs]);
  const resetGroups = useCallback(() => { projectKey.current = ""; reset({}, groupIds[0]); }, [reset]);
  // 다른 작품의 문서를 열면 그 작품에 저장해 둔 배치로 바꾼다.
  const commitOpenDocument = useCallback((doc: Doc, { pinned, after }: { sameProject: boolean; pinned: boolean; after: string }) => {
    const key = workspaceKey(latest.current.root, doc.projectId);
    if (projectKey.current === key) { updateTabs(tabs => placeTab(tabs, doc.id, pinned, after)); return; }
    rememberLayout();
    projectKey.current = key;
    const saved = readWorkspaceState(key).layout as Layout | undefined;
    const available = new Set(latest.current.documents.filter(d => d.projectId === doc.projectId).map(d => d.id));
    const restored: SplitGroups<EditorTab> = {};
    for (const side of groupIds) {
      const group = saved?.groups?.[side];
      if (!group || !Array.isArray(group.tabs)) continue;
      const seen = new Set<string>();
      const kept = group.tabs.filter(t => {
        if (!t || !available.has(t.id) || seen.has(t.id)) return false;
        seen.add(t.id); return true;
      }).map(t => ({ id: t.id, pinned: t.pinned !== false }));
      if (kept.length) restored[side] = { tabs: kept, current: kept.some(t => t.id === group.docId) ? group.docId : kept[0].id };
    }
    const previous = isGroupId(saved?.focusedSide) ? saved.focusedSide : groupIds[0];
    const focused = restored[previous]?.tabs.some(t => t.id === doc.id) ? previous
      : groupIds.find(side => restored[side]?.tabs.some(t => t.id === doc.id)) ?? previous;
    restored[focused] = { tabs: placeTab(restored[focused]?.tabs ?? [], doc.id, pinned, ""), current: doc.id };
    reset(restored, focused, saved?.tree, saved?.x, saved?.y);
  }, [updateTabs, reset]);
  const pinTab = useCallback((id: string) => updateTabs(tabs => placeTab(tabs, id, true, "")), [updateTabs]);
  const replaceDocumentId = useCallback((oldId: string, newId: string, location?: Doc) => {
    if (oldId !== newId && projectKey.current) {
      const scroll = { ...readWorkspaceState(projectKey.current).scroll };
      for (const side of groupIds) {
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
    mapTabs(tab => tab.id === oldId ? { ...tab, id: newId } : tab);
  }, [mapTabs]);
  const openDoc = useCallback(async (id: string, pinned = false) => { await latest.current.navigate(id, pinned); }, []);
  // 연결 문서는 포커스를 옮기지 않고 옆 그룹에 연다.
  async function openLinked(id: string, pinned = false) {
    const seq = ++linkedOpenSeq.current, key = projectKey.current, focused = state().focused, current = latest.current.currentId();
    await latest.current.flush();
    const fresh = await call<Doc>("readDocument", { id });
    if (seq !== linkedOpenSeq.current || key !== projectKey.current || state().focused !== focused || latest.current.currentId() !== current) return;
    const retained = getRetainedDocument(id);
    setSideDoc(retained && !sameDocumentContent(retained, fresh) ? retained : fresh);
    split.openBeside({ id, pinned }, pinned);
  }
  useEffect(() => {
    document.querySelector<HTMLElement>(".editor-group.focused .editor-tab.current")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [options.active?.id, split.tabs.length]);

  // 각 그룹에 보이는 문서도 최신 내용으로 갱신한다. 포커스된 그룹은 편집 세션이 맡는다.
  function useSideDocument(side: Side) {
    const group = side === split.focused ? undefined : split.groups[side];
    const id = group?.current ?? "", doc = getRetainedDocument(id);
    const revision = options.documents.find(d => d.id === id)?.revision;
    const check = useSyncFileUpdates({
      fileKey: id, enabled: !!id && !!doc && id !== options.active?.id,
      automatic: true,
      canCheck: () => latest.current.visible && !latest.current.pendingDocumentMove(),
      current: () => { const doc = getRetainedDocument(id); return doc ? { doc, version: doc.revision } : null; },
      read: (doc: Doc) => call<Doc>("readDocument", { id: doc.id }),
      reconcile: fresh => {
        const current = getRetainedDocument(id);
        if (!current || !sameDocumentContent(current, fresh)) return false;
        setSideDoc(fresh); return true;
      },
      apply: fresh => {
        const before = getRetainedDocument(id);
        setSideDoc(fresh);
        if (latest.current.visible) notifyRemoteUpdate(before, fresh, latest.current.message);
      },
      report: options.report,
    });
    useEffect(() => {
      if (!id || id === latest.current.active?.id) return;
      if (getRetainedDocument(id)) { void check().catch(latest.current.report); return; }
      let canceled = false;
      call<Doc>("readDocument", { id }).then(doc => { if (!canceled) setSideDoc(doc); }).catch(latest.current.report);
      return () => { canceled = true; };
    }, [id, revision, !!doc, check]);
  }
  // 그룹 ID 목록은 고정이므로 매 렌더 같은 순서로 훅을 부른다.
  groupIds.forEach(side => useSideDocument(side));
  return {
    area: split, tabs: split.tabs, groups: split.groups, sides: split.order, split: split.split, focusedSide: split.focused,
    groupStyle: split.groupStyle,
    retainDocument, getRetainedDocument, clearRetainedDocuments,
    pruneDocuments, resetGroups, commitOpenDocument, replaceDocumentId, getProjectDocument,
    openDoc, openLinked, pinTab, pinSideTab: split.pinOtherTab, cycleTab: split.cycleTab, shiftTab: split.shiftTab, canSplit: split.canSplit,
    closeTab: split.closeTab, closeTabs: split.closeTabs, moveTab: split.moveTab,
    focusOther: (id?: string, pinned = false, side?: Side, closeSource = false) =>
      split.focusOther(id ? tabFor(id) : undefined, pinned, side, closeSource),
    focusSide: split.focusGroup, focusGroupAt: split.focusGroupAt, focusDirection: split.focusDirection,
    closeGroup: split.closeGroup, closeOtherGroup: split.closeOtherGroup,
    openInGroup: (id: string, side: Side, move = false, source?: Side, direction?: SplitDirection) =>
      split.openInGroup(tabFor(id), side, move, source, direction),
    splitTo: (id: string, direction?: SplitDirection, from?: Side) => split.splitTo(tabFor(id), direction, from),
    moveToOther: (id: string) => split.moveToOther(tabFor(id)),
    moveToDirection: (id: string, step: 1 | -1) => split.moveToDirection(tabFor(id), step),
    closeSideTab: (id: string, side?: Side) => split.closeOtherTab(id, side),
    closeSideTabs: (keep: (tab: EditorTab, index: number) => boolean, side: Side, focusId?: string) =>
      split.closeOtherTabs(keep, side, focusId),
  };
}
