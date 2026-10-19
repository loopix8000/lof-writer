export default function LayoutIcon({ side, open }: { side: "left" | "right"; open: boolean }) {
  const x = side === "left" ? 2.5 : 10;
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" />
      <rect x={x} y="3" width="3.5" height="10" fill={open ? "currentColor" : "none"} />
      <path d={side === "left" ? "M6 3v10" : "M10 3v10"} stroke="currentColor" />
    </svg>
  );
}
