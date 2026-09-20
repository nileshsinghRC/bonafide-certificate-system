-- Adds forced-password-change support for accounts created via bulk import
-- or the SDMIS sync API. Safe to run against a database that already has
-- the original schema applied.
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
