"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { packages, reviewMinutes, users, verificationRequests } from "@/lib/db/schema";
import type { ReviewAction } from "@/lib/db/schema";
import { getViewer, isAdmin, isModerator } from "@/lib/viewer";

/**
 * Moderation actions.
 *
 * Server actions rather than API endpoints, on purpose. Nothing here is CLI
 * surface: `finn` must never be able to call it, it needs no versioned contract,
 * and keeping it out of the Hono app means the public API stays exactly what
 * docs/REGISTRY-CONTRACT.md §3 documents. Authorisation is re-checked inside
 * every action — a server action is a public POST endpoint whatever the page
 * around it renders, so hiding the button is not a permission check.
 */

function now() {
  return new Date().toISOString();
}

/**
 * Record what was just decided, and by whom (`review_minutes`).
 *
 * **Always called last**, after the write it describes. D1 has no transaction
 * across statements, so one of the two failure directions has to be chosen:
 *
 *  - minute last — the effect holds with no minute: a *gap* in the history. A
 *    reviewer sees an entry whose vouch has no author and can re-record it by
 *    ruling again, and nothing in the record claims anything false.
 *  - minute first — a minute for an effect that never landed: a *false record*,
 *    naming a colleague as having ruled something they did not, with no
 *    on-screen symptom to prompt anyone to look.
 *
 * A minute is a claim about a person, so a false one is the worse failure by a
 * wide margin. The gap is the direction the failure is allowed to take.
 *
 * The insert is deliberately not wrapped in a try/catch: if the history cannot
 * be written the reviewer should be told, not quietly left with an unattributed
 * ruling.
 */
async function recordMinute(minute: {
  reviewerId: string;
  action: ReviewAction;
  subjectUserId?: string | null;
  subjectPackageId?: string | null;
  reason?: string | null;
}) {
  const db = getDb();
  await db.insert(reviewMinutes).values({
    id: crypto.randomUUID(),
    reviewerId: minute.reviewerId,
    action: minute.action,
    subjectUserId: minute.subjectUserId ?? null,
    subjectPackageId: minute.subjectPackageId ?? null,
    reason: minute.reason ?? null,
    // `createdAt` is left to SQLite's CURRENT_TIMESTAMP, the same format every
    // other created_at in the schema uses, so minutes sort chronologically as
    // text alongside everything else.
  });
}

/**
 * Approve a verification request: the reviewer confirms this account is who it
 * claims to be, and the confirmation travels to everything it has registered.
 */
export async function approveVerification(form: FormData) {
  const viewer = await getViewer();
  if (!isAdmin(viewer)) throw new Error("Only an admin can verify a publisher.");

  const requestId = String(form.get("requestId") ?? "");
  const userId = String(form.get("userId") ?? "");
  if (!requestId || !userId) throw new Error("Malformed request.");

  const db = getDb();

  // Order matters, and D1 gives no transaction across these two statements. The
  // account is verified first: if the second write fails, the request stays
  // pending and a reviewer sees it again, and approving twice is harmless. The
  // other order would close the request against an account that never got
  // verified — a silent failure nobody would ever look at again.
  await db.update(users).set({ isVerified: true }).where(eq(users.id, userId));
  await db
    .update(verificationRequests)
    .set({ status: "approved", reviewerId: viewer!.id, reviewedAt: now() })
    .where(eq(verificationRequests.id, requestId));

  await recordMinute({
    reviewerId: viewer!.id,
    action: "publisher_verified",
    subjectUserId: userId,
  });

  revalidatePath("/admin");
}

/**
 * Refuse a request. The reason is required: a refusal without one is useless to
 * the account, which cannot fix what it is not told, and useless to the next
 * reviewer, who will see the same application again.
 */
export async function refuseVerification(form: FormData) {
  const viewer = await getViewer();
  if (!isAdmin(viewer)) throw new Error("Only an admin can rule on a request.");

  const requestId = String(form.get("requestId") ?? "");
  const reason = String(form.get("reason") ?? "").trim();
  if (!requestId) throw new Error("Malformed request.");
  if (!reason) throw new Error("A refusal needs a reason.");

  const db = getDb();

  // Read the subject before ruling: a minute records *who* was refused, and the
  // form carries only the request id. Reading first also means a stale id fails
  // before anything is written rather than silently updating no rows.
  const request = await db
    .select({ userId: verificationRequests.userId })
    .from(verificationRequests)
    .where(eq(verificationRequests.id, requestId))
    .get();
  if (!request) throw new Error("That request is no longer in the queue.");

  await db
    .update(verificationRequests)
    .set({
      status: "rejected",
      reviewerNote: reason.slice(0, 1000),
      reviewerId: viewer!.id,
      reviewedAt: now(),
    })
    .where(eq(verificationRequests.id, requestId));

  await recordMinute({
    reviewerId: viewer!.id,
    action: "verification_refused",
    subjectUserId: request.userId,
    // The same words the account is shown. One reason, recorded once.
    reason: reason.slice(0, 1000),
  });

  revalidatePath("/admin");
}

/**
 * Vouch for one package, or take the vouch back.
 *
 * `updatedAt` is deliberately not bumped. It records what the *publisher* did to
 * the entry, and a moderator's flag is not the publisher's act — bumping it
 * would push every moderated package to the top of "recently updated" for a
 * reason no reader could see.
 */
export async function setPackageTrust(form: FormData) {
  const viewer = await getViewer();
  if (!isModerator(viewer)) {
    throw new Error("Only a moderator can vouch for a package.");
  }

  const packageId = String(form.get("packageId") ?? "");
  const trusted = String(form.get("trusted") ?? "") === "true";
  if (!packageId) throw new Error("Malformed request.");

  const db = getDb();
  await db
    .update(packages)
    .set({ isTrusted: trusted })
    .where(eq(packages.id, packageId));

  await recordMinute({
    reviewerId: viewer!.id,
    action: trusted ? "package_vouched" : "package_vouch_withdrawn",
    subjectPackageId: packageId,
  });

  revalidatePath("/admin");
}

/* Withdrawing a package is the publisher's call, never a moderator's, so there
   is deliberately no action here that deprecates one. */
