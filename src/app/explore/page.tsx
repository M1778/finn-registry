import type { Metadata } from "next";
import ExploreBrowser from "./ExploreBrowser";

export const metadata: Metadata = {
  title: "The register",
  description:
    "Every package name claimed on Finn Registry, who claimed it, and the repository it points at.",
};

/**
 * The page shell for browsing.
 *
 * Static on purpose. `ExploreBrowser` reads the query string, which puts it
 * behind a Suspense boundary — so anything rendered inside it is absent from the
 * SSR payload. The heading and the description are the same for every visitor
 * and belong out here, where a crawler and a reader can both see them.
 */
export default function ExplorePage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-3xl sm:text-4xl">The register</h1>
      <p className="reading-muted mt-3 max-w-2xl">
        Every name claimed here, who claimed it, and what it points at.
      </p>
      <ExploreBrowser />
    </div>
  );
}
