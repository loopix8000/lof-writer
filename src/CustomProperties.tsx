import { useEffect, useRef, useState } from "react";
import {
  AlignLeft, Bookmark, User, Users, Calendar, Clock, MapPin, Flag, Star, Heart,
  Hash, List, Check, Link2, Folder, Lightbulb, Pencil, Plus, X,
} from "lucide-react";
import type { MenuItem } from "./ContextMenu";
import {
  ICONS_KEY, PROPERTY_ICONS, propertyIcon, propertyIcons, propertyNameError, propertyPresets,
  putProperty, removeProperty, readPropertyValue, valueYaml, type PropertyPreset, type PropertyValue,
} from "./custom-properties";

const ICONS = {
  text: { icon: AlignLeft, label: "텍스트" }, bookmark: { icon: Bookmark, label: "책갈피" },
  user: { icon: User, label: "사람" }, users: { icon: Users, label: "인물들" },
  calendar: { icon: Calendar, label: "달력" }, clock: { icon: Clock, label: "시간" },
  location: { icon: MapPin, label: "장소" }, flag: { icon: Flag, label: "깃발" },
  star: { icon: Star, label: "별" }, heart: { icon: Heart, label: "마음" },
  number: { icon: Hash, label: "숫자" }, list: { icon: List, label: "목록" },
  check: { icon: Check, label: "체크" }, link: { icon: Link2, label: "연결" },
  folder: { icon: Folder, label: "폴더" }, idea: { icon: Lightbulb, label: "아이디어" },
};
export function PropertyIcon({ name }: { name: unknown }) {
  const Icon = ICONS[propertyIcon(name) as keyof typeof ICONS].icon;
  return <Icon size={14} />;
}
type ValueType = "text" | "number" | "boolean" | "yaml";
const valueType = (value: unknown): ValueType =>
  typeof value === "string" ? "text" : typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "yaml";
const preview = (value: unknown) => typeof value === "string" ? value || "비어 있음"
  : typeof value === "boolean" ? value ? "체크됨" : "체크 안 됨" : valueYaml(value);

