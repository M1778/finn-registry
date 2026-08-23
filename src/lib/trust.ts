/**
 * Trust level derivation.
 *
 * The registry publishes one summary — the trust level — and `finn` branches on
 * that alone (contract §2.4, ADR-0003). The underlying signals are returned
 * alongside it for display only, so that adding a signal later does not change
 * the CLI.
 *
 * Two signals feed it, and they are orthogonal on purpose:
 *
 *   - a *verified publisher* is an account an admin has confirmed the identity
 *     of, and that travels to everything the account registers;
 *   - a *trusted package* is one package a moderator has vouched for on its own
 *     merits, which deliberately does not require a verified publisher.
 *
 * A package is never "verified" and a publisher is never "trusted".
 *
 * This module is a pure function over booleans. It performs no I/O and reads no
 * database row, so the serializers can call it per row without touching the CPU
 * budget.
 */

/**
 * The levels the registry can publish.
 *
 * `unrecognized` is deliberately absent. It is a CLI-side state for a source
 * the registry has never seen — a raw Git URL, GitHub shorthand, or a local
 * path — and the registry has nothing to say about those, so it never returns
 * it.
 */
export type TrustLevel = "verified" | "trusted" | "recognized";

/** The raw signals a trust level is derived from. */
export interface TrustSignals {
  /** An admin has verified the publisher's identity. */
  publisherVerified: boolean;
  /** A moderator has marked this one package trusted. */
  packageTrusted: boolean;
  /** The publisher proved push access to the repository at registration. */
  repoOwnershipConfirmed: boolean;
}

/**
 * Derive the single trust level the registry publishes for a package.
 *
 * The ladder, highest first:
 *
 *   1. `verified`   — publisher is a verified identity and repository ownership
 *                     is confirmed.
 *   2. `trusted`    — the package carries a moderator's vouch, but the
 *                     publisher is not (yet) verified.
 *   3. `recognized` — registered with proven repository ownership and nothing
 *                     more. The floor, and not a warning: it is the ordinary
 *                     case for everything in the registry.
 *
 * `recognized` is also the fallback for any combination the ladder does not
 * name, because the floor is the weakest thing the registry may assert and it
 * must never report a level it cannot stand behind.
 */
export function deriveTrustLevel(signals: TrustSignals): TrustLevel {
  const { publisherVerified, packageTrusted, repoOwnershipConfirmed } = signals;

  if (publisherVerified && repoOwnershipConfirmed) return "verified";
  if (packageTrusted) return "trusted";

  return "recognized";
}
