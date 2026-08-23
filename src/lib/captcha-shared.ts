/**
 * The parts of the proof-of-work captcha that both sides need.
 *
 * Nothing here touches the signing key, which is why it is its own module: the
 * solver runs in the browser, so anything it imports ships to the browser. Keep
 * `captcha.ts` (which reads the secret) out of that graph.
 *
 * The scheme is deliberately dull. The server hands out a random salt and a
 * difficulty, signed so neither can be edited. The client looks for a nonce
 * whose SHA-256 digest starts with `bits` zero bits. Finding one costs about
 * 2^bits hashes; checking one costs exactly one. That asymmetry is the whole
 * mechanism — there is no puzzle for a person to solve and no third party to
 * ask, so there is no API key to hold and nothing to sign up for.
 */

/** Bumped if the token layout ever changes, so old tokens fail closed. */
export const CAPTCHA_VERSION = "v1";

/** Header the solved token travels in. */
export const CAPTCHA_HEADER = "x-finn-captcha";

/**
 * What each protected action costs. Tuned by measurement, not taste: awaited
 * WebCrypto digests run about 20k/s one at a time and about 45k/s batched, so
 * 14 bits (~16k hashes) is a few hundred milliseconds on a laptop and one to two
 * seconds on a phone. The client solves on mount rather than on submit, so that
 * time is spent while the reader is still typing.
 *
 * Raising a number here raises an attacker's cost and the reader's wait by the
 * same factor. Each doubling of `bits` doubles both.
 */
export const CAPTCHA_SCOPES = {
  login: 13,
  "register-check": 14,
  register: 15,
  "verify-request": 15,
} as const;

export type CaptchaScope = keyof typeof CAPTCHA_SCOPES;

/** How long a challenge may be held before it is refused. */
export const CAPTCHA_TTL_MS = 10 * 60 * 1000;

export interface Challenge {
  salt: string;
  bits: number;
  exp: number;
  sig: string;
}

/** The exact bytes the signature covers. Scope is in here so a cheap `login`
 *  token cannot be spent on `register`, which costs four times as much. */
export function signedPayload(
  salt: string,
  bits: number,
  exp: number,
  scope: string,
) {
  return `${CAPTCHA_VERSION}.${salt}.${bits}.${exp}.${scope}`;
}

export function encodeChallenge(ch: Challenge) {
  return `${CAPTCHA_VERSION}.${ch.salt}.${ch.bits}.${ch.exp}.${ch.sig}`;
}

/** A solved token is the challenge with the nonce appended. */
export function encodeSolution(ch: Challenge, nonce: number) {
  return `${encodeChallenge(ch)}.${nonce}`;
}

export function decodeSolution(
  token: string,
): { challenge: Challenge; nonce: number } | null {
  const parts = token.split(".");
  if (parts.length !== 6) return null;
  const [version, salt, bitsRaw, expRaw, sig, nonceRaw] = parts;
  if (version !== CAPTCHA_VERSION) return null;

  const bits = Number(bitsRaw);
  const exp = Number(expRaw);
  const nonce = Number(nonceRaw);
  // Integer-only: `Number("1e9")` and `Number(" 1")` both parse, and neither
  // should be accepted where a plain digit string is expected.
  if (!/^\d+$/.test(bitsRaw) || !/^\d+$/.test(expRaw) || !/^\d+$/.test(nonceRaw)) {
    return null;
  }
  if (!Number.isSafeInteger(bits) || !Number.isSafeInteger(exp)) return null;
  if (!Number.isSafeInteger(nonce)) return null;
  if (!/^[0-9a-f]{32}$/.test(salt)) return null;
  if (!sig) return null;

  return { challenge: { salt, bits, exp, sig }, nonce };
}

/** The string that gets hashed. */
export function workString(salt: string, nonce: number) {
  return `${salt}.${nonce}`;
}

/** Leading zero bits of a digest, capped at `want` — we never need more. */
export function leadingZeroBits(digest: Uint8Array, want: number) {
  let seen = 0;
  for (const byte of digest) {
    if (byte === 0) {
      seen += 8;
      if (seen >= want) return seen;
      continue;
    }
    // Math.clz32 counts on a 32-bit word; a byte's leading zeros are that
    // minus the 24 bits of padding above it.
    return seen + (Math.clz32(byte) - 24);
  }
  return seen;
}

export async function meetsDifficulty(
  salt: string,
  nonce: number,
  bits: number,
) {
  const bytes = new TextEncoder().encode(workString(salt, nonce));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return leadingZeroBits(digest, bits) >= bits;
}
