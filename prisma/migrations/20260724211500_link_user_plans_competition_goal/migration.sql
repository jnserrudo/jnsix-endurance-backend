ALTER TABLE `user_plans`
  ADD COLUMN `competition_goal_id` VARCHAR(191) NULL,
  ADD COLUMN `goal_snapshot` JSON NULL;

CREATE INDEX `user_plans_competition_goal_id_idx`
  ON `user_plans`(`competition_goal_id`);

ALTER TABLE `user_plans`
  ADD CONSTRAINT `user_plans_competition_goal_id_fkey`
  FOREIGN KEY (`competition_goal_id`) REFERENCES `competition_goals`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
