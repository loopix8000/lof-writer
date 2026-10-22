import { useCallback, useState } from "react";

export type UndoState = { canUndo: boolean; canRedo: boolean };
const empty: UndoState = { canUndo: false, canRedo: false };

export function useUndoState(documentKey: string) {
  const [snapshot, setSnapshot] = useState({ key: documentKey, value: empty });
  const onUndoStateChange = useCallback((value: UndoState) => {
    setSnapshot(previous => previous.key === documentKey &&
      previous.value.canUndo === value.canUndo && previous.value.canRedo === value.canRedo
      ? previous : { key: documentKey, value });
  }, [documentKey]);
  return {
    undoState: snapshot.key === documentKey ? snapshot.value : empty,
    onUndoStateChange,
  };
}
