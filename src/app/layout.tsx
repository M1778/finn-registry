import type { Metadata } from "next";
import { Archivo, Newsreader, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { ThemeProvider } from "@/components/theme-provider";

// Signage face: headings, interface chrome, anything that labels.
const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  display: "swap",
});

// Reading face: descriptions, docs prose, READMEs.
const newsreader = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
  display: "swap",
});

// Record face: package names, versions, commits, checksums. A primary face
// here, not a caption face — most of what this site shows is an identifier.
const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

const TAGLINE =
  "The register of record for Fin packages. Every name has an owner, a repository it resolves to, and a commit behind each version.";

export const metadata: Metadata = {
  // Without this, Next resolves the card's URL against localhost and warns at
  // build time. Same env var the OAuth callback is built from, so one setting
  // keeps both correct.
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL ||
      process.env.APP_URL ||
      "http://localhost:3000",
  ),
  title: {
    default: "finn-registry",
    template: "%s · finn-registry",
  },
  description: TAGLINE,
  applicationName: "finn-registry",
  // The card is the mark alone (src/app/opengraph-image.png); the name and the
  // line under it travel as text so they stay crisp and translatable.
  openGraph: {
    type: "website",
    siteName: "finn-registry",
    title: "finn-registry",
    description: TAGLINE,
  },
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${archivo.variable} ${newsreader.variable} ${plexMono.variable} antialiased`}
        suppressHydrationWarning
      >
        {/* Dark is the register's own ground. Paper is offered, not guessed at
            from the OS, which is why enableSystem is off. */}
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem={false}
          disableTransitionOnChange
        >
          <div className="relative flex min-h-screen flex-col">
            <Navbar />
            <main className="flex-1">{children}</main>
            <Footer />
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
