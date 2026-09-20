-- Migration 002: granular status tracking, SDMIS photo + fee-in-words,
-- department inline editing, Registrar return/direct-resubmit loop,
-- signature upload + notification tracking, and the activity_logs rename.
-- Safe to run against a database that already has 001_must_change_password.sql applied.

-- ---- Req. 2: SDMIS profile photo sync + fee data (placeholder until a real
-- central fee DB is wired — see README "known gaps") ----
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_picture_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_picture_synced_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS tuition_fee_amount NUMERIC(12,2);
ALTER TABLE users ADD COLUMN IF NOT EXISTS hostel_fee_amount NUMERIC(12,2);

-- ---- Req. 1 + 4: granular level tracking + Registrar return loop ----
-- (run as its own statement / connection — ALTER TYPE ... ADD VALUE cannot
-- be used in the same transaction as a statement that references the new value)
ALTER TYPE application_status ADD VALUE IF NOT EXISTS 'RETURNED_TO_DEPARTMENT';

ALTER TABLE applications ADD COLUMN IF NOT EXISTS assigned_reviewer_id UUID REFERENCES users(user_id);
ALTER TABLE applications ADD COLUMN IF NOT EXISTS level_entered_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE applications ADD COLUMN IF NOT EXISTS return_comment TEXT;

-- ---- Req. 3: department inline editing + fee-in-words snapshot ----
ALTER TABLE applications ADD COLUMN IF NOT EXISTS certificate_draft JSONB;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS fee_snapshot JSONB;

-- ---- Req. 5: certificates_issued -> certificates, signature upload + notification ----
ALTER TABLE certificates_issued RENAME TO certificates;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS registrar_signature_data TEXT; -- base64 data: URL of the uploaded signature image
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS notification_channel VARCHAR(20);

-- ---- Req. 6: application_events -> activity_logs (cross-stakeholder feed) ----
ALTER TABLE application_events RENAME TO activity_logs;
ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS from_stage VARCHAR(30);
ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS to_stage VARCHAR(30);
