-- Выполни вручную на существующей БД, если `theater` / `theater_id` ещё нет.
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

-- Если колонки ещё нет:
-- ALTER TABLE `target` ADD COLUMN `theater_id` VARCHAR(32) NULL AFTER `code`;
-- UPDATE `target` SET `theater_id` = 'GITIS' WHERE `code` LIKE 'GITIS%' OR `code` LIKE 'Gitis%';
-- UPDATE `target` SET `theater_id` = 'VGIK' WHERE `code` LIKE 'VGIK%';
-- UPDATE `target` SET `theater_id` = 'RGSI' WHERE `code` LIKE 'rgsi%';
-- UPDATE `target` SET `theater_id` = 'GITIS' WHERE `theater_id` IS NULL;
-- ALTER TABLE `target` MODIFY `theater_id` VARCHAR(32) NOT NULL;
-- ALTER TABLE `target` ADD CONSTRAINT `fk_target_theater` FOREIGN KEY (`theater_id`) REFERENCES `theater` (`id`);

-- Отбор таргета в приложении — по `url`, не по `code` (code — только подпись).
-- Для существующей БД: снять UNIQUE с `code`, сделать UNIQUE на `url`:
-- ALTER TABLE `target` DROP INDEX `uniq_target_code`;
-- ALTER TABLE `target` MODIFY `url` VARCHAR(2048) NOT NULL;
-- ALTER TABLE `target` ADD UNIQUE KEY `uniq_target_url` (`url`);
