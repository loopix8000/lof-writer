import { useState } from "react";
import { ArrowUp, ArrowDown, Pencil, Plus, Trash2 } from "lucide-react";
import { PropertyForm, PropertyIcon } from "./CustomProperties";
import TagInput from "./TagInput";
import { favoriteTags, propertyPresets, valueYaml, type PropertyPreset } from "./custom-properties";

export default function PropertyPresetSettings({ presets: rawPresets, tags: rawTags, onChange }: {
  presets: unknown; tags: unknown; onChange: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const presets = propertyPresets(rawPresets);
  const tags = favoriteTags(rawTags);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const initial = presets.find((field) => field.id === editing);
  async function save(next: PropertyPreset[]) {
    setBusy(true);
    try { await onChange({ propertyPresets: next }); setError(""); }
    finally { setBusy(false); }
  }
  async function change(patch: Record<string, unknown>) {
    setBusy(true);
    try { await onChange(patch); setError(""); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  function move(index: number, offset: number) {
    const next = [...presets];
    const [field] = next.splice(index, 1);
    next.splice(index + offset, 0, field);
    void change({ propertyPresets: next });
  }
  return <>
    <div className="settings-subsection">
      <h3>사용자 속성 프리셋</h3>
      <p className="settings-description">아이콘·속성명·기본값을 미리 만들어 두세요. 문서의 ‘속성 추가하기’에서 골라 사용할 수 있습니다.</p>
      <div className="property-presets">
        {presets.map((field, index) => <div className="property-preset" key={field.id}>
          <PropertyIcon name={field.icon} />
          <div className="property-preset-description"><b>{field.name}</b><span>{typeof field.value === "string" ? field.value || "비어 있음" : valueYaml(field.value)}</span></div>
          <div className="row gap">
            <button type="button" disabled={busy || index === 0} aria-label={`${field.name} 프리셋 위로`} onClick={() => move(index, -1)}><ArrowUp size={14} /></button>
            <button type="button" disabled={busy || index === presets.length - 1} aria-label={`${field.name} 프리셋 아래로`} onClick={() => move(index, 1)}><ArrowDown size={14} /></button>
            <button type="button" disabled={busy} aria-label={`${field.name} 프리셋 편집`} onClick={() => { setEditing(field.id); setError(""); }}><Pencil size={14} /></button>
            <button type="button" disabled={busy} aria-label={`${field.name} 프리셋 삭제`} onClick={() => {
              if (editing === field.id) setEditing(null);
              void change({ propertyPresets: presets.filter((item) => item.id !== field.id) });
            }}><Trash2 size={14} /></button>
          </div>
        </div>)}
        {!presets.length && <p className="settings-description">아직 만든 속성 프리셋이 없습니다.</p>}
      </div>
      {editing !== null ? <PropertyForm key={editing} initial={initial} original={initial?.name}
        existing={presets.map((field) => field.name)} saveLabel="프리셋 저장" onCancel={() => setEditing(null)}
        onSave={async (field) => {
          await save(initial ? presets.map((item) => item.id === initial.id ? field : item) : [...presets, field]);
          setEditing(null);
        }} /> : <button type="button" onClick={() => setEditing("")}><Plus size={15} />속성 프리셋 만들기</button>}
    </div>
    <div className="settings-subsection">
      <h3>자주 쓰는 태그</h3>
      <p className="settings-description">콤마로 구분해 등록하면 작품과 문서의 태그 입력란에서 바로 골라 쓸 수 있습니다.</p>
      <TagInput tags={tags} maxTags={null} onChange={(next) => { void change({ favoriteTags: favoriteTags(next) }); }} />
    </div>
    {error && <p className="input-error" role="alert">{error}</p>}
  </>;
}
