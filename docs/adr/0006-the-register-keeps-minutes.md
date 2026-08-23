# The register keeps minutes of what reviewers decide

Every act of a reviewer — verifying a publisher, refusing a request, vouching for a package,
withdrawing a vouch — is recorded as a row in `review_minutes`, naming the reviewer, the subject,
the reason where one was required, and the time. The table is append-only: nothing updates or
deletes a minute.

Before this, `users.is_verified` and `packages.is_trusted` were bare booleans. The register asserted
that a package was worth trusting without recording who had said so, when, or on what grounds —
which is out of step with everything else it stores. A version record names the commit it resolved
to; a name claim names the repository it was proved against (ADR-0004). The two assertions that
carry the most weight, and that ADR-0003 is entirely about, were the two with no provenance at all.

The alternative was to derive the flags from the minutes and stop storing them, which is the
cleaner model and the wrong one here. A trust level is read on every resolve and every page of the
register, and folding a per-subject history into a boolean on each read does not fit the 10 ms CPU
ceiling in ADR-0005. So both exist, deliberately: the boolean is the answer, the minutes are the
history.

## Consequences

**The two can disagree, and the rule for when they do is fixed.** D1 offers no transaction across
statements, so a reviewer's act is two writes that can half-fail. The boolean is written first and
the minute last. A missing minute is a gap that shows on the bench and that a reviewer can close by
repeating the act; a minute for an effect that never landed would name a colleague as having ruled
something that never happened, with no on-screen symptom. So the boolean is the record of effect,
the minute is the record of intent, and neither is derivable from the other.

**Nothing that happened before this decision can be recovered.** Every package trusted up to now has
no minute and never will. The interface says exactly that — *vouched before this register kept
minutes* — rather than backfilling a guess or leaving the line blank. This asymmetry is the reason
the table went in before anything reads it: a vouching interface can be built any week, but history
that was never written down is gone. It is the only part of the trust model with that property.

**It is not published, and whether it ever should be is open.** Minutes are visible to reviewers on
the bench and nowhere else. `trust.level` remains the only trust field on the wire, because
attaching a reviewer's name to it would invite the CLI to branch on the person instead of the level,
and would make every reviewer personally addressable for a judgement the project made. §4.3 of
`docs/REGISTRY-CONTRACT.md` puts the narrower version of the question to the `finn` side: whether a
*date* — has anyone looked at this recently — would change what the CLI prompts.

**Deleting an account does not delete the minutes about it.** They keep the account id after the row
is gone, which `/privacy` states plainly. A register that could be made to forget its own rulings
would not be a register, and the alternative is worse: an account that could erase a refusal and
apply again as a stranger.
