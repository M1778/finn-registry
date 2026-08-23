"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Github, Loader2 } from "lucide-react";
import EntryRow, { toEntry, type Entry } from "@/components/registry/EntryRow";
import Seal, { SEAL_MEANING } from "@/components/registry/Seal";

/**
 * The publisher's own side of the register.
 *
 * A register keeps two halves of every entry: the public one, and the
 * counterfoil the signatory keeps. That is what this page is — not an analytics
 * dashboard. The registry measures nothing about a package, so there is nothing
 * here to chart, and the four stat tiles that used to sit at the top were
 * measuring either a column nothing writes or someone's GitHub account.
 *
 * What a publisher actually comes here for, in order:
 *
 *   1. their standing — the one thing the register asserts about them, and the
 *      only thing they can act on;
 *   2. the entries they hold, shown with the same row the public register uses,
 *      so a name never looks like two different things in two places;
 *   3. the details we hold on the account;
 *   4. the sign-ins we recorded, because an account that can claim names is
 *      worth being able to audit.
 *
 * No tabs. A register reads top to bottom.
 */

type VerificationStatus = "none" | "pending" | "approved" | "rejected";

interface DashboardUser {
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  role: "user" | "moderator" | "admin";
  isVerified: boolean;
  createdAt: string | null;
}

interface DashboardPackage {
  id: string;
  name: string;
  description: string | null;
  isTrusted: boolean;
  isDeprecated: boolean;
  /** null when nothing has been released under this name. */
  latestVersion: string | null;
  versionCount: number;
  createdAt: string | null;
}

interface LoginRow {
  id: string;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string | null;
}

interface Verification {
  status: VerificationStatus;
  requestedAt: string | null;
  reviewedAt: string | null;
  /**
   * The reviewer's reason, on a request that was refused. Distinct from the note
   * the requester submits — the two used to share one column, so a refusal
   * erased the evidence the account had given for itself.
   */
  reviewerNote: string | null;
}

interface DashboardData {
  user: DashboardUser;
  packages: DashboardPackage[];
  logins: LoginRow[];
  verification: Verification;
}

/** Fixed locale and UTC, matching the register: a date reads the same for every
 *  reader, and renders identically on the server and the client. */
function formatDate(iso: string | null) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString("en-CA", { timeZone: "UTC" });
}

function formatDateTime(iso: string | null) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleString("en-CA", { timeZone: "UTC", timeZoneName: "short" });
}

