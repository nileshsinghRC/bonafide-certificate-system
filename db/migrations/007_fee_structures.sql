-- Migration 007: per-programme, per-batch fee structure. Feeds the fee tables on the
-- Bank Loan certificates (#5 with Financial Aid, #6 General). Additive and idempotent.
-- batch NULL = applies to every batch of that programme; a batch-specific row wins.
-- *_year NULL = shown as 2 x the semester amount. No amounts are pre-filled: the Fees
-- office / Super Admin enters the real figures.
CREATE TABLE IF NOT EXISTS fee_structures (
    fee_structure_id   SERIAL PRIMARY KEY,
    programme_id       SMALLINT NOT NULL REFERENCES programmes(programme_id) ON DELETE CASCADE,
    batch              VARCHAR(20),
    year_no            SMALLINT NOT NULL CHECK (year_no BETWEEN 1 AND 6),
    tuition_semester   NUMERIC(12,2),
    tuition_year       NUMERIC(12,2),
    residence_semester NUMERIC(12,2),
    residence_year     NUMERIC(12,2),
    updated_by         UUID REFERENCES users(user_id),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fee_structures ON fee_structures (programme_id, COALESCE(batch, ''), year_no);
