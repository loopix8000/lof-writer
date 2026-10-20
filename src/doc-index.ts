import type { Node as PMNode } from "@tiptap/pm/model";
import { Mapping, StepMap } from "@tiptap/pm/transform";
import { needsMarkdownCopy } from "./source-protection";

// 본문 맨 위 단계 블록마다 위치·줄 수·주석 상태를 모아 둔다. 입력은 보통 한 문단만 바꾸므로
// 바뀐 블록만 다시 세고, 나머지는 바로 앞 문서의 값을 옮겨 쓴다.

export type CommentState = { open: boolean; stray: boolean };
type BlockInfo = { lines: number; copy: boolean; breaks: boolean; tokens: boolean; exits: (CommentState | undefined)[] };

export type DocIndex = {
  doc: PMNode;
  // 블록 i의 시작 위치. 마지막 칸은 문서 끝이다.
  starts: Int32Array;
  // 블록 i 앞까지의 줄 수.
  lines: Int32Array;
  // 블록 i에 들어설 때 닫히지 않은 주석(<!--)이 열려 있는지.
  open: Uint8Array;
  // 블록 i 앞에 짝 없는 주석 닫기(-->)가 있었는지.
  stray: Uint8Array;
  // 원문 보관이 필요한 블록 수.
  copies: number;
  // 주석 기호가 있는 블록 수.
  tokens: number;
};

const CLOSED: CommentState = { open: false, stray: false };
const OPEN: CommentState = { open: true, stray: false };

export const isHardBreak = (node: PMNode) => node.type.name === "hardBreak" || node.type.name === "hard_break";

// 줄 번호 기준: 문단(표 칸·목록 항목 포함)과 구분선을 한 줄로, 강제 줄바꿈마다 한 줄을 더 센다.
const lineCounts = new WeakMap<PMNode, number>();
export function nodeLineCount(node: PMNode): number {
  const cached = lineCounts.get(node);
  if (cached !== undefined) return cached;
  let count = 0;
  if (node.isTextblock) {
    count = 1;
    node.forEach((child) => { if (child.type.name === "hardBreak") count++; });
  } else if (node.isBlock && node.isLeaf) count = 1;
  else node.forEach((child) => { count += nodeLineCount(child); });
  lineCounts.set(node, count);
  return count;
}

// 주석 범위를 찾을 때 쓰는 문단 글. 강제 줄바꿈은 줄바꿈으로, 그 밖의 인라인 노드는 한 글자로 둔다.
const texts = new WeakMap<PMNode, string>();
export function textblockText(node: PMNode): string {
  let text = texts.get(node);
  if (text === undefined) {
    text = "";
    node.forEach((child) => { text += child.isText ? child.text! : child.type.name === "hardBreak" ? "\n" : "￼"; });
    texts.set(node, text);
  }
  return text;
}
const leafText = (leaf: PMNode) => (leaf.type.name === "hardBreak" ? "\n" : "￼");

// textblockText의 offset번째 글자의 문서 위치. 끝(offset === 글 길이)이면 문단 내용의 끝 위치다.
export function textPos(node: PMNode, pos: number, offset: number): number {
  let at = pos + 1;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i), size = child.isText ? child.text!.length : 1;
    if (offset < size) return at + offset;
    offset -= size;
    at += child.nodeSize;
  }
  return pos + node.nodeSize - 1;
}

export function eachTextblock(block: PMNode, pos: number, f: (node: PMNode, pos: number) => void) {
  if (block.isTextblock) return f(block, pos);
  block.descendants((node, offset) => {
    if (!node.isTextblock) return true;
    f(node, pos + 1 + offset);
    return false;
  });
}

export const COMMENT_OPEN = "<!--", COMMENT_CLOSE = "-->";

// 주석 기호를 앞에서부터 짝짓는다(/<!--[\s\S]*?-->/ 정규식과 같은 짝). 주석이 걸친 구간마다 piece를 부르고,
// 닫기(-->)로 끝난 구간이면 closed가 참이다.
export function scanComments(text: string, state: CommentState, piece?: (from: number, to: number, closed: boolean) => void) {
  let cursor = 0, start = 0;
  for (;;) {
    if (!state.open) {
      const open = text.indexOf(COMMENT_OPEN, cursor);
      if (!state.stray) {
        const close = text.indexOf(COMMENT_CLOSE, cursor);
        if (close >= 0 && (open < 0 || close < open)) state.stray = true;
      }
      if (open < 0) return;
      state.open = true;
      start = open;
      cursor = open + COMMENT_OPEN.length;
    } else {
      const close = text.indexOf(COMMENT_CLOSE, cursor);
      if (close < 0) {
        piece?.(start, text.length, false);
        return;
      }
      piece?.(start, close + COMMENT_CLOSE.length, true);
      state.open = false;
      cursor = close + COMMENT_CLOSE.length;
    }
  }
}

const infos = new WeakMap<PMNode, BlockInfo>();
export function blockInfo(node: PMNode): BlockInfo {
  let info = infos.get(node);
  if (!info) {
    // 문단 경계를 넘는 기호를 잘못 잡아도 아래 상세 검사에서 걸러지므로, 빠른 거름으로만 쓴다.
    const text = node.textContent;
    let breaks = false;
    node.descendants((child) => {
      if (breaks) return false;
      if (isHardBreak(child)) breaks = true;
      return !child.isInline;
    });
    info = {
      lines: nodeLineCount(node),
      copy: needsMarkdownCopy(node),
      breaks,
      tokens: text.includes(COMMENT_OPEN) || text.includes(COMMENT_CLOSE),
      exits: [],
    };
    infos.set(node, info);
  }
  return info;
}

