"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Check, Github, Loader2, X } from "lucide-react";
import Countersignature from "@/components/registry/Countersignature";
import { useCaptcha } from "@/lib/use-captcha";
import { SEAL_MEANING } from "@/components/registry/Seal";
import type { PackageRecord, TrustLevel } from "@/types/registry";

/**
 * The registration form.
 *
 * This is the only place in the product where a record is created, so it is
 * built as the act of signing one: you name the repository, you name the
 * package, and then you read the exact register entry you are about to sign
 * before you sign it. The preview is a real Countersignature — not a mock of
 * one — so nothing can appear here that would not appear on the register.
 *
 * The three steps are numbered because they genuinely are a sequence: the name
 * cannot be checked until the repository is known, and nothing can be signed
 * until both are settled.
 *
 * The page's heading and explanation live in `page.tsx` on the server. Only the
 * form waits on the session, so a visitor reads what this page is for while the
 * session check is still in flight instead of watching a placeholder pulse.
 */

const NAME_RULE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const NAME_MIN = 2;
const NAME_MAX = 64;

interface Viewer {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  isVerified: boolean;
}

interface RepoFacts {
  full_name: string;
  description: string | null;
  homepage: string | null;
  license: string | null;
  default_branch: string;
}

type AccessState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "granted"; repo: RepoFacts }
  | { status: "refused"; reason: string }
  | { status: "needs_scope" };

type NameState =
  | { status: "empty" }
  | { status: "invalid"; reason: string }
  | { status: "checking" }
  | { status: "available" }
  | { status: "taken" };

/** `acme/fin-http` → `http`. A Fin package repo conventionally carries the
 *  prefix; the registered name is bare (contract §2.1). */
