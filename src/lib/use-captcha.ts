"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CAPTCHA_HEADER, type CaptchaScope, type Challenge } from "./captcha-shared";
import { solveToken } from "./captcha-solver";

/**
 * Hold a solved proof of work ready for one submission.
 *
 * The work is done ahead of the click, not during it. A 15-bit challenge is
 * around a second of hashing on a laptop and a few on a phone, which is fine
 * while someone is still typing a description and much less fine after they
 * have pressed the button. So the hook fetches and solves as soon as it is
 * enabled, and `headers()` usually resolves instantly with a token that has
 * been sitting ready.
 *
 * Tokens are single-use server-side, so `headers()` starts the next solve as it
 * hands the current one over. That also covers the retry path: if a submission
 * comes back 4xx for an unrelated reason, the fresh token is already in flight
 * by the time the reader fixes the field and tries again.
 */

export type CaptchaState = "idle" | "working" | "ready" | "failed";

export interface CaptchaHandle {
  /**
   * Headers to merge into the request. Awaits the current solve; retries once
   * from a new challenge if that solve failed, and throws if it fails again.
   */
  headers: () => Promise<Record<string, string>>;
  state: CaptchaState;
}

async function fetchChallenge(
  scope: CaptchaScope,
  signal: AbortSignal,
): Promise<Challenge> {
  const res = await fetch(`/api/captcha?scope=${encodeURIComponent(scope)}`, {
    signal,
  });
  if (!res.ok) throw new Error(`Could not get a challenge (${res.status}).`);
  const challenge = (await res.json()) as Challenge;
  if (
    typeof challenge?.salt !== "string" ||
    typeof challenge?.sig !== "string" ||
    typeof challenge?.bits !== "number"
  ) {
    throw new Error("The challenge was not in a shape we understand.");
  }
  return challenge;
}

export function useCaptcha(
  scope: CaptchaScope,
  options: { enabled?: boolean } = {},
): CaptchaHandle {
  const enabled = options.enabled ?? true;
  const [state, setState] = useState<CaptchaState>("idle");

  // The in-flight (or settled) solve. A ref, not state: replacing it must not
  // re-render, and `headers()` has to read the current one rather than the one
  // captured when it was created.
  const pending = useRef<Promise<string> | null>(null);
  const aborter = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  const start = useCallback(() => {
    aborter.current?.abort();
    const controller = new AbortController();
    aborter.current = controller;

    if (mounted.current) setState("working");
    const attempt = (async () => {
      const challenge = await fetchChallenge(scope, controller.signal);
      return solveToken(challenge, { signal: controller.signal });
    })();

    pending.current = attempt;
    attempt.then(
      () => {
        // Only the latest solve may report; an aborted one is not a failure.
        if (mounted.current && aborter.current === controller) setState("ready");
      },
      () => {
        if (mounted.current && aborter.current === controller) setState("failed");
      },
    );
    return attempt;
  }, [scope]);

  useEffect(() => {
    mounted.current = true;
    if (enabled) start();
    return () => {
      mounted.current = false;
      aborter.current?.abort();
    };
  }, [enabled, start]);

  const headers = useCallback(async () => {
    let token: string;
    try {
      token = await (pending.current ?? start());
    } catch {
      // One retry from a fresh challenge. The usual cause is a challenge that
      // sat past its ten minutes on a page left open, which a new one fixes.
      token = await start();
    }
    // Spent as far as the server is concerned — line up the next one.
    pending.current = null;
    start();
    return { [CAPTCHA_HEADER]: token };
  }, [start]);

  // Memoized so a caller can list the handle in a dependency array without
  // rebuilding its own callbacks on every render.
  return useMemo(() => ({ headers, state }), [headers, state]);
}
