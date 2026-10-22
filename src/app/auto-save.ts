// 원고와 메모가 함께 쓰는 자동 저장 조건.
// 설정한 주기가 지나고 마지막 저장 뒤 바뀐 글자 수가 최소 글자 수 이상일 때만 자동 저장한다.

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
function codePoints(text: string, from: number, to: number) {
  let count = 0;
  for (let i = from; i < to; i++) {
    if (isHighSurrogate(text.charCodeAt(i)) && i + 1 < to && isLowSurrogate(text.charCodeAt(i + 1))) i++;
    count++;
  }
  return count;
}
// 앞뒤로 같은 부분을 뺀 가운데 구간의 글자(코드 포인트) 수. 긴 원고에서도 글자 배열을 만들지 않도록
// 같은 구간은 큰 묶음으로 비교해 건너뛰고, 서로게이트 쌍은 쪼개지 않는다.
const SKIP = 4096;
export function changedChars(before: string, after: string): number {
  if (before === after) return 0;
  const min = Math.min(before.length, after.length);
  let pre = 0;
  while (pre + SKIP <= min && before.slice(pre, pre + SKIP) === after.slice(pre, pre + SKIP)) pre += SKIP;
  while (pre < min && before.charCodeAt(pre) === after.charCodeAt(pre)) pre++;
  if (pre > 0 && pre < min && isHighSurrogate(before.charCodeAt(pre - 1))) pre--;
  let endA = before.length, endB = after.length;
  while (endA - SKIP >= pre && endB - SKIP >= pre && before.slice(endA - SKIP, endA) === after.slice(endB - SKIP, endB)) {
    endA -= SKIP;
    endB -= SKIP;
  }
  while (endA > pre && endB > pre && before.charCodeAt(endA - 1) === after.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  if (endA < before.length && endA > pre && isLowSurrogate(before.charCodeAt(endA))) {
    endA++;
    endB++;
  }
  return Math.max(codePoints(before, pre, endA), codePoints(after, pre, endB));
}

export function autoSaveCondition(
  prefs: Record<string, any> | undefined,
  savedBody: string,
  body: string,
  lastSavedAt: number,
) {
  const maxMinutes = Math.max(1, Number(prefs?.historyMaxMinutes ?? 1));
  const minChars = Math.max(0, Number(prefs?.historyMinChars ?? 200));
  const intervalMs = maxMinutes * 60_000;
  const elapsed = Date.now() - lastSavedAt;
  const chars = changedChars(savedBody, body);
  return {
    intervalMs,
    elapsed,
    chars,
    minChars,
    // 글자 수를 채웠을 때 남은 주기만큼 기다린 뒤 다시 확인한다.
    delay: Math.max(650, intervalMs - elapsed),
    met: chars >= minChars && elapsed >= intervalMs,
  };
}
