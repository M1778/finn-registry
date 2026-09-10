ALTER TABLE `packages` ADD `github_repo_id` integer;--> statement-breakpoint
CREATE INDEX `packages_github_repo_id_idx` ON `packages` (`github_repo_id`);
