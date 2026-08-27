import DocsIndex from "./DocsIndex";

/**
 * Docs shell: a table of contents down the side, prose in the middle.
 *
 * The index is the only interactive part, so it is the only client component —
 * the shell itself renders on the server. Removed with the rewrite: a
 * dashed-border card advertising a Discord server that does not exist, and an
 * animating chevron on the active link.
 */
export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-6xl gap-12 px-6 py-10 lg:flex">
      <aside className="lg:w-56 lg:shrink-0">
        <div className="lg:sticky lg:top-24">
          <DocsIndex />
        </div>
      </aside>

      <main className="mt-12 min-w-0 flex-1 lg:mt-0">
        <div className="max-w-2xl">{children}</div>
      </main>
    </div>
  );
}
