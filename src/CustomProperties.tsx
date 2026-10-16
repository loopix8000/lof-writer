import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  AlignLeft, Bookmark, User, Users, Calendar, Clock, MapPin, Flag, Star, Heart,
  Hash, List, Check, Link2, Folder, Lightbulb, Pencil, Plus, X,
} from "lucide-react";
import type { MenuItem } from "./ContextMenu";
import {
  ICONS_KEY, PROPERTY_ICONS, PROPERTY_TYPES, emptyValue, fieldType, propertyIcon, propertyIcons, propertyNameError,
  propertyPresets, putProperty, removeProperty, readPropertyValue, valueYaml,
  type FieldType, type PropertyPreset, type PropertyValue,
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

// 내용에 맞춰 높이가 늘어나는 글 상자(뮤블의 요약·작가의 말 입력).
export function GrowingText({ value, onChange, onBlur, disabled, label, dim, className, autoFocus }: {
  value: string; onChange: (v: string) => void; onBlur?: () => void; disabled: boolean; label: string;
  dim?: boolean; className?: string; autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      className={`property-text${dim ? " dim" : ""}${className ? ` ${className}` : ""}`}
      aria-label={label}
      rows={1}
      value={value}
      disabled={disabled}
      autoFocus={autoFocus}
      spellCheck={false}
      placeholder="비어 있음"
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
    />
  );
}

// YAML은 입력 중간에 형식이 깨지기 쉬우니 포커스가 빠질 때 확인하고 저장한다.
function YamlValue({ label, value, disabled, autoFocus, onChange }: {
  label: string; value: unknown; disabled: boolean; autoFocus?: boolean; onChange: (value: PropertyValue) => void;
}) {
  const text = valueYaml(value);
  const [raw, setRaw] = useState(text);
  const [error, setError] = useState("");
  useEffect(() => { setRaw(text); setError(""); }, [text]);
  return <div className="custom-property-yaml">
    <GrowingText className="yaml-value" label={label} value={raw} disabled={disabled} autoFocus={autoFocus}
      onChange={(v) => { setRaw(v); setError(""); }}
      onBlur={() => {
        if (raw === text) return;
        try { onChange(readPropertyValue(raw)); }
        catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      }} />
    {error && <p role="alert" className="input-error">{error}</p>}
  </div>;
}

// 목록 프리셋의 항목을 칩으로 쌓는다. Enter로 추가하고, 끌어서 순서를 바꾼다.
function ListItems({ name, items, onChange }: {
  name: string; items: string[]; onChange: (items: string[]) => void;
}) {
  const [value, setValue] = useState("");
  const composing = useRef(false);
  const dragging = useRef<number | null>(null);
  const add = (raw = value) => {
    const parts = [...new Set(raw.split(/\r?\n/).map((item) => item.trim()).filter((item) => item && !items.includes(item)))];
    if (parts.length) onChange([...items, ...parts]);
    setValue("");
  };
  return <div className="episode-tags custom-property-list is-editable">
    {items.map((item, index) => <span key={`${index}:${item}`} className="episode-tag" draggable
      onDragStart={(e) => {
        dragging.current = index;
        e.stopPropagation(); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", item);
      }}
      onDragOver={(e) => {
        if (dragging.current !== null) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "move"; }
      }}
      onDrop={(e) => {
        const from = dragging.current;
        if (from === null) return;
        e.preventDefault(); e.stopPropagation();
        if (from !== index) {
          const next = [...items]; next.splice(index, 0, ...next.splice(from, 1)); onChange(next);
        }
      }}
      onDragEnd={(e) => { e.stopPropagation(); dragging.current = null; }}>
      <span className="episode-tag-label">{item}</span>
      <button type="button" className="custom-property-list-remove" aria-label={`${item} 항목 제거`}
        title="항목 제거" onMouseDown={(e) => e.preventDefault()}
        onClick={() => onChange(items.filter((_, i) => i !== index))}><X size={11} /></button>
    </span>)}
    <input className="episode-tag-input" aria-label={`${name} 항목 입력`}
        placeholder={items.length ? "항목 추가" : "항목 입력 후 Enter"} value={value}
        onChange={(e) => setValue(e.target.value)}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onPaste={(e) => {
          const text = e.clipboardData.getData("text");
          if (/[\r\n]/.test(text)) { e.preventDefault(); add(value + text); }
        }}
        onBlur={() => { if (!composing.current && value.trim()) add(); }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || composing.current || e.keyCode === 229) return;
          if (e.key === "Enter") { e.preventDefault(); add(); }
          if (e.key === "Backspace" && !value && items.length) onChange(items.slice(0, -1));
        }} />
  </div>;
}

