"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import EntryRow, { toEntry } from "@/components/registry/EntryRow";
import type { PackageSummary } from "@/app/api/[[...route]]/serializers";

/**
 * The entries attributed to a publisher, with a client-side filter.
 *
 * The rows arrive already serialized from the server, so they are in the HTML a
 * crawler sees. Only the filter needs a browser, and it filters what is already
 * on the page rather than re-querying — a publisher's list is bounded and a
 * round trip per keystroke would spend requests we do not have (ADR-0005).
 */
export default function PublisherEntries({ items }: { items: PackageSummary[] }) {
  const [filter, setFilter] = useState("");

  const entries = useMemo(() => items.map(toEntry), [items]);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter(
      (e) =>
        e.name.toLowerCase().includes(needle) ||
        e.description?.toLowerCase().includes(needle),
    );
  }, [entries, filter]);

  return (
    <section aria-labelledby="entries-heading" className="mt-10">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <h2 id="entries-heading" className="text-2xl">
          Entries
        </h2>

        {entries.length > 4 ? (
          <div className="relative w-full sm:w-72">
            <label htmlFor="filter-entries" className="sr-only">
              Filter this publisher&rsquo;s entries
            </label>
            <Search
              className="text-ink-faint pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
              aria-hidden
            />
            <input
              id="filter-entries"
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by name"
              autoComplete="off"
              spellCheck={false}
              className="identifier bg-recessed border-rule rounded-document focus:border-rule-strong h-10 w-full border pr-3 pl-9 text-sm transition-colors outline-none"
            />
          </div>
        ) : null}
      </div>

      <div className="record overflow-hidden">
        {entries.length === 0 ? (
          <p className="text-ink-muted px-4 py-10 text-center text-sm">
            No entries attributed to this account.
          </p>
        ) : shown.length === 0 ? (
          <p className="text-ink-muted px-4 py-10 text-center text-sm">
            Nothing here matches &ldquo;{filter.trim()}&rdquo;.
          </p>
        ) : (
          <ul>
            {shown.map((entry) => (
              <EntryRow key={entry.name} entry={entry} />
            ))}
          </ul>
        )}
      </div>

      <p className="eyebrow rule-top mt-6 pt-4">
        Each entry points at a GitHub repository. The registry records the claim;
        GitHub serves the code.
      </p>
    </section>
  );
}
