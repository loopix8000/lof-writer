import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { call, type WritingRules } from "./types";
import { addCounts, type ManuscriptCounts } from "./manuscript-counts";
import { createValueStore } from "./value-store";

type Model = {
  scope: string; id: string; rulesKey: string; rules: WritingRules; body: string; initialBody: string; sequence: number;
  stats: ManuscriptCounts | null; sent: number; exact: boolean; changedAt: number; pendingSince: number;
  changes: { sequence: number; delta: ManuscriptCounts | null }[];
};

export function useManuscriptCounts({ scope, id, body, rules, onBaseline, onError }: {
  scope: string; id?: string; body: string | null; rules: WritingRules;
  onBaseline: (scope: string, id: string, count: number) => void; onError: (error: unknown) => void;
}) {
  const [statsStore] = useState(() => createValueStore<ManuscriptCounts | null>(null));
  const current = useRef<Model | null>(null);
  const worker = useRef<Worker | null>(null);
  const busy = useRef(false);
  const callbacks = useRef({ onBaseline, onError });
  callbacks.current = { onBaseline, onError };
  const rulesKey = JSON.stringify(rules);
  const model = current.current;
  if (!id || body === null) current.current = null;
  else if (!model || model.scope !== scope || model.id !== id || model.rulesKey !== rulesKey) {
    current.current = { scope, id, body, initialBody: body, rules, rulesKey, sequence: 0, stats: null, sent: -1,
      exact: false, changedAt: Date.now(), pendingSince: Date.now(), changes: [] };
  } else if (model.body !== body) {
    // 외부 수정·원문 모드의 변경도 순서를 올려 이전 결과가 덮어쓰지 못하게 한다.
    model.body = body; model.sequence++; model.changes.push({ sequence: model.sequence, delta: null });
    model.exact = false; model.changedAt = Date.now(); model.pendingSince ||= model.changedAt;
  }
  const pump = useRef<() => void>(() => {});
  const schedule = useRef<() => void>(() => {});
  useEffect(() => {
    let instance: Worker;
    try { instance = new Worker(new URL("./counts-worker.ts", import.meta.url), { type: "module" }); }
    catch (error) { callbacks.current.onError(error); return; }
    worker.current = instance;
    if (current.current) current.current.sent = -1;
    let disposed = false;
    let job: { model: Model; sequence: number } | null = null;
    let idle: ReturnType<typeof setTimeout> | null = null;
    pump.current = () => {
      const target = current.current;
      if (disposed || busy.current || !target || target.sent === target.sequence) return;
      busy.current = true;
      const first = target.sent < 0 && target.stats === null;
      target.sent = first ? 0 : target.sequence;
      target.pendingSince = first && target.sequence > 0 ? target.pendingSince : 0;
      job = { model: target, sequence: target.sent };
      instance.postMessage({ sequence: target.sent, body: first ? target.initialBody : target.body });
    };
    schedule.current = () => {
      if (idle) clearTimeout(idle);
      idle = null;
      const target = current.current;
      if (!target || target.sent === target.sequence || busy.current) return;
      if (target.sent < 0) { pump.current(); return; }
      // 주석·구조 변경도 같은 제한을 적용한다. 연속 입력은 최대 2초마다 최신 한 건만 보낸다.
      const due = Math.min(target.changedAt + 700, (target.pendingSince || target.changedAt) + 2_000);
      idle = setTimeout(() => { idle = null; pump.current(); }, Math.max(0, due - Date.now()));
    };
    instance.onmessage = async (event: MessageEvent<{ sequence: number; text?: string; error?: string }>) => {
      const pending = job;
      if (!pending || disposed || event.data.sequence !== pending.sequence) return;
      try {
        if (current.current !== pending.model) return;
        if (event.data.error) throw Error(event.data.error);
        const stats = await call<ManuscriptCounts>("countManuscript", { text: event.data.text ?? "", rules: pending.model.rules });
        if (disposed) return;
        if (pending.sequence === 0) callbacks.current.onBaseline(pending.model.scope, pending.model.id, stats.utf16WithoutSpaces);
        if (current.current === pending.model) {
          const later = pending.model.changes.filter(change => change.sequence > pending.sequence);
          // 계산 중 입력한 문단 증감을 더하면 연속 입력 중에도 최신 카운트를 유지할 수 있다.
          pending.model.exact = later.every(change => change.delta !== null);
          const next = pending.model.exact ? later.reduce((sum, change) => addCounts(sum, change.delta!), stats) : stats;
          const previous = pending.model.stats;
          pending.model.stats = next;
          if (!previous || (Object.keys(next) as (keyof ManuscriptCounts)[]).some(key => previous[key] !== next[key]))
            statsStore.set(next);
          pending.model.changes = later;
        }
      } catch (error) { if (!disposed) callbacks.current.onError(error); }
      finally {
        if (!disposed) { job = null; busy.current = false; schedule.current(); }
      }
    };
    instance.onerror = event => {
      if (!disposed) { busy.current = false; callbacks.current.onError(Error(event.message || "글자 수 계산 작업을 시작하지 못했습니다.")); }
    };
    pump.current();
    return () => {
      disposed = true; if (idle) clearTimeout(idle);
      instance.terminate(); worker.current = null; busy.current = false;
    };
  }, []);
  useLayoutEffect(() => { statsStore.set(current.current?.stats ?? null); schedule.current(); }, [scope, id, body, rulesKey]);
  const update = useCallback((nextBody: string, delta?: ManuscriptCounts | null) => {
    const target = current.current;
    if (!target || target.body === nextBody) return;
    target.body = nextBody; target.sequence++;
    target.changedAt = Date.now(); target.pendingSince ||= target.changedAt;
    target.changes.push({ sequence: target.sequence, delta: delta ?? null });
    if (target.stats && delta && target.exact) {
      target.stats = addCounts(target.stats, delta);
      statsStore.set(target.stats);
    } else target.exact = false;
    schedule.current();
  }, [statsStore]);
  return { statsStore, update };
}
