// server.js
require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const XLSX = require("xlsx");

const { pool } = require("./src/db");
const { signToken, requireAuth, requireRole } = require("./src/auth");
const { renderCertificateHtml } = require("./src/certificateTemplates");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const app = express();
app.use(cors());
app.use(express.json({ limit: "8mb" })); // signature/seal/logo images travel as base64 in JSON bodies

// Department roles own one stage each of the forwarding sequence.
// registrar_admin always owns the implicit final stage.
const STAGE_TO_ROLE = {
  SCHOOL: "school_admin",
  EXAM: "exam_admin",
  FEES_FINAID: "fees_finaid_admin",
  ADMISSION: "admission_admin",
  WARDEN: "warden"
};
const DEPARTMENT_ROLES = Object.values(STAGE_TO_ROLE);

function err(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

// ---------------- Student account provisioning helpers ----------------
// If set, student usernames/emails must end with "@<this domain>" — e.g. "anu.edu.in".
// Leave STUDENT_EMAIL_DOMAIN unset to allow any well-formed email during initial rollout.
const STUDENT_EMAIL_DOMAIN = (process.env.STUDENT_EMAIL_DOMAIN || "").trim().toLowerCase();

function isValidEmailFormat(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ""));
}
function studentEmailAllowed(email) {
  if (!STUDENT_EMAIL_DOMAIN) return true;
  return String(email).toLowerCase().endsWith("@" + STUDENT_EMAIL_DOMAIN);
}
function generateTempPassword() {
  // e.g. "k3m9xQ2p7R" — readable, URL-safe, no ambiguous separators
  return crypto.randomBytes(9).toString("base64url").slice(0, 10);
}

// Matches a student's programme string against each school's programme
// list (case-insensitive) so a bulk-imported or SDMIS-synced account is
// automatically tagged with the right school — this is the validation step
// that makes a School Admin's queue actually scoped to their own school's
// students rather than the whole university.
async function matchSchoolForProgramme(client, programme) {
  if (!programme) return null;
  const { rows } = await client.query("SELECT school_id, programmes FROM schools WHERE is_active = true");
  const needle = String(programme).trim().toLowerCase();
  for (const s of rows) {
    const list = (s.programmes || []).map((p) => String(p).trim().toLowerCase());
    if (list.indexOf(needle) !== -1) return s.school_id;
  }
  return null;
}

// Shared by both the SDMIS sync API and the Super Admin bulk-import screen.
// Creates new student accounts with a generated temporary password (forced
// change on first login) and updates profile fields on accounts that already
// exist, without ever touching an existing password.
async function bulkUpsertStudents(client, students) {
  const created = [];
  const updated = [];
  const errors = [];
  for (const raw of students) {
    const email = String((raw && raw.email) || "").trim().toLowerCase();
    const name = String((raw && raw.name) || "").trim();
    if (!email || !name) { errors.push({ email: raw && raw.email, reason: "Missing email or name" }); continue; }
    if (!isValidEmailFormat(email)) { errors.push({ email, reason: "Not a valid email address" }); continue; }
    if (!studentEmailAllowed(email)) { errors.push({ email, reason: "Email domain is not allowed for student accounts" }); continue; }

    const schoolId = await matchSchoolForProgramme(client, raw.program);
    const schoolWarning = raw.program && !schoolId ? " (no school matched this programme — assign manually in Users & Roles)" : "";

    const existing = await client.query("SELECT user_id FROM users WHERE lower(username) = $1", [email]);
    if (existing.rows[0]) {
      await client.query(
        `UPDATE users SET name = $1, student_sdmis_id = $2, program = $3, school_dept = $4, residency = $5, school_id = $6
         WHERE user_id = $7`,
        [name, raw.studentSdmisId || null, raw.program || null, raw.schoolDept || null, raw.residency || null, schoolId, existing.rows[0].user_id]
      );
      updated.push(email + schoolWarning);
    } else {
      const tempPassword = generateTempPassword();
      const hash = await bcrypt.hash(tempPassword, 10);
      await client.query(
        `INSERT INTO users (username, password_hash, name, role_code, student_sdmis_id, program, school_dept, residency, school_id, must_change_password)
         VALUES ($1,$2,$3,'student',$4,$5,$6,$7,$8,true)`,
        [email, hash, name, raw.studentSdmisId || null, raw.program || null, raw.schoolDept || null, raw.residency || null, schoolId]
      );
      created.push({ email, tempPassword, school: schoolWarning ? null : schoolId });
    }
  }
  return { created, updated, errors };
}

// Very small in-memory brute-force guard. Resets on deploy/restart and does
// not share state across multiple instances — fine for a single free-tier
// Render service; swap for a Redis-backed limiter if you scale out.
const LOGIN_ATTEMPTS = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
function checkLoginRateLimit(key) {
  const now = Date.now();
  const rec = LOGIN_ATTEMPTS.get(key);
  if (!rec || now - rec.first > LOGIN_WINDOW_MS) {
    LOGIN_ATTEMPTS.set(key, { count: 0, first: now });
    return true;
  }
  return rec.count < LOGIN_MAX_ATTEMPTS;
}
function recordLoginFailure(key) {
  const now = Date.now();
  const rec = LOGIN_ATTEMPTS.get(key) || { count: 0, first: now };
  if (now - rec.first > LOGIN_WINDOW_MS) { rec.count = 0; rec.first = now; }
  rec.count += 1;
  LOGIN_ATTEMPTS.set(key, rec);
}
function clearLoginFailures(key) { LOGIN_ATTEMPTS.delete(key); }

// Machine-to-machine auth for the SDMIS sync endpoint — a static API key,
// never a user JWT, since this is meant to be called by a deployment script
// or a scheduled SDMIS export job, not a logged-in person.
function requireApiKey(req, res, next) {
  const configured = process.env.INTEGRATION_API_KEY;
  if (!configured) return err(res, 503, "NOT_CONFIGURED", "INTEGRATION_API_KEY is not set on the server.");
  const provided = req.headers["x-api-key"];
  if (!provided || provided !== configured) return err(res, 401, "INVALID_API_KEY", "Missing or invalid X-API-Key header.");
  next();
}

// ---------------- Number-to-words (Indian numbering system) ----------------
// Used to render numeric fee fields into formal text on certificates, e.g.
// 185000 -> "Rupees One Lakh Eighty-Five Thousand Only".
const NUM_WORDS_ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const NUM_WORDS_TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function twoDigitsToWords(n) {
  if (n < 20) return NUM_WORDS_ONES[n];
  return NUM_WORDS_TENS[Math.floor(n / 10)] + (n % 10 ? "-" + NUM_WORDS_ONES[n % 10] : "");
}
function threeDigitsToWords(n) {
  var parts = [];
  if (n >= 100) { parts.push(NUM_WORDS_ONES[Math.floor(n / 100)] + " Hundred"); n %= 100; }
  if (n > 0) parts.push(twoDigitsToWords(n));
  return parts.join(" ");
}
function numberToWords(amount) {
  var n = Math.round(Number(amount) || 0);
  if (n === 0) return "Rupees Zero Only";
  var crore = Math.floor(n / 10000000); n %= 10000000;
  var lakh = Math.floor(n / 100000); n %= 100000;
  var thousand = Math.floor(n / 1000); n %= 1000;
  var rest = n;
  var parts = [];
  if (crore) parts.push(threeDigitsToWords(crore) + " Crore");
  if (lakh) parts.push(threeDigitsToWords(lakh) + " Lakh");
  if (thousand) parts.push(threeDigitsToWords(thousand) + " Thousand");
  if (rest) parts.push(threeDigitsToWords(rest));
  return "Rupees " + parts.join(" ") + " Only";
}

