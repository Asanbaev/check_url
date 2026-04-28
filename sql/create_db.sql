CREATE DATABASE IF NOT EXISTS `check_url`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE `check_url`;

CREATE TABLE IF NOT EXISTS `target` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `code` VARCHAR(128) NOT NULL,
  `url` TEXT NOT NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_target_code` (`code`) USING BTREE
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `status_log` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `target_id` BIGINT UNSIGNED NOT NULL,
  `status` ENUM('no_slots', 'slots_opened', 'site_unreachable', 'site_error') NOT NULL,
  `details` TEXT NULL,
  `detected_at` DATETIME NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_status_target_detected` (`target_id`, `detected_at`),
  KEY `idx_status_type_detected` (`status`, `detected_at`),
  CONSTRAINT `fk_status_target_id` FOREIGN KEY (`target_id`) REFERENCES `target` (`id`)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `request` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `target_id` BIGINT UNSIGNED NOT NULL,
  `url` VARCHAR(512) NOT NULL,
  `req_body` JSON NULL,
  `res_body` JSON NULL,
  `http_status` SMALLINT NULL,
  `status` ENUM('pending', 'sent', 'failed') NOT NULL DEFAULT 'pending',
  `error_text` TEXT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_outbound_target_created` (`target_id`, `created_at`),
  KEY `idx_outbound_status_created` (`status`, `created_at`),
  CONSTRAINT `fk_outbound_target_id` FOREIGN KEY (`target_id`) REFERENCES `target` (`id`)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;
