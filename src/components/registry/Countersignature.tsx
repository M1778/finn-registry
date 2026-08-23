import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import Seal from "@/components/registry/Seal";
import { cn } from "@/lib/utils";
import type { PackageRecord, VersionRecord } from "@/types/registry";

/**
 * The countersignature block: the one thing this site exists to show.
 *
 * A register entry, laid out as one. The registry does not hold the code — it
 * holds the assertion that this name belongs to this publisher, points at this
 * repository, and resolves to this commit. So the block is a ruled field/value
 * document with a seal stamped in the corner, and it says plainly at the foot
 * where the code actually comes from.
 */

function formatDate(iso: string) {
  // Fixed locale and UTC: a register entry reads the same for every reader, and
  // this renders identically on the server and the client.
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "UTC" });
}

function displayRepo(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/\.git$/, "");
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <>
      <dt className="eyebrow rule-top flex items-center px-4 py-3 sm:border-r sm:border-r-[color:var(--rule)]">
        {label}
      </dt>
      <dd
        className={cn(
          "rule-top flex min-w-0 items-center gap-2 px-4 py-3 text-sm",
          className,
        )}
      >
        {children}
      </dd>
    </>
  );
}

export default function Countersignature({
  pkg,
  version,
  label = "Register entry",
  /**
   * The element the package name is rendered as. It is the page title on a
   * package page, but a specimen on the landing page and a draft on the
   * registration form both sit under an existing h1 — so those pass "p" rather
   * than putting a second h1 in the document.
   */
  nameAs: NameTag = "h1",
  className,
}: {
  pkg: PackageRecord;
  /** The version whose commit and checksum are shown. Omit if none exists. */
  version?: VersionRecord | null;
  /**
   * Header strip wording. Defaults to the real thing; pass "Specimen entry"
   * when showing a form sample rather than a record that exists.
   */
  label?: string;
  nameAs?: "h1" | "h2" | "p";
  className?: string;
}) {
  const sealKind = pkg.is_deprecated ? "withdrawn" : pkg.trust.level;
  const publisherName = pkg.publisher.display_name ?? pkg.publisher.login;

  return (
    <section
      className={cn("record overflow-hidden", className)}
      aria-label={`Register entry for ${pkg.name}`}
    >
      {/* Header strip: what this document is, and the seal stamped on it. */}
      <div className="bg-recessed flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
        <p className="eyebrow">
          {label} · {formatDate(pkg.created_at)}
        </p>
        <Seal kind={sealKind} />
      </div>

      {/* The name, at the size the name deserves. */}
      <div className="rule-top flex flex-wrap items-start justify-between gap-x-8 gap-y-4 px-4 pt-6 pb-5">
        <div className="min-w-0">
          <NameTag className="identifier text-ink text-3xl leading-none font-medium sm:text-4xl">
            {pkg.name}
          </NameTag>
          {pkg.description ? (
            <p className="reading-muted mt-3 max-w-prose text-base">
              {pkg.description}
            </p>
          ) : null}
        </div>

        <div className="shrink-0 sm:text-right">
          <p className="eyebrow">Latest</p>
          {pkg.latest_version ? (
            <p className="identifier text-ink mt-1 text-2xl leading-none">
              {pkg.latest_version}
            </p>
          ) : (
            /* Never fabricate a version. No release means no release. */
            <p className="text-ink-faint mt-1 text-sm">No release yet</p>
          )}
        </div>
      </div>

      {/* The register itself: fields, ruled, in the order a reader verifies them. */}
      <dl className="grid grid-cols-1 sm:grid-cols-[minmax(8rem,10rem)_1fr]">
        <Field label="Publisher">
          <Link
            href={`/publishers/${pkg.publisher.login}`}
            className="identifier text-ink hover:decoration-ink-faint truncate underline decoration-transparent underline-offset-4 transition-colors"
          >
            {pkg.publisher.login}
          </Link>
          {publisherName !== pkg.publisher.login ? (
            <span className="text-ink-faint truncate text-xs">
              {publisherName}
            </span>
          ) : null}
        </Field>

        <Field label="Repository">
          <a
            href={pkg.repo_url}
            target="_blank"
            rel="noopener noreferrer"
            className="identifier text-ink hover:decoration-ink-faint inline-flex min-w-0 items-center gap-1.5 underline decoration-transparent underline-offset-4 transition-colors"
          >
            <span className="truncate">{displayRepo(pkg.repo_url)}</span>
            <ArrowUpRight className="size-3.5 shrink-0" aria-hidden />
          </a>
        </Field>

        <Field label="Commit">
          {version ? (
            <span
              className="identifier text-ink truncate"
              title={version.commit}
            >
              {version.commit.slice(0, 12)}
            </span>
          ) : (
            <span className="text-ink-faint text-sm">—</span>
          )}
        </Field>

        <Field label="Checksum">
          {version?.checksum ? (
            <>
              <span className="identifier text-ink-muted min-w-0 text-xs break-all">
                {version.checksum}
              </span>
              {/* The registry never sees the code, so it can only ever relay a
                  checksum the publisher asserted. Labelled, not implied. */}
              <span className="eyebrow shrink-0">Attested</span>
            </>
          ) : (
            <span className="text-ink-faint text-sm">—</span>
          )}
        </Field>
      </dl>

      {/* The footer answers the one question the record leaves open: what will
          actually be installed. */}
      <p className="rule-top bg-recessed text-ink-faint px-4 py-3 text-sm">
        <span className="reading-muted">
          {version
            ? "finn installs this version from the commit above."
            : "finn installs each version of this package from a tagged commit."}
        </span>
      </p>
    </section>
  );
}
