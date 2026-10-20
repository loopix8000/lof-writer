import type { MenuItem } from "../ContextMenu";
import { defaultSplitDirection, splitDirections, type SplitDirection } from "./layout";

// 탭 메뉴의 분할 항목. 어느 화면이든 같은 항목·순서·단축키 표시를 쓴다.
export function splitMenuItems({ focused, split, canSplit, splitTo, moveToOther, closeGroup }: {
  // 포커스된 그룹의 탭인지. 단축키 표시는 포커스된 그룹에만 붙는다.
  focused: boolean;
  split: boolean;
  canSplit: (direction: SplitDirection) => boolean;
  splitTo: (direction: SplitDirection) => void;
  moveToOther: () => void;
  closeGroup: () => void;
}): MenuItem[] {
  return [
    ...splitDirections.map(({ direction, label }) => ({
      label,
      shortcut: !focused ? undefined : direction === defaultSplitDirection ? "Ctrl+\\" : direction === "down" ? "Ctrl+K Ctrl+\\" : undefined,
      disabled: !canSplit(direction),
      action: () => splitTo(direction),
    })),
    ...(split ? [{ label: "다른 그룹으로 이동", shortcut: focused ? "Ctrl+Alt+→" : undefined, action: moveToOther }] : []),
    { label: "그룹 닫기", disabled: !split, action: closeGroup },
  ];
}
