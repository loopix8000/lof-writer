import { favoriteTags } from "./custom-properties";

export default function TagSuggestions({ tags, favorites, query = "", onSelect }: {
  tags: string[]; favorites: unknown; query?: string; onSelect: (tag: string) => void;
}) {
  const current = new Set(tags.map((tag) => tag.toUpperCase()));
  const filter = query.trim().replace(/^#+/, "").toUpperCase();
  const candidates = favoriteTags(favorites).filter((tag) => !current.has(tag.toUpperCase()) && tag.toUpperCase().includes(filter));
  if (!candidates.length) return null;
  return <div className="tag-suggestions" role="group" aria-label="자주 쓰는 태그">
    <span>자주 쓰는 태그</span>
    {candidates.map((tag) => <button key={tag} type="button" aria-label={`${tag} 태그 추가`} disabled={tags.length >= 30}
      onMouseDown={(e) => e.preventDefault()} onClick={() => onSelect(tag)}>#{tag}</button>)}
  </div>;
}
