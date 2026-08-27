"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import { Ban } from "lucide-react";
import type { VersionRecord } from "@/types/registry";

/**
 * The interactive half of a package page: the readme/versions switch, and the
 * README fetch that has to happen in the reader's browser.
 *
 * Everything a crawler or a link preview needs — the name, the publisher, the
 * repository, the commit — is rendered on the server by the page around this.
 * What is left here genuinely needs a browser.
 */

/** github.com/acme/fin-http -> { owner: "acme", repo: "fin-http" } */
function parseRepo(repoUrl: string) {
  const m = repoUrl.match(/github\.com[/:]([^/]+)\/([^/#?]+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/, "") };
}

/**
 * The README is fetched by the reader's browser straight from GitHub at the
 * pinned commit — the registry neither stores nor proxies it. That is the
 * architecture working as designed, and it costs the registry nothing.
 *
 * Deliberately *not* moved to the server along with the rest of this page.
 * Pulling it server-side would push third-party bytes through our Worker and
 * onto our CPU budget, for content the registry does not hold and does not
 * vouch for (ADR-0001).
 *
 * Rendered WITHOUT rehype-raw: this is untrusted third-party markdown, and
 * allowing raw HTML through would make every README an XSS vector.
 */
function Readme({
  repoUrl,
  commit,
}: {
  repoUrl: string;
  commit: string | null;
}) {
  const [state, setState] = useState<
    { status: "loading" } | { status: "ok"; text: string } | { status: "none" }
  >({ status: "loading" });

  useEffect(() => {
    const parsed = parseRepo(repoUrl);
    if (!parsed || !commit) {
      setState({ status: "none" });
      return;
    }
    let live = true;
    const base = `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${commit}`;

    (async () => {
      for (const file of ["README.md", "readme.md", "Readme.md"]) {
        try {
          const res = await fetch(`${base}/${file}`);
          if (res.ok) {
            const text = await res.text();
            if (live) setState({ status: "ok", text });
            return;
          }
        } catch {
          /* try the next candidate */
        }
      }
      if (live) setState({ status: "none" });
    })();

    return () => {
      live = false;
    };
  }, [repoUrl, commit]);

  if (state.status === "loading") {
    return (
      <div className="space-y-3" aria-busy="true">
        <div className="bg-muted h-4 w-2/3 animate-pulse rounded-xs" />
        <div className="bg-muted h-4 w-full animate-pulse rounded-xs" />
        <div className="bg-muted h-4 w-4/5 animate-pulse rounded-xs" />
      </div>
    );
  }

  if (state.status === "none") {
    return (
      <p className="reading-muted text-sm">
        No README found in this repository at this commit.{" "}
        <a
          href={repoUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-ink underline underline-offset-4"
        >
          Open the repository
        </a>
        .
      </p>
    );
  }

  return (
    /* A README is markdown we did not write, so it can contain a table wider
       than a phone or a code fence that never wraps. Those get their own scroll
       box here; without it the widest line in someone else's README decides how
       wide this page is, and the whole document scrolls sideways. The `_`
       descendant variants are deliberate: the elements come from ReactMarkdown,
       so there is no call site to put a class on.

       `readme` carries the element styles (globals.css). This used to be a row
       of `prose-*` classes for `@tailwindcss/typography`, which was never
       registered as a Tailwind v4 `@plugin` — so every one of them compiled to
       nothing and a rendered README came out unstyled. Registering it was tried
       and rejected: `prose-invert` has no theme in it and put body text at
       1.25:1 on the paper theme. */
    <article
      className="readme reading max-w-none
        [&_pre]:overflow-x-auto [&_table]:block [&_table]:w-fit [&_table]:max-w-full
        [&_table]:overflow-x-auto [&_code]:break-words [&_a]:break-words"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
      >
        {state.text}
      </ReactMarkdown>
    </article>
  );
}

function Versions({
  versions,
  latest,
}: {
  versions: VersionRecord[];
  latest: string | null;
}) {
  if (versions.length === 0) {
    return (
      <p className="reading-muted text-sm">
        No versions registered yet. The name is claimed, but nothing resolves to
        a commit.
      </p>
    );
  }

  return (
    <ul className="record overflow-hidden">
      {versions.map((v) => (
        <li
          key={v.version}
          className="rule-top first:border-t-0 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3"
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="identifier text-ink text-sm font-medium">
              {v.version}
            </span>
            {v.version === latest ? (
              <span className="eyebrow">latest</span>
            ) : null}
            {v.yanked ? (
              <span className="seal seal-withdrawn">
                <Ban className="size-3 shrink-0" aria-hidden />
                Yanked
              </span>
            ) : null}
          </div>
          <div className="text-ink-faint flex items-center gap-4 text-xs">
            <span className="identifier" title={v.commit}>
              {v.commit.slice(0, 12)}
            </span>
            <span className="identifier">
              {new Date(v.published_at).toLocaleDateString("en-CA", {
                timeZone: "UTC",
              })}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function PackageTabs({
  repoUrl,
  versions,
  latest,
  latestCommit,
}: {
  repoUrl: string;
  /** Already serialized on the server: §3.3 records, newest first. */
  versions: VersionRecord[];
  /** `pkg.latest_version` — null when nothing has been released. */
  latest: string | null;
  /** The commit the README is read at, or null when there is no release. */
  latestCommit: string | null;
}) {
  const [tab, setTab] = useState<"readme" | "versions">("readme");

  return (
    <>
      <div className="rule-bottom mb-6 flex gap-6">
        {(["readme", "versions"] as const).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            aria-current={tab === id ? "true" : undefined}
            className={`-mb-px border-b-2 py-3 text-sm capitalize transition-colors ${
              tab === id
                ? "border-ink text-ink"
                : "text-ink-muted hover:text-ink border-transparent"
            }`}
          >
            {id}
            {id === "versions" && versions.length > 0 ? (
              <span className="text-ink-faint ml-1.5 text-xs">
                {versions.length}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {tab === "readme" ? (
        <>
          <Readme repoUrl={repoUrl} commit={latestCommit} />
          {latestCommit ? (
            <p className="eyebrow rule-top mt-8 pt-4">
              Fetched from GitHub at {latestCommit.slice(0, 12)} · not stored
              here
            </p>
          ) : null}
        </>
      ) : (
        <Versions versions={versions} latest={latest} />
      )}
    </>
  );
}
