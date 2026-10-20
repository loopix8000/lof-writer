import type { CSSProperties } from "react";

// 창 분할의 순수 계산. 화면 상태나 DOM에 기대지 않으므로 어느 화면에서든 같은 규칙으로 나누고 그린다.

// 그룹 ID는 화면 위치와 무관한 식별자다. 예전 2×2 배치의 이름을 그대로 써서 저장된 세션·스크롤 기록과 호환한다.
// 동시에 열 수 있는 그룹 수는 이 목록의 길이로만 정해진다.
export const groupIds = ["left", "right", "bottom-left", "bottom-right"] as const;
export type GroupId = typeof groupIds[number];
export const isGroupId = (value: unknown): value is GroupId => groupIds.includes(value as GroupId);
// 두 칸 분할만 저장하던 예전 기록(split 하나)을 읽을 때 상대 그룹을 정한다.
export const legacyPairedGroup = (id: GroupId): GroupId =>
  ({ left: "right", right: "left", "bottom-left": "bottom-right", "bottom-right": "bottom-left" } as const)[id];
// Ctrl+숫자 단축키가 가리키는 그룹 순번. 그룹 수를 넘는 숫자는 -1이다.
export function groupShortcutIndex(code: string) {
  const match = /^Digit([1-9])$/.exec(code), index = match ? Number(match[1]) - 1 : -1;
  return index < groupIds.length ? index : -1;
}

export const splitDirections = [
  { direction: "left", label: "왼쪽으로 분할" },
  { direction: "right", label: "오른쪽으로 분할" },
  { direction: "up", label: "위로 분할" },
  { direction: "down", label: "아래로 분할" },
] as const;
export type SplitDirection = typeof splitDirections[number]["direction"];
export const defaultSplitDirection: SplitDirection = "right";

export type SplitLayout = GroupId | { axis: "x" | "y"; ratio: number; first: SplitLayout; second: SplitLayout };
const clampRatio = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.min(0.85, Math.max(0.15, value)) : 0.5;
const branch = (axis: "x" | "y", first: SplitLayout, second: SplitLayout, ratio = 0.5): SplitLayout => ({ axis, ratio: clampRatio(ratio), first, second });
const sameShape = (a: SplitLayout, b: SplitLayout): boolean => typeof a === "string" || typeof b === "string" ? a === b
  : a.axis === b.axis && sameShape(a.first, b.first) && sameShape(a.second, b.second);

// 저장된 트리를 읽어 ids에 있는 그룹만 남긴다. 빈 그룹과 중복 잎은 접어 남은 창이 그 공간을 채운다.
// 트리가 없으면 예전 2×2 배치(x·y 비율)로 읽는다.
export function resolveLayout(value: unknown, ids: readonly GroupId[], x = 0.5, y = 0.5): SplitLayout {
  const seen = new Set<GroupId>();
  function prune(node: unknown, depth = 0): SplitLayout | null {
    if (isGroupId(node)) {
      if (!ids.includes(node) || seen.has(node)) return null;
      seen.add(node); return node;
    }
    if (!node || typeof node !== "object" || depth > groupIds.length * 2) return null;
    const n = node as Record<string, unknown>;
    if (n.axis !== "x" && n.axis !== "y") return null;
    const first = prune(n.first, depth + 1), second = prune(n.second, depth + 1);
    return first && second ? branch(n.axis, first, second, clampRatio(n.ratio)) : first ?? second;
  }
  const legacyColumn = (top: GroupId, bottom: GroupId) => ids.includes(top) && ids.includes(bottom)
    ? branch("y", top, bottom, y) : ids.includes(top) ? top : ids.includes(bottom) ? bottom : null;
  const left = legacyColumn("left", "bottom-left"), right = legacyColumn("right", "bottom-right");
  const legacy = left && right ? branch("x", left, right, x) : left ?? right;
  let layout = prune(value ?? legacy);
  for (const id of ids) if (!seen.has(id)) {
    layout = layout ? branch("x", layout, id) : id; seen.add(id);
  }
  return layout ?? ids[0] ?? groupIds[0];
}

