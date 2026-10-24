import type { ButtonHTMLAttributes, CSSProperties, MouseEvent, ReactNode } from "react";

export const treeRowStyle = (depth = 0): CSSProperties => ({ paddingLeft: 8 + depth * 16 });

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  depth?: number;
  folder?: boolean;
  marker: ReactNode;
  label: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
};

export default function TreeRow({ depth = 0, folder = false, marker, label, badge, actions, className = "", style, ...props }: Props) {
  return <button type="button" {...props} className={`tree-item ${folder ? "memo-folder" : ""} ${className}`}
    style={{ ...treeRowStyle(depth), ...style }}>
    {marker}
    <span>{label}</span>
    {badge}
    {actions && <span className="tree-actions">{actions}</span>}
  </button>;
}

export function TreeRowAction({ title, label = title, disabled = false, onAction, children }: {
  title: string;
  label?: string;
  disabled?: boolean;
  onAction: (event: MouseEvent<HTMLSpanElement>) => void;
  children: ReactNode;
}) {
  return <span className="tree-action" role="button" tabIndex={-1} title={title} aria-label={label}
    aria-disabled={disabled || undefined}
    onClick={event => { event.stopPropagation(); if (!disabled) onAction(event); }}
    onDoubleClick={event => event.stopPropagation()}>
    {children}
  </span>;
}
