import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";

type ActiveSelectionGuard = { roots: Set<HTMLElement>; restore: () => void };
const guards = new WeakMap<Selection, ActiveSelectionGuard>();

function isIndexSizeError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "IndexSizeError";
}

function protectSelection(selection: Selection): ActiveSelectionGuard {
  const roots = new Set<HTMLElement>();
  const collapse = selection.collapse;
  const extend = selection.extend;
  const collapseDescriptor = Object.getOwnPropertyDescriptor(selection, "collapse");
  const extendDescriptor = Object.getOwnPropertyDescriptor(selection, "extend");

  function applyPosition(target: Selection, node: Node | null, offset: number, apply: (offset: number) => void) {
    try {
      apply(offset);
    } catch (error) {
      // 연속 삭제로 DOM이 먼저 짧아져도 선택 갱신과 입력 감시 처리를 끝까지 진행한다.
      if (target !== selection || !node || !isIndexSizeError(error) ||
          !Array.from(roots).some(root => root.contains(node))) throw error;
      const length = node.nodeType === Node.TEXT_NODE ? node.nodeValue?.length ?? 0 : node.childNodes.length;
      const safeOffset = Math.max(0, Math.min(offset, length));
      if (!Number.isInteger(offset) || safeOffset === offset) throw error;
      try {
        apply(safeOffset);
      } catch (recoveryError) {
        // 보정 중에도 DOM이 바뀌면 현재 선택을 보존하고 다음 입력 처리를 계속한다.
        if (!isIndexSizeError(recoveryError)) throw recoveryError;
      }
      console.warn("편집기 커서 위치가 현재 DOM 범위를 벗어났습니다.", { offset, safeOffset, error });
    }
  }

  const safeCollapse: Selection["collapse"] = function(this: Selection, node, offset = 0) {
    applyPosition(this, node, offset, next => collapse.call(this, node, next));
  };
  const safeExtend: Selection["extend"] = function(this: Selection, node, offset = 0) {
    applyPosition(this, node, offset, next => extend.call(this, node, next));
  };
  // 문서의 Selection 인스턴스만 감싸고, 등록된 편집기 안의 위치 오류만 복구한다.
  selection.collapse = safeCollapse;
  if (typeof extend === "function") selection.extend = safeExtend;
  return {
    roots,
    restore() {
      if (selection.collapse === safeCollapse) {
        if (collapseDescriptor) Object.defineProperty(selection, "collapse", collapseDescriptor);
        else Reflect.deleteProperty(selection, "collapse");
      }
      if (selection.extend === safeExtend) {
        if (extendDescriptor) Object.defineProperty(selection, "extend", extendDescriptor);
        else Reflect.deleteProperty(selection, "extend");
      }
    },
  };
}

export const SelectionGuard = Extension.create({
  name: "selectionGuard",
  addProseMirrorPlugins() {
    return [new Plugin({
      view(view) {
        const selection = (view.root as Document).getSelection();
        if (!selection) return {};
        let guard = guards.get(selection);
        if (!guard) {
          guard = protectSelection(selection);
          guards.set(selection, guard);
        }
        const activeGuard = guard;
        activeGuard.roots.add(view.dom);
        return {
          destroy() {
            activeGuard.roots.delete(view.dom);
            if (activeGuard.roots.size) return;
            activeGuard.restore();
            guards.delete(selection);
          },
        };
      },
    })];
  },
});
