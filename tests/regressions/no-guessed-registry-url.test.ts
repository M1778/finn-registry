/**
 * `registry/v1/url.txt` must never publish a guess.
 *
 * This file redirects package resolution for every `finn` user. There is nothing
 * behind it: `[registry].url` in finn.toml or `$FINN_REGISTRY_URL` wins over it,
 * and the client's compiled-in default is `None` on purpose, because a URL baked
 * into a binary that 404s turns "not deployed" into "your package does not exist".
 * So whatever this file says is, for an ordinary user, the whole answer.
 *
 * THE REGRESSION. The file used to end with
 * `https://finn-registry.REPLACE-WITH-ACCOUNT-SUBDOMAIN.workers.dev`, in the same
 * placeholder idiom as `wrangler.jsonc`'s `database_id`. In a JSON config that is
 * harmless — nothing accepts it. Here it is not, because it satisfies **every
 * rule the file documents**: https, a non-empty host, no trailing slash, no path.
 * A client cannot tell it from a real answer. It accepts it, caches it for 24
 * hours, fails to connect, and reports the registry as *unreachable* — when the
 * truth is that the registry has never been *deployed*. Those two need different
 * words from a package manager, and a placeholder that validates destroys the
 * difference.
 *
 * A file of comments has no such problem: the client reports that it contains no
 * URL line, finds no cache and no compiled-in default, and says plainly that it
 * knows of no deployment.
 *
 * WHAT IS ASSERTED, AND WHAT IS NOT. Not "there is no URL line" — appending one
 * is exactly how a deploy activates the pointer, and a test that had to be edited
 * in the same commit would be friction with no safety in it. What is asserted is
 * the invariant that holds before and after that day: whatever sits in URL
 * position is a URL somebody meant, it obeys the four format rules, and
 * `packages.json` agrees with it.
 *
 * The parse and the rules are restated here rather than imported. This test
 * guards the *committed bytes* of two files, so it must not depend on the
 * generator being runnable, on a database, or on anything the generator would
 * have to be trusted for.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const POINTER = join(repoRoot, "registry/v1/url.txt");
const INDEX = join(repoRoot, "registry/v1/packages.json");

/**
 * Both spellings this repository uses, matched loosely. The failure being caught
 * is a copy-paste, and a copy-paste does not respect a precise spelling.
 */
const PLACEHOLDER = /REPLACE[-_]WITH/i;

/** Lines the client would read as content: not blank, not a comment. */
function contentLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/** The client's parse: the first content line is the URL, or there is none. */
function pointerUrl(): string | null {
  return contentLines(readFileSync(POINTER, "utf8"))[0] ?? null;
}

describe("registry/v1/url.txt", () => {
  it("carries no placeholder in URL position", () => {
    for (const line of contentLines(readFileSync(POINTER, "utf8"))) {
      expect(
        PLACEHOLDER.test(line),
        `${line} is a placeholder, and it passes every format rule this file documents. ` +
          "A client would accept it, cache it for 24 hours and report the registry as " +
          "unreachable rather than as never deployed. Delete the line: comments only is " +
          "correct until a real origin exists.",
      ).toBe(false);
    }
  });

  /**
   * A placeholder *inside a comment* is fine and the file has several — the block
   * at the end explains the mistake by name. Asserted so that a future tightening
   * to "the word must not appear anywhere" is a deliberate change: it would make
   * the file unable to document its own hazard.
   */
  it("still allows the placeholder to be named in a comment", () => {
    const text = readFileSync(POINTER, "utf8");
    expect(PLACEHOLDER.test(text)).toBe(true);
    expect(contentLines(text).some((line) => PLACEHOLDER.test(line))).toBe(false);
  });

  it("names at most one URL, and obeys the four format rules if it names any", () => {
    const url = pointerUrl();
    if (url === null) return;

    expect(url.startsWith("https://"), `${url}: rule scheme`).toBe(true);
    expect(url.slice("https://".length).length, `${url}: rule host`).toBeGreaterThan(0);
    expect(url.endsWith("/"), `${url}: rule no trailing slash`).toBe(false);

    const parsed = new URL(url);
    expect(parsed.pathname, `${url}: rule no path`).toBe("/");
    expect(parsed.search, `${url}: rule no query`).toBe("");
    expect(parsed.hash, `${url}: rule no fragment`).toBe("");
  });

  /**
   * `finn-registry.workers.dev` is not a shortcut for an unknown account
   * subdomain: a workers.dev origin is
   * `<worker>.<account-subdomain>.workers.dev`, so the two-label form names an
   * *account* subdomain anybody could register — which is not a thing to publish
   * in a file that redirects package resolution for every user.
   */
  it("does not name a two-label workers.dev host", () => {
    const url = pointerUrl();
    if (url === null) return;

    const host = new URL(url).hostname;
    if (!host.endsWith(".workers.dev")) return;

    expect(
      host.split(".").length,
      `${host} is missing the account subdomain: a workers.dev origin is ` +
        "<worker>.<account-subdomain>.workers.dev, and the two-label form names a subdomain " +
        "anybody could register.",
    ).toBeGreaterThanOrEqual(4);
  });
});

describe("registry/v1/packages.json", () => {
  /**
   * The index's `registry_url` is generated *from* the pointer, and a client that
   * fetches the index writes that field into the same 24-hour cache the pointer
   * feeds. So a placeholder there is the identical failure one file over.
   */
  it("carries no placeholder in registry_url", () => {
    const index = JSON.parse(readFileSync(INDEX, "utf8"));
    if (index.registry_url === null) return;

    expect(typeof index.registry_url).toBe("string");
    expect(
      PLACEHOLDER.test(index.registry_url),
      `${index.registry_url} is a placeholder. A client caches it and then reports the ` +
        "registry as unreachable rather than as never deployed; null is the correct value " +
        "until a real origin exists.",
    ).toBe(false);
  });

  it("says exactly what the pointer says", () => {
    const index = JSON.parse(readFileSync(INDEX, "utf8"));

    expect(
      index.registry_url ?? null,
      "registry_url is generated from registry/v1/url.txt, so the two cannot be allowed to " +
        "differ: a client caches whichever it reads first. Regenerate with " +
        "`npm run build:fallback-index`.",
    ).toBe(pointerUrl());
  });
});
