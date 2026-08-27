CREATE TABLE `dependencies` (
	`id` text PRIMARY KEY NOT NULL,
	`version_id` text NOT NULL,
	`dependency_name` text NOT NULL,
	`version_range` text NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `logins` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `organization_members` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member',
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`display_name` text,
	`avatar_url` text,
	`description` text,
	`owner_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_name_unique` ON `organizations` (`name`);--> statement-breakpoint
CREATE TABLE `packages` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`repo_url` text NOT NULL,
	`homepage` text,
	`license` text,
	`keywords` text,
	`owner_id` text NOT NULL,
	`organization_id` text,
	`downloads` integer DEFAULT 0,
	`stars` integer DEFAULT 0,
	`category` text DEFAULT 'Utilities',
	`is_trusted` integer DEFAULT false NOT NULL,
	`is_deprecated` integer DEFAULT false NOT NULL,
	`deprecation_message` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `packages_name_unique` ON `packages` (`name`);--> statement-breakpoint
CREATE INDEX `packages_stars_idx` ON `packages` (`stars`);--> statement-breakpoint
CREATE INDEX `packages_downloads_idx` ON `packages` (`downloads`);--> statement-breakpoint
CREATE INDEX `packages_created_at_idx` ON `packages` (`created_at`);--> statement-breakpoint
CREATE INDEX `packages_updated_at_idx` ON `packages` (`updated_at`);--> statement-breakpoint
CREATE INDEX `packages_owner_id_idx` ON `packages` (`owner_id`);--> statement-breakpoint
CREATE INDEX `packages_organization_id_idx` ON `packages` (`organization_id`);--> statement-breakpoint
CREATE TABLE `review_minutes` (
	`id` text PRIMARY KEY NOT NULL,
	`reviewer_id` text NOT NULL,
	`action` text NOT NULL,
	`subject_user_id` text,
	`subject_package_id` text,
	`reason` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`reviewer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`subject_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`subject_package_id`) REFERENCES `packages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `review_minutes_subject_package_id_idx` ON `review_minutes` (`subject_package_id`);--> statement-breakpoint
CREATE INDEX `review_minutes_subject_user_id_idx` ON `review_minutes` (`subject_user_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`github_access_token` text,
	`github_scope` text,
	`expires_at` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_unique` ON `sessions` (`token`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`github_id` integer NOT NULL,
	`login` text NOT NULL,
	`email` text,
	`name` text,
	`bio` text,
	`location` text,
	`blog` text,
	`avatar_url` text,
	`role` text DEFAULT 'user' NOT NULL,
	`is_verified` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_github_id_unique` ON `users` (`github_id`);--> statement-breakpoint
CREATE INDEX `users_login_idx` ON `users` (`login`);--> statement-breakpoint
CREATE TABLE `verification_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reviewer_id` text,
	`note` text,
	`reviewer_note` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	`reviewed_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `verification_requests_user_id_idx` ON `verification_requests` (`user_id`);--> statement-breakpoint
CREATE INDEX `verification_requests_status_idx` ON `verification_requests` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `verification_requests_one_pending_idx` ON `verification_requests` (`user_id`) WHERE "verification_requests"."status" = 'pending';--> statement-breakpoint
CREATE TABLE `versions` (
	`id` text PRIMARY KEY NOT NULL,
	`package_id` text NOT NULL,
	`version` text NOT NULL,
	`git_ref` text NOT NULL,
	`commit` text NOT NULL,
	`readme_content` text,
	`checksum` text,
	`checksum_origin` text,
	`yanked` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`package_id`) REFERENCES `packages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `versions_package_version_idx` ON `versions` (`package_id`,`version`);--> statement-breakpoint
CREATE INDEX `versions_package_id_idx` ON `versions` (`package_id`);