import type { WordPart } from "@/lib/ops/diff";

/** Inline red/green word diff. */
export function WordDiff({ parts }: { parts: WordPart[] }) {
  return (
    <p className="text-sm leading-relaxed">
      {parts.map((part, index) => {
        if (part.added) {
          return (
            <span
              key={index}
              className="rounded-sm bg-[var(--color-added-soft)] text-[var(--color-added)]"
            >
              {part.value}
            </span>
          );
        }
        if (part.removed) {
          return (
            <span
              key={index}
              className="rounded-sm bg-[var(--color-removed-soft)] text-[var(--color-removed)] line-through"
            >
              {part.value}
            </span>
          );
        }
        return <span key={index}>{part.value}</span>;
      })}
    </p>
  );
}
