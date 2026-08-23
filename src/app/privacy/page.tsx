import type { Metadata } from "next";
import Link from "next/link";

/**
 * The privacy page.
 *
 * Written as a schedule of records rather than a policy, because for this
 * register that is the honest form: it holds no package bytes (ADR-0001), so
 * the complete answer to "what do you have on me" is four database rows and
 * three cookies, and those can simply be named. A policy would have to be
 * longer than the truth to sound like a policy.
 *
 * What was here before claimed the registry hashes session tokens (it stores
 * them as issued, because they are looked up by value), collects package
 * downloads and search queries (neither is recorded anywhere), sets analytics
 * cookies (there are none), and complies with the GDPR and the CCPA (nobody has
 * checked). Every one of those was boilerplate, and boilerplate about data is
 * not a neutral placeholder — it is a promise made on someone's behalf.
 */

export const metadata: Metadata = {
  title: "What we hold",
  description:
    "The complete list of what Finn Registry stores about an account, what it does not store, and the three cookies it sets.",
};

// Hardcoded, not `new Date()`. A date that is always today is not a revision
// date, it is a claim that the page was reviewed when it was only rendered.
const REVISED = "2026-08-22";

function Field({
  name,
  children,
}: {
  name: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rule-top grid gap-1 px-4 py-3 first:border-t-0 sm:grid-cols-[13rem_1fr] sm:gap-4">
      <p className="identifier text-ink-muted text-sm">{name}</p>
      <p className="reading-muted text-sm">{children}</p>
    </div>
  );
}