export function splitLayout(layout: SplitLayout, id: GroupId, target: GroupId, direction: SplitDirection): SplitLayout {
  if (typeof layout === "string") return layout !== id ? layout
    : direction === "left" || direction === "up"
      ? branch(direction === "left" ? "x" : "y", target, id)
      : branch(direction === "right" ? "x" : "y", id, target);
  return { ...layout, first: splitLayout(layout.first, id, target, direction), second: splitLayout(layout.second, id, target, direction) };
}

export function resizeLayout(layout: SplitLayout, path: string, ratio: number): SplitLayout {
  if (typeof layout === "string") return layout;
  if (!path) return { ...layout, ratio: clampRatio(ratio) };
  const key = path[0] === "0" ? "first" : "second";
  return { ...layout, [key]: resizeLayout(layout[key], path.slice(1), ratio) };
}

// 나눌 그룹에 새 ID를 붙인다. 탭 하나뿐인 그룹(vacated)을 옮길 때는 그 그룹을 새 자리로 옮긴다.
// 옮긴 결과가 지금 배치와 같으면 분할로 보지 않는다.
export function planSplit(layout: SplitLayout, id: GroupId, direction: SplitDirection, ids: readonly GroupId[], vacated?: GroupId) {
  if (!ids.includes(id)) return null;
  const target = vacated && vacated !== id ? vacated : groupIds.find(g => !ids.includes(g));
  if (!target) return null;
  const current = resolveLayout(layout, ids);
  const next = splitLayout(resolveLayout(current, ids.filter(g => g !== target)), id, target, direction);
  return sameShape(current, next) ? null : { target, direction, layout: next };
}

// 분할 뒤 한쪽 창이 이보다 작아지면 편집하기 어려우므로 그 방향으로는 나누지 않는다.
const minimumGroupSize = { x: 240, y: 160 };
export const splitFits = (rect: { width: number; height: number }, direction: SplitDirection) =>
  direction === "left" || direction === "right" ? rect.width / 2 >= minimumGroupSize.x : rect.height / 2 >= minimumGroupSize.y;

function subtreeMinSpan(node: SplitLayout, axis: "x" | "y"): number {
  if (typeof node === "string") return minimumGroupSize[axis];
  return node.axis === axis
    ? subtreeMinSpan(node.first, axis) + subtreeMinSpan(node.second, axis) + 4
    : Math.max(subtreeMinSpan(node.first, axis), subtreeMinSpan(node.second, axis));
}

type Length = { percent: number; pixels: number };
type LayoutBox = { left: Length; top: Length; width: Length; height: Length };
export type SplitSash = {
  path: string;
  axis: "x" | "y";
  style: CSSProperties;
  parent: LayoutBox;
  minFirst: number;
  minSecond: number;
  linkedPath?: string;
};
export type SplitIntersection = {
  style: CSSProperties;
  xSash: SplitSash;
  ySash: SplitSash;
};
const length = (percent: number, pixels = 0): Length => ({ percent, pixels });
const add = (a: Length, b: Length): Length => length(a.percent + b.percent, a.pixels + b.pixels);
const scale = (value: Length, ratio: number): Length => length(value.percent * ratio, value.pixels * ratio);
const cssLength = (value: Length) => `calc(${value.percent * 100}% + ${value.pixels}px)`;
const boxStyle = (box: LayoutBox): CSSProperties => ({ position: "absolute", left: cssLength(box.left), top: cssLength(box.top), width: cssLength(box.width), height: cssLength(box.height) });

