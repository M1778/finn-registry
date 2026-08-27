import type { Metadata } from "next";
import Link from "next/link";
import { and, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { ExternalLink } from "lucide-react";
import Seal from "@/components/registry/Seal";
import { getDb } from "@/lib/db";
import { packages, reviewMinutes, users, verificationRequests } from "@/lib/db/schema";
import { deriveTrustLevel, REPO_OWNERSHIP_CONFIRMED } from "@/lib/trust";
import { getViewer, isAdmin, isModerator } from "@/lib/viewer";
import {
  approveVerification,
  refuseVerification,
  setPackageTrust,
} from "./actions";

/**
 * The reviewers' bench.
 *
 * Two judgements are made here and they are not the same judgement (ADR-0003):
 * an admin rules on *who someone is*, and a moderator vouches for *one package*.
 * The page keeps them in separate sections with separate wording because the
 * single most common way to break this register is to conflate them.
 *
 * Every row states the consequence of the button next to it before you press it.
 * Approving a request is retroactive — it lifts every name the account already
 * holds — and a reviewer who cannot see that on the row will eventually approve
 * something they did not mean to.
 */

export const metadata: Metadata = {
  title: "Reviewers' bench",
  robots: { index: false, follow: false },
};

// A queue is never a build-time constant, and a stale one would show work that
// has already been done to the next reviewer.
export const dynamic = "force-dynamic";

const TRUST_PAGE_SIZE = 40;

function formatDate(raw: string | null) {
  if (!raw) return null;
  // Stored timestamps are SQLite's `CURRENT_TIMESTAMP` — UTC, but with no `T`
  // and no zone, which `new Date()` would read as local time.
  const iso = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(raw);
  const d = new Date(iso ? `${iso[1]}T${iso[2]}Z` : raw);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString("en-CA", { timeZone: "UTC" });
}

function Refusal({ heading, body }: { heading: string; body: string }) {
  return (
    <div className="mx-auto max-w-lg px-6 py-24">
      <section className="record overflow-hidden">
        <div className="bg-recessed px-4 py-2.5">
          <p className="eyebrow">Not your page</p>
        </div>
        <div className="space-y-3 px-4 py-6">
          <h1 className="text-xl">{heading}</h1>
          <p className="reading-muted text-sm">{body}</p>
          <p className="eyebrow pt-2">
            <Link href="/explore" className="hover:text-ink">
              Browse the register →
            </Link>
          </p>
        </div>
      </section>
    </div>
  );
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const viewer = await getViewer();

  if (!viewer) {
    return (
      <Refusal
        heading="Sign in first."
        body="This is where reviewers rule on verification requests and vouch for packages. We need to know who you are before we can tell you whether it is yours."
      />
    );
  }

  if (!isModerator(viewer)) {
    return (
      <Refusal
        heading="This bench is for reviewers."
        body="Moderators vouch for packages; admins verify publishers. Neither role is applied for — moderators are people the community already trusts. Nothing about your own account or your entries depends on this page."
      />
    );
  }

  const { q } = await searchParams;
  const query = (q ?? "").trim();
  const db = getDb();

  // The queue, oldest first: a request that has waited longest is the one to
  // rule on next.
  const pending = isAdmin(viewer)
    ? await db
        .select({
          id: verificationRequests.id,
          note: verificationRequests.note,
          createdAt: verificationRequests.createdAt,
          userId: users.id,
          login: users.login,
          name: users.name,
          avatarUrl: users.avatarUrl,
          joinedAt: users.createdAt,
        })
        .from(verificationRequests)
        .innerJoin(users, eq(verificationRequests.userId, users.id))
        .where(eq(verificationRequests.status, "pending"))
        .orderBy(verificationRequests.createdAt)
        .limit(50)
    : [];

  // What each applicant already holds. One query for the whole queue, because
  // one per row is how a 10 ms CPU budget gets spent (ADR-0005).
  const applicantIds = pending.map((p) => p.userId);
  const heldNames = applicantIds.length
    ? await db
        .select({ ownerId: packages.ownerId, name: packages.name })
        .from(packages)
        .where(inArray(packages.ownerId, applicantIds))
    : [];

  const held = new Map<string, string[]>();
  for (const row of heldNames) {
    held.set(row.ownerId, [...(held.get(row.ownerId) ?? []), row.name]);
  }

  const bench = await db
    .select({
      id: packages.id,
      name: packages.name,
      description: packages.description,
      repoUrl: packages.repoUrl,
      isTrusted: packages.isTrusted,
      isDeprecated: packages.isDeprecated,
      ownerLogin: users.login,
      publisherVerified: users.isVerified,
    })
    .from(packages)
    .innerJoin(users, eq(packages.ownerId, users.id))
    .where(
      query
        ? or(
            like(packages.name, `%${query}%`),
            like(packages.description, `%${query}%`),
          )
        : undefined,
    )
    // Unvouched first: the work is the packages nobody has looked at.
    .orderBy(sql`${packages.isTrusted} asc`, desc(packages.createdAt))
    .limit(TRUST_PAGE_SIZE);

  // Who vouched for the entries that already carry a vouch, so a reviewer can
  // see whether they are about to overrule a colleague. One query for the whole
  // page — one per row is how a 10 ms CPU budget gets spent (ADR-0005) — and the
  // page is already capped at TRUST_PAGE_SIZE rows.
  const vouchedIds = bench.filter((pkg) => pkg.isTrusted).map((pkg) => pkg.id);
  const vouchMinutes = vouchedIds.length
    ? await db
        .select({
          packageId: reviewMinutes.subjectPackageId,
          reviewerLogin: users.login,
          createdAt: reviewMinutes.createdAt,
        })
        .from(reviewMinutes)
        .innerJoin(users, eq(reviewMinutes.reviewerId, users.id))
        .where(
          and(
            eq(reviewMinutes.action, "package_vouched"),
            inArray(reviewMinutes.subjectPackageId, vouchedIds),
          ),
        )
        // Newest first, so the first minute seen for a package is the one that
        // stands: a vouch taken back and given again is two minutes, and it is
        // the latest reviewer who is answerable for the current state.
        .orderBy(desc(reviewMinutes.createdAt))
    : [];

  const vouchedBy = new Map<string, { login: string; on: string | null }>();
  for (const minute of vouchMinutes) {
    if (!minute.packageId || vouchedBy.has(minute.packageId)) continue;
    vouchedBy.set(minute.packageId, {
      login: minute.reviewerLogin,
      on: formatDate(minute.createdAt),
    });
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <p className="eyebrow">Reviewers&rsquo; bench</p>
      <h1 className="mt-2 text-3xl sm:text-4xl">
        Two judgements, kept apart
      </h1>
      <p className="reading-muted mt-3 max-w-2xl">
        You are signed in as{" "}
        <span className="identifier text-ink">{viewer.login}</span>, a{" "}
        {viewer.role}. Verifying a publisher settles who someone is. Vouching for
        a package says one package is worth trusting. A reviewer who treats those
        as the same thing is the failure this register is built to avoid —{" "}
        <Link
          href="/docs/trust"
          className="underline decoration-transparent underline-offset-4 transition-colors hover:decoration-current"
        >
          what each seal asserts
        </Link>
        .
      </p>

      {/* ---------------------------------------------------------------- */}
      <section aria-labelledby="queue" className="mt-12">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h2 id="queue" className="text-2xl">
            Verification requests
          </h2>
          {isAdmin(viewer) ? (
            <span className="eyebrow">
              {pending.length} waiting
            </span>
          ) : null}
        </div>

        {!isAdmin(viewer) ? (
          <div className="record px-4 py-8 text-center">
            <p className="text-ink-muted text-sm">
              Admins rule on identity. As a moderator you vouch for packages,
              below.
            </p>
          </div>
        ) : pending.length === 0 ? (
          <div className="record px-4 py-10 text-center">
            <p className="text-ink font-medium">The queue is empty.</p>
            <p className="reading-muted mx-auto mt-2 max-w-sm text-sm">
              Publishers ask to be verified from their own account page. Nothing
              is queued right now.
            </p>
          </div>
        ) : (
          <ul className="space-y-6">
            {pending.map((request) => {
              const names = held.get(request.userId) ?? [];
              return (
                <li key={request.id} className="record overflow-hidden">
                  <div className="bg-recessed flex items-baseline justify-between gap-4 px-4 py-2.5">
                    <p className="eyebrow">Request</p>
                    <p className="eyebrow">
                      Filed {formatDate(request.createdAt) ?? "unknown"}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-start gap-4 px-4 py-5">
                    {request.avatarUrl ? (
                      <img
                        src={request.avatarUrl}
                        alt=""
                        width={48}
                        height={48}
                        className="border-rule rounded-document size-12 shrink-0 border"
                      />
                    ) : null}
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/publishers/${encodeURIComponent(request.login)}`}
                        className="identifier text-ink text-lg underline decoration-transparent underline-offset-4 transition-colors hover:decoration-current"
                      >
                        {request.login}
                      </Link>
                      {request.name && request.name !== request.login ? (
                        <p className="reading-muted text-sm">{request.name}</p>
                      ) : null}
                      <p className="eyebrow mt-2">
                        Signing since {formatDate(request.joinedAt) ?? "unknown"}
                      </p>
                    </div>
                  </div>

                  <div className="rule-top px-4 py-5">
                    <p className="eyebrow mb-2">What they submitted</p>
                    {request.note ? (
                      <div className="well p-3">
                        <p className="reading text-sm whitespace-pre-wrap">
                          {request.note}
                        </p>
                      </div>
                    ) : (
                      <p className="text-ink-faint text-sm">
                        Nothing. That is not disqualifying, but there is nothing
                        here for you to check either.
                      </p>
                    )}
                  </div>

                  <div className="rule-top px-4 py-5">
                    <p className="eyebrow mb-2">What approving would do</p>
                    {names.length === 0 ? (
                      <p className="reading-muted text-sm">
                        This account holds no names, so approving changes nothing
                        on the register today — it applies to whatever they
                        register next.
                      </p>
                    ) : (
                      <p className="reading-muted text-sm">
                        Lift {names.length}{" "}
                        {names.length === 1 ? "entry" : "entries"} to{" "}
                        <span className="text-ink">Verified publisher</span>,
                        retroactively:{" "}
                        {names.map((name, i) => (
                          <span key={name}>
                            {i > 0 ? ", " : ""}
                            <Link
                              href={`/package/${encodeURIComponent(name)}`}
                              className="identifier text-ink underline decoration-transparent underline-offset-4 transition-colors hover:decoration-current"
                            >
                              {name}
                            </Link>
                          </span>
                        ))}
                        .
                      </p>
                    )}
                  </div>

                  <div className="rule-top grid gap-4 px-4 py-5 sm:grid-cols-2">
                    <form action={approveVerification} className="flex items-start">
                      <input type="hidden" name="requestId" value={request.id} />
                      <input type="hidden" name="userId" value={request.userId} />
                      <button
                        type="submit"
                        className="bg-primary text-primary-foreground rounded-document px-3.5 py-2 text-sm font-medium transition-opacity hover:opacity-90"
                      >
                        Verify {request.login}
                      </button>
                    </form>

                    <form action={refuseVerification} className="space-y-2">
                      <input type="hidden" name="requestId" value={request.id} />
                      <label
                        htmlFor={`reason-${request.id}`}
                        className="eyebrow block"
                      >
                        Reason, if you refuse
                      </label>
                      <textarea
                        id={`reason-${request.id}`}
                        name="reason"
                        required
                        rows={2}
                        maxLength={1000}
                        placeholder="What they would need to show for this to be approvable."
                        className="bg-recessed border-rule rounded-document focus:border-rule-strong w-full resize-none border px-3 py-2 text-sm transition-colors outline-none"
                      />
                      <button
                        type="submit"
                        className="rounded-document border-oxblood/50 text-oxblood hover:border-oxblood border px-3.5 py-2 text-sm font-medium transition-colors"
                      >
                        Refuse
                      </button>
                    </form>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      <section aria-labelledby="trust" className="mt-16">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h2 id="trust" className="text-2xl">
            Package trust
          </h2>
          <span className="eyebrow">
            {bench.length === TRUST_PAGE_SIZE
              ? `first ${TRUST_PAGE_SIZE}`
              : `${bench.length} shown`}
          </span>
        </div>

        <p className="reading-muted mb-6 max-w-2xl text-sm">
          Vouching says a moderator read this package and stands behind it on its
          own merits. It says nothing about who published it, and it does not
          need a verified publisher. Unvouched entries come first, because those
          are the ones nobody has looked at.
        </p>

        <form method="get" className="mb-6">
          <label htmlFor="bench-search" className="eyebrow mb-2 block">
            Find a package
          </label>
          <div className="flex gap-2">
            <input
              id="bench-search"
              name="q"
              type="search"
              defaultValue={query}
              placeholder="http"
              autoComplete="off"
              spellCheck={false}
              className="identifier bg-recessed border-rule rounded-document focus:border-rule-strong h-11 w-full max-w-md border px-3 text-sm transition-colors outline-none"
            />
            <button
              type="submit"
              className="rounded-document border-rule hover:border-rule-strong h-11 shrink-0 border px-3.5 text-sm font-medium transition-colors"
            >
              Search
            </button>
          </div>
        </form>

        <div className="record overflow-hidden">
          {bench.length === 0 ? (
            <p className="text-ink-muted px-4 py-10 text-center text-sm">
              {query
                ? `Nothing on the register matches “${query}”.`
                : "The register is empty."}
            </p>
          ) : (
            <ul>
              {bench.map((pkg) => {
                // A real row's real level, stamped as a seal a moderator rules
                // on, so the signal comes from the one definition rather than a
                // literal that could drift from the API's.
                const level = deriveTrustLevel({
                  publisherVerified: pkg.publisherVerified,
                  packageTrusted: pkg.isTrusted,
                  repoOwnershipConfirmed: REPO_OWNERSHIP_CONFIRMED,
                });
                // Every vouch that predates the minutes has no author on record,
                // which is the honest thing to say rather than leaving the line
                // blank as though nobody had ruled.
                const vouch = pkg.isTrusted ? vouchedBy.get(pkg.id) : undefined;
                return (
                  <li
                    key={pkg.id}
                    className="rule-top grid grid-cols-1 gap-x-4 gap-y-3 px-4 py-4 first:border-t-0 sm:grid-cols-[1fr_auto] sm:items-center"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-3">
                        <Link
                          href={`/package/${encodeURIComponent(pkg.name)}`}
                          className="identifier text-ink text-sm font-medium underline decoration-transparent underline-offset-4 transition-colors hover:decoration-current"
                        >
                          {pkg.name}
                        </Link>
                        <Seal kind={pkg.isDeprecated ? "withdrawn" : level} />
                      </div>
                      {pkg.description ? (
                        <p className="reading-muted mt-1 truncate text-sm">
                          {pkg.description}
                        </p>
                      ) : null}
                      <p className="eyebrow mt-1.5 flex flex-wrap items-center gap-3">
                        <span>{pkg.ownerLogin}</span>
                        <a
                          href={pkg.repoUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-ink inline-flex items-center gap-1 transition-colors"
                        >
                          read the code
                          <ExternalLink className="size-3" aria-hidden />
                        </a>
                        {pkg.isTrusted ? (
                          <span>
                            {vouch
                              ? `Vouched by ${vouch.login}${vouch.on ? ` on ${vouch.on}` : ""}`
                              : "Vouched before this register kept minutes"}
                          </span>
                        ) : null}
                      </p>
                    </div>

                    <form action={setPackageTrust} className="sm:justify-self-end">
                      <input type="hidden" name="packageId" value={pkg.id} />
                      <input
                        type="hidden"
                        name="trusted"
                        value={pkg.isTrusted ? "false" : "true"}
                      />
                      <button
                        type="submit"
                        className="rounded-document border-rule hover:border-rule-strong border px-3 py-1.5 text-sm font-medium transition-colors"
                      >
                        {pkg.isTrusted ? "Take back the vouch" : "Vouch for it"}
                      </button>
                    </form>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <p className="reading-muted mt-4 text-sm">
          Withdrawing a package is the publisher&rsquo;s decision, not yours, so
          there is no control for it here.
        </p>
      </section>
    </div>
  );
}