function PropertyValueInput({ name, type, value, options, disabled, autoFocus, onChange }: {
  name: string; type: FieldType; value: unknown; options?: string[]; disabled: boolean; autoFocus?: boolean;
  onChange: (value: PropertyValue) => void;
}) {
  const label = `${name} 값`;
  if (type === "boolean")
    return <input type="checkbox" aria-label={label} checked={value === true} disabled={disabled} autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.checked)} />;
  if (type === "number")
    return <input type="number" step="any" className="property-text" aria-label={label} placeholder="비어 있음"
      value={typeof value === "number" ? value : ""} disabled={disabled} autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value.trim() === "" ? null : Number(e.target.value))} />;
  if (type === "list") {
    const current = typeof value === "string" ? value : "";
    // 프리셋에서 항목이 빠져도 이미 고른 값은 잃지 않게 그대로 보여 준다.
    const choices = current && !options?.includes(current) ? [...(options ?? []), current] : options ?? [];
    return <select className="property-choice" aria-label={label} value={current} disabled={disabled}
      autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)}>
      <option value="">선택 안 함</option>
      {choices.map((option) => <option key={option} value={option}>{option}</option>)}
    </select>;
  }
  if (type === "yaml")
    return <YamlValue label={label} value={value} disabled={disabled} autoFocus={autoFocus} onChange={onChange} />;
  return <GrowingText label={label} value={typeof value === "string" ? value : ""} disabled={disabled}
    autoFocus={autoFocus} onChange={onChange} />;
}

export type PropertyDefinition = { name: string; icon: string; type: FieldType; fullWidth: boolean; options: string[] };

// 속성의 정의(이름·아이콘·값 형식)만 정한다. 값은 집필 화면에서 바로 입력한다.
// layout은 프리셋 폼이다. 목록 항목과 폭은 프리셋에만 저장할 수 있다.
export function PropertyForm({ initial, existing, original, layout, onSave, onCancel, saveLabel = "추가" }: {
  initial?: PropertyDefinition; existing: string[]; original?: string; layout?: boolean;
  onSave: (field: PropertyDefinition) => void | Promise<void>; onCancel: () => void; saveLabel?: string;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [icon, setIcon] = useState(initial?.icon ?? "text");
  const [type, setType] = useState<FieldType>(initial?.type ?? "text");
  const [fullWidth, setFullWidth] = useState(initial?.fullWidth ?? true);
  const [options, setOptions] = useState(initial?.options ?? []);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function save() {
    const nextName = name.trim();
    const problem = propertyNameError(nextName, existing, original);
    if (problem) { setError(problem); return; }
    if (type === "list" && !options.length) { setError("목록에 항목을 하나 이상 추가해 주세요."); return; }
    setSaving(true);
    try { await onSave({ name: nextName, icon, type, fullWidth, options: type === "list" ? options : [] }); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }
  return <div className="custom-property-form" role="group" aria-label={original ? `${original} 속성 편집` : "새 사용자 속성"}>
    <label>속성명<input autoFocus aria-label="사용자 속성명" value={name} onChange={(e) => { setName(e.target.value); setError(""); }}
      onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void save(); } }} /></label>
    <div className="property-icon-picker" role="group" aria-label="속성 아이콘">
      {PROPERTY_ICONS.map((id) => {
        const Icon = ICONS[id].icon;
        return <button key={id} type="button" aria-label={`${ICONS[id].label} 아이콘`} title={ICONS[id].label}
          aria-pressed={icon === id} onClick={() => setIcon(id)}><Icon size={16} /></button>;
      })}
    </div>
    <label>값 형식<select aria-label="속성 값 형식" value={type} onChange={(e) => { setType(e.target.value as FieldType); setError(""); }}>
      {Object.entries(PROPERTY_TYPES).filter(([id]) => layout || id !== "list")
        .map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      {initial?.type === "yaml" && <option value="yaml">YAML</option>}
    </select></label>
    {layout && type === "list" && <div className="custom-property-options">
      <span>항목</span>
      <ListItems name="목록" items={options} onChange={setOptions} />
      <small>집필 화면에서 이 항목 중 하나를 골라 씁니다.</small>
    </div>}
    {layout && <div className="custom-property-layout" role="radiogroup" aria-label="속성 폭">
      <span>폭</span>
      <button type="button" role="radio" aria-checked={fullWidth} onClick={() => setFullWidth(true)}>한 줄</button>
      <button type="button" role="radio" aria-checked={!fullWidth} onClick={() => setFullWidth(false)}>반 칸</button>
    </div>}
    {error && <p role="alert" className="input-error">{error}</p>}
    <div className="row gap"><button type="button" disabled={saving} onClick={onCancel}>취소</button>
      <button type="button" disabled={saving} className="primary" onClick={save}>{saveLabel}</button></div>
  </div>;
}

// 속성 정의 폼을 기준 요소 아래에 띄운다. 바깥을 누르거나 Esc를 누르면 닫는다.
function FloatingForm({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const handle = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) close.current();
    };
    window.addEventListener("mousedown", handle, true);
    window.addEventListener("keydown", handle, true);
    return () => {
      window.removeEventListener("mousedown", handle, true);
      window.removeEventListener("keydown", handle, true);
    };
  }, []);
  useEffect(() => { ref.current?.scrollIntoView({ block: "nearest" }); }, []);
  return <div ref={ref} className="property-form-pop">{children}</div>;
}

// 프리셋 폼은 앱에서 만들 수 있는 형식만 고르게 한다.
export const presetType = (type: FieldType) => type === "yaml" ? "text" as const : type;

