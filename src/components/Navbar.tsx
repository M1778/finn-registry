"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Github, LogOut, Menu } from "lucide-react";
import ThemeToggle from "@/components/ThemeToggle";
import Logo from "@/components/registry/Logo";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

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

/** Match nested routes too: /docs/anything still marks Docs. */
function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function Navbar() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [mounted, setMounted] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
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

  // A <Link> inside the panel is a client-side transition: the route changes but
  // nothing unmounts the panel, so it would sit open over the page the reader
  // just asked for. Closing on pathname change covers every way out of the
  // panel — link, back button, redirect — rather than only the ones we wired.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/";
  };

  const canReview = user?.role === "moderator" || user?.role === "admin";

  // One row of the panel. Rows are 44px minimum because a thumb, not a cursor,
  // is aiming at them; square-edged and ruled off each other because the panel
  // is a page of the register like everything else (globals.css, rule 2).
  const rowClass =
    "rule-bottom flex min-h-11 w-full items-center px-6 text-left text-[0.9375rem] transition-colors";

  return (
    <nav className="rule-bottom bg-ground/85 sticky top-0 z-50 w-full backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 px-6 sm:gap-6">
        <div className="flex min-w-0 items-center gap-7">
          <Link href="/" className="shrink-0" aria-label="finn-registry home">
            <Logo />
          </Link>

          <div className="hidden items-center gap-5 text-sm sm:flex">
            {LINKS.map((link) => {
              const active = isActive(pathname, link.href);
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
                {/* Below sm the whole signed-in cluster lives in the panel
                    instead. At 320px the bar is 320 - 48 (px-6) = 272px of
                    usable width; the logo lockup alone is ~150px, so "Bench" +
                    "Account" + the sign-out icon (~190px together) cannot also
                    fit. The icons stay, the words move. */}
                {canReview ? (
                  <Link
                    href="/admin"
                    aria-current={isActive(pathname, "/admin") ? "page" : undefined}
                    className="text-ink-muted hover:text-ink rounded-document hover:bg-accent hidden px-2.5 py-1.5 text-sm transition-colors sm:block"
                  >
                    Bench
                  </Link>
                ) : null}
                <Link
                  href="/dashboard"
                  aria-current={
                    isActive(pathname, "/dashboard") ? "page" : undefined
                  }
                  className="text-ink-muted hover:text-ink rounded-document hover:bg-accent hidden px-2.5 py-1.5 text-sm transition-colors sm:block"
                >
                  Account
                </Link>
                <button
                  type="button"
                  onClick={handleLogout}
                  aria-label="Sign out"
                  title="Sign out"
                  className="text-ink-muted hover:text-ink rounded-document hover:bg-accent hidden p-2 transition-colors sm:block"
                >
                  <LogOut className="size-4" aria-hidden />
                </button>
              </>
            ) : (
              /* Signed out, the call to action is the only way in, so it stays
                 in the bar at every width and is repeated in the panel. */
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

          {/* The inline links appear at sm, so the trigger disappears there:
              one set of navigation at any given width, never both. Radix Dialog
              (via Sheet) is doing the work here rather than a hand-rolled
              panel — focus trap, Esc, scroll lock, aria-modal and focus return
              to the trigger are all things a nav menu must get right and none
              of them are worth reimplementing. */}
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger
              aria-label="Open menu"
              className="text-ink-muted hover:text-ink rounded-document hover:bg-accent -mr-2 flex size-11 items-center justify-center transition-colors sm:hidden"
            >
              <Menu className="size-5" aria-hidden />
            </SheetTrigger>

            {/* z-[60]: the bar is sticky z-50, and the panel must cover it
                rather than slide under it.

                The `[&>button]` rules re-size Sheet's own close button, which
                ships as a bare 16px glyph. It is the one control a reader
                reaches for to get out of the panel, so it gets the same 44px
                box as the trigger and the rows; it is centred in the 56px
                header so it lines up with the bar it replaced. */}
            <SheetContent
              side="right"
              aria-describedby={undefined}
              className="bg-ground border-rule z-[60] w-[min(20rem,86vw)] gap-0 p-0 [&>button]:top-1.5 [&>button]:right-2.5 [&>button]:flex [&>button]:size-11 [&>button]:items-center [&>button]:justify-center"
            >
              <SheetHeader className="rule-bottom h-14 justify-center p-0 px-6">
                <SheetTitle className="font-display text-[0.9375rem] font-semibold">
                  Menu
                </SheetTitle>
              </SheetHeader>

              <div className="flex flex-col">
                {LINKS.map((link) => {
                  const active = isActive(pathname, link.href);
                  return (
                    <Link
                      key={link.href}
                      href={link.href}
                      aria-current={active ? "page" : undefined}
                      className={`${rowClass} ${
                        active ? "text-ink bg-accent font-medium" : "text-ink-muted"
                      }`}
                    >
                      {link.label}
                    </Link>
                  );
                })}

                {/* Same mount gate as the bar: the panel is part of the same
                    component, so a session-dependent row rendered on the server
                    would be the hydration mismatch the gate exists to avoid. */}
                {mounted ? (
                  user ? (
                    <>
                      <Link
                        href="/dashboard"
                        aria-current={
                          isActive(pathname, "/dashboard") ? "page" : undefined
                        }
                        className={`${rowClass} ${
                          isActive(pathname, "/dashboard")
                            ? "text-ink bg-accent font-medium"
                            : "text-ink-muted"
                        }`}
                      >
                        Account
                      </Link>

                      {canReview ? (
                        <Link
                          href="/admin"
                          aria-current={
                            isActive(pathname, "/admin") ? "page" : undefined
                          }
                          className={`${rowClass} ${
                            isActive(pathname, "/admin")
                              ? "text-ink bg-accent font-medium"
                              : "text-ink-muted"
                          }`}
                        >
                          Bench
                        </Link>
                      ) : null}

                      {/* Sign-out is not a navigation, so it does not close via
                          the pathname effect — SheetClose closes the panel and
                          returns focus before the reload takes the page away. */}
                      <SheetClose asChild>
                        <button
                          type="button"
                          onClick={handleLogout}
                          className={`${rowClass} text-ink-muted gap-2.5`}
                        >
                          <LogOut className="size-4 shrink-0" aria-hidden />
                          Sign out
                        </button>
                      </SheetClose>
                    </>
                  ) : (
                    /* eslint-disable-next-line @next/next/no-html-link-for-pages */
                    <a
                      href="/api/auth/github"
                      className={`${rowClass} text-ink gap-2.5 font-medium`}
                    >
                      <Github className="size-4 shrink-0" aria-hidden />
                      Sign in with GitHub
                    </a>
                  )
                ) : null}
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </nav>
  );
}
