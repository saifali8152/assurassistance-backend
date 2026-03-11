-- Sub-agents: link agent users to a parent agent (NULL = main agent, NOT NULL = sub-agent)
ALTER TABLE `users`
  ADD COLUMN `parent_agent_id` INT DEFAULT NULL AFTER `whatsapp_phone`,
  ADD KEY `fk_parent_agent` (`parent_agent_id`),
  ADD CONSTRAINT `fk_parent_agent` FOREIGN KEY (`parent_agent_id`) REFERENCES `users` (`id`) ON DELETE SET NULL;
