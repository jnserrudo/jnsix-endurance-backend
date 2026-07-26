-- Referral program: unique codes + bilateral points on first activity
ALTER TABLE `users` ADD COLUMN `referral_code` VARCHAR(191) NULL;
ALTER TABLE `users` ADD COLUMN `referred_by_user_id` VARCHAR(191) NULL;

CREATE UNIQUE INDEX `users_referral_code_key` ON `users`(`referral_code`);

CREATE TABLE `referrals` (
    `id` VARCHAR(191) NOT NULL,
    `inviter_id` VARCHAR(191) NOT NULL,
    `invitee_id` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `qualifying_activity_id` VARCHAR(191) NULL,
    `rewarded_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE UNIQUE INDEX `referrals_invitee_id_key` ON `referrals`(`invitee_id`);
CREATE INDEX `referrals_inviter_id_status_idx` ON `referrals`(`inviter_id`, `status`);
CREATE INDEX `referrals_created_at_idx` ON `referrals`(`created_at`);

ALTER TABLE `referrals` ADD CONSTRAINT `referrals_inviter_id_fkey` FOREIGN KEY (`inviter_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `referrals` ADD CONSTRAINT `referrals_invitee_id_fkey` FOREIGN KEY (`invitee_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
