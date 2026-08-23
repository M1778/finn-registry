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
