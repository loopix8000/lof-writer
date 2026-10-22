import { useEffect, useRef } from "react";
import type { Library } from "../types";
import type { useProjectReorder } from "../useProjectReorder";

type Drop = { card: HTMLElement; id: string; after: boolean };
type Gesture = {
  id: string;
  root: string;
  touch: number;
  x: number;
  y: number;
  currentY: number;
  offset: number;
  card: HTMLElement;
  preview: HTMLElement | null;
};

export function useMobileProjectReorder(
  lib: Library,
  enabled: boolean,
  busy: boolean,
  reorder: ReturnType<typeof useProjectReorder>,
  attempt: (fn: () => Promise<any>) => () => Promise<any>,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const latest = useRef({ lib, busy, reorder, attempt });
  latest.current = { lib, busy, reorder, attempt };
  const suppressClickUntil = useRef(0);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll || !enabled) return;
    let gesture: Gesture | null = null;
    let drop: Drop | null = null;
    let hold: ReturnType<typeof setTimeout> | undefined;
    let frame: number | undefined;
    const clearDrop = () => {
      drop?.card.classList.remove("m-project-drop-before", "m-project-drop-after");
      drop = null;
    };
    const cancel = () => {
      clearTimeout(hold);
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      if (gesture?.preview) suppressClickUntil.current = Date.now() + 650;
      gesture?.card.classList.remove("m-project-dragging");
      gesture?.preview?.remove();
      gesture = null;
      clearDrop();
    };
    const updateDrop = () => {
      if (!gesture?.preview) return;
      const cards = [...scroll.querySelectorAll<HTMLElement>(".m-project-card[data-project-id]")]
        .filter((card) => card.dataset.projectId !== gesture!.id);
      let next: Drop | null = null;
      for (const card of cards) {
        const rect = card.getBoundingClientRect();
        const after = gesture.currentY >= rect.top + rect.height / 2;
        next = { card, id: card.dataset.projectId!, after };
        if (!after) break;
      }
      if (next?.id === drop?.id && next?.after === drop?.after) return;
      clearDrop();
      drop = next;
      drop?.card.classList.add(drop.after ? "m-project-drop-after" : "m-project-drop-before");
    };
    const animate = () => {
      if (!gesture?.preview) return;
      const rect = scroll.getBoundingClientRect();
      const edge = Math.min(56, rect.height / 4);
      const up = Math.max(0, Math.min(1, (rect.top + edge - gesture.currentY) / edge));
      const down = Math.max(0, Math.min(1, (gesture.currentY - rect.bottom + edge) / edge));
      scroll.scrollTop += (down - up) * 12;
      gesture.preview.style.top = `${gesture.currentY - gesture.offset}px`;
      updateDrop();
      frame = requestAnimationFrame(animate);
    };
    const start = (event: TouchEvent) => {
      cancel();
      suppressClickUntil.current = 0;
      if (event.touches.length !== 1 || latest.current.busy || latest.current.reorder.saving || latest.current.lib.projects.length < 2) return;
      const card = event.target instanceof Element
        ? event.target.closest<HTMLElement>(".m-project-card[data-project-id]") : null;
      if (!card || !scroll.contains(card)) return;
      const touch = event.touches[0];
      gesture = {
        id: card.dataset.projectId!, root: latest.current.lib.root, touch: touch.identifier,
        x: touch.clientX, y: touch.clientY, currentY: touch.clientY, offset: 0, card, preview: null,
      };
      hold = setTimeout(() => {
        if (!gesture || latest.current.lib.root !== gesture.root || latest.current.busy || latest.current.reorder.saving
          || !latest.current.lib.projects.some((project) => project.id === gesture!.id)) { cancel(); return; }
        const rect = card.getBoundingClientRect();
        const preview = card.cloneNode(true) as HTMLElement;
        preview.removeAttribute("data-project-id");
        preview.classList.add("m-project-reorder-preview");
        preview.setAttribute("aria-hidden", "true");
        preview.inert = true;
        Object.assign(preview.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px` });
        scroll.closest(".m-screen")!.append(preview);
        gesture.preview = preview;
        gesture.offset = gesture.y - rect.top;
        card.classList.add("m-project-dragging");
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && card.contains(focused)) focused.blur();
        animate();
      }, 420);
    };
    const move = (event: TouchEvent) => {
      if (!gesture) return;
      if (event.touches.length !== 1) { cancel(); return; }
      const touch = event.touches[0];
      if (touch.identifier !== gesture.touch) { cancel(); return; }
      if (!gesture.preview) {
        if (Math.hypot(touch.clientX - gesture.x, touch.clientY - gesture.y) > 10) cancel();
        return;
      }
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      gesture.currentY = touch.clientY;
      gesture.preview.style.top = `${touch.clientY - gesture.offset}px`;
      updateDrop();
    };
    const end = (event: TouchEvent) => {
      if (!gesture?.preview) { cancel(); return; }
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      const touch = [...event.changedTouches].find((touch) => touch.identifier === gesture!.touch);
      if (!touch) { cancel(); return; }
      gesture.currentY = touch.clientY;
      updateDrop();
      const moving = gesture;
      const target = drop;
      cancel();
      if (target) void latest.current.attempt(() => latest.current.reorder.move(
        moving.id, target.id, target.after, moving.root,
      ))();
    };
    const suppressClick = (event: MouseEvent) => {
      if (!gesture?.preview && Date.now() >= suppressClickUntil.current) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const suppressContextMenu = (event: Event) => {
      if (gesture || Date.now() < suppressClickUntil.current) event.preventDefault();
    };
    const options = { capture: true, passive: false };
    scroll.addEventListener("touchstart", start, options);
    scroll.addEventListener("touchmove", move, options);
    scroll.addEventListener("touchend", end, options);
    scroll.addEventListener("touchcancel", cancel, true);
    scroll.addEventListener("mousedown", suppressClick, true);
    scroll.addEventListener("click", suppressClick, true);
    scroll.addEventListener("contextmenu", suppressContextMenu, true);
    scroll.addEventListener("dragstart", suppressContextMenu, true);
    return () => {
      cancel();
      scroll.removeEventListener("touchstart", start, true);
      scroll.removeEventListener("touchmove", move, true);
      scroll.removeEventListener("touchend", end, true);
      scroll.removeEventListener("touchcancel", cancel, true);
      scroll.removeEventListener("mousedown", suppressClick, true);
      scroll.removeEventListener("click", suppressClick, true);
      scroll.removeEventListener("contextmenu", suppressContextMenu, true);
      scroll.removeEventListener("dragstart", suppressContextMenu, true);
    };
  }, [lib.root, enabled, busy, reorder.saving]);

  return scrollRef;
}