// ---------------- SDMIS fee data (placeholder — see README "known gaps") ----------------
// Real integration point: replace with a live call to the central fee
// database. Until then, falls back to sensible defaults so the certificate
// draft always has something meaningful to render.
function buildFeeSnapshot(student) {
  var tuition = student.tuition_fee_amount != null ? Number(student.tuition_fee_amount) : 185000;
  var hostel = student.hostel_fee_amount != null ? Number(student.hostel_fee_amount) : (student.residency === "HOSTELLER" ? 65000 : 0);
  return {
    currency: "INR",
    asOf: new Date().toISOString(),
    fees: [
      { category: "TUITION_FEE_SEMESTER", amount: tuition, amountInWords: numberToWords(tuition) },
      { category: "HOSTEL_FEE_SEMESTER", amount: hostel, amountInWords: numberToWords(hostel) }
    ]
  };
}
function defaultCertificateDraft(application, feeSnapshot) {
  var fees = (feeSnapshot && feeSnapshot.fees) || [];
  return {
    studentName: application.student_name,
    programName: application.program || "",
    schoolDept: application.school_dept || "",
    residency: application.residency || "",
    purposeNote: application.purpose_note || "",
    tuitionFeeInWords: fees[0] ? fees[0].amountInWords : "",
    hostelFeeInWords: fees[1] ? fees[1].amountInWords : ""
  };
}

// ---------------- SDMIS profile photo sync (placeholder — see README) ----------------
// Real integration point: replace with a live fetch of the SDMIS master
// photo. Until then, generates a stable initials avatar so every dashboard
// still has a real image to render and cache, not a broken link.
function placeholderPhotoUrl(name) {
  return "https://ui-avatars.com/api/?background=7A2E2E&color=fff&name=" + encodeURIComponent(name || "Student");
}

// ---------------- Workflow level helpers ----------------
function currentLevelOf(application) {
  return application.current_stage_index >= application.stages.length ? "REGISTRAR" : application.stages[application.current_stage_index];
}

// ============================================================
// AUTH
// ============================================================
app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return err(res, 400, "MISSING_FIELDS", "Username and password are required.");
  const rlKey = String(username).trim().toLowerCase();
  if (!checkLoginRateLimit(rlKey)) {
    return err(res, 429, "TOO_MANY_ATTEMPTS", "Too many failed sign-in attempts. Try again in a few minutes.");
  }
  try {
    const { rows } = await pool.query("SELECT * FROM users WHERE lower(username) = lower($1)", [username]);
    const user = rows[0];
    if (!user) { recordLoginFailure(rlKey); return err(res, 401, "INVALID_CREDENTIALS", "Incorrect username or password."); }
    if (!user.active) return err(res, 403, "ACCOUNT_DEACTIVATED", "This account has been deactivated. Contact a Super Admin.");
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) { recordLoginFailure(rlKey); return err(res, 401, "INVALID_CREDENTIALS", "Incorrect username or password."); }
    clearLoginFailures(rlKey);

    // Req. 2: sync the profile photo from SDMIS on every login. Real
    // integration point — see buildFeeSnapshot/placeholderPhotoUrl comments.
    if (!user.profile_picture_url) {
      user.profile_picture_url = placeholderPhotoUrl(user.name);
      await pool.query("UPDATE users SET profile_picture_url = $1, profile_picture_synced_at = now() WHERE user_id = $2", [user.profile_picture_url, user.user_id]);
    } else {
      await pool.query("UPDATE users SET profile_picture_synced_at = now() WHERE user_id = $1", [user.user_id]);
    }

    const token = signToken(user);
    res.json({
      token,
      user: {
        id: user.user_id, username: user.username, name: user.name, role: user.role_code,
        studentSdmisId: user.student_sdmis_id, program: user.program, schoolDept: user.school_dept,
        residency: user.residency, mustChangePassword: user.must_change_password,
        profilePictureUrl: user.profile_picture_url
      }
    });
  } catch (e) {
    console.error(e);
    err(res, 500, "SERVER_ERROR", "Could not process login.");
  }
});

app.get("/api/me", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM users WHERE user_id = $1", [req.auth.userId]);
  const user = rows[0];
  if (!user || !user.active) return err(res, 401, "INVALID_SESSION", "Session no longer valid.");
  res.json({
    id: user.user_id, username: user.username, name: user.name, role: user.role_code,
    studentSdmisId: user.student_sdmis_id, program: user.program, schoolDept: user.school_dept,
    residency: user.residency, mustChangePassword: user.must_change_password,
    profilePictureUrl: user.profile_picture_url
  });
});

// Self-service password change — also how a forced first-login change is cleared.
app.post("/api/me/password", requireAuth, async (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 8) {
    return err(res, 422, "WEAK_PASSWORD", "New password must be at least 8 characters.");
  }
  const hash = await bcrypt.hash(newPassword, 10);
  await pool.query("UPDATE users SET password_hash = $1, must_change_password = false WHERE user_id = $2", [hash, req.auth.userId]);
  res.json({ ok: true });
});

// ============================================================
// CERTIFICATE TYPES (reference data for the application form)
// ============================================================
app.get("/api/certificate-types", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT cert_type_id, code, label, stages, warden_conditional, requires_document, requires_undertaking FROM certificate_types WHERE is_active = true ORDER BY cert_type_id"
  );
  res.json(rows);
});

