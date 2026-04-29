CREATE DATABASE IF NOT EXISTS `check_url`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE `check_url`;

CREATE TABLE IF NOT EXISTS `theater` (
  `id` VARCHAR(32) NOT NULL,
  `name` VARCHAR(128) NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;

INSERT INTO `theater` (`id`, `name`) VALUES
  ('GITIS', 'ГИТИС'),
  ('VGIK', 'ВГИК'),
  ('RGSI', 'РГИСИ')
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

CREATE TABLE IF NOT EXISTS `target` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `code` VARCHAR(128) NOT NULL,
  `theater_id` VARCHAR(32) NOT NULL,
  `url` VARCHAR(2048) NOT NULL,
  `enabled` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_target_url` (`url`) USING BTREE,
  KEY `idx_target_theater` (`theater_id`),
  CONSTRAINT `fk_target_theater` FOREIGN KEY (`theater_id`) REFERENCES `theater` (`id`)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `status_log` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `target_id` BIGINT UNSIGNED NOT NULL,
  `status` ENUM('key_ok', 'key_false', 'unreachable', 'error', 'auth', 'key_error') NOT NULL,
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
