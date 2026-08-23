# The registry indexes packages; GitHub serves them

Finn Registry stores no package contents. A package registration is a name bound to a GitHub
repository, and everything a consumer downloads comes from GitHub, version-controlled in the
publisher's own repository. The alternative was to host artifacts ourselves, which would have
bought reproducibility and download counts at the cost of storage, bandwidth, a signing story,
and an operational burden neither this project nor the language's user base can currently carry.

## Consequences

The registry never sees package bytes, so it cannot compute a checksum, scan code, or sign an
artifact. Every claim it makes is therefore about *identity*, and any wording that implies
otherwise — "cryptographically verified packages", "distributed", "globally cached" — is not a
marketing overreach to be softened but a false statement to be deleted.

Download counts cannot be observed. GitHub serves the bytes, so unless `finn` volunteers a
report, the registry has no way to know an install happened. This makes downloads unusable as a
sort key or a headline figure until that is resolved.

Integrity remains the CLI's job. A checksum in the registry can only ever be publisher-attested,
which proves contents have not changed since registration and nothing more.

The registry stays deployable as a small application with a database and no object storage, which
is what makes Cloudflare Pages sufficient. It is not, however, a static site — the API, the
database binding, and the OAuth secrets all need a server, so GitHub Pages is not an option.
