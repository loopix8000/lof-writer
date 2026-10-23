import { useEffect, useRef, useState } from "react";
import type { ConfirmOptions } from "../ConfirmDialog";
import type { Doc } from "../types";
import { requiresDocumentSource } from "./model";

export const LARGE_DOCUMENT_CHARS = 100_000;
export type LargeDocumentMode = ReturnType<typeof useLargeDocumentMode>;

const isLarge = (doc: Doc) => doc.body.length > LARGE_DOCUMENT_CHARS && !requiresDocumentSource(doc);

// 10만 자가 넘는 문서는 서식 편집기가 무거우므로 처음 열 때 원문 모드로 열지 묻는다.
// 고른 값은 문서마다 기억해, 편집하다 기준을 넘거나 내려가도 편집기가 바뀌지 않게 한다.
export function useLargeDocumentMode(active: Doc | null, confirm: (options: ConfirmOptions) => Promise<boolean>) {
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  const decided = useRef(new Set<string>());
  const id = active?.id;
  useEffect(() => {
    if (!active || decided.current.has(active.id)) return;
    const docId = active.id;
    decided.current.add(docId);
    if (!isLarge(active)) {
      setChoices(current => docId in current ? current : { ...current, [docId]: false });
      return;
    }
    void confirm({
      title: "큰 문서 열기",
      message: "10만 자가 넘는 문서는 서식 모드에서 편집이 느릴 수 있습니다. 원문 모드로 여시겠습니까?",
      detail: "연 뒤에도 원문 편집 전환으로 바꿀 수 있습니다.",
      confirmLabel: "원문 모드로 열기",
      cancelLabel: "서식 모드로 열기",
    }).then(source => setChoices(current => ({ ...current, [docId]: source })));
  }, [id]);
  return {
    // 고르기 전에는 가벼운 원문 모드로 보여 준다.
    sourceFor: (doc: Doc) => choices[doc.id] ?? isLarge(doc),
    choose: (docId: string, source: boolean) => setChoices(current => ({ ...current, [docId]: source })),
  };
}
