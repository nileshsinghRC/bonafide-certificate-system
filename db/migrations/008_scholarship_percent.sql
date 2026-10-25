-- Migration 008: the scholarship / financial-aid percentage is entered by the Financial Aid department
-- on each application (it drives the "after scholarship" fee columns). Additive and idempotent.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS scholarship_percent NUMERIC(5,2);
