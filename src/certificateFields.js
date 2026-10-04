// src/certificateFields.js
//
// Single source of truth for every blank on the 10 certificate templates.
// Each field declares WHERE its value comes from. The renderers in
// certificateTemplates.js never hard-code a value: they ask for a field by key,
// and get either the resolved text or a highlighted, clearly-marked blank
// (<mark class="blank" data-field="key">) that a human fills in the editor.
//
// Source kinds (shown in the field audit):
//   application  - the applications row (name, enrolment no., programme)
//   student      - users.profile_data (SDMIS sync / bulk import / Super Admin)
//   programme    - programmes.duration_years
//   request      - applications.request_details (entered by the student)
//   settings     - app_settings (university-level constants, Super Admin)
//   fees         - users.tuition_fee_amount (only when a REAL amount is on file)
//   derived      - computed from another field (e.g. batch "2023-2027")
//   issuance     - assigned when the Registrar issues (cert no., date, QR token)

const ORD_SUFFIX = ["th", "st", "nd", "rd"];
function ordinal(n) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 1 || v > 12) return null;
  const mod100 = v % 100;
  const suffix = ORD_SUFFIX[(mod100 - 20) % 10] || ORD_SUFFIX[mod100] || ORD_SUFFIX[0];
  return v + suffix;
}
const NUM_WORDS = { 1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six" };

function clean(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

// "2023-2027" or "2023-27" -> { start: 2023, end: 2027 }
function parseBatch(batch) {
  const m = String(batch || "").match(/(\d{4})\s*[-\u2013/]\s*(\d{2,4})/);
  if (!m) return null;
  const start = Number(m[1]);
  let end = Number(m[2]);
  if (m[2].length === 2) end = Math.floor(start / 100) * 100 + end;
  return { start, end };
}

function normGender(g) {
  const s = String(g || "").trim().toLowerCase();
  if (s === "m" || s === "male" || s === "man") return "M";
  if (s === "f" || s === "female" || s === "woman") return "F";
  return null;
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function inr(n) {
  return Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

// ---------------------------------------------------------------------------
// Registry. `placeholder` is what the blank shows until someone fills it in.
// `c` is the resolution context: { application, student, profile, programme,
// settings, details, feeSnapshot }.
// ---------------------------------------------------------------------------
const FIELDS = [
  // ---- identity (always present) ----
  { key: "student_name", label: "Student name", placeholder: "(Student Name)", kind: "application", source: "applications.student_name",
    resolve: (c) => clean(c.application.student_name) },
  { key: "enrolment_no", label: "Enrolment / Student ID", placeholder: "(Student ID)", kind: "application", source: "applications.student_sdmis_id",
    resolve: (c) => clean(c.application.student_sdmis_id) },
  { key: "programme_name", label: "Programme name", placeholder: "(Programme Name)", kind: "application", source: "applications.program (validated against programmes)",
    resolve: (c) => clean(c.application.program) },

  // ---- honorific + pronouns ----
  { key: "honorific", label: "Mr./Ms.", placeholder: "Mr./Ms.", kind: "student", source: "users.profile_data.gender",
    resolve: (c) => ({ M: "Mr.", F: "Ms." })[normGender(c.profile.gender)] || null },
  { key: "he_cap", label: "He/She", placeholder: "He/She", kind: "student", source: "users.profile_data.gender",
    resolve: (c) => ({ M: "He", F: "She" })[normGender(c.profile.gender)] || null },
  { key: "he", label: "he/she", placeholder: "he/she", kind: "student", source: "users.profile_data.gender",
    resolve: (c) => ({ M: "he", F: "she" })[normGender(c.profile.gender)] || null },
  { key: "his_cap", label: "His/Her", placeholder: "His/Her", kind: "student", source: "users.profile_data.gender",
    resolve: (c) => ({ M: "His", F: "Her" })[normGender(c.profile.gender)] || null },
  { key: "his", label: "his/her", placeholder: "his/her", kind: "student", source: "users.profile_data.gender",
    resolve: (c) => ({ M: "his", F: "her" })[normGender(c.profile.gender)] || null },
  { key: "him", label: "him/her", placeholder: "him/her", kind: "student", source: "users.profile_data.gender",
    resolve: (c) => ({ M: "him", F: "her" })[normGender(c.profile.gender)] || null },

  // ---- programme + batch ----
  { key: "batch", label: "Batch", placeholder: "(Batch)", kind: "student", source: "users.batch",
    resolve: (c) => clean(c.application.batch) || clean(c.student.batch) },
  { key: "programme_years", label: "Programme length (years)", placeholder: "(4/5)", kind: "programme", source: "programmes.duration_years",
    resolve: (c) => (c.programme && c.programme.duration_years ? String(c.programme.duration_years) : null) },
  { key: "programme_years_word", label: "Programme length (four/five)", placeholder: "(four/five)", kind: "programme", source: "programmes.duration_years",
    resolve: (c) => (c.programme && NUM_WORDS[c.programme.duration_years]) || null },
  { key: "programme_semesters", label: "Number of semesters", placeholder: "(08/10)", kind: "programme", source: "programmes.duration_years x 2",
    resolve: (c) => (c.programme && c.programme.duration_years ? String(c.programme.duration_years * 2).padStart(2, "0") : null) },
  { key: "current_semester", label: "Current semester", placeholder: "(1st\u201310th)", kind: "student", source: "users.profile_data.current_semester",
    resolve: (c) => ordinal(c.profile.current_semester) || clean(c.profile.current_semester) },
  { key: "completed_semester", label: "Last completed semester", placeholder: "(____)", kind: "student", source: "users.profile_data.completed_semester",
    resolve: (c) => ordinal(c.profile.completed_semester) || clean(c.profile.completed_semester) },

  // ---- admission / completion ----
  { key: "admission_month_year", label: "Admission (Month/Year)", placeholder: "(Month/Year)", kind: "student", source: "users.profile_data.admission_month_year",
    resolve: (c) => clean(c.profile.admission_month_year) },
  { key: "completion_month_year", label: "Completion (Month/Year)", placeholder: "(Completion Month/Year)", kind: "student", source: "users.profile_data.completion_month_year",
    resolve: (c) => clean(c.profile.completion_month_year) },
  { key: "completion_year", label: "Year of completion", placeholder: "(Year of Completion)", kind: "student", source: "users.profile_data.completion_year (else batch end year)",
    resolve: (c) => clean(c.profile.completion_year) || (parseBatch(c.application.batch || c.student.batch) || {}).end || null },
  { key: "foundation_batch", label: "Foundation batch / joining year", placeholder: "(Foundation Batch)", kind: "student", source: "users.profile_data.foundation_batch (else derived from batch)",
    resolve: (c) => {
      if (clean(c.profile.foundation_batch)) return clean(c.profile.foundation_batch);
      const b = parseBatch(c.application.batch || c.student.batch);
      return b ? b.start + "-" + String(b.start + 1).slice(2) : null;
    } },
  { key: "admission_academic_year", label: "Academic year of admission", placeholder: "(20__)", kind: "student", source: "users.profile_data.admission_academic_year (else derived from batch)",
    resolve: (c) => {
      if (clean(c.profile.admission_academic_year)) return clean(c.profile.admission_academic_year);
      const b = parseBatch(c.application.batch || c.student.batch);
      return b ? b.start + "-" + String(b.start + 1).slice(2) : null;
    } },
  { key: "admission_route", label: "Admitted through (NATA/ACPC/ADEPT)", placeholder: "(NATA/ACPC/ADEPT)", kind: "student", source: "users.profile_data.admission_route",
    resolve: (c) => clean(c.profile.admission_route) },

  // ---- academic record ----
  { key: "cgpa", label: "CGPA", placeholder: "(CGPA)", kind: "student", source: "users.profile_data.cgpa",
    resolve: (c) => clean(c.profile.cgpa) },
  { key: "cgpa_scale", label: "CGPA out of", placeholder: "(____)", kind: "student", source: "users.profile_data.cgpa_scale (else app_settings.cgpa_scale)",
    resolve: (c) => clean(c.profile.cgpa_scale) || clean(c.settings.cgpa_scale) },
  { key: "abc_id", label: "ABC / NAD / APAAR ID", placeholder: "(ID No.)", kind: "student", source: "users.profile_data.abc_id",
    resolve: (c) => clean(c.profile.abc_id) },

  // ---- residence ----
  { key: "address", label: "Current address", placeholder: "(Address)", kind: "student", source: "users.profile_data.address",
    resolve: (c) => clean(c.profile.address) },
  { key: "hostel_since", label: "Residing in hostel since", placeholder: "(Month/Year)", kind: "student", source: "users.profile_data.hostel_since",
    resolve: (c) => clean(c.profile.hostel_since) },

  // ---- per-request details the student enters (VISA) ----
  { key: "visa_country", label: "Country of travel", placeholder: "(Country)", kind: "request", source: "applications.request_details.country",
    resolve: (c) => clean(c.details.country) },
  { key: "visa_event", label: "Programme / event name", placeholder: "(Programme/Event Name)", kind: "request", source: "applications.request_details.eventName",
    resolve: (c) => clean(c.details.eventName) },
  { key: "visa_dates", label: "Travel dates", placeholder: "(Date range)", kind: "request", source: "applications.request_details.dateFrom / dateTo",
    resolve: (c) => {
      const a = clean(c.details.dateFrom) && fmtDate(c.details.dateFrom);
      const b = clean(c.details.dateTo) && fmtDate(c.details.dateTo);
      return a && b ? a + " to " + b : null;
    } },
  { key: "visa_sponsorship", label: "Sponsored / Non-Sponsored", placeholder: "(Sponsored / Non-Sponsored)", kind: "request", source: "applications.request_details.sponsorship",
    resolve: (c) => ({ SPONSORED: "Sponsored", NON_SPONSORED: "Non-Sponsored" })[String(c.details.sponsorship || "").toUpperCase()] || null },

  // ---- fees / financial aid ----
  { key: "fin_aid_percent", label: "Scholarship / financial aid %", placeholder: "(percentage %)", kind: "student", source: "users.profile_data.financial_aid_percent",
    resolve: (c) => (clean(c.profile.financial_aid_percent) ? clean(c.profile.financial_aid_percent).replace(/\s*%?$/, "%") : null) },
  { key: "fee_structure", label: "Fee table (Autogenerated cells)", placeholder: "(Autogenerated)", kind: "fees",
    source: "fee_structures (programme + batch; scholarship % from users.profile_data.financial_aid_percent; residence from the student's residency)",
    resolve: () => null },
  { key: "tuition_fee_inr", label: "Tuition fee paid (INR)", placeholder: "(Tuition fee in INR)", kind: "fees", source: "users.tuition_fee_amount (real value only; the 185000 demo default is NOT used)",
    resolve: (c) => {
      if (c.student.tuition_fee_amount == null) return null;
      const fee = ((c.feeSnapshot && c.feeSnapshot.fees) || [])[0];
      return "INR " + inr(c.student.tuition_fee_amount) + (fee && fee.amountInWords ? " (" + fee.amountInWords + ")" : "");
    } },

  // ---- university constants (Super Admin edits in app_settings) ----
  { key: "bank_account_number", label: "University bank account number", placeholder: "(Account Number)", kind: "settings", source: "app_settings.bank_account_number (default: from the bank-loan templates)",
    resolve: (c) => clean(c.settings.bank_account_number) || "918010043537915" },
  { key: "bank_ifsc", label: "University bank IFSC", placeholder: "(IFSC Code)", kind: "settings", source: "app_settings.bank_ifsc (default: from the bank-loan templates)",
    resolve: (c) => clean(c.settings.bank_ifsc) || "UTIB0000878" },
  { key: "bank_name", label: "Bank", placeholder: "(Bank)", kind: "settings", source: "app_settings.bank_name (default: Axis Bank)",
    resolve: (c) => clean(c.settings.bank_name) || "Axis Bank" },
  { key: "bank_branch", label: "Bank branch", placeholder: "(Branch)", kind: "settings", source: "app_settings.bank_branch (default: Bopal, Ahmedabad)",
    resolve: (c) => clean(c.settings.bank_branch) || "Bopal, Ahmedabad" },
  { key: "bank_branch_code", label: "Bank branch code", placeholder: "(Branch code)", kind: "settings", source: "app_settings.bank_branch_code (default: 878)",
    resolve: (c) => clean(c.settings.bank_branch_code) || "878" },
  { key: "mysy_notify_email", label: "MYSY notification e-mail", placeholder: "(MYSY e-mail)", kind: "settings", source: "app_settings.mysy_notify_email (default per template)",
    resolve: (c) => clean(c.settings.mysy_notify_email) || "mysy-kcg@gujgov.edu.in" },
  { key: "registry_email", label: "Registry e-mail (cc)", placeholder: "(Registry e-mail)", kind: "settings", source: "app_settings.registry_email (default per template)",
    resolve: (c) => clean(c.settings.registry_email) || "ro@anu.edu.in" }
];

// ADEPT score table is structured, so it is handled separately from FIELDS.
// users.profile_data.adept_scores = [{ mcq, situation, interview, total }, ...]  (the template has two score rows).
const ADEPT_FIELD = {
  key: "adept_scores", label: "ADEPT score sheet", placeholder: "(ADEPT scores)", kind: "student",
  source: "users.profile_data.adept_scores"
};

// Profile keys a student record may carry (used by bulk import / sync / Super Admin edit).
const PROFILE_KEYS = [
  "gender", "admission_month_year", "admission_academic_year", "admission_route", "completion_month_year",
  "completion_year", "completed_semester", "current_semester", "foundation_batch", "cgpa", "cgpa_scale",
  "abc_id", "address", "hostel_since", "financial_aid_percent", "adept_scores"
];

function normaliseAdept(a) {
  if (!a) return null;
  const list = Array.isArray(a) ? a : (typeof a === "object" ? [a] : []);
  const out = [];
  list.forEach((r) => {
    if (!r || typeof r !== "object") return;
    const row = { mcq: clean(r.mcq), situation: clean(r.situation), interview: clean(r.interview), total: clean(r.total) };
    if (row.mcq || row.situation || row.interview || row.total) out.push(row);
  });
  return out.length ? out.slice(0, 2) : null;
}

// Rows for "Year 1..N". Fee rows: the student's batch wins over the all-batches row.
function money(n) { return n === null || n === undefined || n === "" || isNaN(Number(n)) ? null : Number(n); }
function buildFeeTable(feeRows, c) {
  const batch = clean(c.application.batch) || clean(c.student.batch);
  const years = {};
  feeRows.forEach((r) => {
    const exact = r.batch && batch && r.batch === batch;
    if (!r.batch || exact) {
      const cur = years[r.year_no];
      if (!cur || (exact && !cur._exact)) years[r.year_no] = Object.assign({}, r, { _exact: !!exact });
    }
  });
  const duration = c.programme && c.programme.duration_years ? Number(c.programme.duration_years) : null;
  const maxData = Math.max(0, ...Object.keys(years).map(Number));
  const n = duration || maxData || 4;
  const pctRaw = clean(c.profile.financial_aid_percent);
  const pct = pctRaw !== null && !isNaN(parseFloat(pctRaw)) ? parseFloat(pctRaw) : null;
  const dayScholar = /day/i.test(String(c.application.residency || c.student.residency || ""));
  const rows = [];
  for (let y = 1; y <= n; y++) {
    const r = years[y];
    const ts = r ? money(r.tuition_semester) : null;
    const ty = r ? (money(r.tuition_year) !== null ? money(r.tuition_year) : (ts !== null ? ts * 2 : null)) : null;
    const rs = r ? money(r.residence_semester) : null;
    const ry = r ? (money(r.residence_year) !== null ? money(r.residence_year) : (rs !== null ? rs * 2 : null)) : null;
    const after = (v) => (v === null || pct === null ? null : Math.round(v * (1 - pct / 100)));
    rows.push({ year: y, tuitionSem: ts, tuitionSemAfter: after(ts), tuitionYear: ty, tuitionYearAfter: after(ty), resSem: rs, resYear: ry });
  }
  return { rows, pct, dayScholar };
}

const BY_KEY = {};
FIELDS.forEach((f) => { BY_KEY[f.key] = f; });
BY_KEY[ADEPT_FIELD.key] = ADEPT_FIELD;

// Build the resolution context.  Everything comes from rows the server already
// loaded; this module does no I/O so it is trivial to unit-test.
function resolveAll(input) {
  const c = {
    application: input.application || {},
    student: input.student || {},
    profile: (input.student && input.student.profile_data) || {},
    programme: input.programme || null,
    settings: input.settings || {},
    details: (input.application && input.application.request_details) || {},
    feeSnapshot: input.feeSnapshot || null
  };
  const values = {};
  FIELDS.forEach((f) => {
    let v = null;
    try { v = f.resolve(c); } catch (e) { v = null; }
    values[f.key] = v === null || v === undefined || v === "" ? null : String(v);
  });
  // ADEPT scores: array of up to two sittings [{mcq, situation, interview, total}, ...] (or null)
  values.adept_scores = normaliseAdept(c.profile.adept_scores);
  // Fee table for the bank-loan templates (structured; rendered by certificateTemplates.js)
  values.fee_table = buildFeeTable(input.feeRows || [], c);
  return values;
}

module.exports = { FIELDS, BY_KEY, ADEPT_FIELD, PROFILE_KEYS, resolveAll, ordinal, parseBatch, normGender, normaliseAdept };
