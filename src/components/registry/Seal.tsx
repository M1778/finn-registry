import { Ban, Signature as SignatureIcon, Stamp } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TrustLevel } from "@/types/registry";

/**
 * A trust seal. The only pill-shaped element in the design system — a seal is
 * round, a record is square (globals.css, rule 2).
 *
 * The wording here is the glossary's, not looser synonyms: publishers are
 * *verified*, packages are *trusted*, and everything on the register is
 * *recognized*. See CONTEXT.md and docs/adr/0003.
 */

type SealKind = TrustLevel | "withdrawn";

const SEALS: Record<
  SealKind,
  { label: string; className: string; icon: React.ReactNode | null }
> = {
  verified: {
    label: "Verified publisher",
    className: "seal-verified",
    // A stamp: a human reviewer confirmed this account is who it claims to be.
    icon: <Stamp className="size-3 shrink-0" aria-hidden />,
  },
  trusted: {
    label: "Trusted package",
    className: "seal-trusted",
    // A signature: someone vouched for this package on its own merits.
    icon: <SignatureIcon className="size-3 shrink-0" aria-hidden />,
  },
  recognized: {
    label: "Recognized",
    className: "seal-recognized",
    // Deliberately no icon. Recognized is the floor — registered with proven
    // repository ownership — and dressing it up would make the ordinary case
    // look either decorated or deficient.
    icon: null,
  },
  withdrawn: {
    label: "Withdrawn",
    className: "seal-withdrawn",
    icon: <Ban className="size-3 shrink-0" aria-hidden />,
  },
};

export default function Seal({
  kind,
  className,
}: {
  kind: SealKind;
  className?: string;
}) {
  const seal = SEALS[kind];

  return (
    <span className={cn("seal", seal.className, className)}>
      {seal.icon}
      {seal.label}
    </span>
  );
}

/** One line explaining what a seal means, for use under a seal in context. */
export const SEAL_MEANING: Record<SealKind, string> = {
  verified:
    "A reviewer confirmed this publisher's identity. The confirmation covers everything they register.",
  trusted: "A moderator vouched for this package on its own merits.",
  recognized:
    "On the register, with repository ownership proven. This is the ordinary state.",
  withdrawn: "The publisher asked us to stop recommending this package.",
};
