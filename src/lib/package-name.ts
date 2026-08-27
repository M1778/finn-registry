/**
 * What a package name may be.
 *
 * One rule, one place. This module is imported by the registration endpoint
 * (`src/app/api/[[...route]]/router.ts`) and by the browser form
 * (`src/app/new/RegisterForm.tsx`), because a client that accepts what the
 * server refuses is worse than no client-side check at all: it walks the
 * registrant through three steps and then refuses at the signature.
 *
 * The rule narrowed on 2026-08-24, by the owner's ruling: `^[a-z][a-z0-9]*$`,
 * 2 to 64 characters, plus Fin's reserved words. It used to permit interior
 * hyphens (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`), which is safe as a URL segment and
 * **not** safe as a Fin identifier — Fin's lexer is
 * `ID {ALPHA}({ALPHA}|{DIGIT})*` over `ALPHA [a-zA-Z_]`, so a hyphen lexes as
 * `MINUS` and `import http-client;` is not a bad-name error but a subtraction of
 * two undeclared names. See ADR-0002's superseding note.
 *
 * **Refused, not normalised and not warned.** Mapping `http-client` to
 * `http_client` would give one package two spellings and make the user
 * reconcile them, which is the same class of mistake as inventing a version.
 * Refusing costs the registrant one rename at the only moment it is free: a name
 * is permanent and first-come-first-served, so accepting `let` means nobody can
 * ever write `import let;` against it.
 *
 * This module is pure — no I/O, no database, no `next/*` import — so the client
 * component can import it and the handler can call it per request.
 */

/**
 * Lowercase letter first, then lowercase letters and digits. No hyphen, no
 * underscore, no dot, no slash. Every string this admits is a Fin identifier.
 */
export const NAME_RULE = /^[a-z][a-z0-9]*$/;

/** Two characters, so a name is pronounceable and a route segment is not one letter. */
export const NAME_MIN = 2;

/** Sixty-four, which is the column width and comfortably past any real name. */
export const NAME_MAX = 64;

/**
 * Fin's reserved words, as of 2026-08-24, filtered to those a name matching
 * `NAME_RULE` could actually spell.
 *
 * Derived mechanically from the keyword rules in `Fin/src/lexer/lexer.l` — every
 * quoted literal that begins a rule and satisfies `NAME_RULE` — rather than
 * transcribed by hand, because a hand-copied grammar is a list that drifts
 * silently. **58 entries**, and two independent countings agree on that number:
 * the lexer's 60 explicit `"word" { MAKE(…) }` rules less `Self` (capitalised)
 * and `as_ptr` (underscored), which the rule already makes unregisterable; or
 * every quoted literal in the same region less those two, the hash-prefixed
 * `#for` and `#index`, and the operator literals `->`, `::` and `=>`. Anything
 * `NAME_RULE` cannot spell is left off rather than listed, because a reserved
 * word no name can collide with is dead weight — `tests/api/registrations.test.ts`
 * asserts that every entry is a name the register could otherwise have issued.
 *
 * **Only words the lexer has today.** Reserving plausible future keywords
 * (`await`, `match`, `switch`, `impl`, …) was considered and rejected: the
 * `import { A, B } from "<name>";` form takes the path as a **string literal**,
 * which never lexes as a keyword, so a future keyword collision costs a name its
 * other import forms and keeps that one. A future collision degrades a name; it
 * does not break it. Spending `select`, `union`, `assert`, `some`, `none`,
 * `with` and `go` permanently to prevent a degradation is a bad trade.
 *
 * **`Fin/src/diagnostics/DiagnosticEngine.cpp` is not the source, and must not
 * become one.** It holds a tidier-looking keyword list and is the file somebody
 * will reach for next, because the lexer is not a list at all. It is for
 * highlighting and did-you-mean suggestions, and it both over- and under-states:
 * it names eight words the lexer does not reserve — `bez`, `beton`, `elseif`,
 * `self`, `short`, `uint`, `ulong`, `ushort`. Reserving any of those would cost a
 * registrant a legal name for no reason, and it is the harder mistake to find
 * later, because nothing fails when a name is refused that should not have been.
 *
 * Fin is a third repository, so this list can fall out of date with its grammar.
 * `tests/api/registrations.test.ts` pins it, and `finn`'s own `FIN_KEYWORDS`
 * (`finn/src/finname.rs`) is the cross-check — see the note on `m1778` below.
 *
 * Provenance, since it crosses a repository and therefore a licence: Fin is
 * GPL-3.0-only and this repository is AGPL-3.0-only, which is the direction the
 * README says code may travel. A grammar's keyword list copied *out* of here into
 * either of those would not be.
 */
export const FIN_RESERVED_WORDS: ReadonlySet<string> = new Set([
  "any", "as", "auto", "blame", "bool", "break",
  "cast", "catch", "char", "class", "const", "continue",
  "define", "delete", "do", "double", "else", "enum",
  "extern", "false", "float", "fn", "for", "foreach",
  "from", "fun", "if", "implements", "import", "in",
  "int", "interface", "let", "long", "m1778", "macro",
  "namespace", "new", "noret", "null", "operator", "priv",
  "pub", "quote", "readonly", "return", "sizeof", "special",
  "static", "string", "struct", "super", "true", "try",
  "type", "typeof", "void", "while",
]);

/**
 * `m1778` is on the list on purpose, and it is the one entry that does not look
 * like a keyword.
 *
 * It is a real reserved token: `"m1778" { MAKE(KW_M1778); }` at `lexer.l:209`,
 * a `%token KW_M1778` and a production at `parser.y:2798`, an
 * `ASTTokenKind::M1778`, and a codegen arm in `CodeGen_LLVM.cpp`. It is Fin's
 * expression for "not implemented", written `blame m1778;`. Unlike `Self` and
 * `as_ptr` it satisfies `NAME_RULE` exactly, so it is a name somebody could
 * otherwise register — and being the project owner's own handle, it is among the
 * likelier names for somebody to try.
 *
 * It is **absent from `finn`'s `FIN_KEYWORDS`**, which is why the derivation runs
 * from the lexer and treats that list as a cross-check rather than a source. Had
 * it been copied from `finn`, this is the single word that would have slipped
 * through. `finn`'s omission is harmless on its own, because that list only
 * warns; here the word decides whether a registration succeeds.
 */

/**
 * Why a name was refused, or `null` when it is fine.
 *
 * The message always states the rule rather than only reporting a failure,
 * because the registrant is choosing a permanent name and "invalid" tells them
 * nothing about what to try next.
 */
export function validatePackageName(name: unknown): string | null {
  if (typeof name !== "string" || name.trim() === "") {
    return "A name is required.";
  }

  const value = name;
  if (value.trim() !== value) {
    return "A name cannot begin or end with whitespace.";
  }
  if (value.length < NAME_MIN) {
    return `A name needs at least ${NAME_MIN} characters.`;
  }
  if (value.length > NAME_MAX) {
    return `A name can be at most ${NAME_MAX} characters.`;
  }
  if (value.includes("/")) {
    return "Names are bare — no slash. A slash always means GitHub to finn.";
  }
  if (!NAME_RULE.test(value)) {
    return (
      "A name is lowercase letters and digits, starting with a letter — no " +
      "hyphens, underscores or dots. Every registered name has to be spellable " +
      "as a Fin identifier so that `import <name>;` works."
    );
  }
  if (FIN_RESERVED_WORDS.has(value)) {
    return (
      `"${value}" is a reserved word in Fin, so \`import ${value};\` could never ` +
      "name a package. Choose another name."
    );
  }

  return null;
}
