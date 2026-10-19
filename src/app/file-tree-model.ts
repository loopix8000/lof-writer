import type { ReactNode } from "react";
import type { Doc } from "../types";

export const EPISODE_GROUP = 20;
export const treeMatch = (text: string, query: string) => text.toLowerCase().includes(query.trim().toLowerCase());
export const episodeNumber = (doc: Doc) => /^episodes\/(\d+)/.exec(doc.relPath || "")?.[1] ?? "";
export const parentOfRel = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
export type FolderEntry = { path: string; name: string; type: string; archived?: boolean };
export type TreeRowOptions = { depth?: number; badge?: string; dropFolder?: string };
export type RenderTreeRow = (doc: Doc, marker: ReactNode, options?: TreeRowOptions) => ReactNode;
