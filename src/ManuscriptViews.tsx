import type { ComponentProps } from "react";
import { countForRule } from "../core/text.mjs";
import { writingName } from "../core/platforms.mjs";
import type { ManuscriptCounts } from "./manuscript-counts";
import type { Doc, WritingRules } from "./types";
import { useStoreValue, type ValueStore } from "./value-store";
import PlatformCount from "./PlatformCount";
import MobilePreview from "./MobilePreview";

type CountsStore = ValueStore<ManuscriptCounts | null>;

export function ManuscriptCountSummary({ store, cursor, kind, rules }: {
  store: CountsStore; cursor: ValueStore<number | null>; kind: string; rules: WritingRules;
}) {
  const stats = useStoreValue(store), line = useStoreValue(cursor);
  const unit = kind === "episode" ? rules.unit : "utf16";
  return <span>
    {kind === "episode"
      ? <>{writingName(rules)} {stats ? stats.platformCharacters.toLocaleString() : "…"}자</>
      : <>공백 제외 {stats ? countForRule(stats, "noSpace", unit).toLocaleString() : "…"}자</>}
    <i /> 공백 포함 {stats ? countForRule(stats, "spaces", unit).toLocaleString() : "…"}자
    {line !== null && <><i /> {line.toLocaleString()}번째 줄</>}
  </span>;
}

export function ManuscriptPlatformCount({ store, ...props }: Omit<ComponentProps<typeof PlatformCount>, "stats"> & { store: CountsStore }) {
  return <PlatformCount {...props} stats={useStoreValue(store)} />;
}

export function ManuscriptSessionCount({ store, id, kind, sessionDelta }: {
  store: CountsStore; id: string; kind: string; sessionDelta: (id: string, count: number) => number;
}) {
  const stats = useStoreValue(store);
  const count = stats ? sessionDelta(id, stats.utf16WithoutSpaces) : 0;
  return <section className="widget session-widget">
    <span>{kind === "episode" ? "이번 회차에서 새로 쓴 글" : "이번 문서에서 새로 쓴 글"}</span>
    <strong>+{count.toLocaleString()}<small>자</small></strong>
  </section>;
}

export function ManuscriptPreview({ store, documentId, ...props }: ComponentProps<typeof MobilePreview> & {
  store: ValueStore<Doc | null>; documentId: string;
}) {
  const doc = useStoreValue(store);
  return <MobilePreview {...props} body={doc?.id === documentId ? doc.body : props.body} />;
}
