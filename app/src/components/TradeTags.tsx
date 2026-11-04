"use client";

import { useEffect, useRef, useState } from "react";
import { Tag, X } from "lucide-react";
import type { TradeNote } from "@/lib/strategy/notes";
import { STARTER_TAGS } from "@/lib/strategy/notes";
import type { NoteTarget, TagCount } from "@/lib/useTradeNotes";

/**
 * Tagging one trade, and writing a note on it.
 *
 * Two components, because the two places this is used want different things.
 * `TagChips` is read-only and belongs on a dense row, where the question is
 * only "is this one flagged". `TradeTagger` is the editor and belongs in an
 * expanded panel, where there is room to pick from the list, type a new tag and
 * leave a sentence about what happened.
 *
 * Tags are saved the moment they are clicked. The comment is saved on blur,
 * because saving per keystroke would write a document a dozen times a sentence.
 */

const HINTS = new Map(STARTER_TAGS.map((s) => [s.tag, s.hint]));

export function TagChips({ note, onClick }: { note?: TradeNote; onClick?: () => void }) {
  if (!note || (note.tags.length === 0 && !note.comment)) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1 align-middle">
      {note.tags.map((tag) => (
        <span
          key={tag}
          title={HINTS.get(tag) ?? tag}
          onClick={onClick}
          className="rounded-[3px] border border-accent bg-accentsoft px-1 py-px text-[9.5px] uppercase tracking-[0.06em] text-accent"
        >
          {tag}
        </span>
      ))}
      {note.comment ? (
        <span
          title={note.comment}
          className="rounded-[3px] border border-line px-1 py-px text-[9.5px] text-muted"
        >
          note
        </span>
      ) : null}
    </span>
  );
}

export function TradeTagger({
  target,
  note,
  tags,
  onSave,
  disabled,
}: {
  target: NoteTarget;
  note?: TradeNote;
  /** Every tag in use plus the starters, most-used first. */
  tags: TagCount[];
  onSave: (target: NoteTarget, tags: string[], comment: string | null) => void;
  disabled?: boolean;
}) {
  const current = note?.tags ?? [];
  const [draft, setDraft] = useState(note?.comment ?? "");
  const [typed, setTyped] = useState("");
  const savedComment = useRef(note?.comment ?? "");

  // A different trade is a different note, not an edit of this one.
  useEffect(() => {
    setDraft(note?.comment ?? "");
    savedComment.current = note?.comment ?? "";
    setTyped("");
  }, [target.id, note?.comment]);

  function toggle(tag: string) {
    if (disabled) return;
    const next = current.includes(tag)
      ? current.filter((t) => t !== tag)
      : [...current, tag];
    onSave(target, next, draft.trim() || null);
  }

  function addTyped() {
    const tag = typed.trim().toLowerCase().replace(/\s+/g, " ");
    setTyped("");
    if (!tag || current.includes(tag) || disabled) return;
    onSave(target, [...current, tag], draft.trim() || null);
  }

  function commitComment() {
    const next = draft.trim();
    if (next === savedComment.current.trim()) return;
    savedComment.current = next;
    onSave(target, current, next || null);
  }

  // Tags already on this trade first, then everything else — so the ones that
  // matter here do not move around as the vocabulary grows.
  const offered = [
    ...current,
    ...tags.map((t) => t.tag).filter((t) => !current.includes(t)),
  ];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Tag className="h-3 w-3 text-muted" aria-hidden />
        {offered.map((tag) => {
          const on = current.includes(tag);
          return (
            <button
              key={tag}
              type="button"
              disabled={disabled}
              onClick={() => toggle(tag)}
              title={HINTS.get(tag) ?? (on ? "Remove this tag" : "Add this tag")}
              className={`rounded-[3px] border px-1.5 py-px text-[10.5px] ${
                on
                  ? "border-accent bg-accentsoft font-semibold text-accent"
                  : "border-line text-muted hover:border-linestrong hover:text-ink2"
              } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
            >
              {tag}
              {on ? <X className="ml-1 inline h-2.5 w-2.5" aria-hidden /> : null}
            </button>
          );
        })}
        <input
          value={typed}
          disabled={disabled}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addTyped();
            }
          }}
          onBlur={addTyped}
          placeholder="new tag…"
          maxLength={40}
          className="w-[7.5rem] rounded-[3px] border border-line bg-surface px-1.5 py-px text-[10.5px] text-ink placeholder:text-faint"
        />
      </div>

      <textarea
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitComment}
        rows={2}
        maxLength={2000}
        placeholder="What happened on this trade?"
        className="w-full resize-y rounded-[4px] border border-line bg-surface px-2 py-1 text-[12px] leading-snug text-ink placeholder:text-faint"
      />
      {disabled ? (
        <p className="text-[10.5px] text-muted">
          MongoDB is not configured, so there is nowhere to keep tags.
        </p>
      ) : null}
    </div>
  );
}
