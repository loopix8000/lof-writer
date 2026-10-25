import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type * as React from "react";
import { MobileActionSheet } from "./MobileActionSheet";

const LONG_PRESS_MS = 450;
const MOVE_TOLERANCE = 10;

// 회차 묶음 제목을 꾹 누르면 모든 묶음을 한 번에 펼치거나 접는 메뉴를 띄운다.
export function useEpisodeGroupMenu(setAll: (open: boolean) => void) {
  const [open, setOpen] = useState(false);
  const press = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  const cancel = () => {
    if (press.current) window.clearTimeout(press.current.timer);
  };
  useEffect(() => () => cancel(), []);

  // 묶음 제목 버튼에 붙인다. 짧게 누르면 그 묶음만 접고 펼친다.
  const bind = (toggle: () => void) => ({
    onPointerDown: (e: React.PointerEvent) => {
      cancel();
      if (!e.isPrimary || e.button !== 0) {
        press.current = null;
        return;
      }
      const next = { timer: 0, x: e.clientX, y: e.clientY, fired: false };
      next.timer = window.setTimeout(() => {
        next.fired = true;
        navigator.vibrate?.(12);
        setOpen(true);
      }, LONG_PRESS_MS);
      press.current = next;
    },
    onPointerMove: (e: React.PointerEvent) => {
      const current = press.current;
      if (current && !current.fired && Math.hypot(e.clientX - current.x, e.clientY - current.y) > MOVE_TOLERANCE) {
        cancel();
        press.current = null;
      }
    },
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onPointerCancel: () => {
      cancel();
      press.current = null;
    },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    // 꾹 눌러 메뉴를 띄운 뒤 따라오는 클릭으로 묶음이 접히지 않게 한다.
    onClick: () => {
      const fired = !!press.current?.fired;
      press.current = null;
      if (!fired) toggle();
    },
  });

  const sheet = (
    <MobileActionSheet
      open={open}
      title="회차 묶음"
      items={[
        { label: "모두 펼치기", icon: <ChevronsUpDown size={18} />, action: () => setAll(true) },
        { label: "모두 접기", icon: <ChevronsDownUp size={18} />, action: () => setAll(false) },
      ]}
      onClose={() => setOpen(false)}
    />
  );

  return { bind, sheet };
}
