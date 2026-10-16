import { hash, fail } from "./store.mjs";
export function normalizeTags(value = []) {
  if (!Array.isArray(value) || value.some((t) => typeof t !== "string"))
    throw fail("태그는 문자열 목록이어야 합니다.");
  const tags = [
    ...new Set(
      value
        .map((t) => t.normalize("NFC").trim().replace(/^#+/, ""))
        .filter(Boolean),
    ),
  ];
  if (
    tags.length > 30 ||
    tags.some((t) => t.length > 40 || /[\r\n\u0000]/.test(t))
  )
    throw fail("태그는 30개까지, 각 40자까지 입력할 수 있습니다.");
  return tags;
}
export const validCover = (name) =>
  typeof name === "string" && /^cover-[a-f0-9]{64}\.png$/.test(name);
export function validateCover(data, name) {
  if (
    !Buffer.isBuffer(data) ||
    data.length > 8_000_000 ||
    !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw fail("표지는 8MB 이하의 PNG여야 합니다.");
  const filename = `cover-${hash(data)}.png`;
  if (name && name !== filename) throw fail("표지 체크섬이 일치하지 않습니다.");
  return filename;
}
