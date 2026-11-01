// 보관 폴더로 옮겨도 문서 트리와 상대 링크는 원래 위치를 기준으로 해석한다.
export function logicalDocumentPath(path?: string): string {
  return (path ?? "").replace(/^archive\/(?=(?:doc|episodes)\/)/, "");
}

export function memoPathInSpace(path?: string): string {
  return logicalDocumentPath(path).replace(/^doc\//, "");
}
