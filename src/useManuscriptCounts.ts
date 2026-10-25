import { useCallback, useEffect, useRef, useState } from "react";
import { call, type WritingRules } from "./types";
import { addCounts, type ManuscriptCounts } from "./manuscript-counts";

type Model = {
  scope: string; id: string; rulesKey: string; rules: WritingRules; body: string; initialBody: string; sequence: number;
  stats: ManuscriptCounts | null; sent: number;
  changes: { sequence: number; delta: ManuscriptCounts | null }[];
};

export function useManuscriptCounts({ scope, id, body, rules, onBaseline, onError }: {
  scope: string; id?: string; body: string | null; rules: WritingRules;
  onBaseline: (scope: string, id: string, count: number) => void; onError: (error: unknown) => void;
}) {
  const [, redraw] = useState(0);
  const current = useRef<Model | null>(null);
  const worker = useRef<Worker | null>(null);
  const busy = useRef(false);
  const callbacks = useRef({ onBaseline, onError });
  callbacks.current = { onBaseline, onError };
  const rulesKey = JSON.stringify(rules);
  const model = current.current;
  if (!id || body === null) current.current = null;
  else if (!model || model.scope !== scope || model.id !== id || model.rulesKey !== rulesKey) {
    current.current = { scope, id, body, initialBody: body, rules, rulesKey, sequence: 0, stats: null, sent: -1, changes: [] };
  } else if (model.body !== body) {
    // 외부 수정·원문 모드의 변경도 순서를 올려 이전 결과가 덮어쓰지 못하게 한다.
    model.body = body; model.sequence++; model.changes.push({ sequence: model.sequence, delta: null });
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
      job = { model: target, sequence: target.sent };
      instance.postMessage({ sequence: target.sent, body: first ? target.initialBody : target.body });
    };
    schedule.current = () => {
      if (idle) clearTimeout(idle);
      idle = null;
      const target = current.current, last = target?.changes[target.changes.length - 1];
      // 문단 증감으로 이미 맞춘 입력이면 원고 전체 계산은 입력이 잠시 멈춘 뒤에 한 번만 한다.
      if (target?.stats && last?.delta && last.sequence === target.sequence)
        idle = setTimeout(() => { idle = null; pump.current(); }, 700);
      else pump.current();
    };
    instance.onmessage = async (event: MessageEvent<{ sequence: number; text?: string; error?: string }>) => {
      const pending = job;
      if (!pending || disposed || event.data.sequence !== pending.sequence) return;
      try {
        if (event.data.error) throw Error(event.data.error);
        const stats = await call<ManuscriptCounts>("countManuscript", { text: event.data.text ?? "", rules: pending.model.rules });
        if (disposed) return;
        if (pending.sequence === 0) callbacks.current.onBaseline(pending.model.scope, pending.model.id, stats.utf16WithoutSpaces);
        if (current.current === pending.model) {
          const later = pending.model.changes.filter(change => change.sequence > pending.sequence);
          // 계산 중 입력한 문단 증감을 더하면 연속 입력 중에도 최신 카운트를 유지할 수 있다.
          if (later.every(change => change.delta !== null)) {
            const next = later.reduce((sum, change) => addCounts(sum, change.delta!, pending.model.rules), stats);
            const previous = pending.model.stats;
            pending.model.stats = next;
            // 즉시 반영한 증감과 같은 결과이면 큰 편집 화면을 다시 커밋하지 않는다.
            if (!previous || (Object.keys(next) as (keyof ManuscriptCounts)[]).some(key => previous[key] !== next[key]))
              redraw(value => value + 1);
          }
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
  useEffect(() => { schedule.current(); }, [scope, id, body, rulesKey]);
  const update = useCallback((nextBody: string, delta?: ManuscriptCounts | null) => {
    const target = current.current;
    if (!target || target.body === nextBody) return;
    target.body = nextBody; target.sequence++;
    target.changes.push({ sequence: target.sequence, delta: delta ?? null });
    if (target.stats && delta) target.stats = addCounts(target.stats, delta, target.rules);
    // 화면은 따로 그리지 않는다. 같은 입력으로 바뀐 본문이 화면에 반영될 때 새 카운트도 함께 보인다.
  }, []);
  return { stats: current.current?.stats ?? null, update };
}
