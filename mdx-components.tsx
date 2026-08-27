import type { MDXComponents } from "mdx/types";
import Link from "next/link";
import { AlertTriangle, Info, Lightbulb } from "lucide-react";

/**
 * How MDX renders inside the design system.
 *
 * Docs pages are `.mdx` files that are real routes, so there is no markdown
 * pipeline at runtime and no regex preprocessing — the previous docs page
 * rewrote `:::callout` fences with a regular expression at render time, which is
 * where most of its bugs lived.
 *
 * Everything here obeys the three rules in globals.css: prose is Newsreader,
 * headings are Archivo, anything a person would type or diff is mono, and
 * nothing is round except a trust seal.
 */

const KINDS = {
  note: { icon: Info, label: "Note" },
  tip: { icon: Lightbulb, label: "Tip" },
  warning: { icon: AlertTriangle, label: "Careful" },
} as const;

/** An aside. `warning` is the only one that may borrow oxblood. */
function Callout({
  kind = "note",
  children,
}: {
  kind?: keyof typeof KINDS;
  children: React.ReactNode;
}) {
  const { icon: Icon, label } = KINDS[kind];
  return (
    <aside
      className={`record my-6 flex gap-3 p-4 ${
        kind === "warning" ? "border-oxblood/40" : ""
      }`}
    >
      <Icon
        className={`mt-0.5 size-4 shrink-0 ${
          kind === "warning" ? "text-oxblood" : "text-ink-faint"
        }`}
        aria-hidden
      />
      <div className="min-w-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
        <p className="eyebrow mb-1.5">{label}</p>
        {children}
      </div>
    </aside>
  );
}

/**
 * Something the registry cannot do, stated plainly. Used wherever the old docs
 * promised a feature that does not exist — a reader who came looking for
 * `finn publish` is better served by "there is no such command, here is why"
 * than by silence.
 */
function NotThis({ children }: { children: React.ReactNode }) {
  return (
    <aside className="well my-6 p-4">
      <p className="eyebrow mb-1.5">Not how this works</p>
      <div className="reading-muted text-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
        {children}
      </div>
    </aside>
  );
}

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    h1: (props) => (
      <h1 className="mt-0 mb-4 text-3xl sm:text-4xl" {...props} />
    ),
    h2: (props) => (
      <h2 className="rule-top mt-12 mb-4 pt-8 text-2xl" {...props} />
    ),
    h3: (props) => <h3 className="mt-8 mb-3 text-lg font-medium" {...props} />,
    p: (props) => <p className="reading my-4" {...props} />,
    ul: (props) => (
      <ul className="reading my-4 list-disc space-y-1.5 pl-5" {...props} />
    ),
    ol: (props) => (
      <ol className="reading my-4 list-decimal space-y-1.5 pl-5" {...props} />
    ),
    li: (props) => <li className="pl-1" {...props} />,
    strong: (props) => <strong className="text-ink font-semibold" {...props} />,
    hr: () => <hr className="border-rule my-10 border-t" />,

    a: ({ href = "", ...props }) => {
      const external = /^https?:\/\//.test(href);
      return external ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-ink underline underline-offset-4"
          {...props}
        />
      ) : (
        <Link
          href={href}
          className="text-ink underline underline-offset-4"
          {...props}
        />
      );
    },

    // Inline code only: fenced blocks arrive as <pre><code>, styled below.
    code: (props) => (
      <code
        className="identifier bg-muted text-ink rounded-xs px-1 py-0.5 text-[0.9em]"
        {...props}
      />
    ),
    pre: (props) => (
      <pre
        className="well identifier my-5 overflow-x-auto p-3.5 text-sm leading-relaxed [&>code]:bg-transparent [&>code]:p-0"
        {...props}
      />
    ),

    table: (props) => (
      <div className="record my-6 overflow-x-auto">
        <table className="w-full border-collapse text-sm" {...props} />
      </div>
    ),
    thead: (props) => <thead className="bg-recessed" {...props} />,
    // The rule under the final row would sit directly on the record's own
    // border, so it comes off there rather than per cell.
    tbody: (props) => (
      <tbody className="[&>tr:last-child>td]:border-0" {...props} />
    ),
    th: (props) => (
      <th
        className="eyebrow border-rule border-b px-3 py-2 text-left align-bottom"
        {...props}
      />
    ),
    td: (props) => (
      <td
        className="border-rule reading-muted border-b px-3 py-2 align-top"
        {...props}
      />
    ),

    blockquote: (props) => (
      <blockquote
        className="reading-muted border-rule-strong my-6 border-l-2 pl-4 italic"
        {...props}
      />
    ),

    Callout,
    NotThis,
    ...components,
  };
}
