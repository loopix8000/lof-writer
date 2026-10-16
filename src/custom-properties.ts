import { parseDocument, stringify } from "yaml";

export type PropertyValue = null | string | number | boolean | PropertyValue[] | { [key: string]: PropertyValue };
export type PropertyPreset = { id: string; name: string; icon: string; value: PropertyValue };
export const ICONS_KEY = "_lofPropertyIcons";
export const PROPERTY_ICONS = [
  "text", "bookmark", "user", "users", "calendar", "clock", "location", "flag",
  "star", "heart", "number", "list", "check", "link", "folder", "idea",
] as const;
const reserved = new Set([
  "lof", "id", "kind", "title", "tags", "manualLineBreak", "episodeId", "archived",
  "createdAt", "updatedAt", "conflictOf", "order", "status", "episodeType", "description",
  "authorComment", ICONS_KEY,
]);
export function propertyNameError(name: string, existing: string[], original?: string) {
  if (!name.trim()) return "속성명을 입력해 주세요.";
  if (reserved.has(name)) return "앱에서 사용하는 속성명입니다. 다른 이름을 입력해 주세요.";
  if (existing.some((key) => key !== original && key === name)) return "이미 있는 속성명입니다.";
  return "";
}
export function propertyIcon(icon: unknown): string {
  return typeof icon === "string" && PROPERTY_ICONS.includes(icon as typeof PROPERTY_ICONS[number]) ? icon : "text";
}
export function propertyIcons(properties: Record<string, unknown>): Record<string, unknown> {
  const icons = properties[ICONS_KEY];
  return icons && typeof icons === "object" && !Array.isArray(icons) ? icons as Record<string, unknown> : {};
}
export function putProperty(properties: Record<string, unknown>, field: PropertyPreset, original?: string) {
  const entries = Object.entries(properties).filter(([key]) => key !== ICONS_KEY);
  const next = Object.fromEntries(entries.map(([key, value]) => key === original ? [field.name, field.value] : [key, value]));
  const icons = Object.fromEntries(Object.entries(propertyIcons(properties)).filter(([key]) => key !== original));
  return { ...next, [field.name]: field.value, [ICONS_KEY]: { ...icons, [field.name]: field.icon } };
}
export function removeProperty(properties: Record<string, unknown>, name: string) {
  const next = Object.fromEntries(Object.entries(properties).filter(([key]) => key !== name && key !== ICONS_KEY));
  const icons = Object.fromEntries(Object.entries(propertyIcons(properties)).filter(([key]) => key !== name));
  return Object.keys(icons).length ? { ...next, [ICONS_KEY]: icons } : next;
}
export function readPropertyValue(raw: string): PropertyValue {
  const doc = parseDocument(raw, { version: "1.2", uniqueKeys: true });
  if (doc.errors.length || doc.warnings.length)
    throw Error("YAML 형식을 확인해 주세요: " + (doc.errors[0] ?? doc.warnings[0]).message);
  const stack = new Set<object>();
  const convert = (value: unknown): PropertyValue => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (!value || typeof value !== "object") throw Error("문자열·숫자·체크·목록·객체·null 값을 사용할 수 있습니다.");
    if (stack.has(value)) throw Error("순환 참조 속성은 사용할 수 없습니다.");
    stack.add(value);
    let result: PropertyValue;
    if (Array.isArray(value)) result = value.map(convert);
    else if (value instanceof Map) {
      const entries: [string, PropertyValue][] = [];
      const keys = new Set<string>();
      for (const [key, child] of value) {
        if (!["string", "number", "boolean"].includes(typeof key)) throw Error("객체의 키는 문자열이나 숫자여야 합니다.");
        const name = String(key);
        if (keys.has(name)) throw Error("중복된 객체 키가 있습니다.");
        keys.add(name);
        entries.push([name, convert(child)]);
      }
      result = Object.fromEntries(entries);
    } else throw Error("지원하지 않는 YAML 값입니다.");
    stack.delete(value);
    return result;
  };
  return convert(doc.toJS({ mapAsMap: true, maxAliasCount: 100 }));
}
export const valueYaml = (value: unknown) => stringify(value ?? null, { lineWidth: 0 }).trimEnd();
export function propertyPresets(raw: unknown): PropertyPreset[] {
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.name !== "string" ||
      propertyNameError(entry.name, names)) return [];
    names.push(entry.name);
    return [{ id: typeof entry.id === "string" ? entry.id : entry.name,
      name: entry.name, icon: propertyIcon(entry.icon), value: Object.hasOwn(entry, "value") ? entry.value : "" }];
  });
}
export function favoriteTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim().replace(/^#+/, ""))
    .filter((tag) => {
      const key = tag.toUpperCase();
      if (!tag || seen.has(key) || tag.length > 40) return false;
      seen.add(key);
      return true;
    });
}
