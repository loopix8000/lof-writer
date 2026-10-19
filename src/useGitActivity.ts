import { useCallback, useEffect, useRef } from "react";
import { call } from "./types";

// 자동 저장의 빈도와 무관하게 실제 입력이 끝나고 저장이 완료될 때까지 Git 기록을 미룬다.
export function useGitActivity(flush: () => Promise<boolean>, report: (error: any) => void) {
  const latest = useRef({ flush, report }); latest.current = { flush, report };
  const state = useRef({ client: crypto.randomUUID(), sequence: 0, generation: 0,
    active: false, mounted: true, timer: undefined as number | undefined, chain: Promise.resolve() });
  const send = useCallback((active: boolean) => {
    if (typeof window.lof.gitEditing !== "function") return;
    const current = state.current;
    const args = { client: current.client, sequence: ++current.sequence, active };
    current.chain = current.chain.then(async () => { await call("gitEditing", args); })
      .catch((error) => { if (current.mounted) latest.current.report(error); });
  }, []);
  const touch = useCallback(() => {
    const current = state.current;
    if (!current.active) { current.active = true; send(true); }
    const generation = ++current.generation;
    clearTimeout(current.timer);
    const finish = async () => {
      if (!current.mounted || current.generation !== generation) return;
      try {
        const saved = await latest.current.flush();
        if (!current.mounted || current.generation !== generation) return;
        if (!saved) { current.timer = window.setTimeout(() => void finish(), 10_000); return; }
        current.active = false;
        send(false);
      } catch (error) {
        if (!current.mounted || current.generation !== generation) return;
        latest.current.report(error);
        current.timer = window.setTimeout(() => void finish(), 10_000);
      }
    };
    current.timer = window.setTimeout(() => void finish(), 10_000);
  }, [send]);
  useEffect(() => {
    const current = state.current;
    current.mounted = true;
    const heartbeat = window.setInterval(() => { if (current.active) send(true); }, 15_000);
    return () => {
      current.mounted = false;
      current.active = false;
      clearTimeout(current.timer);
      clearInterval(heartbeat);
      send(false);
    };
  }, [send]);
  return touch;
}
