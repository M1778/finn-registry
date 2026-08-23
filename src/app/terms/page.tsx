import type { Metadata } from "next";
import Link from "next/link";

/**
 * The terms.
 *
 * Clauses are numbered here, unlike everywhere else in this interface, because a
 * term of use is a thing people cite: "clause 4" has to mean something stable to
 * whoever is arguing about it. Numbering carries referenceability, which is
 * information, rather than decoration.
 *
 * What was here before was assembled from a template for a company that hosts
 * code. It bound the reader to a "Finn Foundation" that does not exist, took a
 * worldwide licence to host and distribute packages the registry never receives
 * (ADR-0001), promised that published versions are immutable when the register
 * holds only a pointer to a Git tag the publisher can delete at will, referred
 * to API keys that were removed, and set governing law to the jurisdiction of
 * the nonexistent foundation. Terms that describe a different service are worse
 * than none: the one thing a reader needs from this page is an accurate account
 * of what they are relying on.
 */

export const metadata: Metadata = {
  title: "Terms",
  description:
    "What Finn Registry does and does not promise: no licence to your code, no guarantee about anything installed, and what a name claim actually gets you.",
};

const REVISED = "2026-08-22";

const CLAUSES = [
  {
    heading: "We take no licence to your code",
    body: (
      <>
        Registering a name gives us a row containing your package name, a
        description, and the URL of your repository. It does not give us your
        code, because we never receive it — GitHub serves every byte anyone
        installs. So there is no licence for you to grant here and we ask for
        none. Your repository stays under whatever licence you put in it, and our
        copy of that licence field is a label, not a grant.
      </>
    ),
  },
  {
    heading: "A claim on a name is not ownership of it",
    body: (
      <>
        To claim a name you prove you can push to the repository it points at.
        That is all the claim asserts. Names are held, not owned: a maintainer can
        release a name that was claimed to squat, to impersonate, or in error, and
        can transfer one when a project moves. We will say who asked and why when
        we do it. If you want a name to be permanently yours, a register run by
        volunteers is not the instrument for that.
      </>
    ),
  },
  {
    heading: "We cannot make anything immutable, and we do not claim to",
    body: (
      <>
        A version record here names a tag and the commit it resolved to. Both live
        in your repository. Delete the tag, force-push over it, rename the
        repository or make it private, and the record still exists while what it
        points at no longer resolves — installs break and we cannot prevent it.
        This is a real limit of not hosting anything, not a defect. What the
        commit hash does buy you is detection: if the contents change, the pin
        stops matching, so a substitution is visible rather than silent.
      </>
    ),
  },
  {
    heading: "A seal is about people, not about code",
    body: (
      <>
        Nobody here reads, scans, builds or signs your package. A{" "}
        <span className="text-brass">verified publisher</span> means a human
        checked that an account is who it says it is. A{" "}
        <span className="text-verdigris">trusted package</span> means one reviewer
        vouched for one package. Neither is a security audit, a warranty of
        fitness, or a promise that a future version will be like the one that was
        vouched for. Everything you install, you install on your own judgement —
        the register exists to tell you whose judgement you are borrowing, and
        that is a narrower service than it may look like.{" "}
        <Link
          href="/docs/trust"
          className="underline decoration-transparent underline-offset-4 transition-colors hover:decoration-current"
        >
          What each seal asserts
        </Link>
        .
      </>
    ),
  },
  {
    heading: "What gets an entry removed",
    body: (
      <>
        Malware, credential theft, impersonation of another person or
        organisation, names claimed to mislead, and anything we are required by
        law to remove. Judged by a maintainer, case by case, and recorded. An
        entry can be withdrawn without notice when leaving it up would put people
        at risk, and you can appeal by asking. There is no automated scanning
        behind this, so it is a response to what gets reported rather than a sweep
        — do not read the absence of a removal as a clean bill of health.
      </>
    ),
  },
  {
    heading: "You are responsible for your session",
    body: (
      <>
        Signing in sets a cookie that identifies you to us until it expires or you
        sign out. Anyone holding it can act as you here, so sign out on machines
        that are not yours. There are no API keys and no CLI login — nothing you
        can leak in a script or commit to a repository, which is the reason it
        works this way.
      </>
    ),
  },
  {
    heading: "No warranty, no entity, no promise it stays up",
    body: (
      <>
        This register is free, run by volunteers, and offered as it is. There is
        no company behind it and no service agreement to appeal to. It may be
        slow, it may be wrong, it may go down, and it may one day stop — and
        because it hosts nothing, the day it stops, every package it lists is
        still exactly where it always was, on GitHub. Building on it is a bet you
        are making; keep your lockfiles, which pin commits and do not need us to
        resolve.
      </>
    ),
  },
  {
    heading: "These terms will change",
    body: (
      <>
        When the register does something new, this page gets a new clause and a new
        date rather than a general reservation of the right to amend. Reading it
        again is the only notice we can offer, since nothing here sends mail.
      </>
    ),
  },
];

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <p className="eyebrow">Terms of use</p>
      <h1 className="mt-2 text-3xl sm:text-4xl">What we do and do not promise</h1>
      <p className="reading-muted mt-3 max-w-2xl">
        Eight clauses, written to be read rather than accepted. Most of what a
        registry&rsquo;s terms usually cover does not apply here, because this one
        stores no code — so what is left is mainly a list of the things you should
        not rely on us for. Revised {REVISED}.
      </p>

      <ol className="mt-10 space-y-6">
        {CLAUSES.map((clause, i) => (
          <li key={clause.heading} className="record overflow-hidden">
            <div className="bg-recessed flex items-baseline gap-3 px-4 py-2.5">
              <span className="identifier text-ink-faint text-xs">
                {String(i + 1).padStart(2, "0")}
              </span>
              <p className="eyebrow">{clause.heading}</p>
            </div>
            <p className="reading px-4 py-4 text-sm">{clause.body}</p>
          </li>
        ))}
      </ol>

      <p className="reading-muted mt-8 text-sm">
        Questions, disputes and removal requests go to a maintainer through the
        registry&rsquo;s repository. There is no legal department to write to; the
        people who would read a letter are the people who wrote this page.
      </p>

      <p className="eyebrow mt-10">
        <Link href="/privacy" className="hover:text-ink transition-colors">
          What we hold about you →
        </Link>
      </p>
    </div>
  );
}
