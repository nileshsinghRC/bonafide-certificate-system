-- Migration 003: schools & programmes (with credential tagging + routing
-- validation), app-wide settings (logo, letterhead, theme), and certificate
-- seal support alongside the existing signature.

-- ---- Schools & programmes ----
CREATE TABLE IF NOT EXISTS schools (
    school_id    SMALLSERIAL PRIMARY KEY,
    code         VARCHAR(40) NOT NULL UNIQUE,
    name         VARCHAR(150) NOT NULL,
    programmes   JSONB NOT NULL DEFAULT '[]'::jsonb,  -- list of programme name strings taught by this school
    is_active    BOOLEAN NOT NULL DEFAULT TRUE
);

-- School Admin accounts are tagged with the one school they manage; student
-- accounts are tagged with the school whose programme list matches their
-- programme (set at bulk-import/sync time — see server.js matchSchoolForProgramme).
ALTER TABLE users ADD COLUMN IF NOT EXISTS school_id SMALLINT REFERENCES schools(school_id);

-- Applications inherit the student's school at submission time, so a
-- Department queue can be scoped to "my school's applications only", not
-- just "applications currently at the SCHOOL stage".
ALTER TABLE applications ADD COLUMN IF NOT EXISTS school_id SMALLINT REFERENCES schools(school_id);
CREATE INDEX IF NOT EXISTS idx_applications_school ON applications(school_id);
CREATE INDEX IF NOT EXISTS idx_users_school ON users(school_id);

-- ---- App-wide settings: logo, letterhead override, theme ----
CREATE TABLE IF NOT EXISTS app_settings (
    setting_key    VARCHAR(60) PRIMARY KEY,
    setting_value  TEXT,                    -- base64 image data, a theme key, etc.
    updated_by     UUID REFERENCES users(user_id),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- Registrar seal, alongside the existing uploaded signature ----
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS registrar_seal_data TEXT;         -- base64 data: URL of the uploaded seal image
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS signature_position JSONB;          -- {top, left} percentages for customized placement
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS seal_position JSONB;
