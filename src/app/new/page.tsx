import type { Metadata } from "next";
import Link from "next/link";
import RegisterForm from "./RegisterForm";

export const metadata: Metadata = {
  title: "Register a package",
  description:
    "Claim a package name, bind it to a repository you can push to, and register the git tags that become its versions.",
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
        Registering claims a name and binds it to a repository you can push to.
        From then on{" "}
        <code className="identifier text-ink">finn add yourname</code> resolves
        through the register: it reads the repository and the exact commit behind
        the version it needs, and installs that.
      </p>
      <p className="eyebrow mt-4">
        <Link href="/docs/registering-a-package" className="hover:text-ink">
          How registering works →
        </Link>
      </p>

      <div className="mt-10">
        <RegisterForm />
      </div>
    </div>
  );
}
