import { useCallback, useEffect, useState } from "react";

export type EpisodeSort = "asc" | "desc";

const STORAGE_KEY = "lof-mobile-episode-sort";
const CHANGE_EVENT = "lof-episode-sort-change";

function readSort(): EpisodeSort {
  try {
    return localStorage.getItem(STORAGE_KEY) === "desc" ? "desc" : "asc";
  } catch {
    return "asc";
  }
}

// 작품 화면과 집필 화면 사이드바가 같은 에피소드 정렬 방향을 공유한다.
export function useEpisodeSort() {
  const [sort, setSortState] = useState<EpisodeSort>(readSort);

  useEffect(() => {
    const sync = () => setSortState(readSort());
    window.addEventListener(CHANGE_EVENT, sync);
    return () => window.removeEventListener(CHANGE_EVENT, sync);
  }, []);

  const toggleSort = useCallback(() => {
    const next: EpisodeSort = readSort() === "asc" ? "desc" : "asc";
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {}
    setSortState(next);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  return { sort, toggleSort };
}
