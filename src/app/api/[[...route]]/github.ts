/**
 * The GitHub side of registration.
 *
 * GitHub is the content server (ADR-0001), so it is also the only authority on
 * who may claim a name: a registration is refused unless the signed-in account
 * can push to the repository it points at, checked against the GitHub API with
 * no human in the loop (ADR-0004).
 *
 * Everything here is `fetch` and string handling, which is all `workerd` offers
 * and all this needs.
 */

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "Finn-Registry";

/** What the registry is willing to copy out of a repository at registration. */
export interface RepoFacts {
  full_name: string;
  description: string | null;
  homepage: string | null;
  /**
   * SPDX identifier as GitHub reports it, or `null`. Never defaulted: guessing a
   * licence for someone else's code is a legal claim the registry cannot make.
   */
  license: string | null;
  default_branch: string;
}

export type RepoAccess =
  | { pushAccess: true; needsScope: false; repo: RepoFacts; reason: null }
  | { pushAccess: false; needsScope: boolean; repo: RepoFacts | null; reason: string };

export interface GitHubRepoRef {
  owner: string;
  repo: string;
  fullName: string;
}

const OWNER_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * Pull `owner/repo` out of whatever form of GitHub reference was submitted.
 *
 * Returns `null` for anything that is not a GitHub repository, including other
 * Git hosts: the registry binds names to GitHub and nowhere else, so accepting a
 * GitLab URL would create a registration it can never verify.
 */
export function parseGitHubRepo(input: string): GitHubRepoRef | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  let path = "";

  const scpLike = /^git@github\.com:(.+)$/i.exec(trimmed);
  if (scpLike) {
    path = scpLike[1];
  } else if (/^[a-z]+:\/\//i.test(trimmed) || /^github\.com\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    } catch {
      return null;
    }
    if (url.hostname.toLowerCase() !== "github.com" && url.hostname.toLowerCase() !== "www.github.com") {
      return null;
    }
    path = url.pathname;
  } else {
    // Bare `owner/repo`.
    path = trimmed;
  }

  const segments = path
    .replace(/\.git$/i, "")
    .split("/")
    .filter(Boolean);

  if (segments.length !== 2) return null;

  const [owner, repo] = segments;
  if (!OWNER_SEGMENT.test(owner) || !REPO_SEGMENT.test(repo)) return null;

  return { owner, repo, fullName: `${owner}/${repo}` };
}

/** GitHub's canonical URL for a reference, so stored URLs are consistent. */
export function canonicalRepoUrl(ref: GitHubRepoRef): string {
  return `https://github.com/${ref.owner}/${ref.repo}`;
}

function toRepoFacts(payload: any, ref: GitHubRepoRef): RepoFacts {
  const spdx = payload?.license?.spdx_id;

  return {
    full_name: typeof payload?.full_name === "string" ? payload.full_name : ref.fullName,
    description: payload?.description || null,
    homepage: payload?.homepage || null,
    // "NOASSERTION" is GitHub saying it found a licence file it could not
    // identify. That is not an SPDX identifier, so it is not a licence.
    license: typeof spdx === "string" && spdx !== "NOASSERTION" ? spdx : null,
    default_branch: typeof payload?.default_branch === "string" ? payload.default_branch : "main",
  };
}

/**
 * Can this token's owner push to this repository?
 *
 * `needsScope` distinguishes "you are not allowed" from "the registry was not
 * granted enough access to find out". The two look identical from GitHub — a
 * private repository is a 404 to a token without repository scope — and only the
 * second is worth sending the user back through an authorization round trip for.
 */
export async function checkPushAccess(input: {
  ref: GitHubRepoRef;
  accessToken: string | null | undefined;
  hasRepositoryScope: boolean;
}): Promise<RepoAccess> {
  const { ref, accessToken, hasRepositoryScope } = input;

  if (!accessToken) {
    return {
      pushAccess: false,
      needsScope: true,
      repo: null,
      reason:
        "This sign-in did not come with a GitHub token, so your access to " +
        `${ref.fullName} cannot be checked. Sign in with GitHub again.`,
    };
  }

  let response: Response;
  try {
    response = await fetch(`${GITHUB_API}/repos/${ref.owner}/${ref.repo}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": USER_AGENT,
      },
    });
  } catch {
    return {
      pushAccess: false,
      needsScope: false,
      repo: null,
      reason: `GitHub could not be reached to check your access to ${ref.fullName}. Try again in a moment.`,
    };
  }

  if (response.status === 401) {
    return {
      pushAccess: false,
      needsScope: true,
      repo: null,
      reason: `Your GitHub sign-in is no longer valid, so your access to ${ref.fullName} cannot be checked. Sign in again.`,
    };
  }

  if (response.status === 404) {
    return {
      pushAccess: false,
      needsScope: !hasRepositoryScope,
      repo: null,
      reason: hasRepositoryScope
        ? `GitHub has no repository at ${ref.fullName}, or your account cannot see it.`
        : `GitHub will not show ${ref.fullName} with the access you have granted so far. If it is private, grant repository access and try again.`,
    };
  }

  if (response.status === 403) {
    return {
      pushAccess: false,
      needsScope: false,
      repo: null,
      reason: `GitHub declined to report your permissions on ${ref.fullName}. If it belongs to an organisation, that organisation may be blocking third-party access.`,
    };
  }

  if (!response.ok) {
    return {
      pushAccess: false,
      needsScope: false,
      repo: null,
      reason: `GitHub returned an unexpected error (HTTP ${response.status}) while checking your access to ${ref.fullName}. Try again shortly.`,
    };
  }

  const payload: any = await response.json().catch(() => null);
  const facts = toRepoFacts(payload, ref);
  const permissions = payload?.permissions;

  if (!permissions) {
    return {
      pushAccess: false,
      needsScope: true,
      repo: facts,
      reason: `GitHub did not report your permissions on ${ref.fullName}. Grant repository access so the check can be made.`,
    };
  }

  if (permissions.push === true || permissions.admin === true || permissions.maintain === true) {
    return { pushAccess: true, needsScope: false, repo: facts, reason: null };
  }

  return {
    pushAccess: false,
    needsScope: false,
    repo: facts,
    reason: permissions.pull === true
      ? `You have read access to ${ref.fullName} but not push access, so you cannot claim a name for it.`
      : `You do not have push access to ${ref.fullName}, so you cannot claim a name for it.`,
  };
}