// ============================================================
// STUDENT: create + track applications
// ============================================================
app.post("/api/applications", requireAuth, requireRole("student", "super_admin"), async (req, res) => {
  const { certTypeCode, purposeNote, documentAttached, undertakingConfirmed } = req.body || {};
  if (!certTypeCode) return err(res, 400, "MISSING_FIELDS", "certTypeCode is required.");

  const client = await pool.connect();
  try {
    const userRes = await client.query("SELECT * FROM users WHERE user_id = $1", [req.auth.userId]);
    const student = userRes.rows[0];
    if (!student) return err(res, 401, "INVALID_SESSION", "Session no longer valid.");

    const ctRes = await client.query("SELECT * FROM certificate_types WHERE code = $1 AND is_active = true", [certTypeCode]);
    const certType = ctRes.rows[0];
    if (!certType) return err(res, 404, "CERT_TYPE_NOT_FOUND", "Unknown certificate type.");

    if (certType.requires_document && !documentAttached) {
      return err(res, 422, "DOCUMENT_REQUIRED", "This certificate type requires a supporting document.");
    }
    if (certType.requires_undertaking && !undertakingConfirmed) {
      return err(res, 422, "UNDERTAKING_REQUIRED", "The signed MYSY undertaking must be attached before submitting.");
    }

    let stages = certType.stages.slice();
    if (certType.warden_conditional && student.residency === "HOSTELLER") {
      stages = stages.concat(["WARDEN"]);
    }

    const seq = await client.query("SELECT nextval('application_code_seq') AS n");
    const code = "APP-" + new Date().getFullYear() + "-" + String(seq.rows[0].n).padStart(5, "0");

    const insertRes = await client.query(
      `INSERT INTO applications
        (application_code, student_user_id, student_name, student_sdmis_id, program, school_dept, school_id, residency,
         cert_type_id, stages, current_stage_index, purpose_note, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,'IN_PROGRESS')
       RETURNING *`,
      [code, student.user_id, student.name, student.student_sdmis_id || student.username, student.program,
       student.school_dept, student.school_id, student.residency, certType.cert_type_id, JSON.stringify(stages), purposeNote || null]
    );
    const application = insertRes.rows[0];

    if (documentAttached) {
      await client.query(
        "INSERT INTO documents (application_id, doc_type, file_name) VALUES ($1,$2,$3)",
        [application.application_id, "SUPPORTING_DOCUMENT", String(documentAttached)]
      );
    }
    if (certType.requires_undertaking && undertakingConfirmed) {
      await client.query(
        "INSERT INTO documents (application_id, doc_type, file_name) VALUES ($1,'UNDERTAKING_MYSY','signed-undertaking.pdf')",
        [application.application_id]
      );
    }
    await client.query(
      "INSERT INTO activity_logs (application_id, actor_user_id, actor_name, actor_role, action, to_stage, note) VALUES ($1,$2,$3,$4,'SUBMITTED',$5,$6)",
      [application.application_id, student.user_id, student.name, student.role_code, stages[0] || "REGISTRAR", "Application submitted"]
    );

    res.status(201).json(application);
  } catch (e) {
    console.error(e);
    err(res, 500, "SERVER_ERROR", "Could not create the application.");
  } finally {
    client.release();
  }
});

