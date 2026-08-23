"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Search } from "lucide-react";
import EntryRow, { toEntry, type Entry } from "@/components/registry/EntryRow";
import type { TrustLevel } from "@/types/registry";

/**
 * The browse controls and the result ledger.
 *
 * Every control here maps to a column that exists. The previous version offered
 * category filters ("Web Frameworks", "Database Drivers") and sorts by downloads
 * and stars — none of which the schema records, so all of them silently did
 * nothing. Filters that cannot filter are worse than no filters.
 *
 * The page's heading and its one-line description live in `page.tsx` on the
 * server. Only the query state needs `useSearchParams`, and that is what forces
 * the Suspense boundary, so keeping the heading out of it means the register has
 * a title and an h1 before any JavaScript runs.
 */

const SORTS = [
  { value: "recent", label: "Recently registered" },
  { value: "updated", label: "Recently updated" },
  { value: "name", label: "Name" },
] as const;

const TRUST_FILTERS: { value: TrustLevel | ""; label: string }[] = [
  { value: "", label: "Any" },
  { value: "verified", label: "Verified publisher" },
  { value: "trusted", label: "Trusted package" },
];

function ExploreContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const query = searchParams.get("q") ?? "";
  const sort = searchParams.get("sort") ?? "recent";
  const trust = searchParams.get("trust") ?? "";

  const [draft, setDraft] = useState(query);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);

  useEffect(() => setDraft(query), [query]);

  useEffect(() => {
    let live = true;
    setEntries(null);

    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (sort) params.set("sort", sort);
    if (trust) params.set("trust", trust);

    fetch(`/api/packages?${params.toString()}`)
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json();
      })
      .then((data) => {
        if (!live) return;
        // Contract §3.5 is {total, items}. Older responses were a bare array.
        const rows = Array.isArray(data) ? data : (data?.items ?? []);
        setEntries(rows.map(toEntry));
        setTotal(typeof data?.total === "number" ? data.total : rows.length);
      })
      .catch(() => {
        if (!live) return;
        setEntries([]);
        setTotal(0);
      });

    return () => {
      live = false;
    };
  }, [query, sort, trust]);

  const setParam = (updates: Record<string, string>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    router.push(`/explore?${params.toString()}`);
  };

  return (
    <>
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setParam({ q: draft.trim() });
        }}
        className="mt-8"
      >
        <label htmlFor="browse-search" className="eyebrow mb-2 block">
          Search names and descriptions
        </label>
        <div className="relative max-w-xl">
          <Search
            className="text-ink-faint pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            aria-hidden
          />
          <input
            id="browse-search"
            type="search"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="http"
            autoComplete="off"
            spellCheck={false}
            className="identifier bg-recessed border-rule rounded-document focus:border-rule-strong h-11 w-full border pr-3 pl-9 text-base transition-colors outline-none"
          />
        </div>
      </form>

      <div className="mt-8 flex flex-wrap items-end gap-x-8 gap-y-4">
        <div>
          <p className="eyebrow mb-2">Sort</p>
          <div className="flex flex-wrap gap-1">
            {SORTS.map((s) => (
              <button
                key={s.value}
                type="button"
                onClick={() => setParam({ sort: s.value })}
                aria-pressed={sort === s.value}
                className={`rounded-document border px-2.5 py-1.5 text-sm transition-colors ${
                  sort === s.value
                    ? "border-rule-strong text-ink bg-accent"
                    : "border-rule text-ink-muted hover:text-ink"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="eyebrow mb-2">Seal</p>
          <div className="flex flex-wrap gap-1">
            {TRUST_FILTERS.map((f) => (
              <button
                key={f.value || "any"}
                type="button"
                onClick={() => setParam({ trust: f.value })}
                aria-pressed={trust === f.value}
                className={`rounded-document border px-2.5 py-1.5 text-sm transition-colors ${
                  trust === f.value
                    ? "border-rule-strong text-ink bg-accent"
                    : "border-rule text-ink-muted hover:text-ink"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="rule-top mt-8 mb-4 flex items-baseline justify-between gap-4 pt-4">
        <p className="eyebrow">
          {entries === null
            ? "Searching"
            : `${total ?? entries.length} ${
                (total ?? entries.length) === 1 ? "entry" : "entries"
              }`}
        </p>
        {query ? (
          <button
            type="button"
            onClick={() => setParam({ q: "", trust: "" })}
            className="text-ink-muted hover:text-ink text-sm transition-colors"
          >
            Clear
          </button>
        ) : null}
      </div>

      <div className="record overflow-hidden">
        {entries === null ? (
          <ul aria-busy="true">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <li key={i} className="rule-top first:border-t-0 px-4 py-3">
                <div className="bg-muted h-4 w-48 animate-pulse rounded-xs" />
              </li>
            ))}
          </ul>
        ) : entries.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-ink font-medium">
              {query ? `Nothing matches “${query}”.` : "The register is empty."}
            </p>
            <p className="reading-muted mx-auto mt-2 max-w-sm text-sm">
              {query
                ? "The package may exist on GitHub without being registered here. Anyone with push access can claim its name."
                : "No names have been claimed yet."}
            </p>
            <Link
              href="/new"
              className="bg-primary text-primary-foreground rounded-document mt-5 inline-block px-3.5 py-2 text-sm font-medium transition-opacity hover:opacity-90"
            >
              Register a package
            </Link>
          </div>
        ) : (
          <ul>
            {entries.map((entry) => (
              <EntryRow key={entry.name} entry={entry} />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

export default function ExploreBrowser() {
  return (
    <Suspense
      fallback={
        <div className="record h-64 animate-pulse" aria-busy="true" />
      }
    >
      <ExploreContent />
    </Suspense>
  );
}
