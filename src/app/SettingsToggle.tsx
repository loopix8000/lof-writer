export default function SettingsToggle({ label, description, checked, onChange }: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="settings-toggle">
      <span><span>{label}</span><small>{description}</small></span>
      <input type="checkbox" role="switch" aria-label={label} checked={checked}
        onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}
