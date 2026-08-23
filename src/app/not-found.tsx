import Link from "next/link";

export const metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <div className="mx-auto w-full max-w-lg px-6 py-24">
      <section className="record overflow-hidden">
        <div className="bg-recessed px-4 py-2.5">
          <p className="eyebrow">404 · No entry</p>
        </div>

        <div className="space-y-4 px-4 py-6">
          <h1 className="text-xl font-semibold">This page isn&rsquo;t here.</h1>
          <p className="reading-muted text-sm">
            If you were looking for a package, it may not be on the register
            yet. Anyone with push access to a repository can add it.
          </p>

          <div className="flex flex-wrap gap-2 pt-1">
            <Link
              href="/explore"
              className="bg-primary text-primary-foreground rounded-document px-3.5 py-2 text-sm font-medium transition-opacity hover:opacity-90"
            >
              Search the register
            </Link>
            <Link
              href="/new"
              className="rounded-document border-rule hover:border-rule-strong border px-3.5 py-2 text-sm font-medium transition-colors"
            >
              Register a package
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
