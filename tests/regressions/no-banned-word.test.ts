/**
 * Permanent regression: the word "official" appears in no user-facing copy.
 *
 * Both projects ban the word outright. The reason is the same one behind
 * `no-fabricated-version.test.ts` and `no-unproven-ownership.test.ts` — a fact
 * published without the state to back it — but this one is about a claim the
 * register is not entitled to make at all. There is no blessed set of packages
 * and no first-party namespace, so nothing on the register can be official, and
 * a badge, a heading or a sentence that says otherwise invents an endorsement
 * the Fin project never gave.
 *
 * Until this file, the rule was enforced by nothing. That is not a hypothetical:
 * `src/app/docs/trust/page.mdx` carried
 *
 * ```text
 * Today `finn install` refuses any source it does not consider official unless
 * you pass `--ignore-regulations`, and `finn add` does not read trust levels.
 * ```
 *
 * in a warning Callout, and every one of its three claims was false against
 * `finn`'s source. `finn/src/trust.rs` deletes that behaviour by name — the
 * module opens by explaining that `PackageSource` *used to* carry
 * `is_official: bool`, that it refused every `false` unless
 * `--ignore-regulations` was passed, and that installing a local directory
 * therefore printed "Cannot install binary from unofficial source
 * '/home/me/pkg'", which it calls "three faults from one bit".
 * `Provenance::OwnDisk` now proceeds without ever prompting;
 * `--ignore-regulations` is the package layout check's bypass and nothing else
 * (`finn/src/main.rs:140`); and `finn add` does read trust levels, through
 * `TrustGate::consent` at `finn/src/commands/add.rs:154-155`. The copy outlived
 * the behaviour it described by three separate facts.
 *
 * Scope, and the half this cannot reach. This walks `src/` only: `tests/` is
 * excluded so that this file's own explanation does not trip it, and `docs/` is
 * excluded because `docs/REGISTRY-CONTRACT.md` has to name the banned word in
 * order to ban it. That leaves the harder half unguarded — the register
 * documenting `finn` behaviour that `finn` does not have. `finn`'s source is not
 * in this container, so no test here can check it, and the drift above was
 * exactly that failure: a rule that holds inside each repo and fails between
 * them, where neither repo's suite is looking. The same gap currently publishes
 * `finn check` and `finn doctor` as existing commands; neither is in
 * `finn/src/main.rs`.
 */

import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BANNED = /offici[a]l/i;
const EXTENSIONS = [".ts", ".tsx", ".mdx", ".md"];

const copyFiles = (): string[] => {
  const found: string[] = [];
  const walk = (absolute: string) => {
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const next = join(absolute, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        found.push(relative(repoRoot, next));
      }
    }
  };
  walk(join(repoRoot, "src"));
  return found;
};

describe("no banned word in user-facing copy", () => {
  /**
   * The walk has to be shown to work before its silence means anything. A wrong
   * root or a bad filter reports no offenders and passes, which is the failure
   * mode this whole suite is written against, so the tree is proved readable and
   * proved to contain the page the drift was found on.
   */
  it("reads the tree it claims to scan", () => {
    const files = copyFiles();
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain("src/app/docs/trust/page.mdx");
  });

  it("matches the word it is looking for", () => {
    expect(BANNED.test("an unofficial source")).toBe(true);
    expect(BANNED.test("Official")).toBe(true);
    expect(BANNED.test("officially blessed")).toBe(true);
    expect(BANNED.test("a recognized package")).toBe(false);
  });

  it("finds it nowhere in src/", () => {
    const offenders: string[] = [];
    for (const file of copyFiles()) {
      const lines = fs.readFileSync(join(repoRoot, file), "utf8").split("\n");
      lines.forEach((line, index) => {
        if (BANNED.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