function Record({
  eyebrow,
  title,
  lead,
  children,
}: {
  eyebrow: string;
  title: string;
  lead: string;
  children: React.ReactNode;
}) {
  return (
    <section className="record overflow-hidden">
      <div className="bg-recessed px-4 py-2.5">
        <p className="eyebrow">{eyebrow}</p>
      </div>
      <div className="space-y-2 px-4 py-4">
        <h3 className="text-lg">{title}</h3>
        <p className="reading-muted text-sm">{lead}</p>
      </div>
      <div>{children}</div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <p className="eyebrow">Schedule of records</p>
      <h1 className="mt-2 text-3xl sm:text-4xl">What we hold</h1>
      <p className="reading-muted mt-3 max-w-2xl">
        Finn Registry holds an account, the names you claim, and the records
        behind them. That is short enough to write out in full rather than
        describe in general terms, so this page lists every field by name.
        Revised {REVISED}.
      </p>

      <div className="mt-10 space-y-6">
        <Record
          eyebrow="Created when you sign in"
          title="Your account"
          lead="Taken from GitHub at sign-in, and refreshed each time you sign in again."
        >
          <Field name="github_id, login">
            Your GitHub numeric id and username. The id is what identifies the
            account, so renaming yourself on GitHub does not orphan your entries.
          </Field>
          <Field name="name, avatar_url">Your GitHub display name and avatar.</Field>
          <Field name="email">
            Your GitHub account email. Nothing sends mail: there is no mailing
            list, no notification, and no reset flow, because signing in goes
            through GitHub.
          </Field>
          <Field name="role, is_verified">
            Whether you are a reviewer, and whether an admin has verified you as
            a publisher. Both are set by us, not by you.
          </Field>
          <Field name="bio, location, blog">
            Columns that exist and are empty. No form writes them and no page
            reads them.
          </Field>
        </Record>

        <Record
          eyebrow="Created when you sign in"
          title="Your session"
          lead="One row per active sign-in. Deleting the row signs that browser out immediately, which is why sessions are rows and not just signed tokens."
        >
          <Field name="token">
            The value in your <span className="identifier">auth_token</span>{" "}
            cookie, stored as issued rather than hashed — the session is found by
            looking this value up. Anyone with database access could therefore use
            your session until it expires.
          </Field>
          <Field name="github_access_token">
            Your GitHub token, in plain text, for as long as the session lives.
            It cannot be hashed: registering a name requires proving you have
            push access to the repository, and only your own token can answer
            that to GitHub. It is requested with the narrowest scope that works,
            and it dies with the session.
          </Field>
          <Field name="expires_at">
            When the session stops working on its own.
          </Field>
        </Record>

        <Record
          eyebrow="Created when you sign in"
          title="Your sign-ins"
          lead="One row each time, so that you can see them on your own account page and notice one you did not make."
        >
          <Field name="ip_address, user_agent">
            Your address and browser string at that moment. Nothing else about the
            visit is recorded: not the pages you opened, not what you searched
            for, not what you resolved.
          </Field>
        </Record>

        <Record
          eyebrow="Created when you ask"
          title="Your verification request"
          lead="Only if you ask to be verified as a publisher."
        >
          <Field name="note">
            Whatever evidence you wrote in the box. It goes to an admin, is kept
            as submitted, and is never shown to you again — it is there for the
            next reviewer, including if you ask a second time.
          </Field>
          <Field name="reviewer_note">
            The reviewer&rsquo;s reason. You are shown this one.
          </Field>
        </Record>

        <Record
          eyebrow="In your browser"
          title="Cookies, all three of them"
          lead="Every cookie here is required for signing in to work. None of them measures anything, and there is no analytics script on any page."
        >
          <Field name="auth_token">
            Keeps you signed in. Http-only, so no script can read it.
          </Field>
          <Field name="oauth_state, oauth_return">
            Set for ten minutes while GitHub redirects you back, then deleted.
            One prevents someone else&rsquo;s sign-in being completed in your
            browser; the other remembers which page to return you to.
          </Field>
          <Field name="not a cookie">
            Your light or dark preference is kept in{" "}
            <span className="identifier">localStorage</span>, in your browser
            only. It is never sent to us.
          </Field>
        </Record>

        <section className="record overflow-hidden">
          <div className="bg-recessed px-4 py-2.5">
            <p className="eyebrow">Absent</p>
          </div>
          <div className="space-y-3 px-4 py-4">
            <h3 className="text-lg">What we do not have</h3>
            <p className="reading-muted text-sm">
              Worth stating, because a registry is the kind of service where you
              would reasonably assume otherwise:
            </p>
            <ul className="reading-muted space-y-2 text-sm">
              <li className="ruled pt-2">
                <span className="text-ink">No download counts.</span> Installs
                do not pass through the register, so there is nothing to count.
              </li>
              <li className="ruled pt-2">
                <span className="text-ink">No search or page logs.</span> What
                you look up is not written down anywhere.
              </li>
              <li className="ruled pt-2">
                <span className="text-ink">
                  No analytics, tags or third-party scripts.
                </span>{" "}
                There is nothing on these pages from anyone but us.
              </li>
              <li className="ruled pt-2">
                <span className="text-ink">No profile if you never sign in.</span>{" "}
                Reading the register creates nothing.
              </li>
              <li className="ruled pt-2">
                <span className="text-ink">No sale or sharing of any of it.</span>{" "}
                There is no arrangement with anyone to sell.
              </li>
            </ul>
          </div>
        </section>

        <section className="record overflow-hidden">
          <div className="bg-recessed px-4 py-2.5">
            <p className="eyebrow">Elsewhere</p>
          </div>
          <div className="space-y-3 px-4 py-4">
            <h3 className="text-lg">Who else sees it</h3>
            <p className="reading-muted text-sm">
              Two services, both structural rather than optional.{" "}
              <span className="text-ink">GitHub</span> authenticates you, tells us
              whether you can push to a repository, and serves the source you
              install — your use of the register is visible to GitHub in the same
              way your use of GitHub already is.{" "}
              <span className="text-ink">Our hosting provider</span> runs the
              site, holds the database and terminates the connection, so it sees
              the requests. We add nobody else.
            </p>
          </div>
        </section>

        <section className="record overflow-hidden">
          <div className="bg-recessed px-4 py-2.5">
            <p className="eyebrow">Removal</p>
          </div>
          <div className="space-y-3 px-4 py-4">
            <h3 className="text-lg">Getting it deleted</h3>
            <p className="reading-muted text-sm">
              Signing out deletes the session row and its GitHub token. To
              delete the account itself, ask a maintainer through the
              registry&rsquo;s repository; it is done by hand. Two things are
              worth knowing before you ask. Deleting your account releases every
              package name you hold, and a released name can be claimed by
              somebody else. And the register keeps a record of what reviewers
              decided, so if an admin verified or refused you, that decision
              stays on file with your account id after the account is gone.
            </p>
            <p className="reading-muted text-sm">
              This page describes what the software does with your data. It is
              not a certification of compliance with any particular
              data-protection regime.
            </p>
          </div>
        </section>
      </div>

      <p className="eyebrow mt-10">
        <Link href="/terms" className="hover:text-ink transition-colors">
          Terms →
        </Link>
      </p>
    </div>
  );
}
