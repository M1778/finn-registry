/**
 * The documentation table of contents.
 *
 * This is a nav manifest, not a content store: each page's prose lives in its
 * own `page.mdx` and is a real route. The 577-line `docs-config.ts` this
 * replaces held every page's markdown in one template literal, which is why the
 * old docs shipped their entire text to the browser to render one page.
 *
 * Four pages are deliberately absent because they documented things that do not
 * exist and must not: `finn login`, `finn publish`, `finn verify`, API keys, and
 * `POST /publish`. Registration happens in a browser (contract §2.6, §3.10), so
 * there is nothing for a CLI to authenticate against.
 */

export interface DocEntry {
  title: string;
  href: string;
  /** Shown in search results and on the docs index. */
  summary: string;
  /** Extra search terms, including the names of things we deliberately removed,
   *  so someone looking for `finn publish` still lands somewhere useful. */
  keywords?: string[];
}

export interface DocGroup {
  title: string;
  entries: DocEntry[];
}

export const DOCS_NAV: DocGroup[] = [
  {
    title: "Start here",
    entries: [
      {
        title: "What this is",
        href: "/docs",
        summary:
          "The registry records names, owners and commits. GitHub serves the code.",
        keywords: ["introduction", "overview", "distribution", "hosting"],
      },
      {
        title: "Installing finn",
        href: "/docs/installing-finn",
        summary: "Get the CLI from a release, or build it from source.",
        keywords: ["install", "cargo", "install.sh", "path"],
      },
    ],
  },
  {
    title: "Using packages",
    entries: [
      {
        title: "Starting a project",
        href: "/docs/starting-a-project",
        summary: "finn init, and what finn.toml actually contains.",
        keywords: ["init", "finn.toml", "manifest", "template", "entrypoint"],
      },
      {
        title: "Adding a dependency",
        href: "/docs/adding-a-dependency",
        summary:
          "finn add resolves a bare name through the registry to a repository and commit.",
        keywords: ["add", "install", "sync", "update", "lockfile", "version"],
      },
    ],
  },
  {
    title: "Being on the register",
    entries: [
      {
        title: "Registering a package",
        href: "/docs/registering-a-package",
        summary:
          "Claim a name in the browser. There is no publish command, and nothing is uploaded.",
        keywords: [
          "publish",
          "publishing",
          "finn publish",
          "finn login",
          "upload",
          "release",
          "claim",
        ],
      },
      {
        title: "Trust and seals",
        href: "/docs/trust",
        summary:
          "Verified publisher, trusted package, recognized — what each one asserts.",
        keywords: [
          "verified",
          "trusted",
          "recognized",
          "withdrawn",
          "badge",
          "moderator",
          "admin",
        ],
      },
      {
        title: "Checksums and integrity",
        href: "/docs/integrity",
        summary:
          "What a checksum can honestly mean when the registry never sees the code.",
        keywords: ["checksum", "sha256", "signing", "signature", "integrity"],
      },
    ],
  },
  {
    title: "Reference",
    entries: [
      {
        title: "HTTP API",
        href: "/docs/api",
        summary: "The read endpoints finn calls, and the ones it must not.",
        keywords: ["api", "endpoints", "json", "rest", "authentication", "keys"],
      },
      {
        title: "Rate limits",
        href: "/docs/rate-limits",
        summary: "What the free tier allows, and how to stay inside it.",
        keywords: ["429", "throttle", "quota", "limits", "backoff"],
      },
      {
        title: "Continuous integration",
        href: "/docs/ci",
        summary: "Installing dependencies in CI. Releases are not automated.",
        keywords: ["ci", "cd", "github actions", "token", "automation"],
      },
    ],
  },
];

export const ALL_DOCS: (DocEntry & { group: string })[] = DOCS_NAV.flatMap(
  (group) => group.entries.map((entry) => ({ ...entry, group: group.title })),
);
