"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import EntryRow, { toEntry, type Entry } from "@/components/registry/EntryRow";

/**
 * The register, as a register: ruled rows, not a card grid.
 *
 * Deliberately shows no download count. Nothing increments one yet
 * (docs/REGISTRY-CONTRACT.md §4.2 is still open), and ranking by a number
 * nobody measures is the same kind of fiction as a default version.
 */
export default function Ledger() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/stats")
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json();
      })
      .then((data) => {
        if (!live) return;
        const rows = Array.isArray(data?.recentPackages)
          ? data.recentPackages
          : [];
        setEntries(rows.map(toEntry));
        setTotal(
          typeof data?.totalPackages === "number" ? data.totalPackages : null,
        );
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);

  return (
    <section aria-labelledby="ledger-heading">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h2 id="ledger-heading" className="text-2xl">
          Recently registered
        </h2>
        <div className="flex items-baseline gap-4">
          {total !== null ? (
            <span className="eyebrow">
              {total} {total === 1 ? "entry" : "entries"}
            </span>
          ) : null}
          <Link
            href="/explore"
            className="text-ink-muted hover:text-ink text-sm underline decoration-transparent underline-offset-4 transition-colors hover:decoration-current"
          >
            Browse the register
          </Link>
        </div>
      </div>

      <div className="record overflow-hidden">
        {failed ? (
          <p className="text-ink-muted px-4 py-8 text-center text-sm">
            The register is unreachable right now. Reload to try again.
          </p>
        ) : entries === null ? (
          <ul aria-busy="true">
            {[0, 1, 2, 3, 4].map((i) => (
              <li key={i} className="rule-top first:border-t-0 px-4 py-3">
                <div className="bg-muted h-4 w-40 animate-pulse rounded-xs" />
              </li>
            ))}
          </ul>
        ) : entries.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-ink font-medium">The register is empty.</p>
            <p className="reading-muted mx-auto mt-2 max-w-sm text-sm">
              The first entry can be yours. If you have push access to a Finn
              package on GitHub, you can claim its name.
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
    </section>
  );
}