app.get("/api/applications/me", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.*, ct.code AS cert_type_code, ct.label AS cert_type_label
     FROM applications a JOIN certificate_types ct ON ct.cert_type_id = a.cert_type_id
     WHERE a.student_user_id = $1 ORDER BY a.created_at DESC`,
    [req.auth.userId]
  );
  res.json(rows);
});

app.get("/api/applications/:id/activity-log", requireAuth, async (req, res) => {
  const { rows: appRows } = await pool.query("SELECT student_user_id FROM applications WHERE application_id = $1", [req.params.id]);
  if (!appRows[0]) return err(res, 404, "APPLICATION_NOT_FOUND", "No application exists with the given ID.");
  if (req.auth.role === "student" && appRows[0].student_user_id !== req.auth.userId) {
    return err(res, 403, "FORBIDDEN", "You can only view the activity log for your own applications.");
  }
  const { rows } = await pool.query(
    "SELECT * FROM activity_logs WHERE application_id = $1 ORDER BY occurred_at ASC",
    [req.params.id]
  );
  res.json(rows);
});

// Req. 1: step-by-step progress — current level, assigned reviewer, pending duration.
app.get("/api/applications/:id/tracker", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM applications WHERE application_id = $1", [req.params.id]);
  const application = rows[0];
  if (!application) return err(res, 404, "APPLICATION_NOT_FOUND", "No application exists with the given ID.");
  if (req.auth.role === "student" && application.student_user_id !== req.auth.userId) {
    return err(res, 403, "FORBIDDEN", "You can only view the tracker for your own applications.");
  }

  const levels = application.stages.concat(["REGISTRAR"]);
  const currentIdx = application.current_stage_index;
  const steps = levels.map((lvl, idx) => {
    var stepStatus;
    if (application.status === "ISSUED") stepStatus = "COMPLETED";
    else if (application.status === "REJECTED") stepStatus = idx <= currentIdx ? "COMPLETED" : "SKIPPED";
    else if (idx < currentIdx) stepStatus = "COMPLETED";
    else if (idx === currentIdx) stepStatus = "CURRENT";
    else stepStatus = "PENDING";
    return { level: lvl, status: stepStatus };
  });

  let assignedReviewer = null;
  if (application.assigned_reviewer_id) {
    const ur = await pool.query("SELECT name, role_code FROM users WHERE user_id = $1", [application.assigned_reviewer_id]);
    if (ur.rows[0]) assignedReviewer = { name: ur.rows[0].name, role: ur.rows[0].role_code };
  }

  res.json({
    applicationId: application.application_id,
    applicationCode: application.application_code,
    currentLevel: currentLevelOf(application),
    status: application.status,
    assignedReviewer,
    levelEnteredAt: application.level_entered_at,
    pendingDurationMinutes: Math.max(0, Math.round((Date.now() - new Date(application.level_entered_at).getTime()) / 60000)),
    returnComment: application.status === "RETURNED_TO_DEPARTMENT" ? application.return_comment : null,
    steps
  });
});

// Req. 3: pre-populated certificate draft (fees rendered to words), created on first view.
app.get("/api/applications/:id/certificate-preview", requireAuth, async (req, res) => {
  if (req.auth.role === "student") return err(res, 403, "FORBIDDEN", "Students cannot preview the certificate draft.");
  const client = await pool.connect();
  try {
    const { rows } = await client.query("SELECT * FROM applications WHERE application_id = $1", [req.params.id]);
    const application = rows[0];
    if (!application) return err(res, 404, "APPLICATION_NOT_FOUND", "No application exists with the given ID.");

    let draft = application.certificate_draft;
    let feeSnapshot = application.fee_snapshot;
    if (!draft) {
      const stuRes = await client.query("SELECT * FROM users WHERE user_id = $1", [application.student_user_id]);
      feeSnapshot = buildFeeSnapshot(stuRes.rows[0] || {});
      draft = defaultCertificateDraft(application, feeSnapshot);
      await client.query("UPDATE applications SET certificate_draft = $1, fee_snapshot = $2 WHERE application_id = $3",
        [JSON.stringify(draft), JSON.stringify(feeSnapshot), application.application_id]);
    }
    res.json({ applicationId: application.application_id, certificateDraft: draft, feeSnapshot });
  } finally {
    client.release();
  }
});

// Req. 3: department inline editing of the pre-populated draft.
app.patch("/api/department/applications/:id/certificate-draft", requireAuth, async (req, res) => {
  if (DEPARTMENT_ROLES.indexOf(req.auth.role) === -1 && req.auth.role !== "super_admin") {
    return err(res, 403, "FORBIDDEN", "Only department reviewers can edit the certificate draft.");
  }
  const { fields } = req.body || {};
  if (!fields || typeof fields !== "object") return err(res, 422, "MISSING_FIELDS", "Provide a fields object to merge into the draft.");
  const client = await pool.connect();
  try {
    const { rows } = await client.query("SELECT * FROM applications WHERE application_id = $1", [req.params.id]);
    const application = rows[0];
    if (!application) return err(res, 404, "APPLICATION_NOT_FOUND", "No application exists with the given ID.");
    const merged = Object.assign({}, application.certificate_draft || {}, fields);
    await client.query("UPDATE applications SET certificate_draft = $1 WHERE application_id = $2", [JSON.stringify(merged), application.application_id]);
    await client.query(
      "INSERT INTO activity_logs (application_id, actor_user_id, actor_name, actor_role, action, note) VALUES ($1,$2,$3,$4,'EDITED',$5)",
      [application.application_id, req.auth.userId, req.auth.name, req.auth.role, "Edited certificate draft fields: " + Object.keys(fields).join(", ")]
    );
    res.json({ applicationId: application.application_id, certificateDraft: merged });
  } finally {
    client.release();
  }
});

// Student resubmits after a DOCS_REQUESTED response
app.post("/api/applications/:id/resubmit", requireAuth, requireRole("student", "super_admin"), async (req, res) => {
  const { documentAttached } = req.body || {};
  const client = await pool.connect();
  try {
    const { rows } = await client.query("SELECT * FROM applications WHERE application_id = $1", [req.params.id]);
    const application = rows[0];
    if (!application) return err(res, 404, "APPLICATION_NOT_FOUND", "No application exists with the given ID.");
    if (application.status !== "DOCS_REQUESTED") return err(res, 409, "INVALID_STATE", "This application is not awaiting a resubmission.");

    if (documentAttached) {
      await client.query("INSERT INTO documents (application_id, doc_type, file_name) VALUES ($1,'SUPPORTING_DOCUMENT',$2)",
        [application.application_id, String(documentAttached)]);
    }
    await client.query("UPDATE applications SET status = 'IN_PROGRESS' WHERE application_id = $1", [application.application_id]);
    await client.query(
      "INSERT INTO activity_logs (application_id, actor_user_id, actor_name, actor_role, action, note) VALUES ($1,$2,$3,$4,'RESUBMITTED',$5)",
      [application.application_id, req.auth.userId, req.auth.name, req.auth.role, "Student resubmitted with requested documents"]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    err(res, 500, "SERVER_ERROR", "Could not resubmit the application.");
  } finally {
    client.release();
  }
});

// ============================================================
// DEPARTMENT DESKS (School / Exam / Fees & Fin. Aid / Admission / Warden)
// ============================================================
app.get("/api/department/queue", requireAuth, async (req, res) => {
  let dept = null;
  let schoolFilter = null; // only applies to the SCHOOL stage — each School Admin sees only their own school's applications
  if (DEPARTMENT_ROLES.indexOf(req.auth.role) !== -1) {
    dept = Object.keys(STAGE_TO_ROLE).find((k) => STAGE_TO_ROLE[k] === req.auth.role);
    if (dept === "SCHOOL") {
      const ur = await pool.query("SELECT school_id FROM users WHERE user_id = $1", [req.auth.userId]);
      schoolFilter = ur.rows[0] ? ur.rows[0].school_id : null;
    }
  } else if (req.auth.role === "super_admin") {
    dept = req.query.dept;
    if (!dept) return err(res, 400, "MISSING_DEPT", "Pass ?dept=SCHOOL|EXAM|FEES_FINAID|ADMISSION|WARDEN for Super Admin.");
    if (dept === "SCHOOL" && req.query.schoolId) schoolFilter = req.query.schoolId;
  } else {
    return err(res, 403, "FORBIDDEN", "Your role does not have a department queue.");
  }

  const params = [dept];
  let schoolClause = "";
  if (dept === "SCHOOL" && schoolFilter) {
    params.push(schoolFilter);
    schoolClause = " AND a.school_id = $2";
  }
  const { rows } = await pool.query(
    `SELECT a.*, ct.code AS cert_type_code, ct.label AS cert_type_label
     FROM applications a JOIN certificate_types ct ON ct.cert_type_id = a.cert_type_id
     WHERE a.status IN ('IN_PROGRESS', 'RETURNED_TO_DEPARTMENT')
       AND a.current_stage_index < jsonb_array_length(a.stages)
       AND a.stages->>a.current_stage_index::int = $1` + schoolClause + `
     ORDER BY a.created_at ASC`,
    params
  );
  const withDuration = rows.map((r) => Object.assign({}, r, {
    pendingDurationMinutes: Math.max(0, Math.round((Date.now() - new Date(r.level_entered_at).getTime()) / 60000))
  }));
  res.json({ dept, applications: withDuration });
});

app.patch("/api/department/applications/:id/action", requireAuth, async (req, res) => {
  const { action, reason } = req.body || {};
  if (!["approve", "reject", "request_docs"].includes(action)) {
    return err(res, 400, "INVALID_ACTION", "action must be approve, reject, or request_docs.");
  }
  if ((action === "reject" || action === "request_docs") && !reason) {
    return err(res, 422, "REASON_REQUIRED", "A reason is required for this action.");
  }

  const client = await pool.connect();
  try {
    const { rows } = await client.query("SELECT * FROM applications WHERE application_id = $1", [req.params.id]);
    const application = rows[0];
    if (!application) return err(res, 404, "APPLICATION_NOT_FOUND", "No application exists with the given ID.");
    if (application.status !== "IN_PROGRESS") return err(res, 409, "INVALID_STATE", "This application is not awaiting department review.");

    const stages = application.stages;
    if (application.current_stage_index >= stages.length) {
      return err(res, 409, "AWAITING_REGISTRAR", "This application has already cleared all department stages.");
    }
    const currentDept = stages[application.current_stage_index];
    const requiredRole = STAGE_TO_ROLE[currentDept];
    if (req.auth.role !== requiredRole && req.auth.role !== "super_admin") {
      return err(res, 403, "FORBIDDEN", "This application is not at your department's stage.");
    }

    const actorLine = req.auth.name + " (" + req.auth.role + ")";
    if (action === "approve") {
      const nextIndex = application.current_stage_index + 1;
      await client.query(
        "UPDATE applications SET current_stage_index = $1, assigned_reviewer_id = $2, level_entered_at = now() WHERE application_id = $3",
        [nextIndex, req.auth.userId, application.application_id]
      );
      await client.query(
        "INSERT INTO activity_logs (application_id, actor_user_id, actor_name, actor_role, action, from_stage, to_stage, note) VALUES ($1,$2,$3,$4,'STAGE_APPROVED',$5,$6,$7)",
        [application.application_id, req.auth.userId, req.auth.name, req.auth.role, currentDept,
         (nextIndex >= stages.length ? "REGISTRAR" : stages[nextIndex]),
         (nextIndex >= stages.length ? "Cleared final department stage — forwarded to Registrar" : "Approved by " + actorLine + ", forwarded to next stage")]
      );
    } else if (action === "reject") {
      await client.query(
        "UPDATE applications SET status = 'REJECTED', rejection_reason = $1, assigned_reviewer_id = $2, level_entered_at = now() WHERE application_id = $3",
        [reason, req.auth.userId, application.application_id]
      );
      await client.query(
        "INSERT INTO activity_logs (application_id, actor_user_id, actor_name, actor_role, action, from_stage, note) VALUES ($1,$2,$3,$4,'REJECTED',$5,$6)",
        [application.application_id, req.auth.userId, req.auth.name, req.auth.role, currentDept, "Rejected by " + actorLine + ": " + reason]
      );
    } else if (action === "request_docs") {
      await client.query(
        "UPDATE applications SET status = 'DOCS_REQUESTED', assigned_reviewer_id = $1, level_entered_at = now() WHERE application_id = $2",
        [req.auth.userId, application.application_id]
      );
      await client.query(
        "INSERT INTO activity_logs (application_id, actor_user_id, actor_name, actor_role, action, from_stage, note) VALUES ($1,$2,$3,$4,'DOCS_REQUESTED',$5,$6)",
        [application.application_id, req.auth.userId, req.auth.name, req.auth.role, currentDept, "Documents requested by " + actorLine + ": " + reason]
      );
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    err(res, 500, "SERVER_ERROR", "Could not update the application.");
  } finally {
    client.release();
  }
});

// Req. 4: direct resubmission after a Registrar return — bypasses any
// intermediate department stages that already cleared it once.
app.post("/api/department/applications/:id/resubmit-to-registrar", requireAuth, async (req, res) => {
  if (DEPARTMENT_ROLES.indexOf(req.auth.role) === -1 && req.auth.role !== "super_admin") {
    return err(res, 403, "FORBIDDEN", "Only department reviewers can resubmit to the Registrar.");
  }
  const client = await pool.connect();
  try {
    const { rows } = await client.query("SELECT * FROM applications WHERE application_id = $1", [req.params.id]);
    const application = rows[0];
    if (!application) return err(res, 404, "APPLICATION_NOT_FOUND", "No application exists with the given ID.");
    if (application.status !== "RETURNED_TO_DEPARTMENT") return err(res, 409, "NOT_RETURNED", "This application was not returned by the Registrar.");

    const currentDept = application.stages[application.current_stage_index];
    const requiredRole = STAGE_TO_ROLE[currentDept];
    if (req.auth.role !== requiredRole && req.auth.role !== "super_admin") {
      return err(res, 403, "FORBIDDEN", "This application is not at your department's stage.");
    }

    await client.query(
      "UPDATE applications SET status = 'IN_PROGRESS', current_stage_index = $1, assigned_reviewer_id = $2, level_entered_at = now() WHERE application_id = $3",
      [application.stages.length, req.auth.userId, application.application_id]
    );
    await client.query(
      "INSERT INTO activity_logs (application_id, actor_user_id, actor_name, actor_role, action, from_stage, to_stage, note) VALUES ($1,$2,$3,$4,'RESUBMITTED_DIRECT',$5,'REGISTRAR',$6)",
      [application.application_id, req.auth.userId, req.auth.name, req.auth.role, currentDept,
       "Corrected by " + req.auth.name + " (" + req.auth.role + ") and resubmitted directly to the Registrar"]
    );
    res.json({ applicationId: application.application_id, status: "IN_PROGRESS", currentLevel: "REGISTRAR", bypassed: true });
  } catch (e) {
    console.error(e);
    err(res, 500, "SERVER_ERROR", "Could not resubmit the application.");
  } finally {
    client.release();
  }
});

// ============================================================
// REGISTRAR'S OFFICE — final review, signing, issuance
// ============================================================
app.get("/api/registrar/queue", requireAuth, requireRole("registrar_admin", "super_admin"), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.*, ct.code AS cert_type_code, ct.label AS cert_type_label
     FROM applications a JOIN certificate_types ct ON ct.cert_type_id = a.cert_type_id
     WHERE a.status = 'IN_PROGRESS' AND a.current_stage_index >= jsonb_array_length(a.stages)
     ORDER BY a.created_at ASC`
  );
  const withDuration = rows.map((r) => Object.assign({}, r, {
    pendingDurationMinutes: Math.max(0, Math.round((Date.now() - new Date(r.level_entered_at).getTime()) / 60000))
  }));
  res.json(withDuration);
});

