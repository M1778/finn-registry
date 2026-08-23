/**
 * Server half of the proof-of-work captcha: hand out challenges, check answers.
 *
 * Stateless by construction. A challenge is a random salt plus a difficulty,
 * HMAC-signed, and the signature is the only reason the client cannot simply
 * mint itself a challenge of difficulty zero. Nothing is written to D1, so a
 * challenge costs no row and no read — which is the point, because the register
 * has a 10 ms CPU budget per request and no storage to spare (ADR-0005).
 *
 * Verifying costs one HMAC and one SHA-256. Solving costs about 2^bits SHA-256s.
 * The gap between those two numbers is the entire defence.
 *
 * What this is not: it is not proof a human is present, and it does not stop a
 * determined attacker — native code hashes far faster than a phone browser. It
 * makes bulk submission cost real CPU per attempt, which is what turns a script
 * that files ten thousand verification requests into one that files a handful.
 * It sits on top of the session gate and the rate limiter rather than replacing
 * either.
 */
import {
  CAPTCHA_SCOPES,
  CAPTCHA_TTL_MS,
  type CaptchaScope,
  type Challenge,
  encodeChallenge,
  decodeSolution,
  meetsDifficulty,
  signedPayload,
} from "./captcha-shared";

export { CAPTCHA_HEADER, type CaptchaScope } from "./captcha-shared";

/**
 * The signing key.
 *
 * `CAPTCHA_SECRET` should be set. When it is not, this falls back to random
 * bytes generated once per isolate — deliberately random, never a literal.
 * A hardcoded default would be published in this file and therefore forgeable
 * by anyone reading it, which is exactly the hole that the removed JWT fallback
 * had. Random bytes cannot be forged; the only cost of the fallback is that a
 * challenge issued by one isolate will not verify in another, so a reader
 * occasionally has to solve a second challenge. The client retries once on its
 * own, so that is a hiccup rather than a failure.
 *
 * Set the variable and the fallback never runs.
 */
let keyPromise: Promise<CryptoKey> | null = null;
let warnedAboutSecret = false;

function secretBytes() {
  const configured = process.env.CAPTCHA_SECRET;
  if (configured && configured.length >= 16) {
    return new TextEncoder().encode(configured);
  }
  if (!warnedAboutSecret) {
    warnedAboutSecret = true;
    console.warn(
      "[CAPTCHA] CAPTCHA_SECRET is unset or shorter than 16 characters. " +
        "Using a random per-isolate key: challenges will not verify across " +
        "isolates, so readers may be asked to solve a second one. Set " +
        "CAPTCHA_SECRET to fix this.",
    );
  }
  return crypto.getRandomValues(new Uint8Array(32));
}

function signingKey() {
  if (!keyPromise) {
    keyPromise = crypto.subtle.importKey(
      "raw",
      secretBytes() as unknown as ArrayBuffer,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  }
  return keyPromise;
}

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sign(payload: string) {
  const key = await signingKey();
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload) as unknown as ArrayBuffer,
  );
  return toHex(new Uint8Array(mac));
}

/** Length-independent, early-exit-free comparison. */
function sameString(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Salts already spent.
 *
 * A signed token is otherwise replayable until it expires, so one solve could
 * be spent on a thousand requests. This is the same per-isolate, best-effort
 * shape as the rate limiter, and it carries the same caveat: two isolates keep
 * separate sets, so a replay can succeed on a second isolate. Closing that
 * properly costs a D1 write per submission, which the CPU budget will not
 * carry. The short TTL bounds how long a stolen token is worth anything.
 */
const spent = new Map<string, number>();
const SPENT_SWEEP_LIMIT = 200;

function sweepSpent(now: number) {
  let examined = 0;
  for (const [salt, exp] of spent) {
    if (examined >= SPENT_SWEEP_LIMIT) break;
    examined += 1;
    if (now > exp) spent.delete(salt);
  }
}

export function difficultyFor(scope: CaptchaScope) {
  return CAPTCHA_SCOPES[scope];
}

/** Issue a challenge for one action. */
export async function issueChallenge(scope: CaptchaScope): Promise<Challenge> {
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const bits = difficultyFor(scope);
  const exp = Date.now() + CAPTCHA_TTL_MS;
  const sig = await sign(signedPayload(salt, bits, exp, scope));
  return { salt, bits, exp, sig };
}

export async function issueChallengeToken(scope: CaptchaScope) {
  return encodeChallenge(await issueChallenge(scope));
}

export type CaptchaFailure =
  | "missing"
  | "malformed"
  | "expired"
  | "bad_signature"
  | "insufficient_work"
  | "replayed";

export type CaptchaResult =
  | { ok: true }
  | { ok: false; reason: CaptchaFailure };

/**
 * Check a solved token against one scope.
 *
 * Order matters: the cheap structural checks run before the two crypto calls,
 * and the signature is checked before the work, so a forged difficulty is
 * rejected without hashing anything.
 */
export async function verifyCaptcha(
  token: string | null | undefined,
  scope: CaptchaScope,
): Promise<CaptchaResult> {
  if (!token) return { ok: false, reason: "missing" };

  const decoded = decodeSolution(token);
  if (!decoded) return { ok: false, reason: "malformed" };
  const { challenge, nonce } = decoded;

  const now = Date.now();
  // Both ends: expired is obvious, but a token claiming to live longer than the
  // TTL was either minted elsewhere or is a signed challenge we would not have
  // issued, and in both cases the signature check below should already fail.
  // Checking here means we never hash for one.
  if (challenge.exp <= now) return { ok: false, reason: "expired" };
  if (challenge.exp > now + CAPTCHA_TTL_MS) {
    return { ok: false, reason: "expired" };
  }

  // The difficulty must be the one this scope asks for. Accepting whatever the
  // token carries would let a client sign up for zero work if it ever got a
  // signature over `bits=0`.
  if (challenge.bits !== difficultyFor(scope)) {
    return { ok: false, reason: "bad_signature" };
  }

  const expected = await sign(
    signedPayload(challenge.salt, challenge.bits, challenge.exp, scope),
  );
  if (!sameString(expected, challenge.sig)) {
    return { ok: false, reason: "bad_signature" };
  }

  if (spent.has(challenge.salt)) return { ok: false, reason: "replayed" };

  if (!(await meetsDifficulty(challenge.salt, nonce, challenge.bits))) {
    return { ok: false, reason: "insufficient_work" };
  }

  sweepSpent(now);
  spent.set(challenge.salt, challenge.exp);
  return { ok: true };
}

/** Wording for each refusal. Says what to do, not what went wrong internally. */
export const CAPTCHA_MESSAGES: Record<CaptchaFailure, string> = {
  missing: "This form needs its proof-of-work check. Reload the page and try again.",
  malformed: "The proof-of-work check was not readable. Reload the page and try again.",
  expired: "The proof-of-work check went stale. Reload the page and try again.",
  bad_signature: "The proof-of-work check did not validate. Reload the page and try again.",
  insufficient_work: "The proof-of-work check was incomplete. Reload the page and try again.",
  replayed: "That proof-of-work check was already used. Reload the page and try again.",
};