export default function CustomProperties({ properties = {}, presets: rawPresets, readOnly, builtinItems, onChange, onSavePresets, onMenu, onNotice }: {
  properties?: Record<string, unknown>; presets?: unknown; readOnly: boolean; builtinItems: MenuItem[];
  onChange: (properties: Record<string, unknown>) => void;
  // 집필 화면에서 만든 속성은 프리셋으로 저장해 설정과 같은 방식(목록 항목·폭)으로 쓴다.
  onSavePresets?: (presets: PropertyPreset[]) => Promise<void>;
  onMenu: (rect: DOMRect, items: MenuItem[]) => void;
  onNotice: (text: string, action?: { label: string; run: () => void }) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [focusName, setFocusName] = useState<string | null>(null);
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
  const presets = propertyPresets(rawPresets);
  // 설정의 프리셋과 이름이 같은 속성은 기본 속성처럼 값만 입력한다.
  const presetOf = new Map(presets.map((field) => [field.name, field]));
  const presetsToAdd = presets.filter((field) => !Object.hasOwn(properties, field.name));
  const current = editing !== null && editing !== "" && Object.hasOwn(properties, editing)
    ? { name: editing, icon: propertyIcon(icons[editing]), type: fieldType(properties[editing]), fullWidth: true, options: [] } : undefined;
  const add = (name: string, icon: string, value: PropertyValue) => {
    latest.current.onChange(putProperty(latest.current.properties, { name, icon, value }));
    setFocusName(name);
  };
  const form = (current?: { name: string; icon: string; type: FieldType; fullWidth: boolean; options: string[] }) =>
    <FloatingForm onClose={() => setEditing(null)}>
      <PropertyForm key={editing} initial={current} original={current?.name} layout={!current && !!onSavePresets}
        existing={current ? names : [...names, ...presets.map((field) => field.name)]}
        saveLabel={current ? "저장" : "추가"} onCancel={() => setEditing(null)} onSave={async (field) => {
          if (!current && onSavePresets) {
            await onSavePresets([...presets, { id: crypto.randomUUID(), ...field, type: presetType(field.type) }]);
            if (!mounted.current) return;
            setEditing(null);
            add(field.name, field.icon, emptyValue(field.type));
            return;
          }
          setEditing(null);
          if (!current) {
            // 프리셋이 없으면 저장된 값으로 형식을 알아내므로 숫자는 0으로 시작한다.
            add(field.name, field.icon, field.type === "number" ? 0 : emptyValue(field.type));
            return;
          }
          const value = field.type === current.type ? properties[current.name] as PropertyValue
            : field.type === "number" ? 0 : emptyValue(field.type);
          onChange(putProperty(properties, { name: field.name, icon: field.icon, value }, current.name));
        }} />
    </FloatingForm>;
  const remove = (name: string) => {
    onChange(removeProperty(properties, name));
    if (editing === name) setEditing(null);
    onNotice(`${name} 속성을 제거했어요.`, { label: "실행 취소", run: () => {
      if (!mounted.current || latest.current.readOnly) return;
      latest.current.onChange(putProperty(latest.current.properties, {
        name, icon: propertyIcon(icons[name]), value: properties[name] as PropertyValue,
      }));
    } });
  };
  return <>
    {entries.map(([name, value]) => {
      const preset = presetOf.get(name);
      const type = fieldType(value, preset?.type);
      return <div key={name} className={`property-row custom-property-row${preset && !preset.fullWidth ? "" : " full"}`}
        role="group" aria-label={name}>
        <div className="property-label"><PropertyIcon name={preset?.icon ?? icons[name]} /><span>{name}</span></div>
        <div className="property-control">
          <PropertyValueInput name={name} type={type} value={value} options={preset?.options} disabled={readOnly} autoFocus={focusName === name}
            onChange={(next) => onChange({ ...properties, [name]: next === null && !preset ? 0 : next })} />
        </div>
        {!readOnly && <>
          {!preset && <button type="button" className="property-remove" aria-label={`${name} 속성 편집`} title="속성 편집"
            onClick={() => setEditing(name)}><Pencil size={13} /></button>}
          <button type="button" className="property-remove" aria-label={`${name} 속성 제거`} title={`${name} 속성 제거`}
            onClick={() => remove(name)}><X size={13} /></button>
        </>}
        {!readOnly && current?.name === name && form(current)}
      </div>;
    })}
    {!readOnly && <div className="property-add-anchor">
    <button type="button" className="property-add" onClick={(e) => onMenu(e.currentTarget.getBoundingClientRect(), [
      ...builtinItems,
      ...(builtinItems.length ? ["separator" as const] : []),
      ...presetsToAdd.map((field) => ({ label: field.name, icon: <PropertyIcon name={field.icon} />,
        action: () => add(field.name, field.icon, emptyValue(field.type)) })),
      ...(presetsToAdd.length ? ["separator" as const] : []),
      { label: "사용자 속성 만들기", icon: <Plus size={14} />, action: () => setEditing("") },
    ])}><Plus size={15} />속성 추가하기</button>
    {editing === "" && form()}
    </div>}
  </>;
}
