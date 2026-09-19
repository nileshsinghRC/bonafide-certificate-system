// server.js
require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");

const { pool } = require("./src/db");
const { signToken, requireAuth, requireRole } = require("./src/auth");
const { renderCertificateHtml } = require("./src/certificateTemplates");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

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

// ============================================================
// AUTH
// ============================================================
app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return err(res, 400, "MISSING_FIELDS", "Username and password are required.");
  try {
    const { rows } = await pool.query("SELECT * FROM users WHERE lower(username) = lower($1)", [username]);
    const user = rows[0];
    if (!user) return err(res, 401, "INVALID_CREDENTIALS", "Incorrect username or password.");
    if (!user.active) return err(res, 403, "ACCOUNT_DEACTIVATED", "This account has been deactivated. Contact a Super Admin.");
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return err(res, 401, "INVALID_CREDENTIALS", "Incorrect username or password.");
    const token = signToken(user);
    res.json({
      token,
      user: {
        id: user.user_id, username: user.username, name: user.name, role: user.role_code,
        studentSdmisId: user.student_sdmis_id, program: user.program, schoolDept: user.school_dept,
        residency: user.residency
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
    residency: user.residency
  });
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
        (application_code, student_user_id, student_name, student_sdmis_id, program, school_dept, residency,
         cert_type_id, stages, current_stage_index, purpose_note, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,'IN_PROGRESS')
       RETURNING *`,
      [code, student.user_id, student.name, student.student_sdmis_id || student.username, student.program,
       student.school_dept, student.residency, certType.cert_type_id, JSON.stringify(stages), purposeNote || null]
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
      "INSERT INTO application_events (application_id, actor_user_id, actor_name, actor_role, action, note) VALUES ($1,$2,$3,$4,'SUBMITTED',$5)",
      [application.application_id, student.user_id, student.name, student.role_code, "Application submitted"]
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

app.get("/api/applications/:id/events", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM application_events WHERE application_id = $1 ORDER BY occurred_at ASC",
    [req.params.id]
  );
  res.json(rows);
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
      "INSERT INTO application_events (application_id, actor_user_id, actor_name, actor_role, action, note) VALUES ($1,$2,$3,$4,'RESUBMITTED',$5)",
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
  if (DEPARTMENT_ROLES.indexOf(req.auth.role) !== -1) {
    dept = Object.keys(STAGE_TO_ROLE).find((k) => STAGE_TO_ROLE[k] === req.auth.role);
  } else if (req.auth.role === "super_admin") {
    dept = req.query.dept;
    if (!dept) return err(res, 400, "MISSING_DEPT", "Pass ?dept=SCHOOL|EXAM|FEES_FINAID|ADMISSION|WARDEN for Super Admin.");
  } else {
    return err(res, 403, "FORBIDDEN", "Your role does not have a department queue.");
  }

  const { rows } = await pool.query(
    `SELECT a.*, ct.code AS cert_type_code, ct.label AS cert_type_label
     FROM applications a JOIN certificate_types ct ON ct.cert_type_id = a.cert_type_id
     WHERE a.status IN ('IN_PROGRESS')
       AND a.current_stage_index < jsonb_array_length(a.stages)
       AND a.stages->>a.current_stage_index::int = $1
     ORDER BY a.created_at ASC`,
    [dept]
  );
  res.json({ dept, applications: rows });
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
      await client.query("UPDATE applications SET current_stage_index = $1 WHERE application_id = $2", [nextIndex, application.application_id]);
      await client.query(
        "INSERT INTO application_events (application_id, actor_user_id, actor_name, actor_role, action, note) VALUES ($1,$2,$3,$4,'STAGE_APPROVED',$5)",
        [application.application_id, req.auth.userId, req.auth.name, req.auth.role,
         (nextIndex >= stages.length ? "Cleared final department stage — forwarded to Registrar" : "Approved by " + actorLine + ", forwarded to next stage")]
      );
    } else if (action === "reject") {
      await client.query("UPDATE applications SET status = 'REJECTED', rejection_reason = $1 WHERE application_id = $2", [reason, application.application_id]);
      await client.query(
        "INSERT INTO application_events (application_id, actor_user_id, actor_name, actor_role, action, note) VALUES ($1,$2,$3,$4,'REJECTED',$5)",
        [application.application_id, req.auth.userId, req.auth.name, req.auth.role, "Rejected by " + actorLine + ": " + reason]
      );
    } else if (action === "request_docs") {
      await client.query("UPDATE applications SET status = 'DOCS_REQUESTED' WHERE application_id = $1", [application.application_id]);
      await client.query(
        "INSERT INTO application_events (application_id, actor_user_id, actor_name, actor_role, action, note) VALUES ($1,$2,$3,$4,'DOCS_REQUESTED',$5)",
        [application.application_id, req.auth.userId, req.auth.name, req.auth.role, "Documents requested by " + actorLine + ": " + reason]
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
  res.json(rows);
});

app.post("/api/registrar/applications/:id/reject", requireAuth, requireRole("registrar_admin", "super_admin"), async (req, res) => {
  const { reason } = req.body || {};
  if (!reason) return err(res, 422, "REASON_REQUIRED", "A reason is required.");
  const client = await pool.connect();
  try {
    const { rows } = await client.query("SELECT * FROM applications WHERE application_id = $1", [req.params.id]);
    const application = rows[0];
    if (!application) return err(res, 404, "APPLICATION_NOT_FOUND", "No application exists with the given ID.");
    await client.query("UPDATE applications SET status = 'REJECTED', rejection_reason = $1 WHERE application_id = $2", [reason, application.application_id]);
    await client.query(
      "INSERT INTO application_events (application_id, actor_user_id, actor_name, actor_role, action, note) VALUES ($1,$2,$3,$4,'REJECTED',$5)",
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

app.post("/api/registrar/applications/:id/generate-certificate", requireAuth, requireRole("registrar_admin", "super_admin"), async (req, res) => {
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
      `INSERT INTO certificates_issued (application_id, certificate_number, cert_type_id, qr_verification_token, issued_by_user_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [application.application_id, certNumber, application.cert_type_id, qrToken, req.auth.userId]
    );
    const cert = certRes.rows[0];

    await client.query("UPDATE applications SET status = 'ISSUED' WHERE application_id = $1", [application.application_id]);
    await client.query(
      "INSERT INTO application_events (application_id, actor_user_id, actor_name, actor_role, action, note) VALUES ($1,$2,$3,$4,'ISSUED',$5)",
      [application.application_id, req.auth.userId, req.auth.name, req.auth.role, "Certificate " + certNumber + " issued by " + req.auth.name + " (Registrar Admin)"]
    );
    await client.query("COMMIT");

    const html = renderCertificateHtml(application, cert);
    res.status(201).json({ certificate: cert, html });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    err(res, 500, "SERVER_ERROR", "Could not generate the certificate.");
  } finally {
    client.release();
  }
});

