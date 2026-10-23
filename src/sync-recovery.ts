import { call } from "./types";

export const saveRecoveryCopy = (document: { body: string }) => call<void>("saveRecoveryCopy", { document });

type Resolution = {
  status: "resolved" | "cancelled" | "failed";
  recoverySaved: boolean;
  error?: unknown;
};

// 화면별로 원고를 읽고 적용하는 방법만 다르고 재시도와 최종 보관 규칙은 같다.
export async function resolveSyncedFile<Snapshot, File>(options: {
  current: () => Snapshot | null;
  unchanged: (snapshot: Snapshot) => boolean;
  adopt: (snapshot: Snapshot, discard: boolean) => Promise<File>;
  apply: (file: File) => Promise<boolean>;
  preserve: (snapshot: Snapshot) => Promise<void>;
}, discard = false): Promise<Resolution> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = options.current();
    if (!snapshot) return { status: "cancelled", recoverySaved: false };
    try {
      const fresh = await options.adopt(snapshot, discard);
      if (!options.unchanged(snapshot)) { discard = false; continue; }
      if (await options.apply(fresh)) return { status: "resolved", recoverySaved: false };
    } catch {
      // 실패한 문서만 재시도하고, 한도를 넘으면 별도 사본을 확보한다.
    }
  }
  const snapshot = options.current();
  if (!snapshot) return { status: "cancelled", recoverySaved: false };
  let recoverySaved = false;
  try {
    await options.preserve(snapshot);
    recoverySaved = true;
    const fresh = await options.adopt(snapshot, true);
    if (!options.unchanged(snapshot)) throw Error("입력이 계속되고 있습니다. 잠시 뒤 다시 시도해 주세요.");
    if (await options.apply(fresh)) return { status: "resolved", recoverySaved };
    throw Error("최신본이 다시 변경되었습니다. 다시 시도해 주세요.");
  } catch (error) {
    return { status: "failed", recoverySaved, error };
  }
}
