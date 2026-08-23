import type { Metadata } from "next";
import Link from "next/link";
import RegisterForm from "./RegisterForm";

export const metadata: Metadata = {
  title: "Register a package",
  description:
    "Claim a package name and bind it to a repository you can push to. Nothing is uploaded — the code stays on GitHub.",
};

/**
 * The page shell for registration.
 *
 * Static on purpose. The heading and the explanation of what registering does
 * are the same for everyone, so they render on the server and do not wait on the
 * session check that `RegisterForm` needs — previously the whole page was one
 * client component, and a visitor's first paint was a pulsing rectangle.
 */
export default function NewPackagePage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-3xl sm:text-4xl">Register a package</h1>
      <p className="reading-muted mt-3">
        Registering claims a name and binds it to a repository. Nothing is
        uploaded — no archive, no code, no build. When someone runs{" "}
        <code className="identifier text-ink">finn add yourname</code>, the
        registry tells them which repository and commit to fetch, and GitHub
        serves it.
      </p>
      <p className="eyebrow mt-4">
        <Link href="/docs/registering-a-package" className="hover:text-ink">
          What this does and does not do →
        </Link>
      </p>

      <div className="mt-10">
        <RegisterForm />
      </div>
    </div>
  );
}
