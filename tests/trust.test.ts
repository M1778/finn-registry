/**
 * Trust level derivation — docs/REGISTRY-CONTRACT.md §2.4, ADR 0003.
 *
 * Two independent signals collapse into one published level, and the CLI
 * branches on that level alone. The derivation is pure: no database, no request,
 * no clock.
 *
 * Casing: the signals are camelCase *here* because this is a TypeScript
 * interface fed from Drizzle column properties. §3.1's snake_case rule governs
 * the wire, and the serialized `trust` object is asserted in the HTTP-level
 * suites (tests/api/*.test.ts), not here.
 */

import { describe, expect, it } from "vitest";
import { deriveTrustLevel, type TrustSignals } from "@/lib/trust";

/** Registered with proven repository ownership and no admin signal: the floor. */
const RECOGNIZED: TrustSignals = {
  publisherVerified: false,
  packageTrusted: false,
  repoOwnershipConfirmed: true,
};

describe("deriveTrustLevel", () => {
  it("returns verified for a verified publisher", () => {
    expect(deriveTrustLevel({ ...RECOGNIZED, publisherVerified: true })).toBe("verified");
  });

  it("lets verified win over trusted", () => {
    expect(
      deriveTrustLevel({
        publisherVerified: true,
        packageTrusted: true,
        repoOwnershipConfirmed: true,
      }),
    ).toBe("verified");
  });

  it("returns trusted only when no publisher verification is present", () => {
    expect(deriveTrustLevel({ ...RECOGNIZED, packageTrusted: true })).toBe("trusted");
  });

  it("returns recognized when neither signal is present", () => {
    // The floor for anything in the registry, and not a warning state: a
    // package registered with proven repository ownership and nothing more.
    expect(deriveTrustLevel(RECOGNIZED)).toBe("recognized");
  });

  it("treats the signals as independent: a trusted package needs no verified publisher", () => {
    expect(
      deriveTrustLevel({
        publisherVerified: false,
        packageTrusted: true,
        repoOwnershipConfirmed: true,
      }),
    ).toBe("trusted");
  });

  it("never returns unrecognized, which only the CLI can observe", () => {
    for (const publisherVerified of [true, false]) {
      for (const packageTrusted of [true, false]) {
        for (const repoOwnershipConfirmed of [true, false]) {
          const level = deriveTrustLevel({
            publisherVerified,
            packageTrusted,
            repoOwnershipConfirmed,
          });
          expect(["verified", "trusted", "recognized"]).toContain(level);
        }
      }
    }
  });

  it("keeps recognized as the floor even without confirmed repo ownership", () => {
    // §2.4: the registry never returns `unrecognized`. Anything it has a record
    // of is at least recognized.
    expect(
      deriveTrustLevel({
        publisherVerified: false,
        packageTrusted: false,
        repoOwnershipConfirmed: false,
      }),
    ).toBe("recognized");
  });

  it("is pure: the same signals derive the same level every time", () => {
    const signals: TrustSignals = {
      publisherVerified: false,
      packageTrusted: true,
      repoOwnershipConfirmed: true,
    };

    expect(deriveTrustLevel(signals)).toBe(deriveTrustLevel(signals));
    expect(signals).toEqual({
      publisherVerified: false,
      packageTrusted: true,
      repoOwnershipConfirmed: true,
    });
  });

  it("does not depend on signal order in the object literal", () => {
    expect(
      deriveTrustLevel({
        repoOwnershipConfirmed: true,
        packageTrusted: false,
        publisherVerified: true,
      }),
    ).toBe("verified");
  });
});
