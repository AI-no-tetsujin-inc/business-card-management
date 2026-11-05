import { useEffect, useId, useState } from "react";
import { api } from "../api";

export function TagInput({ value, onChange }: { value: string[]; onChange: (tags: string[]) => void }) {
  const [text, setText] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const listId = useId();

  useEffect(() => {
    api<{ tags: string[] }>("/api/tags").then((r) => setSuggestions(r.tags), () => {});
  }, []);

  const add = (raw: string) => {
    const t = raw.trim();
    if (t && !value.includes(t)) onChange([...value, t]);
    setText("");
  };

  return (
    <div className="tag-input">
      {value.map((t) => (
        <span key={t} className="tag">
          {t}
          <button type="button" aria-label={`${t} を外す`} onClick={() => onChange(value.filter((x) => x !== t))}>
            ×
          </button>
        </span>
      ))}
      <input
        list={listId}
        value={text}
        placeholder="タグを入力して Enter"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === ",") && !e.nativeEvent.isComposing) {
            e.preventDefault();
            add(text);
          }
        }}
        onBlur={() => text && add(text)}
      />
      <datalist id={listId}>
        {suggestions.filter((s) => !value.includes(s)).map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </div>
  );
}
