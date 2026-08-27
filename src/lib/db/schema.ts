import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql, relations } from "drizzle-orm";

/**
 * Roles. Moderators mark packages trusted; admins verify publishers (ADR-0003).
 * The role a reviewer holds never reaches `finn`, which reads only the derived
 * trust level.
 */
export const USER_ROLES = ["user", "moderator", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** A verification request is pending until a human admin rules on it. */
export const VERIFICATION_STATUSES = ["pending", "approved", "rejected"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/**
 * What a reviewer can rule. Two pairs, kept apart on purpose: an admin rules on
 * *who someone is*, a moderator vouches for *one package* (ADR-0003).
 */
export const REVIEW_ACTIONS = [
  "publisher_verified",
  "verification_refused",
  "package_vouched",
  "package_vouch_withdrawn",
] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

/**
 * The registry never sees package bytes, so it cannot compute a checksum
 * (ADR-0001). Any checksum it holds was submitted by the publisher.
 */
export const CHECKSUM_ORIGINS = ["publisher_attested"] as const;
export type ChecksumOrigin = (typeof CHECKSUM_ORIGINS)[number];

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(), // Using UUID or text ID
    githubId: integer("github_id").unique().notNull(),
    login: text("login").notNull(),
    email: text("email"),
    name: text("name"),
    bio: text("bio"),
    location: text("location"),
    blog: text("blog"),
    avatarUrl: text("avatar_url"),
    role: text("role", { enum: USER_ROLES }).notNull().default("user"),
    /**
     * The publisher signal: a human admin has confirmed this account is who it
     * claims to be. Travels to everything the account registers. A publisher is
     * *verified*; a package is never verified (ADR-0003).
     */
    isVerified: integer("is_verified", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
  },
  // A publisher profile is looked up by login, not by id.
  (t) => [index("users_login_idx").on(t.login)],
);

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id).notNull(),
  token: text("token").unique().notNull(),
  /**
   * The GitHub access token this sign-in was minted with.
   *
   * Registration has to prove push access against the GitHub API (ADR-0004), and
   * only the signing-in user's own token can answer that, so it lives for as
   * long as the session and dies with it. It is stored as issued because it must
   * be replayed to GitHub; it cannot be hashed.
   */
  githubAccessToken: text("github_access_token"),
  /**
   * The scopes GitHub granted, verbatim. Signing in asks for `user:email` only;
   * the wider repository scope is requested incrementally at registration, so
   * this is what tells a caller whether the wider grant has happened yet.
   */
  githubScope: text("github_scope"),
  expiresAt: integer("expires_at").notNull(),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const logins = sqliteTable("logins", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const packages = sqliteTable(
  "packages",
  {
    id: text("id").primaryKey(),
    name: text("name").unique().notNull(),
    description: text("description"),
    /** The content server. Every registration points at one (ADR-0001, ADR-0004). */
    repoUrl: text("repo_url").notNull(),
    /**
     * GitHub's own numeric id for that repository, captured at registration out
     * of the same response that proved push access.
     *
     * `repo_url` is not an identity. A rename or a transfer changes it, and the
     * `owner/repo` a rename frees can be claimed by somebody else — so a URL
     * match alone would eventually let a stranger's tag pushes land on the
     * original publisher's name. This id never changes for the life of the
     * repository, so it is what a webhook delivery is matched against before it
     * may write a version record (ADR-0007).
     *
     * Null on rows registered before this column existed. Those fall back to
     * matching on the URL, which is the weaker case and is named rather than
     * hidden.
     */
    githubRepoId: integer("github_repo_id"),
    homepage: text("homepage"),
    license: text("license"),
    keywords: text("keywords"), // JSON string array
    ownerId: text("owner_id").references(() => users.id).notNull(),
    organizationId: text("organization_id").references(() => organizations.id),
    downloads: integer("downloads").default(0),
    stars: integer("stars").default(0),
    category: text("category").default("Utilities"),
    /**
     * The package signal: a moderator has vouched for this one package on its
     * own merits. Does not require a verified publisher (ADR-0003).
     */
    isTrusted: integer("is_trusted", { mode: "boolean" }).notNull().default(false),
    isDeprecated: integer("is_deprecated", { mode: "boolean" }).notNull().default(false),
    deprecationMessage: text("deprecation_message"),
    createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP`),
  },
  // Every browse/stats query sorts or filters on one of these. Without the
  // indexes the sort is a full table read, which the 10ms CPU budget does not
  // allow.
  //
  // `stars` and `downloads` are the exceptions: nothing increments either
  // column and no endpoint orders by them (the API rejects `sort=downloads`
  // outright), so these two indexes are currently dead weight on every insert.
  // They are kept only to avoid churning an unapplied migration; drop them
  // with the columns if §4.2 settles on not counting at all.
  (t) => [
    index("packages_stars_idx").on(t.stars),
    index("packages_downloads_idx").on(t.downloads),
    index("packages_created_at_idx").on(t.createdAt),
    index("packages_updated_at_idx").on(t.updatedAt),
    index("packages_owner_id_idx").on(t.ownerId),
    index("packages_organization_id_idx").on(t.organizationId),
    // Read once per webhook delivery, which is once per release: rare, but the
    // alternative is a full table scan on the one query that decides whether a
    // version record may be written at all.
    index("packages_github_repo_id_idx").on(t.githubRepoId),
  ],
);

export const versions = sqliteTable(
  "versions",
  {
    id: text("id").primaryKey(),
    packageId: text("package_id").references(() => packages.id).notNull(),
    version: text("version").notNull(),
    /** The tag the version corresponds to in the publisher's repository. */
    gitRef: text("git_ref").notNull(),
    /** The commit the tag resolved to. Together with gitRef this is what makes
     *  a checkout deterministic, and what `finn.lock` pins. */
    commit: text("commit").notNull(),
    readmeContent: text("readme_content"),
    checksum: text("checksum"),
    checksumOrigin: text("checksum_origin", { enum: CHECKSUM_ORIGINS }),
    /** "Do not select for a fresh resolve, but honour an existing lockfile pin." */
    yanked: integer("yanked", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    uniqueIndex("versions_package_version_idx").on(t.packageId, t.version),
    index("versions_package_id_idx").on(t.packageId),
  ],
);

export const dependencies = sqliteTable("dependencies", {
  id: text("id").primaryKey(),
  versionId: text("version_id").references(() => versions.id).notNull(),
  dependencyName: text("dependency_name").notNull(), // bare package name
  versionRange: text("version_range").notNull(), // e.g. "^1.0.0" — resolved by the CLI
});

/**
 * A publisher's application to become verified, awaiting a human reviewer.
 * Scoped to publishers rather than packages, which is what keeps the queue
 * bounded by the number of accounts rather than the number of releases.
 */
export const verificationRequests = sqliteTable(
  "verification_requests",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => users.id).notNull(),
    status: text("status", { enum: VERIFICATION_STATUSES }).notNull().default("pending"),
    /** The admin who ruled on the request; null while pending. */
    reviewerId: text("reviewer_id").references(() => users.id),
    /**
     * The **requester's** words: the evidence the account submits for who it
     * claims to be. Written once, at submission, and never overwritten — an
     * admin reviewing a second request needs to see what the first one claimed.
     */
    note: text("note"),
    /**
     * The **reviewer's** words: why a request was approved or refused, and the
     * text a refused publisher is shown.
     *
     * Separate from `note` because two different people write to these and a
     * single column loses one of them. It lost it in the worst direction, too: a
     * refusal overwrote the evidence the account had submitted.
     */
    reviewerNote: text("reviewer_note"),
    createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
    reviewedAt: text("reviewed_at"),
  },
  (t) => [
    index("verification_requests_user_id_idx").on(t.userId),
    index("verification_requests_status_idx").on(t.status),
    /**
     * At most one *pending* request per account, enforced by the database rather
     * than by a read-then-write in the handler: a double-click fires two
     * requests that can both pass a check before either inserts. Earlier rulings
     * do not participate, so a refused account can ask again.
     */
    uniqueIndex("verification_requests_one_pending_idx")
      .on(t.userId)
      .where(sql`${t.status} = 'pending'`),
  ],
);

/**
 * The minutes: the written record of what a reviewer decided, and when.
 *
 * A minute is **append-only**. Nothing in the codebase updates or deletes one,
 * and nothing should: a corrected ruling is a new minute, not an edited one.
 * This is the only place the register records *who* made an assertion rather
 * than merely that the assertion currently holds — `users.is_verified` and
 * `packages.is_trusted` are bare booleans, and a bare boolean cannot answer
 * "who vouched for this, and on what grounds". That answer cannot be
 * reconstructed after the fact, which is why the table exists before anything
 * publishes it.
 *
 * The booleans stay. They are the fast answer every read needs — a resolve
 * cannot afford to fold a history to decide what a seal says — and the minutes
 * are the history behind them.
 *
 * The deliberate consequence: the two can disagree. D1 has no transaction across
 * statements, so a half-failed moderation leaves the boolean set with no minute
 * recorded (see the ordering comments in `src/app/admin/actions.ts` for why that
 * is the direction the failure is allowed to take). When they disagree, the
 * boolean is the record of *effect* — what the register is asserting right now —
 * and the minutes are the record of *intent*, which is the reviewer's own
 * account of why. Neither is derivable from the other.
 */
export const reviewMinutes = sqliteTable(
  "review_minutes",
  {
    id: text("id").primaryKey(),
    /** The reviewer who ruled. Never null: an unattributed minute is not a minute. */
    reviewerId: text("reviewer_id")
      .references(() => users.id)
      .notNull(),
    action: text("action", { enum: REVIEW_ACTIONS }).notNull(),
    /** Set for the two publisher rulings, null for the two package rulings. */
    subjectUserId: text("subject_user_id").references(() => users.id),
    /** Set for the two package rulings, null for the two publisher rulings. */
    subjectPackageId: text("subject_package_id").references(() => packages.id),
    /**
     * The reviewer's grounds, in their own words. Required by the refusal action
     * because an account cannot fix what it is not told; optional here because
     * a vouch is allowed to stand on the reading itself.
     */
    reason: text("reason"),
    createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
  },
  // The two questions actually asked of this table: "who vouched for this
  // entry" and "what has been ruled about this account". `created_at` is
  // deliberately not indexed — nothing lists minutes chronologically yet, and an
  // index that no query uses is write cost for nothing. Add it with the first
  // query that orders by it.
  (t) => [
    index("review_minutes_subject_package_id_idx").on(t.subjectPackageId),
    index("review_minutes_subject_user_id_idx").on(t.subjectUserId),
  ],
);

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").unique().notNull(), // lowercased e.g. "finn"
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  description: text("description"),
  ownerId: text("owner_id").references(() => users.id).notNull(),
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const organizationMembers = sqliteTable("organization_members", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").references(() => organizations.id).notNull(),
  userId: text("user_id").references(() => users.id).notNull(),
  role: text("role").default("member"), // "owner", "admin", "member"
  createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP`),
});

export const usersRelations = relations(users, ({ many }) => ({
  packages: many(packages),
  organizationMemberships: many(organizationMembers),
}));

export const organizationsRelations = relations(organizations, ({ one, many }) => ({
  owner: one(users, {
    fields: [organizations.ownerId],
    references: [users.id],
  }),
  members: many(organizationMembers),
}));

export const organizationMembersRelations = relations(organizationMembers, ({ one }) => ({
  organization: one(organizations, {
    fields: [organizationMembers.organizationId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [organizationMembers.userId],
    references: [users.id],
  }),
}));

export const packagesRelations = relations(packages, ({ one, many }) => ({
  owner: one(users, {
    fields: [packages.ownerId],
    references: [users.id],
  }),
  organization: one(organizations, {
    fields: [packages.organizationId],
    references: [organizations.id],
  }),
  versions: many(versions),
}));

export const versionsRelations = relations(versions, ({ one }) => ({
  package: one(packages, {
    fields: [versions.packageId],
    references: [packages.id],
  }),
}));
