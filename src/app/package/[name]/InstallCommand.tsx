"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

/**
 * The install command, with a copy button.
 *
 * A client component for one reason: the clipboard. The command itself is
 * rendered on the server and is in the HTML a reader with no JavaScript gets —
 * it is selectable text either way, and the button only saves them the drag.
 */
export default function InstallCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard denied: the text is selectable either way */
    }
  };

  return (
    <div className="well flex items-center gap-2 p-2.5">
      <code className="identifier text-ink min-w-0 flex-1 truncate text-sm">
        <span className="text-ink-faint select-none">$ </span>
        {command}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy install command"}
        className="text-ink-faint hover:text-ink rounded-document hover:bg-accent shrink-0 p-1.5 transition-colors"
      >
        {copied ? (
          <Check className="text-ink size-3.5" aria-hidden />
        ) : (
          <Copy className="size-3.5" aria-hidden />
        )}
      </button>
    </div>
  );
}
