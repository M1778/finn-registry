# Finn Registry

The register of packages for **Finn**, the package manager for the **Fin** language.

**It is a trust layer, not a distribution layer.** The registry stores no package code. Every byte
anyone installs comes from GitHub; what lives here is a record that a name was claimed by an account
that proved it can push to the repository the name points at, and what a human reviewer has said
about that account or that package since. There is no upload, no artifact store, and no
`finn publish`. This is the decision the whole design follows from — see
[ADR-0001](docs/adr/0001-registry-indexes-github-serves.md).

The consequence worth knowing up front: because it hosts nothing, it has no storage bill and fits
on a free tier. That is not a cost saving, it is the constraint the architecture was chosen to meet.

## Where the thinking is written down

Read these before changing behaviour. They are not summaries of the code; the code follows them.

| Document | What it is |
| --- | --- |
| [`CONTEXT.md`](CONTEXT.md) | The glossary. Every domain term, with the words to avoid and why. A publisher is *verified*; a package is *trusted*; the two are never interchangeable. |
| [`docs/REGISTRY-API.md`](docs/REGISTRY-API.md) | The API reference, for anyone building a client: every endpoint, exact request and response shapes, every error code, the rate limits, and an explicit list of what does not exist yet. Authoritative on **behaviour** — it was written from the handlers, and the read endpoints have been exercised against a running Worker. Start here if you are writing code that calls this registry. |
| [`docs/REGISTRY-CONTRACT.md`](docs/REGISTRY-CONTRACT.md) | The contract with the `finn` CLI: why the architecture is shaped this way, what the two repositories have agreed, and the questions still open between them. Authoritative on **intent**. Where it and the API reference disagree about what the code does, the reference is right and the disagreement is a bug worth reporting. |
| [`docs/adr/`](docs/adr/) | Six decisions that would otherwise look arbitrary. |

The ADRs, in the order they build on each other:

1. [The registry indexes; GitHub serves](docs/adr/0001-registry-indexes-github-serves.md)
2. [Package names are bare and globally unique](docs/adr/0002-bare-package-names.md)
3. [Publishers are verified; packages are trusted](docs/adr/0003-publishers-verified-packages-trusted.md)
4. [Registration requires proven push access](docs/adr/0004-registration-requires-push-access.md)
5. [Deploy to Cloudflare Workers via OpenNext](docs/adr/0005-deploy-to-cloudflare-workers-via-opennext.md)
6. [The register keeps minutes](docs/adr/0006-the-register-keeps-minutes.md)

## Stack

- **Next.js 15** (App Router) with **React 19** — server components by default; client islands only where something is genuinely interactive
- **Hono** for the API, mounted at `src/app/api/[[...route]]`
- **Drizzle ORM** over **Cloudflare D1** (SQLite)
- **Tailwind CSS 4**, dark by default with a light switch
- **MDX** for the docs pages under `/docs`
- **Vitest** for tests
- **Cloudflare Workers** via `@opennextjs/cloudflare` — *not* Pages, and not GitHub Pages. Both serve
  static files only, and every endpoint here is a database read against a D1 binding that only a
  Worker has (ADR-0005).

## Running it

Node 20+ (or Bun) and Git.

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill in the GitHub OAuth app values
npm run db:apply:local           # create local.db and apply the migrations
npm run dev
```

Sign-in needs a GitHub OAuth app: `.dev.vars.example` says which fields and what to set the
callback URL to.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Development server on port 3000 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint over `src` and `tests`, zero warnings tolerated |
| `npm test` | Vitest, once |
| `npm run test:watch` | Vitest, watching |
| `npm run build` | Production build, Node target — a fast check, not the deploy artifact |
| `npm run db:generate` | Generate a migration in `drizzle/` from the schema |
| `npm run db:apply:local` | Apply migrations to the local D1 |
| `npm run db:apply` | Apply migrations to the remote D1 |
| `npm run cf:build` | Build the Worker — the artifact that actually ships |
| `npm run cf:preview` | Run that artifact locally on `workerd` |
| `npm run cf:deploy` | Deploy it |
| `npm run cf:typegen` | Regenerate `CloudflareEnv` from `wrangler.jsonc` |

The three `cf:` build scripts set `CF_WORKER_BUILD=1`, which tells `next.config.ts`
to drop the local SQLite driver from the module graph. That driver cannot be
bundled for `workerd` and is never reached there, so leaving it in fails the build
outright rather than producing a worker with dead weight. If you invoke
`opennextjs-cloudflare` directly, set the variable yourself.

`npm run build` and `npm run cf:build` therefore compile *different* graphs. A
green `npm run build` is not evidence that the Worker builds — this exact gap hid
a broken deploy artifact once already. Run `cf:build` before trusting a change.

Migrations go through `wrangler`, not `drizzle-kit push`. D1 has no connection for `drizzle-kit` to
open, so `push` cannot reach it — `db:generate` writes the SQL and `db:apply` is what applies it.
Both local and remote apply the same files from `drizzle/`.

## Verifying it the way it ships

The gates you can run on the host are all necessary and none of them run the
thing that gets deployed. `Dockerfile` closes that gap:

```
docker build -t finn-registry-ci .
docker run --rm finn-registry-ci
```

That runs typecheck, lint, `cf:build` and the tests, applies the migrations to a
local D1, boots the Worker on `workerd`, and makes real requests to it
(`docker/probe.mjs`). Two of those steps cannot be done any other way:

- **`npm ci` on CI's exact Node version.** The image pins the same
  `NODE_VERSION` as the workflow, so a skew between CI and your machine surfaces
  here instead of in a failed deploy. It is also the only check that the lockfile
  and `package.json` still agree, because `npm ci` installs strictly from the
  lockfile and refuses when they have diverged.
- **Requests against the built Worker.** A green `cf:build` proves esbuild
  produced a bundle, not that the bundle serves anything. The probe asserts that
  `/api/packages` returns rows out of D1, which is the only evidence that
  `getDb()` never reaches its local-file branch on `workerd` — the assumption the
  whole libsql exclusion in `next.config.ts` rests on.

Miniflare keys the local database off the binding name, so this works despite the
placeholder `database_id`. Local verification does not wait on a Cloudflare
account.

This has already earned its place once. CI pinned Node 20, where all four Verify
gates pass and `wrangler` then refuses to run at all — so a green build would have
been followed by a deploy that died on the first migration. Both are on 22 now and
`engines` in `package.json` says so out loud. Nothing runnable on the host could
have caught it, because the host is already on 22.

## Not deployed yet

`wrangler.jsonc` carries a placeholder D1 database id, the migrations have never been applied to a
remote database, and the hostname is unsettled. The code is tested against `workerd` and D1 locally;
nothing is live. Don't point a CLI at a URL and expect an answer.

## Contributing

Four gates, all enforced in CI on every push and every pull request, cheapest first:
`npm run typecheck`, `npm run lint`, `npm run build`, `npm test`. None of them is advisory. The
build is a real gate and not a formality — `tsc --noEmit` was green across this repository for the
entire time `next build` was failing, because Next only validates what a route module may export
during the build. Beyond that, one rule that matters more here than the linting does: **the
interface may not claim anything the system cannot back.** No counts nothing increments, no badge
for a check that does not happen, no documented command that does not exist. If you find one, that
is a bug of the same severity as a crash — most of the work in this repository so far has been
removing them.
