// 앱 검색은 검색어를 정규식으로 해석한다. 검색 결과를 편집기에서 열 때도 같은 규칙으로 위치를 찾는다.
// 정규식으로 올바르지 않은 검색어는 입력한 글자 그대로 찾는다.
export function searchPattern(query: string, caseSensitive?: boolean): RegExp {
  const flags = caseSensitive ? "gu" : "giu";
  try {
    return new RegExp(query, flags);
  } catch {
    return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  }
}

// 한 줄(문단)에서 길이가 있는 일치만 위치로 돌려준다.
export function searchLine(line: string, pattern: RegExp): [number, number][] {
  const hits: [number, number][] = [];
  for (const match of line.matchAll(pattern)) {
    if (match[0]) hits.push([match.index!, match.index! + match[0].length]);
  }
  return hits;
}
