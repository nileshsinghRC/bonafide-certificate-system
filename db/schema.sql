-- ============================================================
-- Digital Bonafide Certificate Issuance System
-- Anant National University — PostgreSQL schema
-- Run once against a fresh database: psql "$DATABASE_URL" -f db/schema.sql
-- For an existing database already running the v1 schema, apply
-- db/migrations/001_must_change_password.sql and 002_workflow_v2.sql instead.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SEQUENCE IF NOT EXISTS application_code_seq START 1;
CREATE SEQUENCE IF NOT EXISTS certificate_number_seq START 1;

-- ---------------- ROLES ----------------
-- One row per operational role. Department roles (school_admin, exam_admin,
-- fees_finaid_admin, admission_admin, warden) each own one stage of the
-- forwarding sequence below; registrar_admin always owns the final stage.
CREATE TABLE IF NOT EXISTS roles (
    role_code   VARCHAR(30) PRIMARY KEY,
    label       VARCHAR(80) NOT NULL
);

-- ---------------- USERS ----------------
CREATE TABLE IF NOT EXISTS users (
    user_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username      VARCHAR(80) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name          VARCHAR(150) NOT NULL,
    role_code     VARCHAR(30) NOT NULL REFERENCES roles(role_code),
    student_sdmis_id VARCHAR(30),          -- populated only for role_code = 'student'
    program       VARCHAR(150),
    school_dept   VARCHAR(100),
    residency     VARCHAR(20),             -- DAY_SCHOLAR / HOSTELLER, student only
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    must_change_password BOOLEAN NOT NULL DEFAULT FALSE, -- forced on accounts created by bulk import / SDMIS sync
    profile_picture_url TEXT,              -- synced from SDMIS on every login
    profile_picture_synced_at TIMESTAMPTZ,
    tuition_fee_amount NUMERIC(12,2),      -- placeholder until a real central fee DB is wired (see README)
    hostel_fee_amount NUMERIC(12,2),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role_code);

-- ---------------- CERTIFICATE TYPES ----------------
-- "stages" is the ordered list of department codes an application must clear
-- before the Registrar stage, e.g. ["SCHOOL","EXAM"]. REGISTRAR is implicit
-- and always the last stage — it is not stored in this array.
CREATE TABLE IF NOT EXISTS certificate_types (
    cert_type_id          SMALLSERIAL PRIMARY KEY,
    code                  VARCHAR(40) NOT NULL UNIQUE,
    label                 VARCHAR(120) NOT NULL,
    stages                JSONB NOT NULL DEFAULT '[]'::jsonb,
    warden_conditional    BOOLEAN NOT NULL DEFAULT FALSE, -- WARDEN stage inserted only if the applicant is a hosteller
    requires_document     BOOLEAN NOT NULL DEFAULT FALSE,
    requires_undertaking  BOOLEAN NOT NULL DEFAULT FALSE, -- MYSY: signed undertaking must be attached
    is_active             BOOLEAN NOT NULL DEFAULT TRUE
);

-- ---------------- APPLICATIONS ----------------
CREATE TYPE application_status AS ENUM (
    'IN_PROGRESS',
    'DOCS_REQUESTED',
    'RETURNED_TO_DEPARTMENT',  -- Registrar sent it back with a mandatory comment
    'ISSUED',
    'REJECTED'
);

