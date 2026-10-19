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
const clampRatio = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.min(0.8, Math.max(0.2, value)) : 0.5;
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

type Length = { percent: number; pixels: number };
type LayoutBox = { left: Length; top: Length; width: Length; height: Length };
export type SplitSash = { path: string; axis: "x" | "y"; style: CSSProperties; parent: LayoutBox };
const length = (percent: number, pixels = 0): Length => ({ percent, pixels });
const add = (a: Length, b: Length): Length => length(a.percent + b.percent, a.pixels + b.pixels);
const scale = (value: Length, ratio: number): Length => length(value.percent * ratio, value.pixels * ratio);
const cssLength = (value: Length) => `calc(${value.percent * 100}% + ${value.pixels}px)`;
const boxStyle = (box: LayoutBox): CSSProperties => ({ position: "absolute", left: cssLength(box.left), top: cssLength(box.top), width: cssLength(box.width), height: cssLength(box.height) });

// 트리를 평면 좌표로 그려 그룹이 재배치되어도 편집기 DOM과 탭별 스크롤을 유지한다.
export function layoutGeometry(layout: SplitLayout) {
  const groups: Partial<Record<GroupId, CSSProperties>> = {}, sashes: SplitSash[] = [], order: GroupId[] = [];
  function visit(node: SplitLayout, box: LayoutBox, path: string) {
    if (typeof node === "string") { groups[node] = boxStyle(box); order.push(node); return; }
    const horizontal = node.axis === "x", start = horizontal ? "left" : "top", size = horizontal ? "width" : "height";
    const first = add(scale(box[size], node.ratio), length(0, -2));
    const second = add(scale(box[size], 1 - node.ratio), length(0, -2));
    sashes.push({ path, axis: node.axis, parent: box,
      style: boxStyle({ ...box, [start]: add(box[start], first), [size]: length(0, 4) }) });
    visit(node.first, { ...box, [size]: first }, path + "0");
    visit(node.second, { ...box, [start]: add(add(box[start], first), length(0, 4)), [size]: second }, path + "1");
  }
  visit(layout, { left: length(0), top: length(0), width: length(1), height: length(1) }, "");
  return { groups, sashes, order };
}

type Rect = { left: number; top: number; width: number; height: number };
export function sashRatio(sash: SplitSash, root: Rect, x: number, y: number) {
  const horizontal = sash.axis === "x", size = horizontal ? root.width : root.height;
  const start = sash.parent[horizontal ? "left" : "top"], extent = sash.parent[horizontal ? "width" : "height"];
  const pixels = extent.percent * size + extent.pixels;
  return pixels > 0 ? clampRatio(((horizontal ? x - root.left : y - root.top) - start.percent * size - start.pixels) / pixels) : 0.5;
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
};
export const sameDropZone = (a: DropZone | null, b: DropZone | null) => a === b || !!a && !!b &&
  a.id === b.id && a.direction === b.direction && a.tabs === b.tabs &&
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
  canSplit: (direction: SplitDirection) => boolean;
};

// 탭 막대와 본문 중앙은 합치기, 본문 가장자리는 분할하기에 쓴다. 빈 그룹은 열기만 하고, 바뀌는 것이 없는 곳은 표시하지 않는다.
export function resolveDropZone(t: DropTarget): DropZone | null {
  if (t.overTabBar && t.tabBar) return t.own ? null : {
    id: t.id, tabs: true, left: t.tabBar.left - t.container.left, top: t.tabBar.top - t.container.top,
    width: t.tabBar.width, height: t.tabBar.height,
  };
  if (t.own && t.sole) return null;
  const top = (t.tabBar ? t.tabBar.top + t.tabBar.height : t.group.top) - t.container.top;
  const height = t.group.top + t.group.height - t.container.top - top, left = t.group.left - t.container.left;
  if (t.group.width <= 0 || height <= 0) return null;
  const whole = t.own ? null : { id: t.id, left, top, width: t.group.width, height };
  if (t.empty) return whole;
  const x = (t.x - t.group.left) / t.group.width, y = (t.y - t.container.top - top) / height;
  const edges: [SplitDirection, number][] = [["left", x], ["right", 1 - x], ["up", y], ["down", 1 - y]];
  const edge = edges.sort((a, b) => a[1] - b[1]).find(([direction, distance]) =>
    distance < 0.25 && splitFits(t.group, direction) && t.canSplit(direction));
  if (!edge) return whole;
  const direction = edge[0], horizontal = direction === "left" || direction === "right";
  return { id: t.id, direction,
    left: left + (direction === "right" ? t.group.width / 2 : 0),
    top: top + (direction === "down" ? height / 2 : 0),
    width: horizontal ? t.group.width / 2 : t.group.width,
    height: horizontal ? height : height / 2 };
}
