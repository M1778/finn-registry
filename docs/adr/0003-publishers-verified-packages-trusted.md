# Publishers are verified; packages are trusted

Recognition is carried by two independent signals rather than one flag. A **verified publisher**
is an account a human reviewer has confirmed the identity of, and that verification travels to
everything the publisher registers. A **trusted package** is one package a reviewer has vouched
for on its own merits, and it deliberately does *not* require a verified publisher — a good
package from an unknown individual can be marked trusted, and accumulating trusted packages is
grounds for verifying that publisher's account. The single-flag alternative forced a choice
between a review queue that grows with every release and a badge that unknown-but-good authors
could never earn.

## Consequences

`finn` branches on a derived `trust.level` — `verified`, `trusted`, `recognized` — and never on
the underlying signals, so adding a fourth signal later does not change the CLI. The individual
booleans are published for display only.

A package is never "verified" and a publisher is never "trusted". The two words are not
interchangeable here, and using them loosely collapses the distinction this decision exists to
draw.

`recognized` is the floor, not a warning: it means registered with proven repository ownership.
Presenting it as a deficiency ("unverified") would make the ordinary case look defective and
devalue the two real signals.

Verification is a human review queue, which means it needs an admin surface and a request
workflow. Scoping it to publishers rather than packages is what keeps that queue bounded by the
number of organisations rather than by the number of releases.

## The two signals are administered by two roles

**Moderators mark packages trusted. Admins verify publishers.** The split follows the blast
radius. Vouching for one package is reversible, affects one package, and is a judgement about
code a community member may genuinely know — so it belongs to moderators, drawn from trusted
community members. Asserting that an account *is* who it claims to be travels to everything that
account will ever register and carries legal weight when the account is a company, so it stays
with maintainers. Admins additionally grant roles, transfer names, and handle deprecation;
moderators may escalate to an admin but cannot verify.

The role a reviewer holds never reaches `finn`, which reads only the derived `trust.level`.
