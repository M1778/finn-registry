import { cn } from "@/lib/utils";

/**
 * The registry's mark: a heavy margin rule with two entries ruled off it, and a
 * fainter rule below waiting for the next one. It reads as an F and as a page of
 * a register, which is the whole idea.
 *
 * Drawn in `currentColor` and deliberately not in brass. Brass, verdigris and
 * oxblood are trust pigments (globals.css, rule 1) — a logo wearing brass would
 * teach the reader that brass means "this website", and the seals would stop
 * signalling. The mark is neutral ink in both themes.
 *
 * The tile is square-edged because the mark is a document, not a seal (rule 2).
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={cn("size-6", className)}
    >
      <rect
        x="1"
        y="1"
        width="22"
        height="22"
        rx="2"
        stroke="currentColor"
        strokeOpacity="0.35"
        strokeWidth="1.5"
      />
      {/* The margin rule and the two entries ruled off it. */}
      <path
        d="M6.5 4.75H17.5V7.75H9.75V10.75H15.25V13.5H9.75V19.25H6.5Z"
        fill="currentColor"
      />
      {/* The next line, still blank. Vanishes below ~20px, which is correct:
          at favicon size the mark should be one unmistakable shape. */}
      <path
        d="M11.75 17.25H17.5V19.25H11.75Z"
        fill="currentColor"
        fillOpacity="0.4"
      />
    </svg>
  );
}

/**
 * Mark plus wordmark, for the bar and the footer. The name is set in the
 * signage face rather than mono: mono is for identifiers a person types or
 * diffs (rule 3), and the registry's own name is not one.
 */
export default function Logo({
  className,
  markClassName,
}: {
  className?: string;
  markClassName?: string;
}) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <LogoMark className={cn("text-ink size-[1.375rem] shrink-0", markClassName)} />
      <span className="text-ink font-display text-[0.9375rem] font-semibold tracking-tight">
        finn-registry
      </span>
    </span>
  );
}
