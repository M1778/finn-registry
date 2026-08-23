import { SignJWT, jwtVerify } from "jose";
import { getDb } from "./db";
import { sessions } from "./db/schema";
import { eq } from "drizzle-orm";

/**
 * Session and token handling.
 *
 * Everything here runs on the Cloudflare Workers runtime (ADR-0005), which is
 * `workerd`, not Node. There are no `node:crypto` imports: randomness comes from
 * WebCrypto's `crypto.getRandomValues`, and JWT signing comes from `jose`, which
 * is built on `crypto.subtle`. Both are available as globals on `workerd` and on
 * Node 18+, so the same code runs under vitest.
 *
 * There is no password or API-key hashing left to do. The CLI never
 * authenticates (contract §2.6), so `api_keys` and `auth_codes` are gone, and
 * with them the per-request `scryptSync` scan that could not fit in the 10 ms
 * CPU budget.
 */

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET || "default_secret");

const HEX = "0123456789abcdef";

/**
 * Secure random hex string, `length` bytes of entropy (so `2 * length` chars).
 */
export function generateRandomString(length: number = 32): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);

  let out = "";
  for (const byte of bytes) {
    out += HEX[byte >> 4] + HEX[byte & 0x0f];
  }

  return out;
}

/**
 * Generate JWT
 */
export async function generateToken(payload: Record<string, unknown>) {
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(JWT_SECRET);
}

/**
 * Verify JWT
 */
export async function verifyToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return payload;
  } catch {
    return null;
  }
}

/**
 * Session management
 */
export async function createSession(
  userId: string,
  env?: unknown,
  github?: { accessToken?: string | null; scope?: string | null },
) {
  const currentDb = getDb(env);
  const token = generateRandomString(48);
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days

  const id = crypto.randomUUID();
  await currentDb.insert(sessions).values({
    id,
    userId,
    token,
    githubAccessToken: github?.accessToken ?? null,
    githubScope: github?.scope ?? null,
    expiresAt,
  });

  return token;
}

export async function verifySession(token: string, env?: unknown) {
  const currentDb = getDb(env);
  const session = await currentDb.select().from(sessions).where(eq(sessions.token, token)).get();

  if (!session || session.expiresAt < Date.now()) {
    return null;
  }

  return session;
}

export async function deleteSession(token: string, env?: unknown) {
  const currentDb = getDb(env);
  await currentDb.delete(sessions).where(eq(sessions.token, token));
}

/**
 * Does this sign-in carry a grant wide enough to read repository permissions?
 *
 * Signing in asks for `user:email`, which cannot see repository permissions
 * (ADR-0004), so the answer is normally no until the user has been through the
 * incremental request at registration. GitHub returns the granted scopes as a
 * comma-separated list.
 */
export function hasRepositoryScope(scope: string | null | undefined): boolean {
  if (!scope) return false;

  const granted = scope
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  return granted.includes("repo") || granted.includes("public_repo");
}
