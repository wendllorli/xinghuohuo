CREATE TABLE IF NOT EXISTS task_reference_images (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  url TEXT NOT NULL,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES image_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_reference_images_task_id
  ON task_reference_images(task_id);

CREATE INDEX IF NOT EXISTS idx_task_reference_images_deleted_at
  ON task_reference_images(deleted_at);
