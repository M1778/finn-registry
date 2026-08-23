import Link from "next/link";

const COLUMNS = [
  {
    title: "Register",
    links: [
      { label: "Browse", href: "/explore" },
      { label: "Register a package", href: "/new" },
      { label: "Account", href: "/dashboard" },
    ],
  },
  {
    title: "Reference",
    links: [
      { label: "Docs", href: "/docs" },
      { label: "Privacy", href: "/privacy" },
      { label: "Terms", href: "/terms" },
    ],
  },
];

export default function Footer() {
  return (
    <footer className="rule-top mt-24">
      <div className="mx-auto max-w-5xl px-6 py-12">
        <div className="grid gap-10 sm:grid-cols-[2fr_1fr_1fr]">
          <div>
            <p className="text-[0.9375rem] tracking-tight">
              <span className="text-ink font-semibold">Finn</span>{" "}
              <span className="text-ink-muted font-normal">Registry</span>
            </p>
            {/* The closing statement is the same one the whole site makes. */}
            <p className="reading-muted mt-3 max-w-xs text-sm">
              Package source is fetched from GitHub. The registry holds the
              records — names, owners, and commits — not the code.
            </p>
          </div>

          {COLUMNS.map((column) => (
            <div key={column.title}>
              <h2 className="eyebrow">{column.title}</h2>
              <ul className="mt-4 space-y-2.5">
                {column.links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-ink-muted hover:text-ink text-sm transition-colors"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <p className="eyebrow rule-top mt-10 pt-6">
          Finn Registry · {new Date().getFullYear()}
        </p>
      </div>
    </footer>
  );
}
