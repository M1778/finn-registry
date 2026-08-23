"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Search } from "lucide-react";
import { ALL_DOCS, DOCS_NAV, type DocEntry } from "./docs-nav";

/**
 * The docs index: a ruled table of contents with a filter above it.
 *
 * This replaces a ⌘K command palette that indexed the full text of every page
 * through Fuse.js. Ten pages do not need a modal, and full-text indexing meant
 * shipping the entire documentation set to the browser to render one page of it.
 * Typing narrows the index in place; clearing the field restores it.
 *
 * Matching includes each entry's `keywords`, which deliberately name things the
 * product does not have — `finn publish`, `api keys` — so that searching for one
 * lands on the page explaining why. When that is why an entry matched, the index
 * says so rather than leaving the result looking arbitrary.
 */
export default function DocsIndex() {
  const pathname = usePathname();
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const results = useMemo(() => (q ? match(q) : null), [q]);

  return (
    <>
      <form role="search" onSubmit={(e) => e.preventDefault()}>
        <label htmlFor="docs-filter" className="eyebrow mb-2 block">
          Filter
        </label>
        <div className="relative">
          <Search
            className="text-ink-faint pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            aria-hidden
          />
          <input
            id="docs-filter"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="trust, finn add…"
            autoComplete="off"
            spellCheck={false}
            className="bg-recessed border-rule rounded-document focus:border-rule-strong h-10 w-full border pr-3 pl-9 text-sm transition-colors outline-none"
          />
        </div>
      </form>

      {results ? (
        <div className="mt-6" aria-live="polite">
          {results.length === 0 ? (
            <p className="reading-muted text-sm">
              No page covers that. The index is short — try{" "}
              <button
                type="button"
                onClick={() => setQuery("trust")}
                className="text-ink underline decoration-dotted underline-offset-4"
              >
                trust
              </button>
              ,{" "}
              <button
                type="button"
                onClick={() => setQuery("register")}
                className="text-ink underline decoration-dotted underline-offset-4"
              >
                register
              </button>{" "}
              or{" "}
              <button
                type="button"
                onClick={() => setQuery("api")}
                className="text-ink underline decoration-dotted underline-offset-4"
              >
                api
              </button>
              .
            </p>
          ) : (
            <ul className="space-y-0">
              {results.map((result, i) => (
                <li key={result.entry.href} className={i > 0 ? "rule-top" : ""}>
                  <Link
                    href={result.entry.href}
                    onClick={() => setQuery("")}
                    className="group block py-2.5"
                  >
                    <span className="eyebrow block">{result.entry.group}</span>
                    <span className="text-ink group-hover:text-ink mt-1 block text-sm font-medium">
                      {result.entry.title}
                    </span>
                    <span className="text-ink-muted mt-0.5 block text-xs leading-snug">
                      {result.entry.summary}
                    </span>
                    {result.via ? (
                      <span className="identifier text-ink-faint mt-1 block text-[11px]">
                        covers “{result.via}”
                      </span>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <nav aria-label="Documentation" className="mt-8 space-y-7">
          {DOCS_NAV.map((group) => (
            <div key={group.title}>
              <h2 className="eyebrow">{group.title}</h2>
              <ul className="mt-3 space-y-0.5">
                {group.entries.map((entry) => {
                  const active = pathname === entry.href;
                  return (
                    <li key={entry.href}>
                      <Link
                        href={entry.href}
                        aria-current={active ? "page" : undefined}
                        className={`-ml-px block border-l py-1.5 pl-3 text-sm transition-colors ${
                          active
                            ? "border-ink text-ink font-medium"
                            : "border-rule text-ink-muted hover:border-rule-strong hover:text-ink"
                        }`}
                      >
                        {entry.title}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      )}
    </>
  );
}

interface Result {
  entry: DocEntry & { group: string };
  /** The keyword that matched, when the title and summary did not. */
  via?: string;
  rank: number;
}

/**
 * Every whitespace-separated token must appear somewhere in the entry. Ranking
 * puts title matches above keyword matches above summary matches, which is the
 * order a reader scanning a short list expects.
 */
function match(q: string): Result[] {
  const tokens = q.split(/\s+/).filter(Boolean);

  return ALL_DOCS.map((entry): Result | null => {
    const title = entry.title.toLowerCase();
    const summary = entry.summary.toLowerCase();
    const group = entry.group.toLowerCase();
    const keywords = (entry.keywords ?? []).map((k) => k.toLowerCase());

    const hit = (t: string) =>
      title.includes(t) ||
      summary.includes(t) ||
      group.includes(t) ||
      keywords.some((k) => k.includes(t));

    if (!tokens.every(hit)) return null;

    const rank = title.startsWith(q)
      ? 0
      : title.includes(q)
        ? 1
        : keywords.some((k) => k.includes(q))
          ? 2
          : 3;

    const via =
      rank === 2 && !title.includes(q) && !summary.includes(q)
        ? entry.keywords?.find((k) => k.toLowerCase().includes(q))
        : undefined;

    return { entry, via, rank };
  })
    .filter((r): r is Result => r !== null)
    .sort(
      (a, b) => a.rank - b.rank || a.entry.title.localeCompare(b.entry.title),
    );
}
