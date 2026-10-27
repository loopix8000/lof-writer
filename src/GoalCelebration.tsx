import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";

const GoalCelebrationContext = createContext({
  celebration: 0,
  widgetCount: 0,
  registerWidget: (): (() => void) => () => {},
});

export const useGoalCelebration = () => useContext(GoalCelebrationContext);

export default function GoalCelebration({ identity, value, goal, children }: {
  identity: string | null;
  value: number | null;
  goal: number;
  children: ReactNode;
}) {
  const previous = useRef<{ identity: string; value: number; celebrated: boolean } | null>(null);
  const sequence = useRef(0);
  const [event, setEvent] = useState<{ identity: string; sequence: number } | null>(null);
  const [widgetCount, setWidgetCount] = useState(0);
  const registerWidget = useCallback(() => {
    setWidgetCount((count) => count + 1);
    return () => setWidgetCount((count) => count - 1);
  }, []);

  useEffect(() => {
    if (!identity || goal <= 0) {
      previous.current = null;
      setEvent(null);
      return;
    }
    if (previous.current?.identity !== identity) {
      previous.current = value === null ? null : { identity, value, celebrated: value >= goal };
      setEvent(null);
      return;
    }
    if (value === null) return;
    if (!previous.current.celebrated && previous.current.value < goal && value >= goal) {
      previous.current.celebrated = true;
      setEvent({ identity, sequence: ++sequence.current });
    }
    previous.current.value = value;
  }, [identity, value, goal]);

  useEffect(() => {
    if (!event) return;
    const timer = window.setTimeout(() => setEvent(null), 2800);
    return () => window.clearTimeout(timer);
  }, [event]);

  const celebration = event?.identity === identity ? event?.sequence ?? 0 : 0;
  const context = useMemo(() => ({ celebration, widgetCount, registerWidget }), [celebration, widgetCount, registerWidget]);
  return <GoalCelebrationContext.Provider value={context}>{children}</GoalCelebrationContext.Provider>;
}

export function GoalCheck({ animate = false }: { animate?: boolean }) {
  const reducedMotion = useReducedMotion();
  return <svg className="goal-check" viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <motion.path d="M4.5 10.5 8 14 15.5 6.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
      initial={animate && !reducedMotion ? { pathLength: 0, opacity: 0 } : false}
      animate={{ pathLength: 1, opacity: 1 }} transition={{ duration: reducedMotion ? 0 : 0.45, delay: 0.12, ease: "easeOut" }} />
  </svg>;
}

export function GoalCelebrationNotice() {
  const { celebration, widgetCount } = useGoalCelebration();
  const reducedMotion = useReducedMotion();
  if (!celebration || widgetCount > 0) return null;
  return <div className="goal-notice-position" role="status">
    <motion.div key={celebration} className="goal-notice"
      initial={{ opacity: 0, y: reducedMotion ? 0 : -4 }}
      animate={{ opacity: [0, 1, 1, 0], y: reducedMotion ? 0 : [-4, 0, 0, 0] }}
      transition={{ duration: 2.7, times: [0, 0.12, 0.82, 1], ease: "easeOut" }}>
      <GoalCheck animate />
      <span>목표 분량 달성</span>
    </motion.div>
  </div>;
}
