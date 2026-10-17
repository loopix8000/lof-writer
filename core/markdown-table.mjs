// 표 시작 여부는 첫 두 줄만으로 결정한다. 남은 원고 전체를 매 문단마다 분리하지 않는다.
export function tableStart(source) {
  const [header, separator] = source.split("\n", 2);
  if (separator === undefined || !/^[ \t|:]*-[ \t|:-]*$/.test(separator) || !separator.includes("|")) return -1;
  return header.includes("|") ? 0 : -1;
}
