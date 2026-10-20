import type { DragEvent, PointerEvent } from "react";
import {
  defaultSplitDirection, findAdjacentGroup, groupIds, isGroupId, layoutGeometry, planSplit, resizeLayout, resolveDropZone, resolveLayout,
  sameDropZone, sashRatio, splitFits, type DropZone, type GroupId, type SplitDirection, type SplitIntersection, type SplitLayout, type SplitSash,
} from "./layout";

// 분할 그룹의 상태와 동작. 화면마다 다른 것(탭 모양, 문서를 여는 방법)은 SplitHost로 받고 나머지 규칙은 모두 여기서 정한다.

// current는 그룹에서 보이는 탭의 키다. 포커스된 그룹의 현재 탭은 편집 세션이 정하므로 snapshot()에서 채운다.
export type SplitGroup<T> = { tabs: T[]; current: string };
export type SplitGroups<T> = Partial<Record<GroupId, SplitGroup<T>>>;
export type SplitState<T> = { groups: SplitGroups<T>; focused: GroupId; layout: SplitLayout };
// 끌고 있는 것. 파일 트리에서 끈 문서는 옮기지 않고 연다.
export type SplitDrag<T> = { tab: T; fromTree: boolean; source: GroupId };

export type SplitHost<T> = {
  key: (tab: T) => string;
  // 포커스된 그룹에서 지금 열린 탭의 키. 없으면 빈 문자열.
  currentKey: () => string;
  // 탭을 목록에 넣는다(미리보기 탭 재사용 등). after는 그 뒤에 둘 탭의 키다.
  place: (tabs: T[], tab: T, pinned: boolean, after: string) => T[];
  // 저장과 읽기를 마친 뒤 commit을 부르고, commit이 true일 때만 화면에 연다.
  activate: (tab: T, pinned: boolean, commit: () => boolean) => Promise<void>;
  // 마지막 그룹의 마지막 탭을 닫는다. commit이 true일 때만 편집 화면을 비운다.
  closeLast: (commit: () => boolean) => Promise<void>;
  // 탭이나 그룹을 닫기 전에 저장한다.
  flush: () => Promise<void>;
  // 그룹을 옮긴 탭이 읽던 위치를 함께 가져가게 한다.
  copyScroll?: (from: GroupId, to: GroupId, tabs: T[]) => void;
  // 이 값이 바뀌면(작품 전환 등) 기다리던 그룹 동작을 버린다.
  epoch?: () => unknown;
  // false면 편집 화면이 가려져 있어, 열린 탭을 닫아도 다른 탭을 대신 열지 않는다.
  interactive?: () => boolean;
};

const groupSelector = "[data-split-group]", tabBarSelector = "[data-split-tabs]", tabSelector = "[data-split-tab]";
// 그룹·탭 막대·개별 탭 요소에 붙여 놓기 영역과 삽입 위치를 계산할 수 있게 한다.
export const groupAttributes = (id: GroupId) => ({ "data-split-group": id });
export const tabBarAttributes = { "data-split-tabs": "" };
export const tabAttributes = (key: string) => ({ "data-split-tab": key });
const noTabs: never[] = [];

