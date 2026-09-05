'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The one control the whole surface is built around.
 *
 * A search box asks for keywords. This asks for a sentence, because the thing behind it
 * takes one — "a formal shirt for an office in Chennai under ₹2,500" is a better query than
 * any three words a buyer could pick, and the input should look like it expects that.
 *
 * So: a textarea that grows with what is written, Enter to send, Shift+Enter for a new line.
 */
export function PromptInput({
  onSubmit,
  busy,
  placeholder = 'Ask anything…',
  autoFocus,
}: {
  onSubmit: (value: string) => void;
  busy?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Height follows content, capped so a long paragraph does not eat the conversation.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  function send() {
    const text = value.trim();
    if (!text || busy) return;
    setValue('');
    onSubmit(text);
  }

  return (
    <div
      className={`flex items-end gap-2 rounded-[26px] border bg-[hsl(var(--bg))] px-3 py-2.5 shadow-sm transition ${
        focused
          ? 'border-[hsl(var(--accent))] shadow-[0_0_0_4px_hsl(var(--accent-soft))]'
          : 'border-[hsl(var(--border))]'
      }`}
    >
      <span
        aria-hidden
        className="mb-1.5 ml-1 h-4 w-4 shrink-0 rounded-full border-[3px] border-[hsl(var(--muted))] opacity-50"
      />

      <textarea
        ref={ref}
        rows={1}
        value={value}
        disabled={busy}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        className="max-h-40 flex-1 resize-none bg-transparent py-1.5 text-[15px] leading-6 outline-none placeholder:text-[hsl(var(--muted))] disabled:opacity-60"
      />

      <button
        type="button"
        onClick={send}
        disabled={busy || value.trim() === ''}
        aria-label="Send"
        className="mb-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[hsl(var(--accent))] text-white transition disabled:opacity-25"
      >
        {busy ? (
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
        ) : (
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M12 19V5M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>
    </div>
  );
}

/**
 * The suggestion chips under the input.
 *
 * They exist to answer "what can I even ask this?" — the hardest moment of a blank prompt.
 * Each is a real sentence, not a category filter, so tapping one demonstrates the phrasing
 * that works rather than teaching a taxonomy.
 */
export function Suggestions({
  items,
  onPick,
  disabled,
}: {
  items: { label: string; prompt: string }[];
  onPick: (prompt: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap justify-center gap-2">
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          disabled={disabled}
          onClick={() => onPick(item.prompt)}
          className="rounded-full border border-[hsl(var(--border))] bg-[hsl(var(--bg))] px-3.5 py-1.5 text-[13px] font-medium text-[hsl(var(--muted))] transition hover:border-[hsl(var(--accent))] hover:text-[hsl(var(--text))] disabled:opacity-50"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
