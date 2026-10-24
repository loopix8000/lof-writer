import { useCallback, useEffect, useState } from "react";
import { call, type Doc, type Library } from "./types";

const emptyIds = new Set<string>();

export default function useDocumentSearch(query: string, projectId: string, lib: Library, enabled = true) {
  const q = query.trim().toLowerCase();
  const key = JSON.stringify([lib.root, projectId, q]);
  const contentSearch = enabled && !!projectId && !!q && !q.startsWith("#");
  const [result, setResult] = useState({ key: "", ids: emptyIds, pending: false, error: "" });

  useEffect(() => {
    if (!contentSearch) return;
    let canceled = false;
    setResult(previous => ({ ...previous, pending: true, error: "" }));
    const timer = window.setTimeout(() => {
      call<string[]>("searchDocumentIds", { query: q, projectId })
        .then(ids => {
          if (!canceled) setResult({ key, ids: new Set(ids), pending: false, error: "" });
        })
        .catch(() => {
          if (!canceled) setResult({ key, ids: emptyIds, pending: false, error: "본문 검색을 완료하지 못했습니다. 검색어를 다시 입력해 주세요." });
        });
    }, 180);
    return () => {
      canceled = true;
      window.clearTimeout(timer);
    };
  }, [contentSearch, key, q, projectId, lib]);

  const ids = contentSearch && result.key === key ? result.ids : emptyIds;
  const matches = useCallback((doc: Doc, number: string | number = "") => {
    if (!q) return true;
    const tags = doc.tags ?? [];
    if (q.startsWith("#")) {
      const tagQuery = q.replace(/^#+/, "");
      return !!tagQuery && tags.some(tag => tag.toLowerCase().includes(tagQuery));
    }
    return [String(number), doc.title, doc.relPath, ...tags, doc.body]
      .some(text => text?.toLowerCase().includes(q)) || ids.has(doc.id);
  }, [q, ids]);

  return {
    matches,
    pending: contentSearch && (result.key !== key || result.pending),
    error: contentSearch && result.key === key ? result.error : "",
  };
}
