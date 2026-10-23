import { useEffect, useRef } from "react";
import type { ConfirmOptions } from "../ConfirmDialog";
import type { DaemonUpdateNotice } from "../types";

export function useDaemonUpdateNotice(
  loaded: boolean,
  updates: DaemonUpdateNotice[] | undefined,
  confirm: (options: ConfirmOptions) => Promise<boolean>,
  openGroup: () => Promise<void>,
  report: (error: unknown) => void,
) {
  const shown = useRef(new Set<string>());
  const actions = useRef({ openGroup, report });
  actions.current = { openGroup, report };
  useEffect(() => {
    const show = () => {
      if (!loaded || document.hidden || document.documentElement.dataset.pinLocked === "true") return;
      const pending = updates?.filter(peer => !shown.current.has(peer.id));
      if (!pending?.length) return;
      for (const peer of pending) shown.current.add(peer.id);
      void confirm({
        title: "동기화 데몬 업데이트",
        message: `${pending.map(peer => peer.name).join(", ")}의 Lof Library가 구버전입니다. 해당 기기의 데몬을 최신 버전으로 업데이트해 주세요.`,
        detail: "지금도 동기화할 수 있지만, 데이터 사용량을 줄이려면 데몬 업데이트가 필요합니다.",
        confirmLabel: "동기화 그룹 열기",
        cancelLabel: "나중에",
      }).then(open => { if (open) return actions.current.openGroup(); }).catch(error => actions.current.report(error));
    };
    show();
    document.addEventListener("visibilitychange", show);
    // 잠금을 풀 때도 안내한다. 잠금 화면은 해제 시 resize 이벤트를 보낸다.
    window.addEventListener("resize", show);
    return () => {
      document.removeEventListener("visibilitychange", show);
      window.removeEventListener("resize", show);
    };
  }, [loaded, updates, confirm]);
}
