CREATE TABLE `clipboard_entries` (
	`id` text PRIMARY KEY,
	`text` text NOT NULL,
	`bytes` integer NOT NULL,
	`source` text DEFAULT 'web' NOT NULL,
	`attachments` text DEFAULT '[]' NOT NULL,
	`attachBytes` integer DEFAULT 0 NOT NULL,
	`idemKey` text,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `run_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`script` text NOT NULL,
	`origin` text DEFAULT 'workspace' NOT NULL,
	`status` text NOT NULL,
	`exitCode` integer,
	`startedAt` integer NOT NULL,
	`endedAt` integer NOT NULL,
	`durationMs` integer DEFAULT 0 NOT NULL,
	`stdout` text DEFAULT '' NOT NULL,
	`stderr` text DEFAULT '' NOT NULL,
	`truncated` integer DEFAULT 0 NOT NULL,
	`signal` text DEFAULT '' NOT NULL,
	`triggeredBy` text DEFAULT 'ui' NOT NULL,
	`metricCalls` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `service_metrics` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`serviceId` text NOT NULL,
	`metric` text NOT NULL,
	`value` real NOT NULL,
	`unit` text DEFAULT '' NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `service_samples` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`serviceId` text NOT NULL,
	`status` text NOT NULL,
	`latencyMs` integer,
	`message` text DEFAULT '' NOT NULL,
	`checkedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `service_snapshots` (
	`serviceId` text PRIMARY KEY,
	`status` text NOT NULL,
	`latencyMs` integer,
	`message` text DEFAULT '' NOT NULL,
	`version` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'collector' NOT NULL,
	`details` text DEFAULT '{}' NOT NULL,
	`checkedAt` integer NOT NULL,
	`okCount` integer DEFAULT 0 NOT NULL,
	`totalCount` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_clipboard_created` ON `clipboard_entries` ("createdAt" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_clipboard_idem` ON `clipboard_entries` (`idemKey`) WHERE "clipboard_entries"."idemKey" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_runs_started` ON `run_records` ("startedAt" DESC);--> statement-breakpoint
CREATE INDEX `idx_runs_script` ON `run_records` (`script`,"startedAt" DESC);--> statement-breakpoint
CREATE INDEX `idx_metrics_service` ON `service_metrics` (`serviceId`,`metric`,"at" DESC);--> statement-breakpoint
CREATE INDEX `idx_samples_service` ON `service_samples` (`serviceId`,"checkedAt" DESC);