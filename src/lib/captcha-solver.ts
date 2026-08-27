/**
 * Browser half: find a nonce that satisfies a challenge.
 *
 * Batched on purpose. Awaiting one `crypto.subtle.digest` at a time measures
 * about 20k hashes/s because the per-call promise overhead dominates the hash
 * itself; firing a few hundred and awaiting them together measures about 45k/s.
 * The batch is also the yield point, so the main thread stays responsive
 * without a Web Worker — which would mean another bundle entry for a loop this
 * small.
 */
import {
  type Challenge,
  encodeSolution,
  leadingZeroBits,
  workString,
} from "./captcha-shared";

/** Measured sweet spot; larger batches stop helping and delay cancellation. */
const BATCH = 256;

export interface SolveOptions {
  /** Checked between batches so an unmounting component can stop the loop. */
  signal?: AbortSignal;
  /** Called with the number of hashes tried so far, once per batch. */
  onProgress?: (tried: number) => void;
  /** Stop after this many hashes. At 15 bits the mean is ~32k, so this leaves
   *  generous headroom for an unlucky run rather than capping a typical one. */
  maxAttempts?: number;
}

export class CaptchaSolveError extends Error {}

export async function solveChallenge(
  challenge: Challenge,
  options: SolveOptions = {},
): Promise<number> {
  const encoder = new TextEncoder();
  const want = challenge.bits;
  const limit = options.maxAttempts ?? Math.max(1 << (want + 6), 1 << 20);

  for (let base = 0; base < limit; base += BATCH) {
    if (options.signal?.aborted) throw new CaptchaSolveError("aborted");

    const digests = await Promise.all(
      Array.from({ length: BATCH }, (_, i) =>
        crypto.subtle.digest(
          "SHA-256",
          encoder.encode(workString(challenge.salt, base + i)) as unknown as ArrayBuffer,
        ),
      ),
    );

    for (let i = 0; i < digests.length; i += 1) {
      if (leadingZeroBits(new Uint8Array(digests[i]), want) >= want) {
        return base + i;
      }
    }

    options.onProgress?.(base + BATCH);
  }

  throw new CaptchaSolveError(
    `No solution within ${limit} attempts for ${want} bits.`,
  );
}

/** Solve and return the token to send. */
export async function solveToken(
  challenge: Challenge,
  options?: SolveOptions,
): Promise<string> {
  return encodeSolution(challenge, await solveChallenge(challenge, options));
}