function Section({
  id,
  title,
  aside,
  children,
}: {
  id: string;
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id}>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 id={id} className="text-2xl">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function SignedOut() {
  return (
    <section className="record overflow-hidden">
      <div className="bg-recessed px-4 py-2.5">
        <p className="eyebrow">Sign in required</p>
      </div>
      <div className="space-y-4 px-4 py-6">
        <h2 className="text-xl">This page is your half of the register.</h2>
        <p className="reading-muted text-sm">
          It shows the entries signed in your name, so we need to know whose name
          that is. Signing in asks GitHub only for your account and email.
        </p>
        {/* A real navigation, not client-side routing: this hands the browser to
            GitHub's OAuth flow via our API route. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a
          href="/api/auth/github"
          className="bg-primary text-primary-foreground rounded-document inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium transition-opacity hover:opacity-90"
        >
          <Github className="size-4" aria-hidden />
          Continue with GitHub
        </a>
      </div>
    </section>
  );
}

/**
 * The standing block.
 *
 * Deliberately shows no seal when an account is not verified. Absence is the
 * honest rendering: there is no "unverified publisher" state to assert, and a
 * badge saying so would make the ordinary case look deficient (globals.css,
 * rule 1 — a passed check is neutral ink, and the floor is not a warning).
 */
function Standing({
  user,
  verification,
  onRequested,
}: {
  user: DashboardUser;
  verification: Verification;
  onRequested: (v: Verification) => void;
}) {
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const joined = formatDate(user.createdAt);

  const ask = async () => {
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/me/verification-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: note.trim() || null }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          data?.message ?? `The request could not be filed (${res.status}).`,
        );
      }
      onRequested({
        status: "pending",
        requestedAt: data?.request?.createdAt ?? null,
        reviewedAt: null,
        reviewerNote: null,
      });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "The request could not be filed.",
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="record overflow-hidden" aria-labelledby="standing">
      <div className="bg-recessed flex items-baseline justify-between gap-4 px-4 py-2.5">
        <h2 id="standing" className="eyebrow">
          Your standing
        </h2>
        {user.role !== "user" ? (
          <span className="eyebrow border-rule rounded-document border px-2 py-0.5">
            {user.role}
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-start gap-4 px-4 py-5 sm:gap-5">
        {user.avatarUrl ? (
          // Square, like every other record. Seals are the only round things.
          <img
            src={user.avatarUrl}
            alt=""
            width={56}
            height={56}
            className="border-rule rounded-document size-14 shrink-0 border"
          />
        ) : null}

        <div className="min-w-0 flex-1">
          <p className="identifier text-ink text-lg">{user.login}</p>
          {user.name && user.name !== user.login ? (
            <p className="reading-muted text-sm">{user.name}</p>
          ) : null}
          {joined ? (
            <p className="eyebrow mt-2">Signing since {joined}</p>
          ) : null}
        </div>

        {user.isVerified ? <Seal kind="verified" /> : null}
      </div>

      <div className="rule-top px-4 py-5">
        {user.isVerified ? (
          <p className="reading-muted text-sm">{SEAL_MEANING.verified}</p>
        ) : verification.status === "pending" ? (
          <>
            <p className="text-ink text-sm">
              Your verification request is with the reviewers.
            </p>
            <p className="reading-muted mt-2 text-sm">
              Filed {formatDate(verification.requestedAt) ?? "recently"}. An
              admin rules on these by hand, so there is no position to show and
              no date we can promise. Nothing about your entries changes while
              you wait — they resolve exactly as they did before.
            </p>
          </>
        ) : (
          <>
            <p className="text-ink text-sm">
              You are not a verified publisher, which is the ordinary state.
            </p>
            <p className="reading-muted mt-2 text-sm">
              Verification is about identity and nothing else: a reviewer
              confirms this account is who it claims to be, and that
              confirmation then travels to everything you register. It is not a
              judgement on your code —{" "}
              <Link
                href="/docs/trust"
                className="underline decoration-transparent underline-offset-4 transition-colors hover:decoration-current"
              >
                a package earns its own seal separately
              </Link>
              .
            </p>

            {verification.status === "rejected" ? (
              <div className="well mt-4 p-3">
                <p className="eyebrow">Last request was refused</p>
                <p className="reading-muted mt-2 text-sm">
                  {verification.reviewerNote ??
                    "No reason was recorded. Asking again is fine."}
                </p>
              </div>
            ) : null}

            <div className="mt-4 space-y-3">
              <label htmlFor="verification-note" className="eyebrow block">
                Anything that ties this account to you (optional)
              </label>
              <textarea
                id="verification-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                maxLength={1000}
                placeholder="A company page that lists you, an email domain you control, a talk you gave — whatever a stranger could check."
                className="bg-recessed border-rule rounded-document focus:border-rule-strong w-full resize-none border px-3 py-2 text-sm transition-colors outline-none"
              />
              {error ? <p className="text-oxblood text-sm">{error}</p> : null}
              <button
                type="button"
                onClick={ask}
                disabled={sending}
                className="bg-primary text-primary-foreground rounded-document inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium transition-opacity hover:opacity-90 disabled:opacity-45"
              >
                {sending ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                    Filing
                  </>
                ) : (
                  "Ask to be verified"
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function Entries({
  packages,
  publisherVerified,
}: {
  packages: DashboardPackage[];
  publisherVerified: boolean;
}) {
  const entries: Entry[] = packages.map((pkg) =>
    toEntry({ ...pkg, publisherVerified }),
  );
  const unreleased = packages.filter((p) => p.latestVersion === null);

  return (
    <Section
      id="entries"
      title="Names you hold"
      aside={
        packages.length > 0 ? (
          <div className="flex items-baseline gap-4">
            <span className="eyebrow">
              {packages.length} {packages.length === 1 ? "entry" : "entries"}
            </span>
            <Link
              href="/new"
              className="text-ink-muted hover:text-ink text-sm underline decoration-transparent underline-offset-4 transition-colors hover:decoration-current"
            >
              Register another
            </Link>
          </div>
        ) : null
      }
    >
      <div className="record overflow-hidden">
        {packages.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-ink font-medium">You hold no names yet.</p>
            <p className="reading-muted mx-auto mt-2 max-w-sm text-sm">
              If you have push access to a Fin package on GitHub, you can claim
              its name. The code stays where it is — we only record that the
              name is yours.
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

      {unreleased.length > 0 ? (
        <p className="reading-muted mt-3 text-sm">
          {unreleased.length === 1 ? (
            <>
              <span className="identifier text-ink">
                {unreleased[0].name}
              </span>{" "}
              has no release recorded, so{" "}
              <span className="identifier">finn add {unreleased[0].name}</span>{" "}
              has nothing to resolve.
            </>
          ) : (
            <>
              {unreleased.length} of these have no release recorded, so there is
              nothing for <span className="identifier">finn add</span> to
              resolve yet.
            </>
          )}{" "}
          <Link
            href="/docs/registering-a-package"
            className="underline decoration-transparent underline-offset-4 transition-colors hover:decoration-current"
          >
            How a release gets recorded
          </Link>
          .
        </p>
      ) : null}
    </Section>
  );
}

/**
 * Account details.
 *
 * Only two fields, and both do something. The row also carries `bio`,
 * `location` and `blog` columns, which are offered nowhere: no page publishes
 * them, and a form that collects what nothing reads is its own small fiction.
 * If publisher pages ever carry a bio, this is where the field goes back.
 */
function Details({
  user,
  onSaved,
}: {
  user: DashboardUser;
  onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setSaving(true);
    setStatus(null);
    const form = new FormData(e.currentTarget);
    try {
      const res = await fetch("/api/me/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: String(form.get("name") ?? "").trim(),
          email: String(form.get("email") ?? "").trim(),
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setFailed(false);
      setStatus("Saved.");
      onSaved();
    } catch {
      setFailed(true);
      setStatus("Nothing was saved. Try again in a moment.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section id="details" title="Account details">
      <form onSubmit={save} className="record overflow-hidden">
        <div className="grid gap-5 px-4 py-5 sm:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="display-name" className="eyebrow block">
              Display name
            </label>
            <input
              id="display-name"
              name="name"
              type="text"
              defaultValue={user.name ?? ""}
              maxLength={120}
              className="bg-recessed border-rule rounded-document focus:border-rule-strong h-11 w-full border px-3 text-sm transition-colors outline-none"
            />
            <p className="reading-muted text-sm">
              Appears beside every entry you hold.
            </p>
          </div>

          <div className="space-y-2">
            <label htmlFor="contact-email" className="eyebrow block">
              Contact email
            </label>
            <input
              id="contact-email"
              name="email"
              type="email"
              defaultValue={user.email ?? ""}
              autoComplete="email"
              className="bg-recessed border-rule rounded-document focus:border-rule-strong h-11 w-full border px-3 text-sm transition-colors outline-none"
            />
            <p className="reading-muted text-sm">
              How a reviewer reaches you. Never published, and never given to
              anyone installing your package.
            </p>
          </div>
        </div>

        <div className="rule-top flex items-center justify-end gap-4 px-4 py-3">
          <p
            aria-live="polite"
            className={`text-sm ${failed ? "text-oxblood" : "text-ink-muted"}`}
          >
            {status}
          </p>
          <button
            type="submit"
            disabled={saving}
            className="rounded-document border-rule hover:border-rule-strong inline-flex items-center gap-2 border px-3.5 py-2 text-sm font-medium transition-colors disabled:opacity-45"
          >
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Saving
              </>
            ) : (
              "Save details"
            )}
          </button>
        </div>
      </form>
    </Section>
  );
}

function SignIns({ logins }: { logins: LoginRow[] }) {
  return (
    <Section id="sign-ins" title="Recent sign-ins">
      <div className="record overflow-hidden">
        {logins.length === 0 ? (
          <p className="text-ink-muted px-4 py-8 text-center text-sm">
            Nothing recorded yet.
          </p>
        ) : (
          <ul>
            {logins.map((login) => (
              <li
                key={login.id}
                className="rule-top grid grid-cols-1 gap-x-4 gap-y-1 px-4 py-3 first:border-t-0 sm:grid-cols-[10rem_1fr_auto] sm:items-baseline"
              >
                <span className="identifier text-ink text-sm">
                  {login.ipAddress ?? "address not recorded"}
                </span>
                <span className="text-ink-faint min-w-0 truncate text-sm">
                  {login.userAgent ?? "client not recorded"}
                </span>
                <span className="identifier text-ink-muted text-xs sm:text-right">
                  {formatDateTime(login.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="reading-muted mt-3 text-sm">
        The last ten sign-ins we recorded. An account that can claim names is
        worth watching; if one of these was not you, sign out and revoke this
        app from your GitHub settings.
      </p>
    </Section>
  );
}

export default function DashboardClient() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "signed-out" | "failed">(
    "loading",
  );
  const [message, setMessage] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await fetch("/api/dashboard/data");
      if (res.status === 401) {
        setState("signed-out");
        return;
      }
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.user) {
        setMessage(
          body?.message ?? "Your dashboard could not be loaded right now.",
        );
        setState("failed");
        return;
      }
      setData(body as DashboardData);
      setState("ready");
    } catch {
      setMessage(
        "The register is unreachable right now. Reload to try again.",
      );
      setState("failed");
    }
  };

  useEffect(() => {
    void load();
  }, []);

  if (state === "loading") {
    return (
      <div className="space-y-10" aria-busy="true">
        <div className="record h-56 animate-pulse" />
        <div className="record h-48 animate-pulse" />
      </div>
    );
  }

  if (state === "signed-out") return <SignedOut />;

  if (state === "failed" || !data) {
    return (
      <div className="record px-4 py-10 text-center">
        <p className="text-ink-muted text-sm">{message}</p>
        <button
          type="button"
          onClick={() => {
            setState("loading");
            void load();
          }}
          className="rounded-document border-rule hover:border-rule-strong mt-5 border px-3.5 py-2 text-sm font-medium transition-colors"
        >
          Try again
        </button>
      </div>
    );
  }

  const verification: Verification =
    data.verification ?? {
      status: "none",
      requestedAt: null,
      reviewedAt: null,
      reviewerNote: null,
    };

  return (
    <div className="space-y-12">
      <Standing
        user={data.user}
        verification={verification}
        onRequested={(v) => setData({ ...data, verification: v })}
      />
      <Entries
        packages={data.packages ?? []}
        publisherVerified={data.user.isVerified}
      />
      <Details user={data.user} onSaved={() => void load()} />
      <SignIns logins={data.logins ?? []} />
    </div>
  );
}
