import { useCallback, useEffect, useState } from "react";

export type EpisodeSort = "asc" | "desc";

const STORAGE_KEY = "lof-mobile-episode-sort";
const CHANGE_EVENT = "lof-episode-sort-change";

function readSort(key: string): EpisodeSort {
  try {
    return localStorage.getItem(key) === "desc" ? "desc" : "asc";
  } catch {
    return "asc";
  }
}

function useSort(storageKey: string, changeEvent: string) {
  const [sort, setSortState] = useState<EpisodeSort>(() => readSort(storageKey));

  useEffect(() => {
    const sync = () => setSortState(readSort(storageKey));
    window.addEventListener(changeEvent, sync);
    return () => window.removeEventListener(changeEvent, sync);
  }, [storageKey, changeEvent]);

  const toggleSort = useCallback(() => {
    const next: EpisodeSort = sort === "asc" ? "desc" : "asc";
    try {
      localStorage.setItem(storageKey, next);
    } catch {}
    setSortState(next);
    window.dispatchEvent(new Event(changeEvent));
  }, [sort, storageKey, changeEvent]);

  return { sort, toggleSort };
}

// 작품 화면과 집필 화면 사이드바가 같은 정렬 방향을 공유한다.
export function useEpisodeSort() {
  return useSort(STORAGE_KEY, CHANGE_EVENT);
}

export function useDocumentSort() {
  return useSort("lof-mobile-document-sort", "lof-document-sort-change");
}

export function compareNames(a: string, b: string, sort: EpisodeSort) {
  return a.localeCompare(b, "ko", { numeric: true }) * (sort === "desc" ? -1 : 1);
}
