import { useEffect, useState } from "react";
import { firstQuote, noteLink, type NoteMark } from "../note-links";
import { call, type Doc, type Library } from "../types";

export function useDocumentNotes(active: Doc | null, lib: Library) {
  const [noteMarks, setNoteMarks] = useState<Record<string, NoteMark[]>>({});
  // 지금 원고를 출처 링크로 인용한 메모를 찾는다. 다른 플롯·메모가 바뀌면 다시 찾는다.
  const noteScan = active
    ? lib.documents
      .filter((d) => d.projectId === active.projectId && d.kind !== "episode" && d.id !== active.id)
      .map((d) => d.id + d.updatedAt + d.archived)
      .join()
    : "";
  useEffect(() => {
    const id = active?.id,
      projectId = active?.projectId;
    if (!id) return;
    let canceled = false;
    (async () => {
      const found = await call<{ results: { id: string; archived: boolean }[] }>("searchText", {
        query: noteLink(id),
        projectId,
        caseSensitive: true,
      });
      const list: NoteMark[] = [];
      for (const hit of found.results || []) {
        if (hit.id === id || hit.archived) continue;
        const doc = await call<Doc>("readDocument", { id: hit.id });
        const text = firstQuote(doc.body);
        if (text) list.push({ id: doc.id, title: doc.title, text });
      }
      if (!canceled) setNoteMarks((previous) => ({ ...previous, [id]: list }));
    })().catch(() => { });
    return () => {
      canceled = true;
    };
  }, [active?.id, noteScan]);

  return noteMarks;
}
