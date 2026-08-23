/**
 * Semantic-version precedence, per semver.org §11.
 *
 * This exists for two reasons the registry cares about and one it does not.
 *
 * It cares about ordering: §3.3 of the contract publishes version records
 * newest-first in semver-descending order, and "newest" is not what a string
 * sort or a `created_at` sort gives you.
 *
 * It cares about exactness: §3.4 resolves one exact version and must refuse a
 * range. `isExactVersion` is what makes that refusal explicit rather than an
 * accidental 404.
 *
 * It does not care about ranges. Resolving `^1.0.0` is the CLI's job (§1), and
 * there is deliberately no range matcher here — the registry publishes the
 * version records it knows about and `finn` picks.
 */

/** Strict semver, no leading `v`, no range syntax. Build metadata is allowed. */
const EXACT_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const NUMERIC_IDENTIFIER = /^(0|[1-9]\d*)$/;

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers; empty for a release version. */
  prerelease: string[];
}

/**
 * Is this an exact version, as opposed to a range or junk?
 *
 * `"1.2.0"` yes. `"^1.2.0"`, `"1.x"`, `">=1.0.0 <2.0.0"`, `"v1.2.0"`, `"latest"`
 * all no.
 */
export function isExactVersion(value: string): boolean {
  return EXACT_VERSION.test(value);
}

function parse(value: string): ParsedVersion | null {
  const match = EXACT_VERSION.exec(value);
  if (!match) return null;

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrerelease(a: string[], b: string[]): number {
  // A version with a prerelease has lower precedence than one without.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const left = a[i];
    const right = b[i];
    if (left === right) continue;

    const leftNumeric = NUMERIC_IDENTIFIER.test(left);
    const rightNumeric = NUMERIC_IDENTIFIER.test(right);

    // Numeric identifiers always compare lower than alphanumeric ones.
    if (leftNumeric && !rightNumeric) return -1;
    if (!leftNumeric && rightNumeric) return 1;
    if (leftNumeric && rightNumeric) return Number(left) - Number(right);

    return left < right ? -1 : 1;
  }

  // All shared identifiers equal: the larger set of fields has higher precedence.
  return a.length - b.length;
}

/**
 * Ascending precedence comparator. Unparseable versions sort below every
 * parseable one rather than throwing, so one malformed row cannot fail a whole
 * response.
 */
export function compareVersions(a: string, b: string): number {
  const left = parse(a);
  const right = parse(b);

  if (!left && !right) return a < b ? -1 : a > b ? 1 : 0;
  if (!left) return -1;
  if (!right) return 1;

  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;

  return comparePrerelease(left.prerelease, right.prerelease);
}

/** Descending precedence comparator — the order §3.3 publishes. */
export function compareVersionsDescending(a: string, b: string): number {
  return compareVersions(b, a);
}
