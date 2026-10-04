-- Migration 006: per-certificate page margins (millimetres). NULL = system default
-- (top 10, right 31.7, bottom 0, left 31.7 - taken from the university's sample_margin.docx).
-- Additive and idempotent.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS page_margins JSONB;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS page_margins JSONB;
