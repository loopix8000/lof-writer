import { useEffect, useReducer, useRef, useState } from "react";
import { createSplitController, type SplitHost } from "./controller";

// 화면마다 하나씩 쓰는 분할 그룹 훅. 동작 함수는 렌더가 바뀌어도 같은 함수를 유지한다.
export function useSplitGroups<T>(host: SplitHost<T>) {
  const hostRef = useRef(host); hostRef.current = host;
  const [, render] = useReducer((n: number) => n + 1, 0);
  const [controller] = useState(() => createSplitController<T>(() => hostRef.current, render));
  useEffect(() => controller.dispose, [controller]);
  return { ...controller, ...controller.view() };
}
export type SplitGroupsApi<T> = ReturnType<typeof useSplitGroups<T>>;
