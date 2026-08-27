import { cache } from "react";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { users, type UserRole } from "@/lib/db/schema";
import { verifySession } from "@/lib/security";

/**
 * The signed-in account, resolved on the server.
 *
 * The API resolves callers through Hono's context; a server component and a
 * server action have neither a Hono context nor a request object, so this is the
 * equivalent for them: read the cookie, look the session up, return the row.
 *
 * Session table only, which is now the one way in everywhere — the API's signed-
 * token fallback has been removed. A session can be revoked by deleting a row,
 * and this helper exists to gate moderation.
 *
 * Wrapped in React's `cache()`, so a page that checks the role and then renders
 * the account's own name does one database read, not two.
 */

export interface Viewer {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  role: UserRole;
  isVerified: boolean;
}

export const getViewer = cache(async (): Promise<Viewer | null> => {
  const token = (await cookies()).get("auth_token")?.value;
  if (!token) return null;

  const session = await verifySession(token);
  if (!session) return null;

  const db = getDb();
  const account = await db
    .select({
      id: users.id,
      login: users.login,
      name: users.name,
      avatarUrl: users.avatarUrl,
      role: users.role,
      isVerified: users.isVerified,
    })
    .from(users)
    .where(eq(users.id, session.userId))
    .get();

  return account ?? null;
});

/** Moderators mark packages trusted; admins verify publishers (ADR-0003). */
export function isModerator(viewer: Viewer | null): boolean {
  return viewer?.role === "moderator" || viewer?.role === "admin";
}

/** Only admins rule on a publisher's identity. */
export function isAdmin(viewer: Viewer | null): boolean {
  return viewer?.role === "admin";
}