app.post("/api/registrar/applications/:id/reject", requireAuth, requireRole("registrar_admin", "super_admin"), async (req, res) => {
  const { reason } = req.body || {};
  if (!reason) return err(res, 422, "REASON_REQUIRED", "A reason is required.");
  const client = await pool.connect();
  try {
    const { rows } = await client.query("SELECT * FROM applications WHERE application_id = $1", [req.params.id]);
    const application = rows[0];
    if (!application) return err(res, 404, "APPLICATION_NOT_FOUND", "No application exists with the given ID.");
    await client.query(
      "UPDATE applications SET status = 'REJECTED', rejection_reason = $1, assigned_reviewer_id = $2, level_entered_at = now() WHERE application_id = $3",
      [reason, req.auth.userId, application.application_id]
    );
    await client.query(
      "INSERT INTO activity_logs (application_id, actor_user_id, actor_name, actor_role, action, from_stage, note) VALUES ($1,$2,$3,$4,'REJECTED','REGISTRAR',$5)",
      [application.application_id, req.auth.userId, req.auth.name, req.auth.role, "Rejected by " + req.auth.name + " (Registrar Admin): " + reason]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    err(res, 500, "SERVER_ERROR", "Could not reject the application.");
  } finally {
    client.release();
  }
});

// Req. 4: return to Department with a mandatory explanation.
app.post("/api/registrar/applications/:id/return", requireAuth, requireRole("registrar_admin", "super_admin"), async (req, res) => {
  const { comment } = req.body || {};
  if (!comment) return err(res, 422, "COMMENT_REQUIRED", "A comment is required to return an application.");
  const client = await pool.connect();
  try {
    const { rows } = await client.query("SELECT * FROM applications WHERE application_id = $1", [req.params.id]);
    const application = rows[0];
    if (!application) return err(res, 404, "APPLICATION_NOT_FOUND", "No application exists with the given ID.");
    if (application.status !== "IN_PROGRESS" || application.current_stage_index < application.stages.length) {
      return err(res, 409, "NOT_AT_REGISTRAR", "This application is not currently with the Registrar.");
    }
    const newIndex = Math.max(application.stages.length - 1, 0);
    await client.query(
      "UPDATE applications SET status = 'RETURNED_TO_DEPARTMENT', current_stage_index = $1, return_comment = $2, assigned_reviewer_id = $3, level_entered_at = now() WHERE application_id = $4",
      [newIndex, comment, req.auth.userId, application.application_id]
    );
    await client.query(
      "INSERT INTO activity_logs (application_id, actor_user_id, actor_name, actor_role, action, from_stage, to_stage, note) VALUES ($1,$2,$3,$4,'RETURNED','REGISTRAR',$5,$6)",
      [application.application_id, req.auth.userId, req.auth.name, req.auth.role, application.stages[newIndex] || "SCHOOL", comment]
    );
    res.json({ applicationId: application.application_id, status: "RETURNED_TO_DEPARTMENT", currentLevel: application.stages[newIndex] });
  } catch (e) {
    console.error(e);
    err(res, 500, "SERVER_ERROR", "Could not return the application.");
  } finally {
    client.release();
  }
});

// Req. 5: upload the Registrar's signature and issue the certificate in one
// step — generates the number/token, composites the signature, applies the
// (edited) draft, and queues the notification.
app.post("/api/registrar/applications/:id/upload-signature", requireAuth, requireRole("registrar_admin", "super_admin"), async (req, res) => {
  const { signatureImageBase64, sealImageBase64, signaturePosition, sealPosition } = req.body || {};
  if (!signatureImageBase64) return err(res, 422, "SIGNATURE_REQUIRED", "A signature image is required to issue the certificate.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT a.*, ct.code AS cert_type_code, ct.label AS cert_type_label
       FROM applications a JOIN certificate_types ct ON ct.cert_type_id = a.cert_type_id
       WHERE a.application_id = $1 FOR UPDATE`,
      [req.params.id]
    );
    const application = rows[0];
    if (!application) { await client.query("ROLLBACK"); return err(res, 404, "APPLICATION_NOT_FOUND", "No application exists with the given ID."); }
    if (application.status !== "IN_PROGRESS" || application.current_stage_index < application.stages.length) {
      await client.query("ROLLBACK");
      return err(res, 409, "NOT_READY", "This application has not cleared all department stages yet.");
    }

    const seq = await client.query("SELECT nextval('certificate_number_seq') AS n");
    const certNumber = "UNIV/BC/" + new Date().getFullYear() + "/" + String(seq.rows[0].n).padStart(6, "0");
    const qrToken = crypto.randomBytes(8).toString("hex");

    const certRes = await client.query(
      `INSERT INTO certificates
        (application_id, certificate_number, cert_type_id, qr_verification_token, issued_by_user_id,
         registrar_signature_data, registrar_seal_data, signature_position, seal_position,
         signed_at, notified_at, notification_channel)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),now(),'EMAIL') RETURNING *`,
      [application.application_id, certNumber, application.cert_type_id, qrToken, req.auth.userId, signatureImageBase64,
       sealImageBase64 || null,
       JSON.stringify(signaturePosition || { top: 78, left: 8 }),
       JSON.stringify(sealPosition || { top: 70, left: 60 })]
    );
    const cert = certRes.rows[0];

    await client.query(
      "UPDATE applications SET status = 'ISSUED', assigned_reviewer_id = $1, level_entered_at = now() WHERE application_id = $2",
      [req.auth.userId, application.application_id]
    );
    await client.query(
      "INSERT INTO activity_logs (application_id, actor_user_id, actor_name, actor_role, action, from_stage, to_stage, note) VALUES ($1,$2,$3,$4,'ISSUED','REGISTRAR','REGISTRAR',$5)",
      [application.application_id, req.auth.userId, req.auth.name, req.auth.role, "Certificate " + certNumber + " signed and issued by " + req.auth.name + " (Registrar Admin)"]
    );
    await client.query("COMMIT");

    const draft = application.certificate_draft || defaultCertificateDraft(application, application.fee_snapshot || { fees: [] });
    const mergedApp = Object.assign({}, application, {
      student_name: draft.studentName || application.student_name,
      program: draft.programName || application.program,
      residency: draft.residency || application.residency
    });
    const html = renderCertificateHtml(mergedApp, cert);

    // Notification hook is real; only the email transport is a stub — no
    // SMTP provider connected yet (see README "known gaps").
    console.log("[notify] certificate issued email queued for", application.student_sdmis_id, "->", certNumber);

    res.status(201).json({
      certificate: cert,
      html,
      downloadUrl: "/api/registrar/certificates/" + cert.certificate_id + "/render",
      notificationQueued: true
    });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    err(res, 500, "SERVER_ERROR", "Could not issue the certificate.");
  } finally {
    client.release();
  }
});

app.get("/api/registrar/certificates", requireAuth, requireRole("registrar_admin", "super_admin"), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.*, a.student_name, a.application_code, ct.label AS cert_type_label
     FROM certificates c
     JOIN applications a ON a.application_id = c.application_id
     JOIN certificate_types ct ON ct.cert_type_id = c.cert_type_id
     ORDER BY c.issued_at DESC LIMIT 100`
  );
  res.json(rows);
});

