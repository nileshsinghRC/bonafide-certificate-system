-- Migration 004: canonical programme list (validated school/student data),
-- student batch field, and OTP columns for email-based student login.

CREATE TABLE IF NOT EXISTS programmes (
    programme_id SMALLSERIAL PRIMARY KEY,
    name         VARCHAR(150) NOT NULL UNIQUE,
    sort_order   SMALLINT NOT NULL DEFAULT 0
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS batch VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_code_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_expires_at TIMESTAMPTZ;

ALTER TABLE applications ADD COLUMN IF NOT EXISTS batch VARCHAR(20);
