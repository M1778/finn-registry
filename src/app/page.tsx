import Link from "next/link";
import Countersignature from "@/components/registry/Countersignature";
import Ledger from "@/components/registry/Ledger";
import RegisterSearch from "@/components/registry/RegisterSearch";
import Seal, { SEAL_MEANING } from "@/components/registry/Seal";
import type { PackageRecord, VersionRecord } from "@/types/registry";

/**
 * The hero is a specimen register entry rather than a headline about trust.
 * Showing the actual assertion the registry makes is both the clearest
 * explanation available and the only honest one: the entry below is marked as a
 * specimen because it is a form sample, not a record that exists.
 */
const SPECIMEN: PackageRecord = {
  name: "http",
  description: "An HTTP client and server for Fin",
  repo_url: "https://github.com/acme/fin-http",
  homepage: null,
  license: "MIT",
  keywords: ["net", "http"],
  latest_version: "1.2.0",
  publisher: {
    login: "acme",
    display_name: "Acme Corp",
    avatar_url: null,
    kind: "organization",
    is_verified: true,
  },
  trust: {
    level: "verified",
    publisher_verified: true,
    package_trusted: true,
    repo_ownership_confirmed: true,
  },
  is_deprecated: false,
  deprecation_message: null,
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-20T00:00:00Z",
};

const SPECIMEN_VERSION: VersionRecord = {
  version: "1.2.0",
  git_ref: "v1.2.0",
  commit: "9f2c1ab4e8d07b3c5a1f6e2d8b04c7a9e3f1d5b2",
  checksum: "sha256:3f9a1c7e5b8d2046a9f3e1c7b5d8092a4e6c1f8b3d70a25e9c4b18f6d3a07e52",
  checksum_origin: "publisher_attested",
  yanked: false,
  published_at: "2026-08-20T00:00:00Z",
};

/** Registering really is a sequence, which is why these are numbered. */
const STEPS = [
  {
    title: "Sign in with GitHub",
    body: "We use your GitHub account to check one thing: whether you can push to the repository you are claiming.",
  },
  {
    title: "Choose the repository",
    body: "Push access is the proof of ownership. No push access, no claim — there is no other route in.",
  },
  {
    title: "Claim the name",
    body: "Names are bare and first come, first served. The name now points at your repository.",
  },
  {
    title: "Register a tag",
    body: "Each git tag you register becomes a version record: a ref, a commit, and the checksum you attest to.",
  },
];

export default function Home() {
  return (
    <div className="flex flex-col">
      {/* ── Hero: the thesis, then the artifact ───────────────────────── */}
      <section className="rule-bottom px-6 py-16 sm:py-24">
        <div className="mx-auto max-w-5xl">
          <p className="eyebrow">The register</p>

          <h1 className="mt-5 max-w-3xl text-4xl sm:text-5xl md:text-6xl">
            Finn packages live on GitHub.
            <br />
            Their names live here.
          </h1>

          <p className="reading-muted mt-6 max-w-2xl">
            The registry records who owns a name, the repository it points at,
            and the commit each version resolves to.{" "}
            <span className="identifier text-ink text-[0.95em]">finn</span> reads
            this to know whether it can vouch for what it is about to fetch. Your
            code is never uploaded, never stored here, and never passes through
            us.
          </p>

          <div className="mt-10">
            <RegisterSearch />
          </div>

          <Countersignature
            pkg={SPECIMEN}
            version={SPECIMEN_VERSION}
            label="Specimen entry"
            nameAs="p"
            className="mt-14"
          />
        </div>
      </section>

      {/* ── What the register actually asserts ────────────────────────── */}
      <section className="rule-bottom px-6 py-16 sm:py-20">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-2xl sm:text-3xl">What a seal means</h2>
          <p className="reading-muted mt-4 max-w-2xl">
            Every entry carries one seal.{" "}
            <span className="identifier text-ink text-[0.95em]">finn</span> reads
            the seal, not the reasoning behind it, so there are exactly three and
            they never overlap.
          </p>

          <dl className="mt-10 grid gap-px sm:grid-cols-3">
            {(["verified", "trusted", "recognized"] as const).map((kind) => (
              <div key={kind} className="record p-5">
                <dt>
                  <Seal kind={kind} />
                </dt>
                <dd className="reading-muted mt-3 text-sm">
                  {SEAL_MEANING[kind]}
                </dd>
              </div>
            ))}
          </dl>

          <p className="reading-muted mt-8 max-w-2xl text-sm">
            A name that is not on the register gets no seal at all. When{" "}
            <span className="identifier text-ink text-[0.95em]">finn</span> meets
            one, it does not refuse the install — it tells you the registry
            cannot vouch for it and asks whether to continue.
          </p>
        </div>
      </section>

      {/* ── Live data ─────────────────────────────────────────────────── */}
      <section className="rule-bottom px-6 py-16 sm:py-20">
        <div className="mx-auto max-w-5xl">
          <Ledger />
        </div>
      </section>

      {/* ── How to get on the register ────────────────────────────────── */}
      <section className="px-6 py-16 sm:py-20">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-2xl sm:text-3xl">Adding a package</h2>
          <p className="reading-muted mt-4 max-w-2xl">
            Four steps, and none of them involve uploading anything.
          </p>

          <ol className="mt-10 grid gap-px sm:grid-cols-2">
            {STEPS.map((step, i) => (
              <li key={step.title} className="record p-5">
                <p className="eyebrow">
                  {String(i + 1).padStart(2, "0")}
                </p>
                <h3 className="mt-3 text-lg">{step.title}</h3>
                <p className="reading-muted mt-2 text-sm">{step.body}</p>
              </li>
            ))}
          </ol>

          <div className="mt-10 flex flex-wrap gap-3">
            <Link
              href="/new"
              className="bg-primary text-primary-foreground rounded-document px-4 py-2.5 text-sm font-medium transition-opacity hover:opacity-90"
            >
              Register a package
            </Link>
            <Link
              href="/docs"
              className="rounded-document border-rule hover:border-rule-strong border px-4 py-2.5 text-sm font-medium transition-colors"
            >
              Read the docs
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