// 트리를 평면 좌표로 그려 그룹이 재배치되어도 편집기 DOM과 탭별 스크롤을 유지한다.
export function layoutGeometry(layout: SplitLayout) {
  const groups: Partial<Record<GroupId, CSSProperties>> = {}, sashes: SplitSash[] = [], order: GroupId[] = [];
  const bounds: Partial<Record<GroupId, { left: number; top: number; right: number; bottom: number }>> = {};
  function visit(node: SplitLayout, box: LayoutBox, path: string) {
    if (typeof node === "string") {
      groups[node] = boxStyle(box);
      order.push(node);
      bounds[node] = {
        left: box.left.percent,
        top: box.top.percent,
        right: box.left.percent + box.width.percent,
        bottom: box.top.percent + box.height.percent,
      };
      return;
    }
    const horizontal = node.axis === "x", start = horizontal ? "left" : "top", size = horizontal ? "width" : "height";
    const first = add(scale(box[size], node.ratio), length(0, -2));
    const second = add(scale(box[size], 1 - node.ratio), length(0, -2));
    sashes.push({
      path, axis: node.axis, parent: box,
      minFirst: subtreeMinSpan(node.first, node.axis),
      minSecond: subtreeMinSpan(node.second, node.axis),
      style: boxStyle({ ...box, [start]: add(box[start], first), [size]: length(0, 4) }),
    });
    visit(node.first, { ...box, [size]: first }, path + "0");
    visit(node.second, { ...box, [start]: add(add(box[start], first), length(0, 4)), [size]: second }, path + "1");
  }
  visit(layout, { left: length(0), top: length(0), width: length(1), height: length(1) }, "");

  // 2×2 4분할에서 양쪽 하위 분할선의 비율이 같으면 하나로 묶어 함께 움직이고, 중앙 교차점에 4방향 조절점을 둔다.
  let intersection: SplitIntersection | null = null;
  if (
    typeof layout !== "string" &&
    typeof layout.first !== "string" &&
    typeof layout.second !== "string" &&
    layout.first.axis !== layout.axis &&
    layout.second.axis !== layout.axis &&
    Math.abs(layout.first.ratio - layout.second.ratio) < 0.005
  ) {
    const rootSash = sashes.find(s => s.path === "");
    const sash0 = sashes.find(s => s.path === "0");
    const sash1 = sashes.find(s => s.path === "1");
    if (rootSash && sash0 && sash1) {
      sash0.linkedPath = "1";
      sash1.linkedPath = "0";
      const xSash = layout.axis === "x" ? rootSash : sash0;
      const ySash = layout.axis === "y" ? rootSash : sash0;
      const xRatio = layout.axis === "x" ? layout.ratio : layout.first.ratio;
      const yRatio = layout.axis === "y" ? layout.ratio : layout.first.ratio;
      intersection = {
        style: boxStyle({
          left: add(length(xRatio), length(0, -6)),
          top: add(length(yRatio), length(0, -6)),
          width: length(0, 12),
          height: length(0, 12),
        }),
        xSash,
        ySash,
      };
    }
  }
  return { groups, sashes, order, bounds, intersection };
}

export function findAdjacentGroup(layout: SplitLayout, from: GroupId, direction: SplitDirection): GroupId | undefined {
  const { bounds } = layoutGeometry(layout), cur = bounds[from];
  if (!cur) return undefined;
  let best: GroupId | undefined, bestScore = -1;
  for (const id of groupIds) {
    if (id === from) continue;
    const b = bounds[id];
    if (!b) continue;
    const touches = direction === "left" ? Math.abs(b.right - cur.left) < 1e-4
      : direction === "right" ? Math.abs(b.left - cur.right) < 1e-4
      : direction === "up" ? Math.abs(b.bottom - cur.top) < 1e-4
      : Math.abs(b.top - cur.bottom) < 1e-4;
    if (!touches) continue;
    const overlap = direction === "left" || direction === "right"
      ? Math.min(b.bottom, cur.bottom) - Math.max(b.top, cur.top)
      : Math.min(b.right, cur.right) - Math.max(b.left, cur.left);
    if (overlap > 1e-4 && overlap > bestScore) {
      bestScore = overlap;
      best = id;
    }
  }
  return best;
}

type Rect = { left: number; top: number; width: number; height: number };
export function sashRatio(sash: SplitSash, root: Rect, x: number, y: number) {
  const horizontal = sash.axis === "x", size = horizontal ? root.width : root.height;
  const start = sash.parent[horizontal ? "left" : "top"], extent = sash.parent[horizontal ? "width" : "height"];
  const pixels = extent.percent * size + extent.pixels;
  if (pixels <= 0) return 0.5;
  const raw = ((horizontal ? x - root.left : y - root.top) - start.percent * size - start.pixels) / pixels;
  const minRatio = Math.min(0.45, Math.max(0.15, (sash.minFirst ?? minimumGroupSize[sash.axis]) / pixels));
  const maxRatio = Math.max(0.55, Math.min(0.85, 1 - (sash.minSecond ?? minimumGroupSize[sash.axis]) / pixels));
  return Math.min(maxRatio, Math.max(minRatio, raw));
}

