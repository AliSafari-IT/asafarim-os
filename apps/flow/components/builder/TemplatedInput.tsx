"use client";
/**
 * A text field that takes `{{…}}` placeholders, with their autocomplete: typing `{{` opens a list of
 * what this node may read (lib/builder/suggest.ts), filtered as you type; ↑ ↓ move, Enter or Tab
 * inserts, Escape closes. The list is an ARIA listbox the field controls (a combobox), so a screen
 * reader follows the choice.
 */
import { useId, useRef, useState } from "react";
import { matching, type Suggestion } from "@/lib/builder/suggest";

/** The text typed after an unclosed `{{` before the caret, or undefined when the caret isn't in one. */
function openPlaceholder(text: string, caret: number): { from: number; typed: string } | undefined {
  const before = text.slice(0, caret);
  const from = before.lastIndexOf("{{");
  if (from < 0 || before.slice(from).includes("}}")) return undefined;
  const typed = before.slice(from + 2);
  return /^[\sA-Za-z0-9_.-]*$/.test(typed) ? { from, typed } : undefined;
}

export function TemplatedInput({
  id,
  value,
  onChange,
  suggestions,
  multiline = false,
  maxLength,
  disabled,
  describedBy,
  invalid,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  suggestions: readonly Suggestion[];
  multiline?: boolean;
  maxLength?: number;
  disabled?: boolean;
  describedBy?: string;
  invalid?: boolean;
}) {
  const listId = useId();
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const [open, setOpen] = useState<{ from: number; typed: string } | undefined>();
  const [active, setActive] = useState(0);
  const options = open ? matching(suggestions, open.typed) : [];
  const expanded = !!open && options.length > 0;

  const refresh = (text: string, caret: number | null) => {
    const found = caret === null ? undefined : openPlaceholder(text, caret);
    setOpen(found);
    setActive(0);
  };

  const insert = (s: Suggestion) => {
    const el = ref.current;
    if (!el || !open) return;
    const caret = el.selectionStart ?? value.length;
    const after = value.slice(caret).replace(/^[^{}\s]*\}\}/, "");
    const text = `${value.slice(0, open.from)}{{${s.path}}}`;
    onChange(text + after);
    setOpen(undefined);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(text.length, text.length);
    });
  };

  const props = {
    id,
    ref,
    value,
    disabled,
    maxLength,
    role: "combobox" as const,
    "aria-autocomplete": "list" as const,
    "aria-expanded": expanded,
    "aria-controls": listId,
    "aria-activedescendant": expanded ? `${listId}-${active}` : undefined,
    "aria-describedby": describedBy,
    "aria-invalid": invalid || undefined,
    autoComplete: "off",
    spellCheck: false,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      onChange(e.target.value);
      refresh(e.target.value, e.target.selectionStart);
    },
    onClick: (e: React.MouseEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      refresh(e.currentTarget.value, e.currentTarget.selectionStart),
    onBlur: () => setTimeout(() => setOpen(undefined), 150),
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (!expanded) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActive((a) => (a + step + options.length) % options.length);
      } else if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insert(options[active]!);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setOpen(undefined);
      }
    },
  };

  return (
    <div className="combo">
      {multiline ? <textarea rows={5} {...props} /> : <input type="text" {...props} />}
      <ul id={listId} role="listbox" className="combo-list" hidden={!expanded} aria-label="Fields to insert">
        {options.map((s, i) => (
          <li
            key={s.path}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === active}
            onMouseDown={(e) => {
              e.preventDefault();
              insert(s);
            }}
          >
            <span className="mono">{s.path}</span> <span className="muted">{s.from}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
