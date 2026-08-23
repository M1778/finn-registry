"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Github, LogOut } from "lucide-react";
import ThemeToggle from "@/components/ThemeToggle";
import Logo from "@/components/registry/Logo";

/**
 * Only the fields the bar renders. `/api/auth/status` returns the whole account
 * row, and `role` is the one thing here that changes what is offered: a reviewer
 * gets a link to the bench, and nobody else is shown a door they cannot open.
 */
type SessionUser = {
  login?: string;
  username?: string;
  name?: string | null;
  role?: string;
};

const LINKS = [
  { href: "/explore", label: "Explore" },
  { href: "/docs", label: "Docs" },
];

export default function Navbar() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [mounted, setMounted] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    setMounted(true);
    let live = true;
    fetch("/api/auth/status")
      .then((res) => res.json())
      .then((data) => live && setUser(data?.authenticated ? data.user : null))
      .catch(() => live && setUser(null));
    return () => {
      live = false;
    };
  }, [pathname]);

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/";
  };

  return (
    <nav className="rule-bottom bg-ground/85 sticky top-0 z-50 w-full backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-6 px-6">
        <div className="flex min-w-0 items-center gap-7">
          <Link href="/" className="shrink-0" aria-label="finn-registry home">
            <Logo />
          </Link>

          <div className="hidden items-center gap-5 text-sm sm:flex">
            {LINKS.map((link) => {
              // Match nested routes too: /docs/anything still marks Docs.
              const active =
                pathname === link.href || pathname.startsWith(`${link.href}/`);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={active ? "page" : undefined}
                  className={
                    active
                      ? "text-ink"
                      : "text-ink-muted hover:text-ink transition-colors"
                  }
                >
                  {link.label}
                </Link>
              );
            })}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <ThemeToggle />

          {/* Rendered only after mount: the server has no session, and showing
              "Sign in" to a signed-in reader for one frame is worse than a gap. */}
          {mounted ? (
            user ? (
              <>
                {user.role === "moderator" || user.role === "admin" ? (
                  <Link
                    href="/admin"
                    className="text-ink-muted hover:text-ink rounded-document hover:bg-accent px-2.5 py-1.5 text-sm transition-colors"
                  >
                    Bench
                  </Link>
                ) : null}
                <Link
                  href="/dashboard"
                  className="text-ink-muted hover:text-ink rounded-document hover:bg-accent px-2.5 py-1.5 text-sm transition-colors"
                >
                  Account
                </Link>
                <button
                  type="button"
                  onClick={handleLogout}
                  aria-label="Sign out"
                  title="Sign out"
                  className="text-ink-muted hover:text-ink rounded-document hover:bg-accent p-2 transition-colors"
                >
                  <LogOut className="size-4" aria-hidden />
                </button>
              </>
            ) : (
              /* eslint-disable-next-line @next/next/no-html-link-for-pages */
              <a
                href="/api/auth/github"
                className="bg-primary text-primary-foreground rounded-document ml-1 inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium transition-opacity hover:opacity-90"
              >
                <Github className="size-4" aria-hidden />
                Sign in
              </a>
            )
          ) : null}
        </div>
      </div>
    </nav>
  );
}
