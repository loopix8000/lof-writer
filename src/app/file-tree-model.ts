import type { ReactNode } from "react";
import type { Doc } from "../types";

export const EPISODE_GROUP = 20;
// 설정에서 고를 수 있는 회차 묶음 크기. 0은 묶지 않음이다.
export const EPISODE_GROUP_OPTIONS = [0, 10, 20, 30, 50, 100] as const;
// 저장된 설정값을 묶음 크기로 바꾼다. 묶지 않음은 목록 길이와 상관없이 묶이지 않도록 무한대로 둔다.
export const episodeGroupSize = (value: unknown) => {
  if (value === 0) return Infinity;
  return (EPISODE_GROUP_OPTIONS as readonly unknown[]).includes(value) ? (value as number) : EPISODE_GROUP;
};
export const treeMatch = (text: string, query: string) => text.toLowerCase().includes(query.trim().toLowerCase());
export const episodeNumber = (doc: Doc) => /^episodes\/(\d+)/.exec(doc.relPath || "")?.[1] ?? "";
export const parentOfRel = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
export type FolderEntry = { path: string; name: string; type: string; archived?: boolean };
export type TreeRowOptions = { depth?: number; badge?: string; dropFolder?: string };
export type RenderTreeRow = (doc: Doc, marker: ReactNode, options?: TreeRowOptions) => ReactNode;
