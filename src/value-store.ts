import { useSyncExternalStore } from "react";

export type ValueStore<T> = {
  getSnapshot: () => T;
  subscribe: (listener: () => void) => () => void;
  set: (value: T) => void;
};

// 입력으로 바뀌는 값은 사용하는 화면 조각에만 알린다.
export function createValueStore<T>(initial: T): ValueStore<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set(next) {
      if (Object.is(value, next)) return;
      value = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

export function useStoreValue<T>(store: ValueStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
