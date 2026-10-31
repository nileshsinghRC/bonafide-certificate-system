-- Migration 009: optional "School Lead approval" attachments (e.g. VISA & Passport / travel abroad).
-- The School's Office can attach the lead's approval (PDF/JPEG/PNG) to an application; the Registrar can
-- request it. Never blocks issuing. Additive and idempotent.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS lead_approval_requested BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS lead_approval_note TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS lead_approval_requested_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS lead_approvals (
    approval_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id    UUID NOT NULL REFERENCES applications(application_id) ON DELETE CASCADE,
    file_name         VARCHAR(255) NOT NULL,
    mime_type         VARCHAR(100) NOT NULL,
    size_bytes        INTEGER NOT NULL,
    file_data         BYTEA NOT NULL,
    note              TEXT,
    uploaded_by       UUID REFERENCES users(user_id),
    uploaded_by_name  VARCHAR(150),
    uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lead_approvals_app ON lead_approvals(application_id);
