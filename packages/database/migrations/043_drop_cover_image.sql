-- 043_drop_cover_image.sql
--
-- Removes the competition cover image.
--
-- `cover_url` (migration 001) was a second hero image alongside the banner, and
-- `cover_caption` (migration 003) its caption. Neither was ever settable from
-- the Create or Manage screen — the public competition page rendered cover in
-- preference to banner, but nothing could populate it. The banner is now the
-- only hero image.
--
-- ⚠ DESTRUCTIVE: this discards any cover image URL and caption still stored.
-- To see what would be lost before running it:
--
--   SELECT id, title, cover_url, cover_caption
--   FROM competitions
--   WHERE cover_url IS NOT NULL OR cover_caption IS NOT NULL;
--
-- The uploaded image files themselves are not deleted from storage; only the
-- references are dropped.

alter table competitions drop column if exists cover_url;
alter table competitions drop column if exists cover_caption;
