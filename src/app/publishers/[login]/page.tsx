import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import Seal, { SEAL_MEANING } from "@/components/registry/Seal";
import { findPublisher } from "@/lib/registry/queries";
import PublisherEntries from "./PublisherEntries";

/**
 * The other half of a countersignature: who signed.
 *
 * A package page answers "what does this name point at". This page answers
 * "who stands behind these names" — so it is laid out as a signatory block
 * above the entries attributed to that signatory, not as a social profile.
 *
 * Everything shown here is recorded. There are no download or star totals: the
 * registry records neither (ADR-0001, §4.2), and a profile is the most tempting
 * place in the product to invent them.
 *
 * `force-dynamic` because a signatory's list of entries is not a build-time
 * constant — it changes the moment they claim or withdraw a name — and it must
 * never be served from a stale prerender. The read goes straight to D1 rather
 * than to our own HTTP API, which is one Cloudflare request per view instead of
 * two (ADR-0005, §3.8).
 */
export const dynamic = "force-dynamic";

function formatDate(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString("en-CA", { timeZone: "UTC" });
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rule-top pt-3">
      <dt className="eyebrow">{label}</dt>
      <dd className="text-ink mt-1.5 text-sm">{children}</dd>
    </div>
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ login: string }>;
}): Promise<Metadata> {
  const { login } = await params;
  const found = await findPublisher(login);

  // As on a package page: the "no signatory" panel below is a real destination
  // and still renders at 200, but there is no publisher here to index.
  if (!found) {
    return {
      title: `${login} — not on the register`,
      description: `Nothing on the Finn register is attributed to ${login}.`,
      robots: { index: false },
    };
  }

  const held = found.total === 1 ? "1 entry" : `${found.total} entries`;

  return {
    // The login, as written on the entries they signed.
    title: found.profile.login,
    description: `${found.profile.login} holds ${held} on the Finn register.`,
  };
}

export default async function PublisherPage({
  params,
}: {
  params: Promise<{ login: string }>;
}) {
  const { login } = await params;
  const found = await findPublisher(login);

  // No profile means no publisher: by the glossary, a publisher is an account
  // that has registered something. An account that has not is simply not on the
  // register, and saying so is more useful than "user not found".
  if (!found) {
    return (
      <div className="mx-auto max-w-lg px-6 py-24">
        <section className="record overflow-hidden">
          <div className="bg-recessed px-4 py-2.5">
            <p className="eyebrow">No signatory</p>
          </div>
          <div className="space-y-4 px-4 py-6">
            <h1 className="identifier text-2xl">{login}</h1>
            <p className="reading-muted text-sm">
              Nothing on the register is attributed to this account. It may
              exist on GitHub — the registry only knows accounts that have
              claimed a package name here.
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <a
                href={`https://github.com/${encodeURIComponent(login)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-document border-rule hover:border-rule-strong inline-flex items-center gap-1.5 border px-3.5 py-2 text-sm font-medium transition-colors"
              >
                Look them up on GitHub
                <ArrowUpRight className="size-3.5" aria-hidden />
              </a>
              <Link
                href="/explore"
                className="rounded-document text-ink-muted hover:text-ink px-3.5 py-2 text-sm font-medium transition-colors"
              >
                Browse the register
              </Link>
            </div>
          </div>
        </section>
      </div>
    );
  }

  const profile = found.profile;
  const name = profile.display_name ?? profile.login;
  const joined = formatDate(profile.created_at);

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <nav aria-label="Breadcrumb" className="eyebrow mb-6">
        <Link href="/explore" className="hover:text-ink transition-colors">
          Register
        </Link>
        <span className="mx-2">/</span>
        <span className="text-ink-muted">{profile.login}</span>
      </nav>

      <section className="record overflow-hidden" aria-label="Signatory">
        <div className="bg-recessed flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
          <p className="eyebrow">
            Signatory · {profile.kind === "organization" ? "Organisation" : "Person"}
          </p>
          {profile.is_verified ? <Seal kind="verified" /> : null}
        </div>

        <div className="flex flex-wrap items-start gap-x-6 gap-y-5 px-4 pt-6 pb-6 sm:flex-nowrap">
          {/* Square, like every other record. A rounded avatar would be the one
              circle in a system where only seals are round. */}
          {profile.avatar_url ? (
            <img
              src={profile.avatar_url}
              alt=""
              width={72}
              height={72}
              className="border-rule rounded-document size-16 shrink-0 border object-cover sm:size-18"
            />
          ) : null}

          <div className="min-w-0 flex-1">
            {/* The signature line: the login written large above a rule, the
                way a signatory writes their name on a document. */}
            <h1 className="identifier text-ink truncate text-3xl leading-none font-medium sm:text-4xl">
              {profile.login}
            </h1>
            {name !== profile.login ? (
              <p className="reading-muted mt-3 text-base">{name}</p>
            ) : null}
          </div>

          <div className="shrink-0 sm:text-right">
            <p className="eyebrow">On the register</p>
            <p className="identifier text-ink mt-1 text-2xl leading-none">
              {found.items.length}
            </p>
          </div>
        </div>

        <dl className="grid grid-cols-1 gap-x-8 px-4 pb-4 sm:grid-cols-2">
          <Field label="Verification">
            {profile.is_verified ? (
              <span className="reading-muted">{SEAL_MEANING.verified}</span>
            ) : (
              <span className="reading-muted">
                Not verified. That is the ordinary state — verification confirms
                identity, and says nothing about the quality of anything they
                registered.
              </span>
            )}
          </Field>

          <Field label="GitHub">
            <a
              href={`https://github.com/${encodeURIComponent(profile.login)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="identifier text-ink hover:decoration-ink-faint inline-flex items-center gap-1.5 underline decoration-transparent underline-offset-4 transition-colors"
            >
              github.com/{profile.login}
              <ArrowUpRight className="size-3.5 shrink-0" aria-hidden />
            </a>
          </Field>

          {joined ? (
            <Field label="Signed up">
              <span className="identifier text-ink-muted">{joined}</span>
            </Field>
          ) : null}
        </dl>
      </section>

      <PublisherEntries items={found.items} />
    </div>
  );
}