app.post("/api/registrar/certificates/:id/revoke", requireAuth, requireRole("registrar_admin", "super_admin"), async (req, res) => {
  const { reason } = req.body || {};
  if (!reason) return err(res, 422, "REASON_REQUIRED", "A reason is required to revoke a certificate.");
  await pool.query(
    "UPDATE certificates SET revoked = true, revoked_at = now(), revoked_reason = $1 WHERE certificate_id = $2",
    [reason, req.params.id]
  );
  res.json({ ok: true });
});

// Re-render a previously issued certificate (e.g. to reprint)
app.get("/api/registrar/certificates/:id/render", requireAuth, requireRole("registrar_admin", "super_admin"), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.*, a.*, ct.code AS cert_type_code, ct.label AS cert_type_label
     FROM certificates c
     JOIN applications a ON a.application_id = c.application_id
     JOIN certificate_types ct ON ct.cert_type_id = c.cert_type_id
     WHERE c.certificate_id = $1`,
    [req.params.id]
  );
  const row = rows[0];
  if (!row) return err(res, 404, "CERTIFICATE_NOT_FOUND", "No certificate exists with the given ID.");
  const html = renderCertificateHtml(row, row);
  res.json({ html, registrarSignatureData: row.registrar_signature_data });
});

// ============================================================
// PUBLIC BRANDING — logo + theme, safe to show before login
// ============================================================
app.get("/api/public/branding", async (req, res) => {
  const { rows } = await pool.query("SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('app_logo_data','theme')");
  const out = {};
  rows.forEach((r) => { out[r.setting_key] = r.setting_value; });
  res.json(out);
});

// ============================================================
// PUBLIC VERIFICATION — no auth
// ============================================================
app.get("/api/certificates/verify", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return err(res, 400, "MISSING_QUERY", "Pass ?q=<certificate number or token>.");
  const { rows } = await pool.query(
    `SELECT c.certificate_number, c.qr_verification_token, c.issued_at, c.revoked,
            a.student_name, ct.label AS cert_type_label
     FROM certificates c
     JOIN applications a ON a.application_id = c.application_id
     JOIN certificate_types ct ON ct.cert_type_id = c.cert_type_id
     WHERE c.certificate_number = $1 OR c.qr_verification_token = $1`,
    [q]
  );
  const cert = rows[0];
  if (!cert || cert.revoked) return res.json({ genuine: false });
  const parts = cert.student_name.trim().split(/\s+/);
  const maskedName = parts[0] + " " + parts[parts.length - 1][0] + ".";
  res.json({
    genuine: true,
    certificateNumber: cert.certificate_number,
    certificateType: cert.cert_type_label,
    holder: maskedName,
    issuedAt: cert.issued_at
  });
});

// ============================================================
// USER & ROLE MANAGEMENT — Super Admin only
// ============================================================
app.get("/api/roles", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM roles ORDER BY role_code");
  res.json(rows);
});

app.get("/api/users", requireAuth, requireRole("super_admin"), async (req, res) => {
  const { rows } = await pool.query(
    "SELECT user_id, username, name, role_code, active, created_at FROM users ORDER BY created_at ASC"
  );
  res.json(rows);
});

app.post("/api/users", requireAuth, requireRole("super_admin"), async (req, res) => {
  const { username, password, name, roleCode, schoolId } = req.body || {};
  if (!username || !password || !name || !roleCode) return err(res, 400, "MISSING_FIELDS", "username, password, name, and roleCode are required.");
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      "INSERT INTO users (username, password_hash, name, role_code, school_id) VALUES ($1,$2,$3,$4,$5) RETURNING user_id, username, name, role_code, active, school_id",
      [username, hash, name, roleCode, schoolId || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === "23505") return err(res, 409, "USERNAME_TAKEN", "That username is already in use.");
    console.error(e);
    err(res, 500, "SERVER_ERROR", "Could not create the user.");
  }
});

app.patch("/api/users/:id", requireAuth, requireRole("super_admin"), async (req, res) => {
  if (req.params.id === req.auth.userId) {
    return err(res, 409, "CANNOT_MODIFY_SELF", "You cannot change your own role or active status.");
  }
  const { roleCode, active } = req.body || {};
  const sets = [], vals = [];
  if (roleCode !== undefined) { vals.push(roleCode); sets.push("role_code = $" + vals.length); }
  if (active !== undefined) { vals.push(active); sets.push("active = $" + vals.length); }
  if (!sets.length) return err(res, 400, "NO_FIELDS", "Nothing to update.");
  vals.push(req.params.id);
  const { rows } = await pool.query(
    `UPDATE users SET ${sets.join(", ")} WHERE user_id = $${vals.length} RETURNING user_id, username, name, role_code, active`,
    vals
  );
  if (!rows[0]) return err(res, 404, "USER_NOT_FOUND", "No user exists with the given ID.");
  res.json(rows[0]);
});

// ============================================================
// STUDENT ACCOUNT PROVISIONING — bulk import + SDMIS sync
// ============================================================
// Human-facing bulk import from the Users & Roles screen (Super Admin only).
// Body: { students: [{ email, name, studentSdmisId, program, schoolDept, residency }, ...] }
// New accounts get a generated temporary password and must change it on
// first login; existing accounts (matched by email) have their profile
// fields refreshed but their password is left untouched.
app.post("/api/admin/students/bulk-import", requireAuth, requireRole("super_admin"), async (req, res) => {
  const students = (req.body && req.body.students) || [];
  if (!Array.isArray(students) || !students.length) return err(res, 400, "MISSING_STUDENTS", "Provide a non-empty students array.");
  const client = await pool.connect();
  try {
    const result = await bulkUpsertStudents(client, students);
    res.json(result);
  } catch (e) {
    console.error(e);
    err(res, 500, "SERVER_ERROR", "Bulk import failed.");
  } finally {
    client.release();
  }
});

// Machine-to-machine endpoint for the SDMIS side of a deployment: point an
// export job or migration script here to provision/refresh the real student
// roster, instead of using the human bulk-import screen. Authenticated by
// the INTEGRATION_API_KEY env var (header: X-API-Key), not a user session.
// Same request/response shape as the route above.
app.post("/api/integrations/students/sync", requireApiKey, async (req, res) => {
  const students = (req.body && req.body.students) || [];
  if (!Array.isArray(students) || !students.length) return err(res, 400, "MISSING_STUDENTS", "Provide a non-empty students array.");
  const client = await pool.connect();
  try {
    const result = await bulkUpsertStudents(client, students);
    res.json(result);
  } catch (e) {
    console.error(e);
    err(res, 500, "SERVER_ERROR", "Bulk sync failed.");
  } finally {
    client.release();
  }
});

// Excel version of the bulk-import screen — same validation/tagging as the
// JSON route, just parses an uploaded .xlsx first. Expected header row:
// email, name, studentSdmisId, program, schoolDept, residency (any order,
// case-insensitive; unrecognized columns are ignored).
app.post("/api/admin/students/bulk-import-excel", requireAuth, requireRole("super_admin"), upload.single("file"), async (req, res) => {
  if (!req.file) return err(res, 400, "MISSING_FILE", "Attach an .xlsx file under the 'file' field.");
  let rows;
  try {
    const wb = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  } catch (e) {
    return err(res, 422, "UNREADABLE_FILE", "Could not read that file as an Excel spreadsheet.");
  }
  const keyMap = { email: "email", name: "name", studentsdmisid: "studentSdmisId", studentid: "studentSdmisId",
    program: "program", schooldept: "schoolDept", school: "schoolDept", residency: "residency" };
  const students = rows.map((row) => {
    const out = {};
    Object.keys(row).forEach((k) => {
      const mapped = keyMap[k.trim().toLowerCase().replace(/[\s_]/g, "")];
      if (mapped) out[mapped] = String(row[k]).trim();
    });
    return out;
  }).filter((s) => s.email);
  if (!students.length) return err(res, 422, "NO_ROWS", "No rows with an email column were found in that file.");

  const client = await pool.connect();
  try {
    const result = await bulkUpsertStudents(client, students);
    res.json(result);
  } catch (e) {
    console.error(e);
    err(res, 500, "SERVER_ERROR", "Bulk import failed.");
  } finally {
    client.release();
  }
});

// ============================================================
// SCHOOLS & PROGRAMMES
// ============================================================
app.get("/api/schools", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM schools WHERE is_active = true ORDER BY name");
  res.json(rows);
});

app.post("/api/schools", requireAuth, requireRole("super_admin"), async (req, res) => {
  const { code, name, programmes } = req.body || {};
  if (!code || !name) return err(res, 400, "MISSING_FIELDS", "code and name are required.");
  try {
    const { rows } = await pool.query(
      "INSERT INTO schools (code, name, programmes) VALUES ($1,$2,$3) RETURNING *",
      [code, name, JSON.stringify(Array.isArray(programmes) ? programmes : [])]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === "23505") return err(res, 409, "CODE_TAKEN", "A school with that code already exists.");
    console.error(e);
    err(res, 500, "SERVER_ERROR", "Could not create the school.");
  }
});

app.patch("/api/schools/:id", requireAuth, requireRole("super_admin"), async (req, res) => {
  const { name, programmes, isActive } = req.body || {};
  const sets = [], vals = [];
  if (name !== undefined) { vals.push(name); sets.push("name = $" + vals.length); }
  if (programmes !== undefined) { vals.push(JSON.stringify(programmes)); sets.push("programmes = $" + vals.length); }
  if (isActive !== undefined) { vals.push(isActive); sets.push("is_active = $" + vals.length); }
  if (!sets.length) return err(res, 400, "NO_FIELDS", "Nothing to update.");
  vals.push(req.params.id);
  const { rows } = await pool.query(`UPDATE schools SET ${sets.join(", ")} WHERE school_id = $${vals.length} RETURNING *`, vals);
  if (!rows[0]) return err(res, 404, "SCHOOL_NOT_FOUND", "No school exists with the given ID.");
  res.json(rows[0]);
});

// ============================================================
// APP SETTINGS — logo, letterhead override, theme (Super Admin writes, everyone reads)
// ============================================================
const PUBLIC_SETTING_KEYS = ["app_logo_data", "letterhead_header_data", "letterhead_footer_data", "theme"];

app.get("/api/settings", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT setting_key, setting_value FROM app_settings WHERE setting_key = ANY($1)", [PUBLIC_SETTING_KEYS]);
  const out = {};
  rows.forEach((r) => { out[r.setting_key] = r.setting_value; });
  res.json(out);
});

app.put("/api/settings/:key", requireAuth, requireRole("super_admin"), async (req, res) => {
  const key = req.params.key;
  if (PUBLIC_SETTING_KEYS.indexOf(key) === -1) return err(res, 400, "UNKNOWN_SETTING", "Not a recognized setting key.");
  const { value } = req.body || {};
  await pool.query(
    `INSERT INTO app_settings (setting_key, setting_value, updated_by, updated_at) VALUES ($1,$2,$3,now())
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, value == null ? null : String(value), req.auth.userId]
  );
  res.json({ ok: true });
});