export type DropZone = {
  id: GroupId;
  left: number;
  top: number;
  width: number;
  // 그룹의 탭 막대에 놓으면 화면을 나누지 않고 그 그룹에 새 탭으로 연다. 표시는 탭 막대 높이만큼만 한다.
  tabs?: boolean;
  height?: number;
  direction?: SplitDirection;
  copy?: boolean;
  insertIndex?: number;
  indicatorLeft?: number;
};
export const sameDropZone = (a: DropZone | null, b: DropZone | null) => a === b || !!a && !!b &&
  a.id === b.id && a.direction === b.direction && a.tabs === b.tabs && a.copy === b.copy &&
  a.insertIndex === b.insertIndex && a.indicatorLeft === b.indicatorLeft &&
  a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;

export type DropTarget = {
  id: GroupId;
  // 화면 좌표의 사각형. 결과는 container 기준 좌표다.
  container: Rect;
  group: Rect;
  tabBar: Rect | null;
  overTabBar: boolean;
  x: number;
  y: number;
  // 끌고 있는 탭이 이 그룹에서 왔는지, 출발 그룹의 유일한 탭인지.
  own: boolean;
  sole: boolean;
  empty: boolean;
  copy?: boolean;
  disableSplit?: boolean;
  insertIndex?: number;
  indicatorLeft?: number;
  canSplit: (direction: SplitDirection) => boolean;
};

// 탭 막대와 본문 중앙(80%×80%)은 합치기, 본문 가장자리(10%)는 3등분(좌 1/3·우 1/3·중앙 상하) 규칙으로 분할한다.
export function resolveDropZone(t: DropTarget): DropZone | null {
  const effectiveOwn = t.own && !t.copy;
  if (t.overTabBar && t.tabBar) {
    if (effectiveOwn && t.insertIndex === undefined) return null;
    return {
      id: t.id, tabs: true, copy: t.copy, insertIndex: t.insertIndex, indicatorLeft: t.indicatorLeft,
      left: t.tabBar.left - t.container.left, top: t.tabBar.top - t.container.top,
      width: t.tabBar.width, height: t.tabBar.height,
    };
  }
  if (effectiveOwn && t.sole) return null;
  const top = (t.tabBar ? t.tabBar.top + t.tabBar.height : t.group.top) - t.container.top;
  const height = t.group.top + t.group.height - t.container.top - top, left = t.group.left - t.container.left;
  if (t.group.width <= 0 || height <= 0) return null;
  const whole: DropZone | null = effectiveOwn ? null : { id: t.id, copy: t.copy, left, top, width: t.group.width, height };
  if (t.empty || t.disableSplit) return whole;
  const x = (t.x - t.group.left) / t.group.width, y = (t.y - t.container.top - top) / height;
  const inEdge = x < 0.1 || x >= 0.9 || y < 0.1 || y >= 0.9;
  if (!inEdge) return whole;
  const primary: SplitDirection = x < 1 / 3 ? "left" : x > 2 / 3 ? "right" : y < 0.5 ? "up" : "down";
  const secondary: SplitDirection | null = (x < 1 / 3 || x > 2 / 3) && (y < 0.1 || y >= 0.9) ? (y < 0.5 ? "up" : "down") : null;
  const direction = [primary, secondary].find((d): d is SplitDirection => !!d && splitFits(t.group, d) && t.canSplit(d));
  if (!direction) return whole;
  const horizontal = direction === "left" || direction === "right";
  return {
    id: t.id, direction, copy: t.copy,
    left: left + (direction === "right" ? t.group.width / 2 : 0),
    top: top + (direction === "down" ? height / 2 : 0),
    width: horizontal ? t.group.width / 2 : t.group.width,
    height: horizontal ? height : height / 2,
  };
}
