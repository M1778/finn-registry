import type { Metadata } from "next";
import DashboardClient from "./DashboardClient";

export const metadata: Metadata = {
  title: "Your account",
  description:
    "The entries signed in your name, your standing on the register, and the details we hold on your account.",
};

/**
 * The page shell for the dashboard.
 *
 * Static on purpose. The heading and what this page is for are the same for
 * everyone, so they render on the server rather than waiting behind the session
 * fetch that `DashboardClient` needs — the previous version was one client
 * component whose first paint, and whose entire SSR payload, was a spinner.
 */
export default function DashboardPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <p className="eyebrow">Counterfoil</p>
      <h1 className="mt-2 text-3xl sm:text-4xl">Your side of the register</h1>
      <p className="reading-muted mt-3">
        A register keeps two halves of every entry: the public one, and the copy
        the signatory keeps. This is your copy — what the register says about
        you, and the names it says are yours.
      </p>

      <div className="mt-10">
        <DashboardClient />
      </div>
    </div>
  );
}
