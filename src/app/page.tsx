import Link from "next/link";
import Countersignature from "@/components/registry/Countersignature";
import { LogoMark } from "@/components/registry/Logo";
import Ledger from "@/components/registry/Ledger";
import RegisterSearch from "@/components/registry/RegisterSearch";
import Seal, { SEAL_MEANING } from "@/components/registry/Seal";
import type { PackageRecord, VersionRecord } from "@/types/registry";

/**
 * The hero closes on a real register entry rather than a claim about one.
 * Marked as a specimen because it is a form sample: `http` is not a name anyone
 * has claimed, so nothing here should be mistaken for a record.
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
    body: "Your GitHub account is how the register knows who you are.",
  },
  {
    title: "Choose the repository",
    body: "Push access proves the repository is yours. That is the proof the register records.",
  },
  {
    title: "Claim the name",
    body: "Names are bare and first come, first served. Yours now resolves to your repository.",
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

          {/* The masthead. Both halves are sized fluidly off the viewport for
              one reason: the name carries a hyphen, and a browser will happily
              break after it. Nothing here may wrap, so nothing here may
              overflow. The mark's box is ~1.65x the wordmark's cap height,
              which is what puts the F's crossbars on the same optical line as
              the letters beside them. */}
          <div className="mt-6 flex items-center gap-4 sm:gap-6">
            <LogoMark className="text-ink size-[clamp(2.5rem,10vw,5.5rem)] shrink-0" />
            <h1 className="text-[clamp(1.75rem,7.5vw,4.5rem)] whitespace-nowrap">
              finn-registry
            </h1>
          </div>

          <p className="reading-muted mt-8 max-w-2xl">
            The register of record for Fin packages. Every name here has an
            owner, a repository it resolves to, and a commit behind each
            version.{" "}
            <span className="identifier text-ink text-[0.95em]">finn</span> reads
            the register before it fetches, so you know what you are installing
            and who stands behind it.
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
            A name that is not on the register carries no seal. Every seal that
            is shown is a claim the register stands behind.
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
            Four steps. You will need push access to the repository you are
            claiming.
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
