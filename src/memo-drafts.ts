// 자동 저장 전까지의 메모 입력을 이 기기에 보관한다. 앱이 저장 없이 꺼져도 다음에 열 때 이어서 쓴다.
type MemoDraft = { body: string; revision: string };

const key = (space: string, path: string) => `lof-memo-draft:${space}\n${path}`;

export function saveMemoDraft(space: string, path: string, body: string, revision: string) {
  try {
    localStorage.setItem(key(space, path), JSON.stringify({ body, revision }));
  } catch {}
}

export function readMemoDraft(space: string, path: string): MemoDraft | null {
  try {
    const raw = localStorage.getItem(key(space, path));
    const draft = raw ? JSON.parse(raw) : null;
    return draft && typeof draft.body === "string" && typeof draft.revision === "string" ? draft : null;
  } catch {
    return null;
  }
}

export function clearMemoDraft(space: string, path: string) {
  try {
    localStorage.removeItem(key(space, path));
  } catch {}
}
