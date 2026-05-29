CREATE TABLE `book_tags` (
	`book_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	PRIMARY KEY(`book_id`, `tag_id`),
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `book_tags_tag_idx` ON `book_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `books` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`author` text,
	`slug` text NOT NULL,
	`original_filename` text NOT NULL,
	`status` text DEFAULT 'uploaded' NOT NULL,
	`page_count` integer,
	`size_bytes` integer,
	`conversion_settings` text,
	`error_message` text,
	`approved_at` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`converted_at` text,
	`deleted_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `books_slug_unique` ON `books` (`slug`);--> statement-breakpoint
CREATE INDEX `books_status_idx` ON `books` (`status`);--> statement-breakpoint
CREATE INDEX `books_deleted_idx` ON `books` (`deleted_at`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`book_id` integer,
	`type` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`stage` text,
	`progress` real DEFAULT 0 NOT NULL,
	`params_json` text,
	`result_json` text,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`started_at` text,
	`finished_at` text,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`);--> statement-breakpoint
CREATE INDEX `jobs_book_idx` ON `jobs` (`book_id`);--> statement-breakpoint
CREATE TABLE `pages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`book_id` integer NOT NULL,
	`page_number` integer NOT NULL,
	`markdown` text NOT NULL,
	`original_markdown` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`edited_at` text,
	`flags_json` text DEFAULT '[]' NOT NULL,
	`layout_json` text,
	`page_width` integer,
	`page_height` integer,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	`updated_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pages_book_page_idx` ON `pages` (`book_id`,`page_number`);--> statement-breakpoint
CREATE INDEX `pages_book_status_idx` ON `pages` (`book_id`,`status`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_unique` ON `tags` (`name`);