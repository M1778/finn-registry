import Link from "next/link";
import Seal from "@/components/registry/Seal";
import type { TrustLevel } from "@/types/registry";

/**
 * One row of the register. Shared by the landing-page ledger and the browse
 * page so an entry looks the same everywhere it appears.
 */
export interface Entry {
  name: string;
  description?: string | null;
  /** null when nothing has been released. Never substitute a default. */
  version?: string | null;
  trust: TrustLevel;
  withdrawn?: boolean;
  registeredAt?: string | null;
}

/**
 * Normalizes the several shapes the API has returned over time into one Entry.
 *
 * `/api/packages` is CLI-facing and so is snake_case with a nested `trust`
 * object (contract §3.1). `/api/stats` is browser-only and returns camelCase
 * Drizzle columns. Older rows carry a single `isVerified` boolean, which meant
 * the *package* was vouched for — the glossary calls that trusted, never
 * verified, so it can only ever map to `"trusted"`.
 */
export function toEntry(row: {
  name: string;
  description?: string | null;
  latestVersion?: string | null;
  latest_version?: string | null;
  isVerified?: boolean | number;
  isTrusted?: boolean | number;
  publisherVerified?: boolean | number;
  is_deprecated?: boolean;
  isDeprecated?: boolean | number;
  trust?: { level?: TrustLevel };
  trustLevel?: TrustLevel;
  createdAt?: string | null;
  created_at?: string | null;
}): Entry {
  return {
    name: row.name,
    description: row.description ?? null,
    version: row.latest_version ?? row.latestVersion ?? null,
    trust: row.trust?.level ?? row.trustLevel ?? deriveLevel(row),
    withdrawn: Boolean(row.is_deprecated ?? row.isDeprecated),
    registeredAt: row.created_at ?? row.createdAt ?? null,
  };
}

/** Last resort, for responses that send raw signals instead of a level. */
function deriveLevel(row: {
  publisherVerified?: boolean | number;
  isTrusted?: boolean | number;
  isVerified?: boolean | number;
}): TrustLevel {
  if (row.publisherVerified) return "verified";
  if (row.isTrusted || row.isVerified) return "trusted";
  return "recognized";
}

function formatDate(iso?: string | null) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString("en-CA", { timeZone: "UTC" });
}

export default function EntryRow({ entry }: { entry: Entry }) {
  return (
    <li className="rule-top first:border-t-0">
      <Link
        href={`/package/${encodeURIComponent(entry.name)}`}
        className="hover:bg-accent/60 grid grid-cols-1 gap-x-4 gap-y-1 px-4 py-3 transition-colors sm:grid-cols-[1fr_auto_auto] sm:items-center"
      >
        <div className="min-w-0">
          <span className="identifier text-ink block truncate text-sm font-medium">
            {entry.name}
          </span>
          {entry.description ? (
            <span className="reading-muted mt-0.5 block truncate text-sm">
              {entry.description}
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-3 sm:justify-end">
          {entry.version ? (
            <span className="identifier text-ink-muted text-xs">
              {entry.version}
            </span>
          ) : (
            <span className="text-ink-faint text-xs">no release</span>
          )}
          <Seal kind={entry.withdrawn ? "withdrawn" : entry.trust} />
        </div>

        <span className="identifier text-ink-faint hidden text-xs sm:inline sm:w-24 sm:text-right">
          {formatDate(entry.registeredAt)}
        </span>
      </Link>
    </li>
  );
}