// ============================================================
// CONSOLIDATED APPLICATION RECORDS — School (own school) & Registrar (all)
// ============================================================
async function fetchConsolidatedApplications(schoolId) {
  const params = [];
  let clause = "";
  if (schoolId) { params.push(schoolId); clause = "WHERE a.school_id = $1"; }
  const { rows } = await pool.query(
    `SELECT a.application_code, a.student_name, a.student_sdmis_id, a.program, a.school_dept, a.status,
            a.current_stage_index, a.stages, a.created_at, a.updated_at,
            ct.label AS cert_type_label, c.certificate_number, c.issued_at
     FROM applications a
     JOIN certificate_types ct ON ct.cert_type_id = a.cert_type_id
     LEFT JOIN certificates c ON c.application_id = a.application_id
     ${clause}
     ORDER BY a.created_at DESC`,
    params
  );
  return rows.map((r) => Object.assign({}, r, { currentLevel: currentLevelOf(r) }));
}

app.get("/api/department/applications/all", requireAuth, async (req, res) => {
  if (DEPARTMENT_ROLES.indexOf(req.auth.role) === -1 && req.auth.role !== "super_admin") {
    return err(res, 403, "FORBIDDEN", "Only department reviewers can view the consolidated list.");
  }
  let schoolId = null;
  if (req.auth.role === "school_admin") {
    const ur = await pool.query("SELECT school_id FROM users WHERE user_id = $1", [req.auth.userId]);
    schoolId = ur.rows[0] ? ur.rows[0].school_id : null;
  } else if (req.query.schoolId) {
    schoolId = req.query.schoolId;
  }
  res.json(await fetchConsolidatedApplications(schoolId));
});

