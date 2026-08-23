"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";

/**
 * Dark is the register's ground; paper is the alternate. The toggle is a plain
 * two-state switch rather than a three-way menu with a system option, because
 * the default is a deliberate choice here, not a guess at the OS.
 */
export default function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const isDark = resolvedTheme !== "light";

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="text-ink-muted hover:text-ink rounded-document hover:bg-accent p-2 transition-colors"
      // Before hydration we cannot know the stored theme, so stay unlabelled
      // rather than announcing the wrong one.
      aria-label={
        mounted ? (isDark ? "Switch to paper" : "Switch to dark") : undefined
      }
      title={mounted ? (isDark ? "Switch to paper" : "Switch to dark") : undefined}
    >
      {mounted && !isDark ? (
        <Moon className="size-4" aria-hidden />
      ) : (
        <Sun className="size-4" aria-hidden />
      )}
    </button>
  );
}