function exitState(node: PMNode, info: BlockInfo, open: boolean): CommentState {
  if (!info.tokens) return open ? OPEN : CLOSED;
  let state = info.exits[+open];
  if (!state) {
    const next = { open, stray: false };
    eachTextblock(node, 0, (child) => scanComments(textblockText(child), next));
    info.exits[+open] = state = next;
  }
  return state;
}

// 두 문서에서 앞뒤로 같은(같은 객체인) 맨 위 블록을 빼고 남은 구간. a의 [start, endA)가 b의 [start, endB)로 바뀌었다.
export function changedBlocks(a: PMNode, b: PMNode) {
  const countA = a.childCount, countB = b.childCount, min = Math.min(countA, countB);
  let start = 0;
  while (start < min && a.child(start) === b.child(start)) start++;
  let endA = countA, endB = countB;
  while (endA > start && endB > start && a.child(endA - 1) === b.child(endB - 1)) {
    endA--;
    endB--;
  }
  return { start, endA, endB };
}

// 바뀐 블록 구간만 갈아 끼운 위치 대응. 바뀌지 않은 블록 안의 위치는 정확히 옮겨진다.
export function blockMapping(before: DocIndex, after: DocIndex, { start, endA, endB }: ReturnType<typeof changedBlocks>) {
  const from = before.starts[start];
  return new Mapping([new StepMap([from, before.starts[endA] - from, after.starts[endB] - after.starts[start]])]);
}

function compute(doc: PMNode, base: DocIndex | null): DocIndex {
  const count = doc.childCount;
  const starts = new Int32Array(count + 1), lines = new Int32Array(count + 1);
  const open = new Uint8Array(count + 1), stray = new Uint8Array(count + 1);
  let copies = 0, tokens = 0, start = 0, endA = 0, endB = count;
  if (base) {
    ({ start, endA, endB } = changedBlocks(base.doc, doc));
    starts.set(base.starts.subarray(0, start + 1));
    lines.set(base.lines.subarray(0, start + 1));
    open.set(base.open.subarray(0, start + 1));
    stray.set(base.stray.subarray(0, start + 1));
    copies = base.copies;
    tokens = base.tokens;
    for (let i = start; i < endA; i++) {
      const info = blockInfo(base.doc.child(i));
      copies -= +info.copy;
      tokens -= +info.tokens;
    }
  }
  for (let i = start; i < endB; i++) {
    const node = doc.child(i), info = blockInfo(node);
    copies += +info.copy;
    tokens += +info.tokens;
    starts[i + 1] = starts[i] + node.nodeSize;
    lines[i + 1] = lines[i] + info.lines;
    const next = exitState(node, info, open[i] === 1);
    open[i + 1] = +next.open;
    stray[i + 1] = stray[i] | +next.stray;
  }
  if (base) {
    const shift = endA - endB, pos = starts[endB] - base.starts[endA], line = lines[endB] - base.lines[endA];
    for (let i = endB + 1; i <= count; i++) {
      starts[i] = base.starts[i + shift] + pos;
      lines[i] = base.lines[i + shift] + line;
    }
    // 바뀐 구간 뒤의 주석 상태는 이전 문서와 같아지는 곳까지만 다시 센다.
    let i = endB;
    while (i < count && (open[i] !== base.open[i + shift] || stray[i] !== base.stray[i + shift])) {
      const node = doc.child(i), next = exitState(node, blockInfo(node), open[i] === 1);
      open[i + 1] = +next.open;
      stray[i + 1] = stray[i] | +next.stray;
      i++;
    }
    open.set(base.open.subarray(i + shift + 1), i + 1);
    stray.set(base.stray.subarray(i + shift + 1), i + 1);
  }
  return { doc, starts, lines, open, stray, copies, tokens };
}

const indexes = new WeakMap<PMNode, DocIndex>();
let recent: DocIndex | null = null;
// previous가 있으면 그 문서와 비교해 바뀐 블록만 다시 센다. 없으면 가장 최근에 만든 색인과 비교한다.
export function docIndex(doc: PMNode, previous?: PMNode): DocIndex {
  let index = indexes.get(doc);
  if (!index) {
    index = compute(doc, (previous && indexes.get(previous)) || recent);
    indexes.set(doc, index);
  }
  recent = index;
  return index;
}

// pos가 들어 있는 맨 위 블록 번호. 문서 끝이면 블록 수를 돌려준다.
export function blockAt(index: DocIndex, pos: number): number {
  const starts = index.starts;
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// pos 앞까지의 주석 상태: 닫히지 않은 주석이 열려 있는지, 짝 없는 닫기가 있었는지.
export function commentStateAt(doc: PMNode, pos: number): CommentState {
  const index = docIndex(doc);
  if (!index.tokens) return CLOSED;
  const i = blockAt(index, pos), start = index.starts[i];
  const state = { open: index.open[i] === 1, stray: index.stray[i] === 1 };
  if (i < doc.childCount && pos > start && blockInfo(doc.child(i)).tokens)
    scanComments(doc.textBetween(start, pos, "\n", leafText), state);
  return state;
}

export const docNeedsMarkdownCopy = (doc: PMNode) => docIndex(doc).copies > 0;