function suggestName(fullName: string) {
  const repo = fullName.split("/").pop() ?? "";
  return repo
    .toLowerCase()
    .replace(/^fin{1,2}-/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeRepoUrl(input: string) {
  const trimmed = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const shorthand = trimmed.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (shorthand) return `https://github.com/${shorthand[1]}/${shorthand[2]}`;
  return trimmed;
}

function validateName(value: string): NameState {
  if (!value) return { status: "empty" };
  if (value.length < NAME_MIN)
    return { status: "invalid", reason: `At least ${NAME_MIN} characters.` };
  if (value.length > NAME_MAX)
    return { status: "invalid", reason: `At most ${NAME_MAX} characters.` };
  if (value.includes("/"))
    return {
      status: "invalid",
      reason: "Names are bare — no slash. A slash always means GitHub to finn.",
    };
  if (!NAME_RULE.test(value))
    return {
      status: "invalid",
      reason:
        "Lowercase letters, digits and single hyphens. Must start with a letter.",
    };
  return { status: "checking" };
}

function Step({
  n,
  title,
  hint,
  disabled,
  children,
}: {
  n: number;
  title: string;
  hint?: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby={`step-${n}`}
      className={`record overflow-hidden transition-opacity ${
        disabled ? "pointer-events-none opacity-45" : ""
      }`}
    >
      <div className="bg-recessed flex items-baseline gap-3 px-4 py-2.5">
        <span className="identifier text-ink-faint text-xs tabular-nums">
          {String(n).padStart(2, "0")}
        </span>
        <h2 id={`step-${n}`} className="eyebrow">
          {title}
        </h2>
      </div>
      <div className="px-4 py-5">
        {hint ? <p className="reading-muted mb-4 text-sm">{hint}</p> : null}
        {children}
      </div>
    </section>
  );
}

/** A check the registry performed. Passed reads in neutral ink — verdigris is
 *  reserved for the trusted seal (globals.css, rule 1). */
function Verdict({
  ok,
  children,
}: {
  ok: boolean;
  children: React.ReactNode;
}) {
  return (
    <p
      className={`mt-3 flex items-start gap-2 text-sm ${
        ok ? "text-ink" : "text-oxblood"
      }`}
      role="status"
    >
      {ok ? (
        <Check className="mt-0.5 size-4 shrink-0" aria-hidden />
      ) : (
        <X className="mt-0.5 size-4 shrink-0" aria-hidden />
      )}
      <span>{children}</span>
    </p>
  );
}

export default function RegisterForm() {
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  const [repoInput, setRepoInput] = useState("");
  const [access, setAccess] = useState<AccessState>({ status: "idle" });

  const [name, setName] = useState("");
  const [nameState, setNameState] = useState<NameState>({ status: "empty" });
  const [nameTouched, setNameTouched] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  /*
   * Both writes carry proof of work. They are deliberately not solved at the
   * same time: hashing competes with itself, and the check always happens
   * first. So the check's proof is prepared on arrival, and the registration's
   * only once a repository has been confirmed — which is exactly when the
   * reader turns to the name and description fields and has something else to
   * do for a second.
   */
  const { headers: checkProof } = useCaptcha("register-check");
  const { headers: registerProof } = useCaptcha("register", {
    enabled: access.status === "granted",
  });

  useEffect(() => {
    let live = true;
    fetch("/api/auth/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!live) return;
        setViewer(
          data?.authenticated && data.user
            ? {
                login: data.user.login,
                name: data.user.name ?? null,
                avatarUrl: data.user.avatarUrl ?? null,
                isVerified: Boolean(data.user.isVerified),
              }
            : null,
        );
      })
      .catch(() => live && setViewer(null))
      .finally(() => live && setAuthLoading(false));
    return () => {
      live = false;
    };
  }, []);

  const checkAccess = useCallback(async () => {
    const repo_url = normalizeRepoUrl(repoInput);
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(repo_url)) {
      setAccess({
        status: "refused",
        reason:
          "That does not look like a GitHub repository. Paste its URL, or owner/repo.",
      });
      return;
    }

    setAccess({ status: "checking" });
    try {
      const res = await fetch("/api/registrations/check", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(await checkProof()),
        },
        body: JSON.stringify({ repo_url }),
      });
      const data = await res.json().catch(() => null);

      if (data?.needs_scope) {
        setAccess({ status: "needs_scope" });
        return;
      }
      if (!res.ok || !data?.push_access) {
        setAccess({
          status: "refused",
          reason:
            data?.reason ??
            "We could not confirm you have push access to that repository.",
        });
        return;
      }

      setAccess({ status: "granted", repo: data.repo });
      if (!nameTouched) setName(suggestName(data.repo.full_name));
    } catch {
      setAccess({
        status: "refused",
        reason: "The check could not be completed. Try again in a moment.",
      });
    }
  }, [repoInput, nameTouched, checkProof]);

  // Availability is answered by the resolve endpoint: a 404 is an unclaimed
  // name. No dedicated availability endpoint needed.
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const local = validateName(name);
    if (local.status !== "checking") {
      setNameState(local);
      return;
    }
    setNameState({ status: "checking" });

    if (debounce.current) clearTimeout(debounce.current);
    const controller = new AbortController();
    debounce.current = setTimeout(() => {
      fetch(`/api/packages/${encodeURIComponent(name)}`, {
        signal: controller.signal,
      })
        .then((res) => setNameState({ status: res.ok ? "taken" : "available" }))
        .catch((err) => {
          if (err?.name !== "AbortError") setNameState({ status: "available" });
        });
    }, 300);

    return () => {
      controller.abort();
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [name]);

  const ready =
    Boolean(viewer) &&
    access.status === "granted" &&
    nameState.status === "available";

  // The preview is a real register entry, assembled from what has actually been
  // confirmed. A new registration is `recognized` — the floor — unless the
  // publisher is already verified, in which case verification travels to it.
  const draft: PackageRecord | null = useMemo(() => {
    if (!viewer || access.status !== "granted" || !name) return null;
    const level: TrustLevel = viewer.isVerified ? "verified" : "recognized";
    return {
      name,
      description: access.repo.description,
      repo_url: `https://github.com/${access.repo.full_name}`,
      homepage: access.repo.homepage,
      license: access.repo.license,
      keywords: [],
      latest_version: null,
      publisher: {
        login: viewer.login,
        display_name: viewer.name,
        avatar_url: viewer.avatarUrl,
        kind: "user",
        is_verified: viewer.isVerified,
      },
      trust: {
        level,
        publisher_verified: viewer.isVerified,
        package_trusted: false,
        repo_ownership_confirmed: true,
      },
      is_deprecated: false,
      deprecation_message: null,
          created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  }, [viewer, access, name]);

  const submit = async () => {
    if (!draft) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch("/api/packages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(await registerProof()),
        },
        body: JSON.stringify({
          name: draft.name,
          repo_url: draft.repo_url,
          description: draft.description,
          homepage: draft.homepage,
          license: draft.license,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.message ?? `Registration failed (${res.status}).`);
      }
      window.location.href = `/package/${encodeURIComponent(draft.name)}`;
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Registration failed.",
      );
      setSubmitting(false);
    }
  };

  if (authLoading) {
    return <div className="record h-72 animate-pulse" aria-busy="true" />;
  }

  if (!viewer) {
    return (
      <section className="record overflow-hidden">
        <div className="bg-recessed px-4 py-2.5">
          <p className="eyebrow">Sign in required</p>
        </div>
        <div className="space-y-4 px-4 py-6">
          <h2 className="text-xl">Registering is signing.</h2>
          <p className="reading-muted text-sm">
            A register entry names the account standing behind it, so we need to
            know who you are. Signing in asks GitHub only for your account and
            email — access to your repositories is requested later, once you name
            the repository you are claiming.
          </p>
          {/* A real navigation, not client-side routing: this hands the
              browser to GitHub's OAuth flow via our API route. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a
            href="/api/auth/github"
            className="bg-primary text-primary-foreground rounded-document inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium transition-opacity hover:opacity-90"
          >
            <Github className="size-4" aria-hidden />
            Continue with GitHub
          </a>
        </div>
      </section>
    );
  }

  return (
    <>
      <div className="space-y-6">
        <Step
          n={1}
          title="Repository"
          hint="The repository this name will point at. You need push access to it — we check with GitHub, and no human reviews it."
        >
          <div className="flex flex-col gap-2 sm:flex-row">
            <label htmlFor="repo" className="sr-only">
              GitHub repository URL
            </label>
            <input
              id="repo"
              type="url"
              inputMode="url"
              value={repoInput}
              onChange={(e) => {
                setRepoInput(e.target.value);
                setAccess({ status: "idle" });
              }}
              placeholder="https://github.com/acme/fin-http"
              autoComplete="off"
              spellCheck={false}
              className="identifier bg-recessed border-rule rounded-document focus:border-rule-strong h-11 min-w-0 flex-1 border px-3 text-sm transition-colors outline-none"
            />
            <button
              type="button"
              onClick={checkAccess}
              disabled={!repoInput.trim() || access.status === "checking"}
              className="rounded-document border-rule hover:border-rule-strong h-11 shrink-0 border px-3.5 text-sm font-medium transition-colors disabled:opacity-45"
            >
              {access.status === "checking" ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  Checking
                </span>
              ) : (
                "Check push access"
              )}
            </button>
          </div>

          {access.status === "granted" ? (
            <Verdict ok>
              Push access confirmed for{" "}
              <span className="identifier">{access.repo.full_name}</span>.
            </Verdict>
          ) : null}

          {access.status === "refused" ? (
            <Verdict ok={false}>{access.reason}</Verdict>
          ) : null}

          {access.status === "needs_scope" ? (
            <div className="well mt-3 p-3">
              <p className="reading-muted text-sm">
                To check push access, GitHub needs to let us read your
                repository permissions. We ask for this now rather than at
                sign-in, so browsing the register never requires it.
              </p>
              <a
                href={`/api/auth/github?scope=repo&return=${encodeURIComponent("/new")}`}
                className="bg-primary text-primary-foreground rounded-document mt-3 inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium transition-opacity hover:opacity-90"
              >
                <Github className="size-3.5" aria-hidden />
                Grant repository access
              </a>
            </div>
          ) : null}
        </Step>

        <Step
          n={2}
          title="Name"
          hint="Names are bare and global: http, not acme/http. First claim wins."
          disabled={access.status !== "granted"}
        >
          <label htmlFor="pkg-name" className="sr-only">
            Package name
          </label>
          <input
            id="pkg-name"
            type="text"
            value={name}
            onChange={(e) => {
              setNameTouched(true);
              setName(e.target.value.toLowerCase());
            }}
            placeholder="http"
            autoComplete="off"
            spellCheck={false}
            maxLength={NAME_MAX + 8}
            aria-describedby="name-state"
            className="identifier bg-recessed border-rule rounded-document focus:border-rule-strong h-11 w-full border px-3 text-base transition-colors outline-none"
          />

          <div id="name-state" aria-live="polite">
            {nameState.status === "invalid" ? (
              <Verdict ok={false}>{nameState.reason}</Verdict>
            ) : nameState.status === "taken" ? (
              <Verdict ok={false}>
                <span className="identifier">{name}</span> is already on the
                register.{" "}
                <Link
                  href={`/package/${encodeURIComponent(name)}`}
                  className="underline underline-offset-4"
                >
                  See who holds it
                </Link>
                .
              </Verdict>
            ) : nameState.status === "available" ? (
              <Verdict ok>
                <span className="identifier">{name}</span> is unclaimed.
              </Verdict>
            ) : nameState.status === "checking" && name ? (
              <p className="text-ink-faint mt-3 flex items-center gap-2 text-sm">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                Checking the register
              </p>
            ) : null}
          </div>
        </Step>

        <Step
          n={3}
          title="Sign the entry"
          hint="This is the record, exactly as it will read. Nothing else is stored."
          disabled={!ready}
        >
          {draft ? (
            <>
              <Countersignature pkg={draft} label="Draft entry" nameAs="p" />

              <p className="reading-muted mt-4 text-sm">
                {viewer.isVerified
                  ? SEAL_MEANING.verified
                  : SEAL_MEANING.recognized}
              </p>

              {submitError ? <Verdict ok={false}>{submitError}</Verdict> : null}

              <button
                type="button"
                onClick={submit}
                disabled={!ready || submitting}
                className="bg-primary text-primary-foreground rounded-document mt-5 inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-opacity hover:opacity-90 disabled:opacity-45"
              >
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                    Registering
                  </>
                ) : (
                  `Register ${draft.name}`
                )}
              </button>
            </>
          ) : (
            <p className="text-ink-faint text-sm">
              Confirm a repository and choose a name to see the entry.
            </p>
          )}
        </Step>
      </div>

      <p className="eyebrow rule-top mt-10 pt-4">
        Releases come later ·{" "}
        <Link
          href="/docs"
          className="hover:text-ink inline-flex items-center gap-1 transition-colors"
        >
          how versions get recorded
          <ArrowUpRight className="size-3" aria-hidden />
        </Link>
      </p>
    </>
  );
}