app.get("/api/registrar/applications/all", requireAuth, requireRole("registrar_admin", "super_admin"), async (req, res) => {
  res.json(await fetchConsolidatedApplications(req.query.schoolId || null));
});

function rowsToWorkbookBuffer(rows) {
  const flat = rows.map((r) => ({
    "Application": r.application_code,
    "Student": r.student_name,
    "SDMIS ID": r.student_sdmis_id,
    "Programme": r.program,
    "School": r.school_dept,
    "Certificate Type": r.cert_type_label,
    "Status": r.status,
    "Current Level": r.currentLevel,
    "Certificate No.": r.certificate_number || "",
    "Submitted": r.created_at ? new Date(r.created_at).toISOString() : "",
    "Last Updated": r.updated_at ? new Date(r.updated_at).toISOString() : ""
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(flat);
  XLSX.utils.book_append_sheet(wb, ws, "Applications");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

app.get("/api/department/applications/export.xlsx", requireAuth, async (req, res) => {
  if (DEPARTMENT_ROLES.indexOf(req.auth.role) === -1 && req.auth.role !== "super_admin") {
    return err(res, 403, "FORBIDDEN", "Only department reviewers can export this list.");
  }
  let schoolId = null;
  if (req.auth.role === "school_admin") {
    const ur = await pool.query("SELECT school_id FROM users WHERE user_id = $1", [req.auth.userId]);
    schoolId = ur.rows[0] ? ur.rows[0].school_id : null;
  } else if (req.query.schoolId) {
    schoolId = req.query.schoolId;
  }
  const rows = await fetchConsolidatedApplications(schoolId);
  const buf = rowsToWorkbookBuffer(rows);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", "attachment; filename=applications.xlsx");
  res.send(buf);
});

app.get("/api/registrar/applications/export.xlsx", requireAuth, requireRole("registrar_admin", "super_admin"), async (req, res) => {
  const rows = await fetchConsolidatedApplications(req.query.schoolId || null);
  const buf = rowsToWorkbookBuffer(rows);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", "attachment; filename=applications.xlsx");
  res.send(buf);
});

// ============================================================
// STUDENT CERTIFICATE DOWNLOAD (the piece missing from the student dashboard)
// ============================================================
app.get("/api/applications/:id/certificate", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.*, a.*, ct.code AS cert_type_code, ct.label AS cert_type_label
     FROM certificates c
     JOIN applications a ON a.application_id = c.application_id
     JOIN certificate_types ct ON ct.cert_type_id = a.cert_type_id
     WHERE a.application_id = $1`,
    [req.params.id]
  );
  const row = rows[0];
  if (!row) return err(res, 404, "CERTIFICATE_NOT_FOUND", "This application has no issued certificate yet.");
  if (req.auth.role === "student" && row.student_user_id !== req.auth.userId) {
    return err(res, 403, "FORBIDDEN", "You can only download your own certificates.");
  }
  const html = renderCertificateHtml(row, row);
  res.json({
    html,
    certificateNumber: row.certificate_number,
    qrToken: row.qr_verification_token,
    registrarSignatureData: row.registrar_signature_data,
    registrarSealData: row.registrar_seal_data,
    signaturePosition: row.signature_position,
    sealPosition: row.seal_position
  });
});

// ============================================================
// STATIC FRONTEND
// ============================================================
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return err(res, 404, "NOT_FOUND", "No such API route.");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Bonafide Certificate System listening on port " + PORT));
