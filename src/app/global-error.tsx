"use client";

import "./globals.css";

/**
 * Last-resort error page. It owns its own <html> and <body> because the root
 * layout has already failed by the time this renders, so it cannot rely on the
 * fonts or providers set up there.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-ground text-ink flex min-h-screen items-center justify-center p-6 antialiased">
        <main className="record w-full max-w-lg overflow-hidden">
          <div className="bg-recessed px-4 py-2.5">
            <p className="eyebrow">Registry error</p>
          </div>

          <div className="space-y-4 px-4 py-6">
            <h1 className="text-xl font-semibold">
              The registry couldn&rsquo;t finish this request.
            </h1>
            <p className="text-ink-muted text-sm">
              Nothing on the register was changed. Try again, and if it keeps
              happening, open an issue with the reference below.
            </p>

            {error.digest ? (
              <p className="well identifier text-ink-muted px-3 py-2 text-xs">
                Reference {error.digest}
              </p>
            ) : null}

            <button
              type="button"
              onClick={reset}
              className="bg-primary text-primary-foreground rounded-document px-3.5 py-2 text-sm font-medium transition-opacity hover:opacity-90"
            >
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
