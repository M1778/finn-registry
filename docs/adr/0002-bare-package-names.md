# Package names are bare and globally unique

A package is named `http`, not `acme/http`: one flat namespace, first claim wins, subject to the
repository-ownership gate of ADR-0004. Scoped `owner/name` identifiers were documented as the
rule, but `finn` resolves anything containing a slash as GitHub shorthand *before* it consults
the registry, so a scoped name was structurally unresolvable — and correcting that would have
meant a breaking change to the CLI's most-used input syntax in exchange for namespacing a
registry that has no packages in it yet.

## Consequences

**A slash always means GitHub, permanently.** This is now a guarantee rather than an accident of
resolution order, and `finn add acme/http` will never consult the registry.

Squatting is handled by the ownership gate plus admin transfer, not by namespacing. There is no
reserved-name list.

Should scoping ever be wanted, it arrives as an alias layer over bare names and requires a new
prefix for GitHub shorthand — `gh:acme/http` or similar. Doing it the other way round, by
reordering resolution, silently changes what existing manifests mean.

## Superseded in part, 2026-08-24: "there is no reserved-name list"

There is one now. The owner narrowed the name grammar to `^[a-z][a-z0-9]*$`, length 2–64, plus
Fin's reserved words, refused server-side at registration. The list lives in
`src/lib/package-name.ts`: **58 words, derived from the keyword rules in Fin's lexer**
(`Fin/src/lexer/lexer.l`), which is the only authoritative list. Not from
`Fin/src/diagnostics/DiagnosticEngine.cpp`, which looks like a keyword list, is used for
highlighting, and names eight words the lexer does not reserve; and not from `finn`'s
`FIN_KEYWORDS`, which is a strict subset missing `m1778`.

**The decision above is untouched.** Names are still bare, still globally unique, still one flat
namespace, and a slash still always means GitHub. What changed is which strings are names at all,
not who may hold one.

That sentence was written about **squatting**, and read that way it still holds: the register
reserves no name for anybody, holds back no vanity list, and grants no priority. What it now shares
a page with is a **grammar** restriction — the same kind of rule as the length bound and the
lowercase requirement, neither of which this ADR mentions either. `let` is refused for the reason
`Http` is refused: not because someone else should have it, but because it is not a name.

The reason is that a legal registry name was not necessarily a legal Fin identifier. Fin's lexer is
`ID {ALPHA}({ALPHA}|{DIGIT})*` over `ALPHA [a-zA-Z_]`, so `import http-client;` was not a
bad-name error — it read as a subtraction of two undeclared names — and about fifty keywords
satisfied the old grammar. Narrowing makes every legal name a usable Fin identifier, which is a
property the register can state rather than a caveat each package has to carry.

Refused rather than normalised: mapping `http-client` to `http_client` would give one package two
spellings and leave the user to reconcile them. And refused rather than warned, because a name is
permanent and first-come-first-served — the registration form is the only moment a rename is free.

Reserved words are only the ones Fin's grammar has today. Plausible future keywords are deliberately
not reserved: `import { A, B } from "<name>";` takes the path as a string literal, which never lexes
as a keyword, so a future collision costs a name its other import forms and keeps that one. That
degrades a name rather than breaking it, and is not worth spending `select`, `union`, `assert`,
`some`, `none`, `with` and `go` to prevent.

Nothing needed migrating: the register held no registrations when this landed, which is the only
window in which this change is free.
