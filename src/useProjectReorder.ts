import { useEffect, useRef, useState, type ButtonHTMLAttributes, type DragEvent, type RefObject } from "react";
import { call, type Library } from "./types";

type DropPosition = { id: string | null; after: boolean; vertical: boolean };

export function useProjectReorder(
  library: RefObject<Library>,
  root: string,
  enabled: boolean,
  busy: boolean,
  refresh: () => Promise<unknown>,
  report: (error: unknown) => void,
) {
  const source = useRef<{ id: string; root: string } | null>(null);
  const pending = useRef(false);
  const suppressClickUntil = useRef(0);
  const [dragging, setDragging] = useState("");
  const [drop, setDrop] = useState<DropPosition | null>(null);
  const [saving, setSaving] = useState(false);

  function clearDrag() {
    if (source.current) suppressClickUntil.current = Date.now() + 250;
    source.current = null;
    setDragging("");
    setDrop(null);
  }

  useEffect(() => { clearDrag(); }, [root, enabled]);

  async function move(id: string, targetId: string, after: boolean, sourceRoot: string) {
    const current = library.current;
    if (pending.current || busy || current.root !== sourceRoot || id === targetId) return;
    const next = current.projects.filter((project) => project.id !== id);
    const moving = current.projects.find((project) => project.id === id);
    const position = next.findIndex((project) => project.id === targetId);
    if (!moving || position < 0) return;
    next.splice(position + (after ? 1 : 0), 0, moving);
    if (next.every((project, index) => project.id === current.projects[index].id)) return;
    pending.current = true;
    setSaving(true);
    try {
      await call("reorderProjects", { root: sourceRoot, ids: next.map((project) => project.id) });
      if (library.current.root === sourceRoot) await refresh();
    } catch (error) {
      // 목록이 외부에서 바뀐 경우 최신 목록으로 다시 시도할 수 있게 한다.
      if (library.current.root === sourceRoot) await refresh().catch(report);
      throw error;
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  function position(event: DragEvent<HTMLButtonElement>, id: string | null): DropPosition {
    const card = event.currentTarget;
    const rect = card.getBoundingClientRect();
    const columns = getComputedStyle(card.parentElement!).gridTemplateColumns.trim().split(/\s+/).length;
    const vertical = columns === 1;
    return {
      id,
      after: id !== null && (vertical ? event.clientY > rect.top + rect.height / 2 : event.clientX > rect.left + rect.width / 2),
      vertical,
    };
  }

  function canDrop(id: string | null) {
    const current = source.current;
    return enabled && !busy && !pending.current && current !== null &&
      current.root === library.current.root && current.id !== id;
  }

  function cardClass(id: string | null) {
    return [
      id !== null && dragging === id ? "project-dragging" : "",
      drop?.id === id ? `project-drop-${drop.after ? "after" : "before"}${drop.vertical ? " project-drop-vertical" : ""}` : "",
    ].filter(Boolean).join(" ");
  }

  function cardProps(id: string | null): ButtonHTMLAttributes<HTMLButtonElement> {
    return {
      draggable: id !== null && enabled && !busy && !saving && library.current.projects.length > 1,
      ...(id !== null ? {
        title: "드래그하여 순서 변경 · Alt+방향키로 이동",
        "aria-keyshortcuts": "Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown",
      } : {}),
      onClickCapture(event) {
        if (source.current || Date.now() < suppressClickUntil.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
      onKeyDown(event) {
        if (id === null || !enabled || busy || pending.current || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const direction = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
        if (!direction) return;
        event.preventDefault();
        const current = library.current;
        const index = current.projects.findIndex((project) => project.id === id);
        const target = current.projects[index + direction];
        if (index >= 0 && target) void move(id, target.id, direction > 0, current.root).catch(report);
      },
      onDragStart(event) {
        if (id === null || !enabled || busy || pending.current || library.current.projects.length < 2) {
          event.preventDefault();
          return;
        }
        event.stopPropagation();
        source.current = { id, root: library.current.root };
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-lof-project", id);
        setDragging(id);
        setDrop(null);
      },
      onDragEnd() {
        suppressClickUntil.current = Date.now() + 250;
        clearDrag();
      },
      onDragOver(event) {
        if (!canDrop(id)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        const next = position(event, id);
        setDrop((previous) => previous?.id === next.id && previous.after === next.after && previous.vertical === next.vertical ? previous : next);
      },
      onDragLeave(event) {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setDrop((previous) => previous?.id === id ? null : previous);
      },
      onDrop(event) {
        if (!canDrop(id)) return;
        event.preventDefault();
        event.stopPropagation();
        const moving = source.current!;
        const after = id === null || position(event, id).after;
        const targetId = id ?? library.current.projects.at(-1)?.id;
        suppressClickUntil.current = Date.now() + 250;
        clearDrag();
        if (targetId) void move(moving.id, targetId, after, moving.root).catch(report);
      },
    };
  }

  return { saving, cardProps, cardClass };
}
