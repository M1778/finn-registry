"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";

/**
 * Register lookup. Search matters here, but it is not the hero — the register
 * entry is. So this is one disciplined field, not a centrepiece.
 */
export default function RegisterSearch() {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (query.trim().length < 2) {
      setSuggestions([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/search/suggestions?q=${encodeURIComponent(query.trim())}`, {
        signal: controller.signal,
      })
        .then((res) => (res.ok ? res.json() : []))
        .then((data) => setSuggestions(Array.isArray(data) ? data : []))
        .catch(() => {
          /* aborted or offline: leave the last suggestions in place */
        });
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  // Dismiss on outside click so the list never strands over the page.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const go = (name: string) => {
    const q = name.trim();
    if (q) router.push(`/explore?q=${encodeURIComponent(q)}`);
  };

  const visible = open && suggestions.length > 0;

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!visible) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === "Escape") {
      setOpen(false);
      setActive(-1);
    }
  };

  return (
    <div ref={containerRef} className="relative w-full max-w-xl">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          go(active >= 0 ? suggestions[active] : query);
        }}
        role="search"
      >
        <label htmlFor="register-lookup" className="eyebrow mb-2 block">
          Look up a name
        </label>
        <div className="relative">
          <Search
            className="text-ink-faint pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
            aria-hidden
          />
          <input
            id="register-lookup"
            type="text"
            role="combobox"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
              setActive(-1);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            placeholder="http"
            autoComplete="off"
            spellCheck={false}
            aria-autocomplete="list"
            aria-expanded={visible}
            aria-controls="register-lookup-suggestions"
            aria-activedescendant={
              visible && active >= 0
                ? `register-lookup-option-${active}`
                : undefined
            }
            className="identifier bg-recessed border-rule rounded-document focus:border-rule-strong h-11 w-full border pr-3 pl-9 text-base transition-colors outline-none"
          />
        </div>
      </form>

      {visible ? (
        <ul
          id="register-lookup-suggestions"
          role="listbox"
          className="record absolute top-full left-0 z-50 mt-1 max-h-72 w-full overflow-auto"
        >
          {suggestions.map((name, i) => (
            <li key={name} role="option" aria-selected={i === active}>
              <button
                type="button"
                onPointerDown={() => go(name)}
                onMouseEnter={() => setActive(i)}
                className={`identifier hover:bg-accent flex w-full items-center px-3 py-2.5 text-left text-sm transition-colors ${
                  i === active ? "bg-accent" : ""
                } ${i > 0 ? "rule-top" : ""}`}
              >
                {name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
