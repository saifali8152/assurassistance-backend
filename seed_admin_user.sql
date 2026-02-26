-- AssurAssistance: Insert admin user
-- Email: assur.assistances@gmail.com
-- Temporary password: Admin@123 (change after first login)

INSERT INTO `users` (
  `name`,
  `email`,
  `password`,
  `role`,
  `status`,
  `force_password_change`
) VALUES (
  'Assur Assistance Admin',
  'assur.assistances@gmail.com',
  '$2b$10$bxwNWi9w43GoDv8SAmQG0ezm9Tp3ptSSZ9Ivl9EC9zbf2OekQQoeC',
  'admin',
  'active',
  0
);
