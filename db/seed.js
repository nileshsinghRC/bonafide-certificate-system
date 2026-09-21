// db/seed.js
// Run with: npm run seed  (after schema.sql has been applied)
require("dotenv").config();
const bcrypt = require("bcryptjs");
const { pool } = require("../src/db");

const ROLES = [
  { role_code: "student", label: "Student" },
  { role_code: "school_admin", label: "School's Office" },
  { role_code: "exam_admin", label: "Exam Office" },
  { role_code: "fees_finaid_admin", label: "Fees & Financial Aid Department" },
  { role_code: "admission_admin", label: "Admission Office" },
  { role_code: "warden", label: "Warden" },
  { role_code: "registrar_admin", label: "Registrar's Office" },
  { role_code: "super_admin", label: "Super Admin" }
];

// stages = department stops BEFORE the implicit, always-final Registrar stage.
const CERT_TYPES = [
  { code: "MIGRATION_GENERAL", label: "Migration Certificate — General", stages: ["SCHOOL", "EXAM"], warden_conditional: false, requires_document: false, requires_undertaking: false },
  { code: "MIGRATION_EARLY_EXIT", label: "Migration Certificate — Early Exit", stages: ["SCHOOL", "EXAM"], warden_conditional: false, requires_document: false, requires_undertaking: false },
  { code: "MEDIUM_OF_INSTRUCTION", label: "Medium of Instruction Certificate", stages: ["SCHOOL", "EXAM"], warden_conditional: false, requires_document: false, requires_undertaking: false },
  { code: "VISA_GENERAL", label: "VISA & Passport — General", stages: ["SCHOOL"], warden_conditional: false, requires_document: true, requires_undertaking: false },
  { code: "BANK_LOAN_FIN_AID", label: "Bank Loan — General, with Financial Aid", stages: ["SCHOOL", "FEES_FINAID"], warden_conditional: false, requires_document: false, requires_undertaking: false },
  { code: "BANK_LOAN_GENERAL", label: "Bank Loan — General", stages: ["SCHOOL", "FEES_FINAID"], warden_conditional: false, requires_document: false, requires_undertaking: false },
  { code: "BANK_LOAN_ADEPT", label: "Bank Loan — ADEPT Score", stages: ["ADMISSION"], warden_conditional: false, requires_document: false, requires_undertaking: false },
  { code: "FIELD_RESEARCH", label: "Field Research Certificate", stages: ["SCHOOL"], warden_conditional: false, requires_document: true, requires_undertaking: false },
  { code: "GOVT_SCHOLARSHIP_GENERAL", label: "Government Scholarship — General", stages: ["SCHOOL"], warden_conditional: true, requires_document: false, requires_undertaking: false },
  { code: "MYSY_SCHOLARSHIP", label: "MYSY Scholarship Certificate", stages: ["SCHOOL", "FEES_FINAID"], warden_conditional: false, requires_document: false, requires_undertaking: true }
];

// Schools & the programmes each one teaches — used to validate/tag new
// student and School Admin accounts against a real programme list.
const SCHOOLS = [
  { code: "SOT", name: "School of Technology", programmes: ["B.Tech Computer Science", "B.Des Product Design", "B.Des Product Design (Hons)"] },
  { code: "SOA", name: "School of Environment and Architecture", programmes: ["B.Arch"] },
  { code: "SOB", name: "School of Business", programmes: ["BBA"] }
];

// Demo accounts — one per role, matching the escalation table stakeholders.
const USERS = [
  { username: "aarav.mehta", password: "student123", name: "Aarav Mehta", role_code: "student",
    student_sdmis_id: "SDM-2023-00451", program: "B.Des Product Design", school_dept: "School of Technology", school_code: "SOT", residency: "HOSTELLER" },
  { username: "priya.desai", password: "admin123", name: "Priya Desai", role_code: "school_admin", school_code: "SOT" },
  { username: "karan.bose", password: "admin123", name: "Karan Bose", role_code: "exam_admin" },
  { username: "meera.iyer", password: "admin123", name: "Meera Iyer", role_code: "fees_finaid_admin" },
  { username: "arjun.rao", password: "admin123", name: "Arjun Rao", role_code: "admission_admin" },
  { username: "sunita.varma", password: "admin123", name: "Sunita Varma", role_code: "warden" },
  { username: "fatima.qureshi", password: "admin123", name: "Fatima Qureshi", role_code: "registrar_admin" },
  { username: "admin", password: "super123", name: "Super Admin", role_code: "super_admin" }
];

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const r of ROLES) {
      await client.query(
        "INSERT INTO roles (role_code, label) VALUES ($1,$2) ON CONFLICT (role_code) DO UPDATE SET label = EXCLUDED.label",
        [r.role_code, r.label]
      );
    }

    for (const c of CERT_TYPES) {
      await client.query(
        `INSERT INTO certificate_types (code, label, stages, warden_conditional, requires_document, requires_undertaking)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, stages = EXCLUDED.stages,
           warden_conditional = EXCLUDED.warden_conditional, requires_document = EXCLUDED.requires_document,
           requires_undertaking = EXCLUDED.requires_undertaking`,
        [c.code, c.label, JSON.stringify(c.stages), c.warden_conditional, c.requires_document, c.requires_undertaking]
      );
    }

    const schoolIdByCode = {};
    for (const s of SCHOOLS) {
      const r = await client.query(
        `INSERT INTO schools (code, name, programmes) VALUES ($1,$2,$3)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, programmes = EXCLUDED.programmes
         RETURNING school_id`,
        [s.code, s.name, JSON.stringify(s.programmes)]
      );
      schoolIdByCode[s.code] = r.rows[0].school_id;
    }

    for (const u of USERS) {
      const hash = await bcrypt.hash(u.password, 10);
      const schoolId = u.school_code ? schoolIdByCode[u.school_code] : null;
      await client.query(
        `INSERT INTO users (username, password_hash, name, role_code, student_sdmis_id, program, school_dept, residency, school_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, name = EXCLUDED.name, role_code = EXCLUDED.role_code, school_id = EXCLUDED.school_id`,
        [u.username, hash, u.name, u.role_code, u.student_sdmis_id || null, u.program || null, u.school_dept || null, u.residency || null, schoolId]
      );
    }

    await client.query("COMMIT");
    console.log("Seed complete:", ROLES.length, "roles,", CERT_TYPES.length, "certificate types,", SCHOOLS.length, "schools,", USERS.length, "demo users.");
    console.log("Demo logins (username / password):");
    USERS.forEach((u) => console.log("  " + u.username + " / " + u.password + "  (" + u.role_code + ")"));
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Seed failed:", e);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