CREATE TABLE IF NOT EXISTS applications (
    application_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_code     VARCHAR(30) NOT NULL UNIQUE,
    student_user_id       UUID NOT NULL REFERENCES users(user_id),
    student_name           VARCHAR(150) NOT NULL,
    student_sdmis_id       VARCHAR(30) NOT NULL,
    program                 VARCHAR(150),
    school_dept             VARCHAR(100),
    residency               VARCHAR(20),
    cert_type_id            SMALLINT NOT NULL REFERENCES certificate_types(cert_type_id),
    stages                  JSONB NOT NULL,          -- resolved stage list for this application, e.g. ["SCHOOL","WARDEN"]
    current_stage_index     SMALLINT NOT NULL DEFAULT 0,
    purpose_note             TEXT,
    status                    application_status NOT NULL DEFAULT 'IN_PROGRESS',
    rejection_reason          TEXT,
    sdmis_profile_snapshot    JSONB,

    -- Granular tracking (current level is derived: stages[current_stage_index]
    -- when current_stage_index < stages.length, else 'REGISTRAR')
    assigned_reviewer_id      UUID REFERENCES users(user_id),      -- last person to act on it
    level_entered_at           TIMESTAMPTZ NOT NULL DEFAULT now(), -- drives "pending duration" on every dashboard

    -- Registrar return loop
    return_comment              TEXT,                               -- mandatory explanation on a Registrar return

    -- Department inline editing + fee-in-words snapshot
    certificate_draft             JSONB,
    fee_snapshot                    JSONB,

    created_at                       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_applications_student ON applications(student_user_id);
CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_applications_cert_type ON applications(cert_type_id);
CREATE INDEX IF NOT EXISTS idx_applications_created_at ON applications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_applications_assigned_reviewer ON applications(assigned_reviewer_id);

-- ---------------- ACTIVITY LOGS (cross-stakeholder, immutable) ----------------
-- Read directly by every dashboard (Student, Department, Registrar, Super
-- Admin), scoped to the applications each role can see.
CREATE TABLE IF NOT EXISTS activity_logs (
    event_id        BIGSERIAL PRIMARY KEY,
    application_id  UUID NOT NULL REFERENCES applications(application_id) ON DELETE CASCADE,
    actor_user_id    UUID REFERENCES users(user_id),
    actor_name        VARCHAR(150),
    actor_role         VARCHAR(30),
    action              VARCHAR(40) NOT NULL,   -- SUBMITTED / EDITED / STAGE_APPROVED / RETURNED / RESUBMITTED_DIRECT / DOCS_REQUESTED / REJECTED / ISSUED / SIGNATURE_UPLOADED / PASSWORD_CHANGED
    from_stage           VARCHAR(30),
    to_stage               VARCHAR(30),
    note                     TEXT,             -- e.g. the Registrar's mandatory return comment
    occurred_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_app ON activity_logs(application_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_activity_actor ON activity_logs(actor_user_id);

-- ---------------- DOCUMENTS ----------------
CREATE TABLE IF NOT EXISTS documents (
    document_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id  UUID NOT NULL REFERENCES applications(application_id) ON DELETE CASCADE,
    doc_type        VARCHAR(60),
    file_name       VARCHAR(255),
    storage_url     TEXT,             -- e.g. a Cloudinary URL, matching the existing upload pattern
    uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_documents_app ON documents(application_id);

-- ---------------- CERTIFICATES ----------------
CREATE TABLE IF NOT EXISTS certificates (
    certificate_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id        UUID NOT NULL UNIQUE REFERENCES applications(application_id),
    certificate_number    VARCHAR(40) NOT NULL UNIQUE,
    cert_type_id           SMALLINT NOT NULL REFERENCES certificate_types(cert_type_id),
    qr_verification_token   TEXT NOT NULL UNIQUE,
    issued_by_user_id        UUID REFERENCES users(user_id),
    issued_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Registrar signature upload — composited onto the PDF at issuance time
    registrar_signature_data   TEXT,          -- base64 data: URL of the uploaded signature image
    signed_at                    TIMESTAMPTZ,

    -- Automated notification
    notified_at                   TIMESTAMPTZ,
    notification_channel            VARCHAR(20),

    revoked                          BOOLEAN NOT NULL DEFAULT FALSE,
    revoked_at                         TIMESTAMPTZ,
    revoked_reason                       TEXT
);
CREATE INDEX IF NOT EXISTS idx_certs_qr_token ON certificates(qr_verification_token);
CREATE INDEX IF NOT EXISTS idx_certs_number ON certificates(certificate_number);

-- ---------------- updated_at trigger ----------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_applications_updated_at ON applications;
CREATE TRIGGER trg_applications_updated_at
    BEFORE UPDATE ON applications
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