export function PropertyForm({ initial, existing, original, onSave, onCancel, saveLabel = "추가" }: {
  initial?: PropertyPreset; existing: string[]; original?: string;
  onSave: (field: PropertyPreset) => void | Promise<void>; onCancel: () => void; saveLabel?: string;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [icon, setIcon] = useState(initial?.icon ?? "text");
  const initialValue = initial ? initial.value : "";
  const [kind, setKind] = useState<ValueType>(valueType(initialValue));
  const [raw, setRaw] = useState(typeof initialValue === "string" ? initialValue : valueYaml(initialValue));
  const [checked, setChecked] = useState(initial?.value === true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function save() {
    const nextName = name.trim();
    const problem = propertyNameError(nextName, existing, original);
    if (problem) { setError(problem); return; }
    try {
      let value: PropertyValue = raw;
      if (kind === "boolean") value = checked;
      if (kind === "number") {
        if (!raw.trim() || !Number.isFinite(Number(raw))) throw Error("유효한 숫자를 입력해 주세요.");
        value = Number(raw);
      }
      if (kind === "yaml") value = readPropertyValue(raw);
      setSaving(true);
      await onSave({ id: initial?.id ?? crypto.randomUUID(), name: nextName, icon, value });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }
  return <div className="custom-property-form" role="group" aria-label={original ? `${original} 속성 편집` : "새 사용자 속성"}>
    <label>속성명<input autoFocus aria-label="사용자 속성명" value={name} onChange={(e) => { setName(e.target.value); setError(""); }} /></label>
    <div className="property-icon-picker" role="group" aria-label="속성 아이콘">
      {PROPERTY_ICONS.map((id) => {
        const Icon = ICONS[id].icon;
        return <button key={id} type="button" aria-label={`${ICONS[id].label} 아이콘`} aria-pressed={icon === id}
          onClick={() => setIcon(id)}><Icon size={16} /></button>;
      })}
    </div>
    <label>값 형식<select aria-label="속성 값 형식" value={kind} onChange={(e) => {
      const next = e.target.value as ValueType;
      setKind(next); setRaw(next === "number" ? "0" : next === "yaml" ? "[]" : ""); setChecked(false); setError("");
    }}>
      <option value="text">텍스트</option><option value="number">숫자</option>
      <option value="boolean">체크</option><option value="yaml">YAML (목록·객체·null)</option>
    </select></label>
    {kind === "boolean" ? <label className="custom-property-check"><input type="checkbox" checked={checked}
      onChange={(e) => setChecked(e.target.checked)} />{original ? "값 체크" : "기본값 체크"}</label>
      : <label>{original ? "값" : "기본값"}{kind === "number"
        ? <input aria-label="속성 값" type="number" step="any" value={raw} onChange={(e) => { setRaw(e.target.value); setError(""); }} />
        : <textarea aria-label="속성 값" rows={kind === "yaml" ? 5 : 2} className={kind === "yaml" ? "yaml-value" : ""}
          value={raw} onChange={(e) => { setRaw(e.target.value); setError(""); }} />}</label>}
    {error && <p role="alert" className="input-error">{error}</p>}
    <div className="row gap"><button type="button" disabled={saving} onClick={onCancel}>취소</button>
      <button type="button" disabled={saving} className="primary" onClick={save}>{saveLabel}</button></div>
  </div>;
}

export default function CustomProperties({ properties = {}, presets, readOnly, builtinItems, onChange, onMenu, onNotice }: {
  properties?: Record<string, unknown>; presets?: unknown; readOnly: boolean; builtinItems: MenuItem[];
  onChange: (properties: Record<string, unknown>) => void;
  onMenu: (rect: DOMRect, items: MenuItem[]) => void;
  onNotice: (text: string, action?: { label: string; run: () => void }) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const latest = useRef({ properties, onChange, readOnly });
  latest.current = { properties, onChange, readOnly };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const entries = Object.entries(properties).filter(([key]) => key !== ICONS_KEY);
  const icons = propertyIcons(properties);
  const names = entries.map(([key]) => key);
  const presetsToAdd = propertyPresets(presets).filter((field) => !Object.hasOwn(properties, field.name));
  const current = editing !== null && editing !== "" && Object.hasOwn(properties, editing)
    ? { id: editing, name: editing, icon: propertyIcon(icons[editing]), value: properties[editing] as PropertyValue } : undefined;
  const remove = (name: string) => {
    onChange(removeProperty(properties, name));
    if (editing === name) setEditing(null);
    onNotice(`${name} 속성을 제거했어요.`, { label: "실행 취소", run: () => {
      if (!mounted.current || latest.current.readOnly) return;
      latest.current.onChange(putProperty(latest.current.properties, {
        id: name, name, icon: propertyIcon(icons[name]), value: properties[name] as PropertyValue,
      }));
    } });
  };
  return <>
    {entries.map(([name, value]) => <div key={name} className="property-row custom-property-row full" role="group" aria-label={name}>
      <div className="property-label"><PropertyIcon name={icons[name]} /><span>{name}</span></div>
      <div className="property-control">{!readOnly && typeof value === "boolean"
        ? <input type="checkbox" aria-label={`${name} 값`} checked={value} onChange={(e) =>
          onChange({ ...properties, [name]: e.target.checked })} />
        : readOnly ? <span className="custom-property-value">{preview(value)}</span>
          : <button type="button" className="custom-property-value" aria-label={`${name} 값 수정`}
            onClick={() => setEditing(name)}>{preview(value)}</button>}</div>
      {!readOnly && <>
        <button type="button" className="property-remove" aria-label={`${name} 속성 편집`} onClick={() => setEditing(name)}><Pencil size={13} /></button>
        <button type="button" className="property-remove" aria-label={`${name} 속성 제거`} onClick={() => remove(name)}><X size={13} /></button>
      </>}
    </div>)}
    {!readOnly && editing !== null && <PropertyForm key={editing} initial={current} original={current?.name} existing={names}
      saveLabel={current ? "저장" : "추가"} onCancel={() => setEditing(null)} onSave={(field) => {
        onChange(putProperty(properties, field, current?.name)); setEditing(null);
      }} />}
    {!readOnly && <button type="button" className="property-add" onClick={(e) => onMenu(e.currentTarget.getBoundingClientRect(), [
      ...builtinItems,
      ...(builtinItems.length ? ["separator" as const] : []),
      ...presetsToAdd.map((field) => ({ label: field.name, icon: <PropertyIcon name={field.icon} />, action: () => onChange(putProperty(properties, field)) })),
      ...(presetsToAdd.length ? ["separator" as const] : []),
      { label: "사용자 속성 만들기", icon: <Plus size={14} />, action: () => setEditing("") },
    ])}><Plus size={15} />속성 추가하기</button>}
  </>;
}
