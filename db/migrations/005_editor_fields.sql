-- Migration 005: Fees / Financial Aid role split, rich-text certificate
-- editor storage, and real backend sources for template blanks.
-- Idempotent: safe to run more than once.

BEGIN;

-- ---------------------------------------------------------------
-- 1. Split the merged "Fees & Financial Aid" role into two roles
--    (matches Digi_Certficate-Forwarding_Sequence.docx)
-- ---------------------------------------------------------------
INSERT INTO roles (role_code, label) VALUES
    ('fees_admin',   'Fees Department'),
    ('finaid_admin', 'Financial Aid Department')
ON CONFLICT (role_code) DO UPDATE SET label = EXCLUDED.label;

-- Existing holders of the merged role become Fees Dept users; a Super Admin
-- can re-tag anyone who should be Financial Aid under Users & roles.
UPDATE users SET role_code = 'fees_admin' WHERE role_code = 'fees_finaid_admin';

-- Bank Loan-General (#6): Fees only. Bank Loan-with-Fin.Aid (#5) and MYSY (#10): Fees then Fin.Aid.
UPDATE certificate_types SET stages = '["SCHOOL","FEES"]'::jsonb
 WHERE code = 'BANK_LOAN_GENERAL';
UPDATE certificate_types SET stages = '["SCHOOL","FEES","FINAID"]'::jsonb
 WHERE code IN ('BANK_LOAN_FIN_AID', 'MYSY_SCHOLARSHIP');

-- In-flight applications still carry the old merged "FEES_FINAID" stage in
-- their own resolved stage list. Rewrite them, and shift current_stage_index
-- when an extra FINAID stage is inserted ahead of where the application is.
DO $$
DECLARE
    r        RECORD;
    both_ct  BOOLEAN;
    pos      INT;
    new_st   JSONB;
BEGIN
    FOR r IN
        SELECT a.application_id, a.stages, a.current_stage_index, ct.code
          FROM applications a
          JOIN certificate_types ct ON ct.cert_type_id = a.cert_type_id
         WHERE a.stages @> '"FEES_FINAID"'::jsonb
    LOOP
        both_ct := r.code IN ('BANK_LOAN_FIN_AID', 'MYSY_SCHOLARSHIP');

        SELECT (t.ord - 1)::INT INTO pos
          FROM jsonb_array_elements_text(r.stages) WITH ORDINALITY AS t(e, ord)
         WHERE t.e = 'FEES_FINAID' LIMIT 1;

        SELECT jsonb_agg(s.el ORDER BY s.ord, s.sub) INTO new_st FROM (
            SELECT t.ord, 1 AS sub,
                   CASE WHEN t.e = 'FEES_FINAID' THEN 'FEES' ELSE t.e END AS el
              FROM jsonb_array_elements_text(r.stages) WITH ORDINALITY AS t(e, ord)
            UNION ALL
            SELECT t.ord, 2, 'FINAID'
              FROM jsonb_array_elements_text(r.stages) WITH ORDINALITY AS t(e, ord)
             WHERE t.e = 'FEES_FINAID' AND both_ct
        ) s;

        UPDATE applications
           SET stages = new_st,
               current_stage_index = CASE WHEN both_ct AND r.current_stage_index > pos
                                          THEN r.current_stage_index + 1
                                          ELSE r.current_stage_index END
         WHERE application_id = r.application_id;
    END LOOP;
END $$;

-- Retire the merged role once nobody holds it.
DELETE FROM roles r
 WHERE r.role_code = 'fees_finaid_admin'
   AND NOT EXISTS (SELECT 1 FROM users u WHERE u.role_code = r.role_code);

-- ---------------------------------------------------------------
-- 2. Rich-text certificate editor storage
-- ---------------------------------------------------------------
-- Working copy edited by any non-student login (HTML from the editor).
ALTER TABLE applications ADD COLUMN IF NOT EXISTS certificate_html TEXT;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS certificate_html_updated_by UUID REFERENCES users(user_id);
ALTER TABLE applications ADD COLUMN IF NOT EXISTS certificate_html_updated_at TIMESTAMPTZ;
-- Frozen copy that was actually issued (what verify / download / reprint serve).
ALTER TABLE certificates  ADD COLUMN IF NOT EXISTS final_html TEXT;

-- ---------------------------------------------------------------
-- 3. Real backend sources for template blanks
-- ---------------------------------------------------------------
-- Per-student record data the templates need (admission month/year, current
-- semester, CGPA, ABC/NAD/APAAR ID, address, honorific/gender, ...). Filled
-- by the SDMIS sync / bulk import, or edited by Super Admin.
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_data JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Programme length drives "(08/10) semesters" and "(four/five)-year".
ALTER TABLE programmes ADD COLUMN IF NOT EXISTS duration_years SMALLINT;

-- (Also written by migration 004; repeated here so 005 stands alone on a database that skipped it.)
ALTER TABLE applications ADD COLUMN IF NOT EXISTS batch VARCHAR(20);

-- Per-request details the student supplies (VISA country / event / dates, ...).
ALTER TABLE applications ADD COLUMN IF NOT EXISTS request_details JSONB NOT NULL DEFAULT '{}'::jsonb;

-- University-level constants used by the bank-loan / MYSY templates are kept
-- in app_settings (bank_account_number, bank_ifsc, mysy_email, registry_email)
-- and edited by Super Admin; no new table is needed.

COMMIT;
