"use client";

import { useEffect, useRef } from "react";

/**
 * A small rich text field for one block's inline content.
 *
 * A block is a single element — a heading, a paragraph, a list item — and what
 * can legitimately live inside it is inline markup: emphasis, a link, a line
 * break. So this is not a document editor, and deliberately offers nothing that
 * would produce a paragraph inside a paragraph. Pressing Enter asks the
 * workspace to split the block in two instead, which is what a paragraph break
 * actually is here.
 *
 * Uncontrolled on purpose. Writing `innerHTML` on every render puts the caret
 * back at the start of the field on every keystroke; it is only written when
 * the incoming value differs from what is already displayed, which happens when
 * an AI option is applied or the block is edited in the preview.
 */
export function RichText({
  value,
  readOnly,
  onChange,
  onSplit,
  onPaste,
  className,
}: {
  value: string;
  readOnly: boolean;
  onChange: (html: string) => void;
  /** Enter pressed: everything before the caret stays, the rest is a new block. */
  onSplit?: (before: string, after: string) => void;
  onPaste?: (event: React.ClipboardEvent<HTMLDivElement>) => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (el && el.innerHTML !== value) el.innerHTML = value;
  }, [value]);

  /**
   * `execCommand` is deprecated and is still the only thing every browser
   * implements for this. The alternative is hand-rolling range surgery for
   * bold, italic and links, which is a great deal of code to arrive at worse
   * behaviour — and the output here is sanitised regardless of how it was made.
   */
  const exec = (command: string, argument?: string) => {
    ref.current?.focus();
    document.execCommand(command, false, argument);
    if (ref.current) onChange(ref.current.innerHTML);
  };

  const link = () => {
    const url = window.prompt("Link to where?", "https://");
    if (!url) return;
    // A javascript: URL typed in here would be stripped by the sanitiser on the
    // way to an op, but never creating one is better than relying on that.
    if (!/^(https?:|mailto:|tel:|\/|#)/i.test(url)) return;
    exec("createLink", url);
  };

  const button = (label: string, title: string, action: () => void, style?: string) => (
    <button
      type="button"
      disabled={readOnly}
      title={title}
      aria-label={title}
      // Keeps the selection: focus would otherwise leave the field before the
      // command runs, and there would be nothing selected to embolden.
      onMouseDown={(event) => event.preventDefault()}
      onClick={action}
      className={`rounded px-1.5 py-0.5 text-[11px] text-[var(--color-ink-soft)] transition-colors hover:bg-[var(--color-sunken)] hover:text-[var(--color-ink)] disabled:opacity-40 ${style ?? ""}`}
    >
      {label}
    </button>
  );

  return (
    <div>
      {readOnly ? null : (
        <div className="mb-1 flex items-center gap-0.5">
          {button("B", "Bold", () => exec("bold"), "font-bold")}
          {button("I", "Italic", () => exec("italic"), "italic")}
          {button("Link", "Add a link", link)}
          {button("Clear", "Remove formatting", () => exec("removeFormat"))}
        </div>
      )}

      <div
        ref={ref}
        contentEditable={!readOnly}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="false"
        spellCheck
        onInput={(event) => onChange((event.target as HTMLDivElement).innerHTML)}
        onPaste={onPaste}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();

          const el = ref.current;
          if (!el) return;

          // Shift+Enter is a line break, which is inline markup and belongs
          // inside the block.
          if (event.shiftKey) {
            document.execCommand("insertLineBreak");
            onChange(el.innerHTML);
            return;
          }
          if (!onSplit) return;

          const selection = window.getSelection();
          if (!selection || selection.rangeCount === 0) return;
          const range = selection.getRangeAt(0);

          const tail = range.cloneRange();
          tail.selectNodeContents(el);
          tail.setStart(range.endContainer, range.endOffset);
          const moved = tail.cloneContents();
          const holder = document.createElement("div");
          holder.appendChild(moved);

          const head = range.cloneRange();
          head.selectNodeContents(el);
          head.setEnd(range.startContainer, range.startOffset);
          const headHolder = document.createElement("div");
          headHolder.appendChild(head.cloneContents());

          onSplit(headHolder.innerHTML, holder.innerHTML);
        }}
        className={`field min-h-16 whitespace-pre-wrap ${className ?? ""}`}
      />
    </div>
  );
}
