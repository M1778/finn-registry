# Finn Registry

Finn Registry is the index of packages for the Fin programming language. It hosts no code: it
records what a package name means, who stands behind it, and whether anyone vouches for them.

This context covers the registry alone. The language and the package manager live in their own
repositories and will get their own sites.

## Language

### The three names

**Fin**:
The programming language. Its compiler is `finc`.
_Avoid_: Finn, "the Finn language" — the language has one `n` and the package manager has two,
so the extra letter is the entire distinction and there is no forgiving context for getting it
wrong.

**finn**:
The package manager and build tool for Fin. It resolves dependencies, fetches them, builds
projects, and maintains `finn.lock`.
_Avoid_: Finn Registry, the CLI's other names — `finn` is the tool a developer runs; the
registry is a website it asks questions of.

**Finn Registry**:
This project: the authority on what a Fin package name means and who may claim it.
_Avoid_: package manager, distribution platform, package host — it manages nothing, hosts
nothing, and distributes no code.

### Packages and their contents

**Package**:
A named, claimable entry in the registry pointing at one Git repository. The name is bare and
globally unique: `http`, never `acme/http`.
_Avoid_: module, library, crate — and note that a name containing a slash never denotes a
package, it denotes a GitHub repository.

**Content server**:
Where package bytes actually live and are version-controlled. Always GitHub; never the registry.
_Avoid_: mirror, cache, CDN — the registry keeps no copy of anything, so there is nothing to
mirror.

**Distributor of record**:
What the registry is to a package: the authority a resolution begins at, and the reason a name
means one thing rather than another. It distributes names and provenance, while the content
server distributes bytes.
_Avoid_: host, artifact store — "we distribute it" is true of the record, not of the code.

**Version record**:
The registry's note that a given version of a package corresponds to a particular Git ref and
commit. It mirrors what already exists in the repository and confers no authority over it.
_Avoid_: release, artifact, build — nothing is produced, and the repository remains the truth.

### Claiming a name

**Registration**:
Claiming a package name and binding it to a repository. This is what a publisher does, in a
browser.
_Avoid_: publishing, uploading, pushing — nothing travels to the registry except a pointer, and
calling it publishing invites everyone to look for the artifact that was published.

**Publisher**:
The account — a person or an organisation — that registered a package and is named as standing
behind it.
_Avoid_: author, owner, maintainer — the publisher is who the registry can vouch for, which is
not always who wrote the code.

**Repository ownership proof**:
Confirmation that the account registering a name can actually push to the repository it points
at. Required for every registration, and machine-checked.
_Avoid_: ownership check, validation — it is a proof obtained from GitHub, not an opinion the
registry forms.

### Vouching

**Recognition**:
What the registry offers instead of guarantees about code. Because it never sees package
contents, everything it asserts is about identity.
_Avoid_: security, verification of packages, auditing — no code is read, scanned, or signed.

**Verified publisher**:
A publisher a human reviewer has confirmed is who it claims to be. Applies to everything that
publisher registers, then and later.
_Avoid_: trusted publisher, official — verification is about identity only, and says nothing
about the quality of any package.

**Trusted package**:
One package a human reviewer has vouched for on its own merits. It does not require its
publisher to be verified, and accumulating trusted packages is grounds for verifying that
publisher's account.
_Avoid_: approved, certified, verified package — a package is never *verified*; only a publisher
is.

**Trust level**:
The single summary the registry publishes for a package, derived from the signals above, and the
only thing `finn` decides anything from: `verified`, `trusted`, or `recognized`.
_Avoid_: score, rating, rank — it is a name for a state, not a position in an ordering, and
nothing is being measured.

**Recognized**:
The trust level of a package that is registered with proven repository ownership and nothing
more. The floor for anything in the registry, not a warning.
_Avoid_: unverified, untrusted — both frame the ordinary case as a deficiency.

**Unrecognized**:
Not in the registry at all — a raw Git URL, a GitHub shorthand, or a local path. A state only
`finn` can observe, since the registry has nothing to say about what it has never seen.
_Avoid_: unofficial, third-party.

**Verification request**:
A publisher's application to become verified, awaiting a human reviewer.
_Avoid_: application, ticket, claim — a claim is what registration makes about a name.

**Minute**:
The record of one reviewer act: who verified a publisher, refused a request, vouched for a
package, or withdrew a vouch, and when. Written once and never altered.
_Avoid_: audit log, history, event — a minute is a reviewer's act, not a system occurrence, and
the register keeps no log of anything else.

**Counterfoil**:
The half of a register entry the signatory keeps: what a publisher can see about their own
standing and their own entries, which nobody else is shown.
_Avoid_: dashboard, profile, analytics — nothing is measured here, and the publisher's public
page is a different thing.

**Bench**:
Where reviewers rule. Admins verify publishers; moderators vouch for packages. Not a queue of
tasks and not reachable by anyone without the role.
_Avoid_: admin panel, moderation tools, back office.

**Attested checksum**:
A hash of a package version submitted by its publisher, recording that the contents have not
changed since registration. The registry cannot compute one itself.
_Avoid_: signature, integrity hash, verified checksum — nothing is signed, and the registry
attests to nothing it did not receive.