app.get("/api/registrar/certificates", requireAuth, requireRole("registrar_admin", "super_admin"), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.*, a.student_name, a.application_code, ct.label AS cert_type_label
     FROM certificates_issued c
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
    "UPDATE certificates_issued SET revoked = true, revoked_at = now(), revoked_reason = $1 WHERE certificate_id = $2",
    [reason, req.params.id]
  );
  res.json({ ok: true });
});

// Re-render a previously issued certificate (e.g. to reprint)
app.get("/api/registrar/certificates/:id/render", requireAuth, requireRole("registrar_admin", "super_admin"), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.*, a.*, ct.code AS cert_type_code, ct.label AS cert_type_label
     FROM certificates_issued c
     JOIN applications a ON a.application_id = c.application_id
     JOIN certificate_types ct ON ct.cert_type_id = c.cert_type_id
     WHERE c.certificate_id = $1`,
    [req.params.id]
  );
  const row = rows[0];
  if (!row) return err(res, 404, "CERTIFICATE_NOT_FOUND", "No certificate exists with the given ID.");
  const html = renderCertificateHtml(row, row);
  res.json({ html });
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
     FROM certificates_issued c
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
  const { username, password, name, roleCode } = req.body || {};
  if (!username || !password || !name || !roleCode) return err(res, 400, "MISSING_FIELDS", "username, password, name, and roleCode are required.");
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      "INSERT INTO users (username, password_hash, name, role_code) VALUES ($1,$2,$3,$4) RETURNING user_id, username, name, role_code, active",
      [username, hash, name, roleCode]
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
// STATIC FRONTEND
// ============================================================
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return err(res, 404, "NOT_FOUND", "No such API route.");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Bonafide Certificate System listening on port " + PORT));