export function createSplitController<T>(host: () => SplitHost<T>, changed: () => void) {
  let state: SplitState<T> = { groups: {}, focused: groupIds[0], layout: groupIds[0] };
  let dropZone: DropZone | null = null;
  let container: HTMLElement | null = null;
  let stopResizing: (() => void) | null = null;
  let tabMru: Partial<Record<GroupId, string[]>> = {};
  let groupMru: GroupId[] = [groupIds[0]];
  let hoverTabTimer: number | undefined;
  let hoverTabKey = "";

  const keyOf = (tab: T) => host().key(tab);
  const has = (group: SplitGroup<T> | undefined, key: string) => !!group?.tabs.some(tab => keyOf(tab) === key);
  const filled = (s = state) => groupIds.filter(id => s.groups[id]);
  const visible = (s = state) => groupIds.filter(id => id === s.focused || s.groups[id]);
  const resolved = (s = state) => resolveLayout(s.layout, visible(s));
  const order = (s = state) => layoutGeometry(resolved(s)).order;
  const tabsOf = (id: GroupId) => state.groups[id]?.tabs ?? noTabs as T[];
  const currentTabOf = (group: SplitGroup<T> | undefined) => group?.tabs.find(tab => keyOf(tab) === group.current);

  function syncMru() {
    const vis = visible();
    groupMru = [
      state.focused,
      ...groupMru.filter(g => g !== state.focused && vis.includes(g)),
      ...vis.filter(g => g !== state.focused && !groupMru.includes(g)),
    ];
    for (const id of groupIds) {
      const group = state.groups[id];
      if (!group || !group.tabs.length) { delete tabMru[id]; continue; }
      const keys = group.tabs.map(keyOf);
      const activeKey = id === state.focused ? (host().currentKey() || group.current) : group.current;
      const prev = (tabMru[id] ?? []).filter(k => keys.includes(k));
      tabMru[id] = [
        ...(activeKey && keys.includes(activeKey) ? [activeKey] : []),
        ...prev.filter(k => k !== activeKey),
        ...keys.filter(k => k !== activeKey && !prev.includes(k)),
      ];
    }
  }

  function without(group: SplitGroup<T>, key: string, id?: GroupId): SplitGroup<T> | null {
    const index = group.tabs.findIndex(tab => keyOf(tab) === key);
    if (index < 0) return group;
    const tabs = group.tabs.filter((_, i) => i !== index);
    if (!tabs.length) return null;
    const mruNext = id ? tabMru[id]?.find(k => k !== key && tabs.some(t => keyOf(t) === k)) : undefined;
    return { tabs, current: group.current === key ? (mruNext ?? keyOf(tabs[index] ?? tabs[index - 1])) : group.current };
  }
  // 빈 그룹은 두지 않는다. 포커스된 그룹이 비면 그 자리는 빈 화면으로 남는다.
  function write(next: Partial<SplitState<T>>) {
    const groups = next.groups && Object.fromEntries(Object.entries(next.groups).filter(([, group]) => group?.tabs.length)) as SplitGroups<T>;
    state = { ...state, ...next, ...(groups && { groups }) };
    syncMru();
    changed();
  }
  function placeAt(tabs: T[], tab: T, pinned: boolean, after: string, insertIndex?: number): T[] {
    const placed = host().place(tabs, tab, pinned, after);
    if (insertIndex === undefined) return placed;
    const key = keyOf(tab), fromIdx = placed.findIndex(t => keyOf(t) === key);
    if (fromIdx < 0) return placed;
    const oldIdx = tabs.findIndex(t => keyOf(t) === key);
    const item = placed[fromIdx];
    const rest = placed.filter((_, i) => i !== fromIdx);
    const targetIdx = Math.max(0, Math.min(rest.length, oldIdx >= 0 && oldIdx < insertIndex ? insertIndex - 1 : insertIndex));
    rest.splice(targetIdx, 0, item);
    return rest;
  }
  // 포커스된 그룹의 current를 편집 세션의 현재 탭으로 채운 전체 그룹.
  function snapshot(): SplitGroups<T> {
    const all = { ...state.groups }, mine = all[state.focused], current = host().currentKey();
    if (mine && current && has(mine, current)) all[state.focused] = { ...mine, current };
    return all;
  }
  // 저장·읽기를 기다리는 동안 배치가 바뀌면 그 동작을 버린다.
  function guard() {
    const before = state, epoch = host().epoch?.();
    return () => state === before && host().epoch?.() === epoch;
  }
  function otherGroup() {
    const list = order();
    const mruGroup = groupMru.find(g => g !== state.focused && list.includes(g));
    if (mruGroup) return mruGroup;
    const index = list.indexOf(state.focused);
    return list[index + 1] ?? list[index - 1];
  }
  function groupFits(id: GroupId, direction: SplitDirection) {
    const group = container?.querySelector<HTMLElement>(`[data-split-group="${id}"]`);
    return !group || splitFits(group.getBoundingClientRect(), direction);
  }
  const canSplit = (id: GroupId, direction: SplitDirection) =>
    !!planSplit(state.layout, id, direction, filled()) && groupFits(id, direction);

  // 탭을 id 그룹에 연다. move면 source 그룹에서 옮기고, direction이 있으면 id 그룹을 그 방향으로 나눈 새 그룹에 연다.
  async function transition(tab: T, id: GroupId, { pinned = true, move = false, source = state.focused, direction, closeSource = false, insertIndex }: {
    pinned?: boolean; move?: boolean; source?: GroupId; direction?: SplitDirection; closeSource?: boolean; insertIndex?: number;
  } = {}) {
    const before = state, all = snapshot(), key = keyOf(tab);
    const vacated = move && source !== id && all[source]?.tabs.length === 1 ? source : undefined;
    const plan = direction ? planSplit(before.layout, id, direction, filled(), vacated) : null;
    if (direction && (!plan || !groupFits(id, direction))) return false;
    if (move && !has(all[source], key)) return false;
    const target = plan?.target ?? id, unchanged = guard();
    let committed = false;
    await host().activate(tab, pinned, () => {
      if (!unchanged()) return false;
      const from = all[source];
      if (source !== target && from && has(from, key)) {
        if (!has(all[target], key)) host().copyScroll?.(source, target, [tab]);
        // 새 분할의 마지막 탭은 두 창에서 볼 수 있도록 남기고, 그룹 간 이동은 비운 그룹을 닫는다.
        if (move && !(plan && source === id && from.tabs.length === 1)) {
          const rest = without(from, key, source);
          if (rest) all[source] = rest; else delete all[source];
        }
      }
      if (closeSource && before.focused !== target) delete all[before.focused];
      const destination = all[target];
      all[target] = { tabs: placeAt(destination?.tabs ?? [], tab, pinned, destination?.current ?? "", insertIndex), current: key };
      write({ groups: all, focused: target, layout: plan?.layout ?? before.layout });
      return committed = true;
    });
    return committed;
  }
  // 다른 그룹으로 포커스를 옮긴다. tab을 주면 그 그룹에서 그 탭을 연다.
  async function focusOther(tab?: T, pinned = false, id = otherGroup(), closeSource = false) {
    if (!id || id === state.focused) return false;
    const next = tab ?? currentTabOf(state.groups[id]);
    return next ? transition(next, id, { pinned, closeSource }) : false;
  }
  async function focusGroup(id: GroupId) { if (state.groups[id]) await focusOther(undefined, false, id); }
  // 화면에 놓인 순서(왼쪽 위부터)의 index번째 그룹으로 간다.
  async function focusGroupAt(index: number) { const id = order()[index]; if (id) await focusGroup(id); }
  async function focusDirection(direction: SplitDirection) {
    const adj = findAdjacentGroup(resolved(), state.focused, direction);
    if (adj) await focusGroup(adj);
  }
  const openInGroup = (tab: T, id: GroupId, move = false, source = state.focused, direction?: SplitDirection, insertIndex?: number) =>
    transition(tab, id, { move, source, direction, insertIndex });
  const splitTo = (tab: T, direction: SplitDirection = defaultSplitDirection, from = state.focused) =>
    openInGroup(tab, from, true, from, direction);
  async function moveToOther(tab: T) { const id = otherGroup(); if (id) await openInGroup(tab, id, true); }
  async function moveToDirection(tab: T, step: 1 | -1) {
    const list = order(), index = list.indexOf(state.focused);
    if (list.length > 1 && index >= 0) {
      const target = list[(index + step + list.length) % list.length];
      if (target && target !== state.focused) await openInGroup(tab, target, true);
    } else if (list.length === 1 && step === 1) {
      await splitTo(tab, defaultSplitDirection);
    }
  }
  // 포커스를 옮기지 않고 옆 그룹에 연다. 우측 인접 그룹이 있으면 우선 활용하고, 옆 그룹이 없으면 오른쪽으로 나눈다.
  function openBeside(tab: T, pinned: boolean) {
    const key = keyOf(tab);
    let id = groupIds.find(g => g !== state.focused && has(state.groups[g], key))
      ?? findAdjacentGroup(resolved(), state.focused, defaultSplitDirection)
      ?? otherGroup();
    let layout = state.layout;
    if (!id) {
      const plan = planSplit(state.layout, state.focused, defaultSplitDirection, visible());
      if (!plan) return null;
      id = plan.target; layout = plan.layout;
    }
    const group = state.groups[id];
    write({ groups: { ...state.groups, [id]: { tabs: host().place(group?.tabs ?? [], tab, pinned, group?.current ?? ""), current: key } }, layout });
    return id;
  }
  async function closeGroup() {
    if (!otherGroup()) return;
    const unchanged = guard();
    await host().flush();
    if (unchanged()) await focusOther(undefined, false, otherGroup(), true);
  }
  function closeOtherGroup(id: GroupId) {
    if (id === state.focused || !state.groups[id]) return;
    const groups = { ...state.groups }; delete groups[id];
    write({ groups });
  }
  // 포커스되지 않은 그룹(id를 주면 그 그룹만)에서 탭을 닫는다.
  function closeOtherTab(key: string, id?: GroupId) {
    const groups = { ...state.groups };
    let changedAny = false;
    for (const g of groupIds) {
      const group = groups[g];
      if (g === state.focused || (id && g !== id) || !group || !has(group, key)) continue;
      const rest = without(group, key, g);
      if (rest) groups[g] = rest; else delete groups[g];
      changedAny = true;
    }
    if (changedAny) write({ groups });
  }
  function closeOtherTabs(keep: (tab: T, index: number) => boolean, id: GroupId, focusKey?: string) {
    if (id === state.focused) return;
    const group = state.groups[id];
    if (!group) return;
    const kept = group.tabs.filter(keep);
    if (kept.length === group.tabs.length) return;
    const groups = { ...state.groups };
    if (!kept.length) {
      delete groups[id];
    } else {
      const stillHasCurrent = kept.some(t => keyOf(t) === group.current);
      const nextCurrent = stillHasCurrent
        ? group.current
        : (focusKey && kept.some(t => keyOf(t) === focusKey)
            ? focusKey
            : (tabMru[id]?.find(k => kept.some(t => keyOf(t) === k)) ?? keyOf(kept[0])));
      groups[id] = { tabs: kept, current: nextCurrent };
    }
    write({ groups });
  }
  function pinOtherTab(key: string, id: GroupId) {
    const group = state.groups[id];
    if (!group) return;
    const tab = group.tabs.find(t => keyOf(t) === key);
    if (!tab) return;
    updateTabs(tabs => host().place(tabs, tab, true, ""), id);
  }
  function updateTabs(update: (tabs: T[]) => T[], id = state.focused) {
    const group = state.groups[id], list = group?.tabs ?? noTabs as T[], next = update(list);
    if (next === list) return;
    write({ groups: { ...state.groups, [id]: { tabs: next, current: group?.current ?? "" } } });
  }
  // keep에 맞지 않는 탭을 포커스된 그룹에서 닫는다. 지금 탭이 닫히면 focusKey·최근 본 탭(MRU)·가까운 탭 순으로 열고,
  // 그룹이 비면 다른 그룹으로 가거나 편집 화면을 비운다.
  async function closeTabs(keep: (tab: T, index: number) => boolean, focusKey?: string) {
    syncMru();
    const list = tabsOf(state.focused), kept = list.filter(keep);
    if (kept.length === list.length) return;
    const index = list.findIndex(tab => keyOf(tab) === host().currentKey());
    if (index < 0 || kept.includes(list[index]) || host().interactive?.() === false) { updateTabs(() => kept); return; }
    const unchanged = guard();
    await host().flush();
    if (!unchanged()) return;
    const mruCandidateKey = tabMru[state.focused]?.find(k => kept.some(tab => keyOf(tab) === k));
    const next = kept.find(tab => keyOf(tab) === focusKey)
      ?? (mruCandidateKey ? kept.find(tab => keyOf(tab) === mruCandidateKey) : undefined)
      ?? list.slice(index + 1).find(tab => kept.includes(tab))
      ?? list.slice(0, index).reverse().find(tab => kept.includes(tab));
    if (next) await host().activate(next, false, () => {
      if (!unchanged()) return false;
      updateTabs(() => kept); return true;
    });
    else if (otherGroup()) await focusOther(undefined, false, otherGroup(), true);
    else await host().closeLast(() => {
      if (!unchanged()) return false;
      updateTabs(() => []); return true;
    });
  }
  const closeTab = (key: string) => closeTabs(tab => keyOf(tab) !== key);
  async function cycleTab(direction: number) {
    const list = tabsOf(state.focused), index = list.findIndex(tab => keyOf(tab) === host().currentKey());
    if (list.length > 1 && index >= 0) await host().activate(list[(index + direction + list.length) % list.length], false, () => true);
  }
  function moveTab(fromKey: string, toKey: string, id = state.focused) {
    updateTabs(tabs => {
      const a = tabs.findIndex(tab => keyOf(tab) === fromKey), b = tabs.findIndex(tab => keyOf(tab) === toKey);
      if (a < 0 || b < 0 || a === b) return tabs;
      const next = [...tabs]; next.splice(b, 0, ...next.splice(a, 1)); return next;
    }, id);
  }
  function moveTabToIndex(fromKey: string, insertIndex: number, id = state.focused) {
    updateTabs(tabs => {
      const a = tabs.findIndex(tab => keyOf(tab) === fromKey);
      if (a < 0) return tabs;
      const target = Math.max(0, Math.min(tabs.length - 1, a < insertIndex ? insertIndex - 1 : insertIndex));
      if (a === target) return tabs;
      const next = [...tabs]; next.splice(target, 0, ...next.splice(a, 1)); return next;
    }, id);
  }
  function shiftTab(step: 1 | -1, id = state.focused) {
    const activeKey = id === state.focused ? host().currentKey() : state.groups[id]?.current ?? "";
    if (!activeKey) return;
    updateTabs(tabs => {
      const a = tabs.findIndex(tab => keyOf(tab) === activeKey), b = a + step;
      if (a < 0 || b < 0 || b >= tabs.length) return tabs;
      const next = [...tabs]; next.splice(b, 0, ...next.splice(a, 1)); return next;
    }, id);
  }
  // 모든 그룹의 탭을 바꾼다. null을 돌려주면 그 탭을 닫는다.
  function mapTabs(map: (tab: T) => T | null) {
    let changedAny = false;
    const groups: SplitGroups<T> = {};
    for (const id of groupIds) {
      const group = state.groups[id];
      if (!group) continue;
      const tabs = group.tabs.map(map).filter((tab): tab is T => !!tab);
      if (tabs.length === group.tabs.length && tabs.every((tab, i) => tab === group.tabs[i])) { groups[id] = group; continue; }
      changedAny = true;
      if (!tabs.length) continue;
      const shown = currentTabOf(group), moved = shown && map(shown);
      groups[id] = { tabs, current: moved && tabs.some(tab => keyOf(tab) === keyOf(moved)) ? keyOf(moved) : keyOf(tabs[0]) };
    }
    if (changedAny) write({ groups });
  }
  // 저장된 배치로 되돌린다. tree가 없으면 예전 2×2 비율(x·y)로 읽는다.
  function reset(groups: SplitGroups<T>, focused: GroupId, tree?: unknown, x?: number, y?: number) {
    stopResizing?.();
    clearHoverTabTimer();
    tabMru = {};
    groupMru = [focused];
    const ids = groupIds.filter(id => id === focused || groups[id]?.tabs.length);
    write({ groups, focused, layout: resolveLayout(tree, ids, x, y) });
  }

  function clearHoverTabTimer() {
    if (hoverTabTimer !== undefined) { clearTimeout(hoverTabTimer); hoverTabTimer = undefined; }
    hoverTabKey = "";
  }
  function updateHoverTab(target: EventTarget | null, drag: SplitDrag<T> | null) {
    if (!(target instanceof Element) || !drag) { clearHoverTabTimer(); return; }
    const tabEl = target.closest<HTMLElement>(tabSelector);
    const groupEl = tabEl?.closest<HTMLElement>(groupSelector);
    const id = groupEl?.dataset.splitGroup, tKey = tabEl?.dataset.splitTab;
    if (!tabEl || !isGroupId(id) || !tKey || tKey === keyOf(drag.tab)) { clearHoverTabTimer(); return; }
    const token = `${id}\n${tKey}`;
    if (hoverTabKey === token) return;
    clearHoverTabTimer();
    hoverTabKey = token;
    hoverTabTimer = window.setTimeout(() => {
      hoverTabTimer = undefined;
      const tab = tabsOf(id).find(t => keyOf(t) === tKey);
      if (!tab) return;
      if (id === state.focused) {
        if (host().currentKey() !== tKey) void host().activate(tab, false, () => true);
      } else {
        const g = state.groups[id];
        if (g && g.current !== tKey) write({ groups: { ...state.groups, [id]: { ...g, current: tKey } } });
      }
    }, 1500);
  }

  function zoneFor(target: EventTarget | null, x: number, y: number, drag: SplitDrag<T>, copy = false, disableSplit = false) {
    if (!(target instanceof Element) || !container) return null;
    const group = target.closest<HTMLElement>(groupSelector), id = group?.dataset.splitGroup;
    if (!group || !container.contains(group) || !isGroupId(id)) return null;
    const containerRect = container.getBoundingClientRect();
    const tabBar = group.querySelector<HTMLElement>(tabBarSelector);
    const overTabBar = !!tabBar && target.closest(tabBarSelector) === tabBar;
    const own = !drag.fromTree && drag.source === id, sole = !drag.fromTree && tabsOf(drag.source).length === 1;
    let insertIndex: number | undefined;
    let indicatorLeft: number | undefined;
    if (overTabBar && tabBar) {
      const tabEls = [...tabBar.querySelectorAll<HTMLElement>(tabSelector)];
      const tabEl = target.closest<HTMLElement>(tabSelector);
      if (tabEl && tabBar.contains(tabEl)) {
        const rect = tabEl.getBoundingClientRect();
        const idx = tabEls.indexOf(tabEl);
        const onLeft = x - rect.left <= rect.width / 2;
        insertIndex = onLeft ? idx : idx + 1;
        indicatorLeft = (onLeft ? rect.left : rect.right) - containerRect.left;
      } else {
        insertIndex = tabEls.length;
        const lastEl = tabEls[tabEls.length - 1];
        indicatorLeft = (lastEl ? lastEl.getBoundingClientRect().right : tabBar.getBoundingClientRect().left) - containerRect.left;
      }
      if (own && !copy) {
        const sourceIdx = tabsOf(id).findIndex(t => keyOf(t) === keyOf(drag.tab));
        if (sourceIdx < 0 || insertIndex === sourceIdx || insertIndex === sourceIdx + 1) {
          insertIndex = undefined;
          indicatorLeft = undefined;
        }
      }
    }
    return resolveDropZone({
      id, container: containerRect, group: group.getBoundingClientRect(),
      tabBar: tabBar?.getBoundingClientRect() ?? null, overTabBar,
      x, y, own, sole, empty: !state.groups[id], copy, disableSplit, insertIndex, indicatorLeft,
      canSplit: direction => !!planSplit(state.layout, id, direction, filled(), sole && !own && !copy ? drag.source : undefined),
    });
  }
  function showDropZone(zone: DropZone | null) {
    if (sameDropZone(dropZone, zone)) return;
    dropZone = zone; changed();
  }
  function dragOver(event: DragEvent, drag: SplitDrag<T> | null) {
    const copy = !!drag && !drag.fromTree && (event.ctrlKey || event.metaKey);
    const disableSplit = event.altKey;
    updateHoverTab(event.target, drag);
    const zone = drag ? zoneFor(event.target, event.clientX, event.clientY, drag, copy, disableSplit) : null;
    if (zone) {
      event.preventDefault(); event.stopPropagation();
      event.dataTransfer.dropEffect = drag!.fromTree || copy ? "copy" : "move";
    } else if (drag && event.target instanceof Element && container?.contains(event.target)) {
      // 같은 그룹의 현재 탭 자리 위에서도 기본 드롭 금지 커서가 뜨지 않게 한다.
      event.preventDefault(); event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
    }
    showDropZone(zone);
  }
  function dragLeave(event: DragEvent) {
    if (!(event.currentTarget as Node).contains(event.relatedTarget as Node)) {
      clearHoverTabTimer();
      showDropZone(null);
    }
  }
  // 놓은 자리에 맞춰 열거나 옮길 동작을 돌려준다. 놓을 수 없는 자리면 null이다.
  function drop(event: DragEvent, drag: SplitDrag<T> | null) {
    clearHoverTabTimer();
    const copy = !!drag && !drag.fromTree && (event.ctrlKey || event.metaKey);
    const disableSplit = event.altKey;
    const zone = drag ? zoneFor(event.target, event.clientX, event.clientY, drag, copy, disableSplit) : null;
    if (drag && event.target instanceof Element && container?.contains(event.target)) { event.preventDefault(); event.stopPropagation(); }
    if (!zone || !drag) { showDropZone(null); return drag ? async () => {} : null; }
    event.preventDefault(); event.stopPropagation();
    showDropZone(null);
    if (zone.tabs && !zone.direction && !drag.fromTree && drag.source === zone.id && !zone.copy) {
      return async () => {
        if (zone.insertIndex !== undefined) moveTabToIndex(keyOf(drag.tab), zone.insertIndex, zone.id);
      };
    }
    return () => openInGroup(
      drag.tab,
      zone.id,
      !drag.fromTree && !zone.copy,
      drag.fromTree ? state.focused : drag.source,
      zone.direction,
      zone.tabs ? zone.insertIndex : undefined,
    );
  }

  function startSash(event: PointerEvent, sash: SplitSash) {
    event.preventDefault();
    const box = container?.getBoundingClientRect(); if (!box) return;
    stopResizing?.();
    const snapshotLayout = resolved(), groups = state.groups;
    const move = (e: globalThis.PointerEvent) => {
      if (state.groups !== groups) { up(); return; }
      const r = sashRatio(sash, box, e.clientX, e.clientY);
      let nextLayout = resizeLayout(snapshotLayout, sash.path, r);
      if (sash.linkedPath !== undefined) nextLayout = resizeLayout(nextLayout, sash.linkedPath, r);
      write({ layout: nextLayout });
    };
    const up = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up); window.removeEventListener("blur", up);
      document.body.classList.remove("sash-dragging", "sash-dragging-horizontal", "sash-dragging-all"); stopResizing = null;
    };
    stopResizing = up;
    document.body.classList.add(sash.axis === "x" ? "sash-dragging" : "sash-dragging-horizontal");
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up); window.addEventListener("blur", up);
  }
  function resetSash(sashOrPath: SplitSash | string) {
    const path = typeof sashOrPath === "string" ? sashOrPath : sashOrPath.path;
    const linked = typeof sashOrPath === "string" ? undefined : sashOrPath.linkedPath;
    let nextLayout = resizeLayout(resolved(), path, 0.5);
    if (linked !== undefined) nextLayout = resizeLayout(nextLayout, linked, 0.5);
    write({ layout: nextLayout });
  }
  function startIntersection(event: PointerEvent, intersection: SplitIntersection) {
    event.preventDefault();
    const box = container?.getBoundingClientRect(); if (!box) return;
    stopResizing?.();
    const snapshotLayout = resolved(), groups = state.groups;
    const move = (e: globalThis.PointerEvent) => {
      if (state.groups !== groups) { up(); return; }
      const rx = sashRatio(intersection.xSash, box, e.clientX, e.clientY);
      const ry = sashRatio(intersection.ySash, box, e.clientX, e.clientY);
      let nextLayout = resizeLayout(snapshotLayout, intersection.xSash.path, rx);
      if (intersection.xSash.linkedPath !== undefined) nextLayout = resizeLayout(nextLayout, intersection.xSash.linkedPath, rx);
      nextLayout = resizeLayout(nextLayout, intersection.ySash.path, ry);
      if (intersection.ySash.linkedPath !== undefined) nextLayout = resizeLayout(nextLayout, intersection.ySash.linkedPath, ry);
      write({ layout: nextLayout });
    };
    const up = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up); window.removeEventListener("blur", up);
      document.body.classList.remove("sash-dragging", "sash-dragging-horizontal", "sash-dragging-all"); stopResizing = null;
    };
    stopResizing = up;
    document.body.classList.add("sash-dragging-all");
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up); window.addEventListener("blur", up);
  }
  function resetIntersection() {
    let nextLayout = resizeLayout(resolved(), "", 0.5);
    nextLayout = resizeLayout(nextLayout, "0", 0.5);
    nextLayout = resizeLayout(nextLayout, "1", 0.5);
    write({ layout: nextLayout });
  }

  // 렌더에 쓰는 값. 같은 상태에서는 같은 배열·객체를 돌려준다.
  let viewCache: { state: SplitState<T>; value: ReturnType<typeof computeView> } | null = null;
  function computeView() {
    const layout = resolved(), geometry = layoutGeometry(layout);
    return {
      groups: state.groups, focused: state.focused, tabs: tabsOf(state.focused), layout,
      order: geometry.order, split: geometry.order.length > 1, sashes: geometry.sashes,
      intersection: geometry.intersection,
      groupStyle: (id: GroupId) => geometry.groups[id],
    };
  }
  function view() {
    syncMru();
    if (viewCache?.state !== state) viewCache = { state, value: computeView() };
    return { ...viewCache.value, dropZone };
  }

  return {
    view, state: () => state, snapshot, tabsOf, otherGroup, canSplit,
    containerRef: (element: HTMLElement | null) => { container = element; },
    transition, focusOther, focusGroup, focusGroupAt, focusDirection, openInGroup, splitTo, moveToOther, moveToDirection, openBeside,
    closeGroup, closeOtherGroup, closeOtherTab, closeOtherTabs, pinOtherTab, closeTabs, closeTab, cycleTab, moveTab, moveTabToIndex, shiftTab, updateTabs, mapTabs, reset,
    dragOver, dragLeave, drop, clearDropZone: () => { clearHoverTabTimer(); showDropZone(null); },
    startSash, resetSash, startIntersection, resetIntersection, dispose: () => { clearHoverTabTimer(); stopResizing?.(); },
  };
}
export type SplitController<T> = ReturnType<typeof createSplitController<T>>;
