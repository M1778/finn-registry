import type { Metadata } from "next";
import Link from "next/link";
import { Ban, ExternalLink } from "lucide-react";
import Countersignature from "@/components/registry/Countersignature";
import Seal from "@/components/registry/Seal";
import { findPackage } from "@/lib/registry/queries";
import InstallCommand from "./InstallCommand";
import PackageTabs from "./PackageTabs";

/**
 * A register entry, server-rendered.
 *
 * `force-dynamic` because a register entry is not a build-time constant: a name
 * can be claimed, released against, or withdrawn at any moment, and it must never
 * be served from a stale prerender — a page that says "recognized" after the
 * publisher withdrew the package, or shows a commit that is no longer the latest,
 * is worse than a slow page. It reads D1 directly rather than fetching our own
 * API over HTTP, which is one Cloudflare request per view instead of three
 * (ADR-0005, §3.8).
 */
export const dynamic = "force-dynamic";

function displayRepo(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/\.git$/, "");
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ name: string }>;
}): Promise<Metadata> {
  const { name } = await params;
  const found = await findPackage(name);

  // The page below still renders, at 200, because "no entry" is a real
  // destination and an unclaimed name is a state worth explaining to a human.
  // It is not content, though, so it stays out of the index.
  if (!found) {
    return {
      title: `${name} — not on the register`,
      description: `No package named "${name}" is registered here.`,
      robots: { index: false },
    };
  }

  const pkg = found.record;

  return {
    // The bare name. The browser tab of a register entry should read `http`.
    title: pkg.name,
    description:
      pkg.description ??
      `${pkg.name} is on the register, claimed by ${pkg.publisher.login} and pointing at ${displayRepo(pkg.repo_url)}.`,
  };
}

export default async function PackagePage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const found = await findPackage(name);

  // An unrecognized name is a designed state, not an error page: this is the
  // moment to explain what the register is and offer the claim. Deliberately not
  // `notFound()` — a not-found boundary cannot see the name, and this panel is
  // about the name.
  if (!found) {
    return (
      <div className="mx-auto max-w-lg px-6 py-24">
        <section className="record overflow-hidden">
          <div className="bg-recessed px-4 py-2.5">
            <p className="eyebrow">No entry</p>
          </div>
          <div className="space-y-4 px-4 py-6">
            <h1 className="identifier text-2xl">{name}</h1>
            <p className="reading-muted text-sm">
              This name is not on the register. That does not mean the package
              does not exist — it means nobody has claimed the name here, so the
              registry cannot tell you who owns it or which repository it points
              at.
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <Link
                href="/new"
                className="bg-primary text-primary-foreground rounded-document px-3.5 py-2 text-sm font-medium transition-opacity hover:opacity-90"
              >
                Claim this name
              </Link>
              <Link
                href="/explore"
                className="rounded-document border-rule hover:border-rule-strong border px-3.5 py-2 text-sm font-medium transition-colors"
              >
                Browse the register
              </Link>
            </div>
          </div>
        </section>
      </div>
    );
  }

  const pkg = found.record;
  // The same read `findPackage` derived `latest_version` from, handed back rather
  // than queried again.
  const versions = found.versions;
  const latestRecord =
    versions.find((v) => v.version === pkg.latest_version) ?? versions[0] ?? null;

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <nav aria-label="Breadcrumb" className="eyebrow mb-6">
        <Link href="/explore" className="hover:text-ink transition-colors">
          Register
        </Link>
        <span className="mx-2">/</span>
        <span className="text-ink-muted">{pkg.name}</span>
      </nav>

      {pkg.is_deprecated ? (
        <div className="record border-oxblood/40 mb-6 flex items-start gap-3 p-4">
          <Ban className="text-oxblood mt-0.5 size-4 shrink-0" aria-hidden />
          <div>
            <p className="text-oxblood text-sm font-medium">
              The publisher withdrew this package.
            </p>
            <p className="reading-muted mt-1 text-sm">
              {pkg.deprecation_message ??
                "It stays resolvable for existing lockfiles, but it is no longer recommended for new work."}
            </p>
          </div>
        </div>
      ) : null}

      {/* The page's heading, and now genuinely in the served HTML. */}
      <Countersignature pkg={pkg} version={latestRecord} />

      <div className="mt-10 grid gap-10 lg:grid-cols-[1fr_16rem]">
        <div className="min-w-0">
          <PackageTabs
            repoUrl={pkg.repo_url}
            versions={versions}
            latest={pkg.latest_version}
            latestCommit={latestRecord?.commit ?? null}
          />
        </div>

        <aside className="space-y-6">
          <div>
            <h2 className="eyebrow mb-2">Install</h2>
            <InstallCommand command={`finn add ${pkg.name}`} />
          </div>

          <dl className="space-y-4 text-sm">
            <div>
              <dt className="eyebrow">Trust</dt>
              <dd className="mt-1.5">
                <Seal
                  kind={pkg.is_deprecated ? "withdrawn" : pkg.trust.level}
                />
              </dd>
            </div>

            <div>
              <dt className="eyebrow">License</dt>
              {/* Never default this. An unstated license is not MIT. */}
              <dd className="identifier text-ink mt-1">
                {pkg.license ?? (
                  <span className="text-ink-faint font-[family-name:var(--font-archivo)]">
                    Not stated
                  </span>
                )}
              </dd>
            </div>

            {pkg.homepage ? (
              <div>
                <dt className="eyebrow">Homepage</dt>
                <dd className="mt-1">
                  <a
                    href={pkg.homepage}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-ink inline-flex items-center gap-1.5 text-sm underline decoration-transparent underline-offset-4 transition-colors hover:decoration-current"
                  >
                    <span className="truncate">
                      {pkg.homepage.replace(/^https?:\/\//, "")}
                    </span>
                    <ExternalLink className="size-3 shrink-0" aria-hidden />
                  </a>
                </dd>
              </div>
            ) : null}

            {pkg.keywords.length > 0 ? (
              <div>
                <dt className="eyebrow">Keywords</dt>
                <dd className="mt-1.5 flex flex-wrap gap-1.5">
                  {pkg.keywords.map((k) => (
                    <Link
                      key={k}
                      href={`/explore?q=${encodeURIComponent(k)}`}
                      className="identifier bg-muted text-ink-muted hover:text-ink rounded-xs px-2 py-0.5 text-xs transition-colors"
                    >
                      {k}
                    </Link>
                  ))}
                </dd>
              </div>
            ) : null}
          </dl>

          <div className="rule-top pt-5">
            <a
              href={`${pkg.repo_url.replace(/\.git$/, "")}/issues`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-ink-muted hover:text-ink inline-flex items-center gap-1.5 text-sm transition-colors"
            >
              Report an issue on GitHub
              <ExternalLink className="size-3" aria-hidden />
            </a>
          </div>
        </aside>
      </div>
    </div>
  );
}
