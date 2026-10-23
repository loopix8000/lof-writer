import { useEffect, useReducer } from "react";
import { readWorkspaceState, saveWorkspaceState, workspaceKey } from "../workspace-state";

const CHANGE_EVENT = "lof-mobile-episode-groups-change";

// 작품 화면과 사이드바의 접기 상태를 작품별로 저장한다. 보관함은 별도로 기억한다.
export function useEpisodeGroups(root: string, projectId: string, defaultStart: number, archive = false) {
  const scope = workspaceKey(root, projectId);
  const mode = archive ? "archive" : "current";
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    const sync = () => refresh();
    window.addEventListener(CHANGE_EVENT, sync);
    return () => window.removeEventListener(CHANGE_EVENT, sync);
  }, []);

  const isGroupOpen = (start: number) => {
    const value = readWorkspaceState(scope).mobileEpisodeGroups?.[mode]?.[start];
    return typeof value === "boolean" ? value : start === defaultStart;
  };
  const toggleGroup = (start: number) => {
    const groups = readWorkspaceState(scope).mobileEpisodeGroups;
    saveWorkspaceState(scope, {
      mobileEpisodeGroups: {
        ...groups,
        [mode]: { ...groups?.[mode], [start]: !isGroupOpen(start) },
      },
    });
    window.dispatchEvent(new Event(CHANGE_EVENT));
  };
  return { isGroupOpen, toggleGroup };
}
