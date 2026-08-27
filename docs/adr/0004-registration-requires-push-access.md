# Registration requires proven push access to the repository

A name claim is refused unless the authenticated GitHub account can push to the repository it
points at, checked against the GitHub API with no human in the loop. A registry whose entire
value is recognition cannot have an unauthenticated claim path: without this gate anyone could
claim `http` and bind it to their own repository, and the verified-publisher badge of ADR-0003
would be decorating a namespace that anybody can poison.

## Consequences

The OAuth scope needed to read repository permissions is wider than the `user:email` that signing
in requires. It is requested incrementally, at registration, so that browsing and logging in
never demand repository access — asking every visitor for repository scope to serve the small
minority who publish would trade away more trust than the gate buys.

"Registered by X" carries weight even when X is not verified, because the binding between account
and repository is always proven. This is what makes `recognized` a meaningful floor rather than
an empty one.

Transfers and abandoned names need an admin path, since a publisher who loses push access can no
longer re-prove a claim they legitimately made earlier.
