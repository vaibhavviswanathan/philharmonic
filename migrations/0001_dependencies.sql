CREATE TABLE `task_dependencies` (
	`task_id` text NOT NULL,
	`blocked_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	PRIMARY KEY(`task_id`, `blocked_by`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`blocked_by`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `task_deps_blocked_by` ON `task_dependencies` (`blocked_by`);