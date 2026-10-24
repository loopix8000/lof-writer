export type MemoEntry = {
  path: string;
  name: string;
  type: "file" | "folder";
  updatedAt?: string;
  kind?: "plot" | "memo";
  episodeId?: string;
  archived?: boolean;
};

// 다른 보기에 있는 부모 폴더도 표시할 하위 항목에 접근할 수 있도록 남긴다.
export function memoEntriesInView(entries: MemoEntry[], archived: boolean): MemoEntry[] {
  const paths = new Set(entries.filter(entry => !!entry.archived === archived).map(entry => entry.path));
  for (const path of [...paths]) {
    let parent = path;
    while (parent.includes("/")) {
      parent = parent.slice(0, parent.lastIndexOf("/"));
      paths.add(parent);
    }
  }
  return entries.filter(entry => paths.has(entry.path));
}
