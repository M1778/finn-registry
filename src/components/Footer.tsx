import Link from "next/link";
import Logo from "@/components/registry/Logo";

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
      { label: "Source", href: "https://github.com/M1778/finn-registry" },
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
            <Logo />
            {/* The closing statement is the same one the whole site makes. */}
            <p className="reading-muted mt-3 max-w-xs text-sm">
              The register of record for Fin packages. Names, owners, and the
              commit behind every version.
            </p>
          </div>

          {COLUMNS.map((column) => (
            <div key={column.title}>
              <h2 className="eyebrow">{column.title}</h2>
              <ul className="mt-4 space-y-2.5">
                {column.links.map((link) => (
                  <li key={link.href}>
                    {link.href.startsWith("https://") ? (
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noreferrer"
                        className="text-ink-muted hover:text-ink text-sm transition-colors"
                      >
                        {link.label}
                      </a>
                    ) : (
                      <Link
                        href={link.href}
                        className="text-ink-muted hover:text-ink text-sm transition-colors"
                      >
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* AGPL-3.0 §13: whoever runs this must offer its users the source. Naming the
            licence here is what makes the "Source" link above legible as that offer. */}
        <p className="eyebrow rule-top mt-10 pt-6">
          finn-registry · {new Date().getFullYear()} · AGPL-3.0
        </p>
      </div>
    </footer>
  );
}
