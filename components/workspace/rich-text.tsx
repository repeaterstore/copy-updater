"use client";

import { useEffect, useRef } from "react";
import { cssEscape } from "@/lib/ops/extract";

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
  inlineVisibility,
  className,
}: {
  value: string;
  readOnly: boolean;
  onChange: (html: string) => void;
  /** Enter pressed: everything before the caret stays, the rest is a new block. */
  onSplit?: (before: string, after: string) => void;
  onPaste?: (event: React.ClipboardEvent<HTMLDivElement>) => void;
  /**
   * Classes this page uses to hide something on one screen size, for wrapping
   * a run of words rather than a whole block. Absent where the page has no
   * such convention, or none that works on an inline element.
   */
  inlineVisibility?: { desktopOnly: string[] | null; mobileOnly: string[] | null };
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


  /**
   * Hide part of a sentence, rather than the block it sits in.
   *
   * Wrapping is done by hand rather than with execCommand, which has no command
   * for "put a span with this class around the selection". The selection is
   * extracted and reinserted inside the span; `surroundContents` would be
   * tidier and throws whenever the selection starts inside one element and ends
   * inside another, which is most real selections.
   *
   * Clicking again on text already wrapped takes the wrapper off, so the same
   * button is how it is undone.
   */
  const wrapSelection = (classes: string[]) => {
    const el = ref.current;
    const selection = window.getSelection();
    if (!el || !selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) return;

    /*
     * Looked up from the caret, not from the selection as a whole.
     *
     * Removing the tag has to work when nothing is selected — the reviewer
     * clicks into the tagged words and presses the button again — and the
     * selection was being cleared after wrapping, so the very next click found
     * no range at all and did nothing. That was the whole of "no way to remove
     * the tag": the button worked, it just could never find what to undo.
     */
    const from = range.startContainer;
    const start = from.nodeType === 1 ? (from as Element) : from.parentElement;
    let existing: Element | null = start?.closest("span[class]") ?? null;
    while (existing && el.contains(existing)) {
      if (classes.every((c) => existing!.classList.contains(c))) break;
      existing = existing.parentElement?.closest("span[class]") ?? null;
    }

    if (existing && el.contains(existing)) {
      const parent = existing.parentNode;
      if (parent) {
        // Keep a caret in the words that were tagged, so a mistaken click can
        // be undone by clicking again without hunting for the text.
        const first = existing.firstChild;
        while (existing.firstChild) parent.insertBefore(existing.firstChild, existing);
        parent.removeChild(existing);
        if (first) {
          const after = document.createRange();
          after.selectNodeContents(first.parentNode ?? parent);
          selection.removeAllRanges();
          selection.addRange(after);
        }
      }
      onChange(el.innerHTML);
      return;
    }

    if (range.collapsed) return;
    const span = document.createElement("span");
    span.className = classes.join(" ");
    span.appendChild(range.extractContents());
    range.insertNode(span);

    // The wrapped words stay selected, so the button that made the tag is also
    // the button that takes it off.
    const wrapped = document.createRange();
    wrapped.selectNodeContents(span);
    selection.removeAllRanges();
    selection.addRange(wrapped);
    onChange(el.innerHTML);
  };

  /**
   * A tag has to be visible in the field that made it.
   *
   * The classes are the page's own, and the page's stylesheet is not loaded
   * here — so tagged words rendered exactly like every other word and there was
   * no sign anything had happened. These rules mark them in the editor only;
   * nothing is added to the markup, so the export stays the classes a developer
   * asked for and nothing else.
   */
  const markerCss = [
    inlineVisibility?.desktopOnly
      ? { classes: inlineVisibility.desktopOnly, colour: "var(--color-accent)", label: "desktop" }
      : null,
    inlineVisibility?.mobileOnly
      ? { classes: inlineVisibility.mobileOnly, colour: "var(--color-comment)", label: "mobile" }
      : null,
  ]
    .filter((m): m is { classes: string[]; colour: string; label: string } => m !== null)
    .map(({ classes, colour, label }) => {
      const selector = classes.map((c) => `.${cssEscape(c)}`).join("");
      return (
        `[data-cu-rte] span${selector}{` +
        `background:color-mix(in oklch, ${colour} 14%, transparent);` +
        `box-shadow:inset 0 -2px ${colour};border-radius:2px}` +
        `[data-cu-rte] span${selector}::after{content:" ${label} only";` +
        `font-size:9px;letter-spacing:.04em;text-transform:uppercase;` +
        `color:${colour};opacity:.85;white-space:nowrap}`
      );
    })
    .join("");

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

          {inlineVisibility?.desktopOnly || inlineVisibility?.mobileOnly ? (
            <span className="mx-0.5 h-3.5 w-px bg-[var(--color-line-strong)]" />
          ) : null}
          {inlineVisibility?.desktopOnly
            ? button(
                "Desktop",
                "Hide the selected words on mobile. Click again to undo.",
                () => wrapSelection(inlineVisibility.desktopOnly!),
              )
            : null}
          {inlineVisibility?.mobileOnly
            ? button(
                "Mobile",
                "Hide the selected words on desktop. Click again to undo.",
                () => wrapSelection(inlineVisibility.mobileOnly!),
              )
            : null}
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

          const inner = (make: (r: Range) => void) => {
            const clone = range.cloneRange();
            clone.selectNodeContents(el);
            make(clone);
            const holder = document.createElement("div");
            holder.appendChild(clone.cloneContents());
            return holder.innerHTML;
          };

          const head = inner((r) => r.setEnd(range.startContainer, range.startOffset));
          const tail = inner((r) => r.setStart(range.endContainer, range.endOffset));

          // The caller inserts this as a complete element, so it has to be one.
          // Handing over bare inner markup put a loose text node into the page:
          // no tag, no id, absent from the outline, and under a <ul> not even
          // valid. The block's own tag and classes are what the new sibling
          // wears, exactly as the preview builds it.
          onSplit(head, tail);
        }}
        data-cu-rte=""
        className={`field min-h-16 whitespace-pre-wrap ${className ?? ""}`}
      />
      {markerCss ? <style>{markerCss}</style> : null}
    </div>
  );
}
