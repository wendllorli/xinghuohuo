ALTER TABLE image_tasks ADD COLUMN media_type TEXT NOT NULL DEFAULT 'image';
ALTER TABLE works ADD COLUMN media_type TEXT NOT NULL DEFAULT 'image';
