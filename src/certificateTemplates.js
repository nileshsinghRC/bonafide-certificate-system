// src/certificateTemplates.js
//
// Renders the certificate body (an HTML fragment dropped into the letterhead
// view) for each of the 10 certificate types.
//
//   renderCertificateHtml(app, cert, values)
//     app    - the applications row joined with cert_type_code
//     cert   - the issued certificates row, or null while it is still a draft
//     values - resolved field values from certificateFields.resolveAll()
//
// Every blank is requested by field key through F(key). A resolved field prints
// as plain text; an unresolved one prints as a highlighted
// <mark class="blank" data-field="..."> that a human fills in the editor.
// Reference number, issue date and QR token do not exist until the Registrar
// issues, so while drafting they are the text tokens {{CERT_NO}}, {{ISSUE_DATE}}
// and {{QR_TOKEN}}, and the signature / seal are token spans — all replaced by
// certificateHtml.finalizeHtml() at issuance.

const { BY_KEY } = require("./certificateFields");

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

function makeF(values) {
  return function F(key) {
    const def = BY_KEY[key];
    if (!def) throw new Error("Unknown certificate field: " + key);
    const v = values ? values[key] : null;
    if (v && typeof v === "string") return esc(v);
    return (
      '<mark class="blank" data-field="' + key + '" data-ph="' + esc(def.placeholder) + '" title="' +
      esc(def.label + " \u2014 source: " + def.source) + '">' + esc(def.placeholder) + "</mark>"
    );
  };
}

function refDate(cert) {
  var no = cert && cert.certificate_number ? esc(cert.certificate_number) : "{{CERT_NO}}";
  var dt = cert && cert.issued_at
    ? esc(new Date(cert.issued_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }))
    : "{{ISSUE_DATE}}";
  return '<p>Ref: ' + no + '&nbsp;&nbsp;&nbsp;&nbsp;Date: ' + dt + "</p>";
}
function heading(text) {
  return '<h2 class="cert-heading">' + esc(text) + "</h2>";
}

// Signature + seal. Before issuance these are token spans (the Registrar's image
// is composited at issue time); on a re-render of an already-issued certificate
// the stored images are placed directly.
function signatureBlock(cert) {
  var sigStyle = "", sealStyle = "";
  if (cert && cert.signature_position) {
    var sp = cert.signature_position;
    sigStyle = ' style="position:absolute;top:' + (sp.top || 78) + '%;left:' + (sp.left || 8) + '%;max-width:150px;max-height:60px;"';
  }
  if (cert && cert.seal_position) {
    var kp = cert.seal_position;
    sealStyle = ' style="position:absolute;top:' + (kp.top || 70) + '%;left:' + (kp.left || 60) + '%;max-width:110px;max-height:110px;"';
  }
  var sigImg = cert && cert.registrar_signature_data
    ? '<img src="' + esc(cert.registrar_signature_data) + '"' + sigStyle + ' alt="Registrar signature">'
    : '<span class="sig-token" data-token="signature">(E-Signature)</span>';
  var sealImg = cert && cert.registrar_seal_data
    ? '<img src="' + esc(cert.registrar_seal_data) + '"' + sealStyle + ' alt="Official seal">'
    : '<span class="sig-token" data-token="seal">(E-Stamp)</span>';
  return (
    '<div class="sig-marks" style="position:relative;min-height:70px;">' + sigImg + "&nbsp;&nbsp;&nbsp;" + sealImg + "</div>" +
    '<p class="sig-name">Sanjay Bhatnagar</p>' +
    '<p class="sig-title">Registrar</p>'
  );
}
function verificationFooter(cert) {
  var no = cert && cert.certificate_number ? esc(cert.certificate_number) : "{{CERT_NO}}";
  var token = cert && cert.qr_verification_token ? esc(cert.qr_verification_token) : "{{QR_TOKEN}}";
  return (
    '<p class="verify-footer">This certificate is issued digitally and does not require a physical signature. ' +
    "To verify its authenticity, scan the QR code above or visit the verification portal and enter reference " +
    "<strong>" + no + "</strong> (verification token <code>" + token + "</code>).</p>"
  );
}
function typeFooter(label) {
  return '<p class="cert-type-footer">(Type of Certificate: ' + esc(label) + ")</p>";
}

// Shared opening used by most bank / visa / scholarship / research letters:
// "...bearing Student ID No X, is a bonafide student... currently pursuing the
// <semester> semester of the <n>-year <programme> programme for the batch <b>."
function currentlyPursuing(F, pron) {
  return (
    pron + " is currently pursuing the " + F("current_semester") + " semester of the " +
    F("programme_years_word") + "-year " + F("programme_name") + " programme for the batch " + F("batch") + "."
  );
}
function bonafideOpening(F, hePron) {
  return (
    "<p>This is to certify that " + F("honorific") + " " + F("student_name") +
    ", bearing Student ID No " + F("enrolment_no") +
    ", is a bonafide student of Anant National University. " + currentlyPursuing(F, hePron) + "</p>"
  );
}
// ---- Bank-loan templates (5, 6, 7): reproduced from the university's Word templates ----
function inr(n) { return Number(n).toLocaleString("en-IN", { maximumFractionDigits: 0 }); }
function feeBlank(why) {
  var def = BY_KEY.fee_structure;
  return '<mark class="blank" data-field="fee_structure" data-ph="' + esc(def.placeholder) + '" title="' +
    esc(def.label + " \u2014 " + why + " \u2014 source: " + def.source) + '">' + esc(def.placeholder) + "</mark>";
}
function cellValue(v, why) { return v === null || v === undefined ? feeBlank(why) : inr(v); }

// Opening paragraph, word for word from templates 5/6/7.
function bankOpening(F) {
  return '<p style="text-align:justify;">This is to certify that ' + F("honorific") + " " + F("student_name") +
    ", bearing Student ID No " + F("enrolment_no") + " is a bonafide student of Anant National University. " +
    F("he_cap") + " is currently pursuing the " + F("current_semester") + " semester of the " + F("programme_years_word") +
    "-year of the " + F("programme_name") + " programme for the batch " + F("batch") + ".</p>";
}
// "Ref: ......  Date: ......" on one line, Ref left and Date right, as in the templates.
function bankRefDate(cert) {
  var no = cert && cert.certificate_number ? esc(cert.certificate_number) : "{{CERT_NO}}";
  var dt = cert && cert.issued_at
    ? esc(new Date(cert.issued_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }))
    : "{{ISSUE_DATE}}";
  return '<table style="width:100%;border-collapse:collapse;border:0;" border="0"><tbody><tr>' +
    '<td style="border:0;text-align:left;">Ref: ' + no + '</td><td style="border:0;text-align:right;">Date: ' + dt + "</td></tr></tbody></table>";
}
function bankHeading(text) {
  return '<h2 class="cert-heading" style="text-align:center;">' + esc(text) + "</h2>";
}
// Bank account block, word for word. `branchSuffix` keeps the template-5 ";" after the branch.
function bankDetails(F, branchSuffix) {
  return '<p style="margin-bottom:0;"><b>Bank Account Details of the University:</b></p>' +
    "<p>Name of account: Anant National University<br>Account Number: " + F("bank_account_number") +
    "<br>IFSC CODE: " + F("bank_ifsc") + "<br>Bank: " + F("bank_name") +
    "<br>Branch: " + F("bank_branch") + (branchSuffix || "") + "<br>Branch code: " + F("bank_branch_code") + "</p>";
}
function bankTypeLine(label) {
  return '<p class="cert-type-footer" style="text-align:right;margin-top:40px;">' + esc(label) + "</p>";
}
var TD = "border:1px solid #000;padding:2px 4px;text-align:center;vertical-align:middle;font-size:10pt;";
var TH = TD + "font-weight:bold;";
function td(content, extra) { return '<td style="' + TD + (extra || "") + '">' + content + "</td>"; }
function th(content, attrs) { return "<th " + (attrs || "") + ' style="' + TH + '">' + content + "</th>"; }

// Template 5: Year | Tuition fees semester wise (2 cols) | Tuition fees year wise (2 cols) | Residence and mess fee (2 cols)
function feeTableFinAid(F, values) {
  var ft = values.fee_table || { rows: [{ year: 1 }], pct: null, dayScholar: false };
  var after = '<span>After </span>' + F("fin_aid_percent") + " Scholarship";
  var h = '<table style="border-collapse:collapse;width:100%;" border="1"><colgroup><col style="width:9.6%"><col style="width:15.4%"><col style="width:16%"><col style="width:15.4%"><col style="width:15.2%"><col style="width:14.2%"><col style="width:14.2%"></colgroup><tbody>' +
    "<tr>" + th("Year", 'rowspan="2"') + th("Tuition fees semester wise (INR)", 'colspan="2"') +
    th("Tuition fees year wise (INR)", 'colspan="2"') + th("Residence and mess fee (INR)", 'colspan="2"') + "</tr>" +
    "<tr>" + th("Without Scholarship") + th(after) + th("Without Scholarship") + th(after) + th("Semester fees") + th("Yearly fees") + "</tr>";
  ft.rows.forEach(function (r) {
    var res = ft.dayScholar ? ["N/A", "N/A"] : [cellValue(r.resSem, "residence & mess fee, semester"), cellValue(r.resYear, "residence & mess fee, year")];
    h += "<tr>" + td("<b>Year " + r.year + "</b>") +
      td(cellValue(r.tuitionSem, "tuition per semester, year " + r.year)) +
      td(cellValue(r.tuitionSemAfter, "needs the tuition fee and the scholarship %")) +
      td(cellValue(r.tuitionYear, "tuition per year, year " + r.year)) +
      td(cellValue(r.tuitionYearAfter, "needs the tuition fee and the scholarship %")) +
      td(res[0]) + td(res[1]) + "</tr>";
  });
  return h + "</tbody></table>";
}
// Template 6: Year | Tuition sem | Tuition year | Residence & mess sem | Residence & mess year
function feeTableGeneral(F, values) {
  var ft = values.fee_table || { rows: [{ year: 1 }], pct: null, dayScholar: false };
  var h = '<table style="border-collapse:collapse;width:100%;" border="1"><colgroup><col style="width:11%"><col style="width:24%"><col style="width:21.7%"><col style="width:21.7%"><col style="width:21.6%"></colgroup><tbody>' +
    "<tr>" + th("Year") + th("Tuition fees semester wise (INR)") + th("Tuition fees year wise (INR)") +
    th("Residence and mess fee (INR) semester wise") + th("Residence and mess fee (INR) Year wise") + "</tr>";
  ft.rows.forEach(function (r) {
    var res = ft.dayScholar ? ["N/A", "N/A"] : [cellValue(r.resSem, "residence & mess fee, semester"), cellValue(r.resYear, "residence & mess fee, year")];
    h += "<tr>" + td("<b>Year " + r.year + "</b>") + td(cellValue(r.tuitionSem, "tuition per semester, year " + r.year)) +
      td(cellValue(r.tuitionYear, "tuition per year, year " + r.year)) + td(res[0]) + td(res[1]) + "</tr>";
  });
  return h + "</tbody></table>";
}
// Template 7: ADEPT score table. "Score" spans the score rows (the template has two).
function adeptTable(F, values) {
  var rows = values.adept_scores;
  var def = BY_KEY.adept_scores;
  function blank(label) {
    return '<mark class="blank" data-field="adept_scores" data-ph="(Autogenerated)" title="' + esc("ADEPT " + label + " \u2014 source: " + def.source) + '">(Autogenerated)</mark>';
  }
  var list = rows && rows.length ? rows : [null, null];
  var body = "";
  list.forEach(function (r, i) {
    body += "<tr>" + (i === 0 ? '<td style="' + TD + 'width:12%;" rowspan="' + list.length + '">Score</td>' : "") +
      td(r && r.mcq ? esc(r.mcq) : blank("MCQ")) + td(r && r.situation ? esc(r.situation) : blank("Situation Test")) +
      td(r && r.interview ? esc(r.interview) : blank("Interview")) + td(r && r.total ? esc(r.total) : blank("Total score")) + "</tr>";
  });
  return '<table style="border-collapse:collapse;width:90%;margin-left:4%;" border="1"><tbody>' +
    "<tr>" + th("Anant Design Entrance &amp; Proficiency Test (ADEPT)", 'colspan="5"') + "</tr>" +
    "<tr>" + td("Test") + td("MCQ", "text-align:left;") + td("Situation Test", "text-align:left;") + td("Interview", "text-align:left;") + td("Total score", "text-align:left;") + "</tr>" +
    body + "</tbody></table>";
}

const RENDERERS = {
  MIGRATION_GENERAL: function (app, cert, F) {
    return (
      refDate(cert) + heading("MIGRATION CERTIFICATE") +
      "<p>This is to certify that " + F("honorific") + " " + F("student_name") +
      " with enrolment number " + F("enrolment_no") +
      " was admitted to Anant National University in " + F("admission_month_year") +
      ". The Programme covers " + F("programme_semesters") + " semesters spread over " + F("programme_years") +
      " years. " + F("he_cap") + " has successfully completed " + F("his") + " " + F("completed_semester") +
      " semester of " + F("programme_name") + " in " + F("completion_month_year") +
      " with CGPA " + F("cgpa") + " out of " + F("cgpa_scale") + ".</p>" +
      "<p>The University has no objection to " + F("honorific") + " " + F("student_name") +
      " getting admission to any other University/Institution.</p>" +
      "<p>" + F("his_cap") + " ABC/NAD/APAAR ID is " + F("abc_id") + ".</p>" +
      signatureBlock(cert) + verificationFooter(cert) + typeFooter("Migration \u2014 General")
    );
  },
  MIGRATION_EARLY_EXIT: function (app, cert, F) {
    return (
      refDate(cert) + heading("MIGRATION CERTIFICATE") +
      "<p>This is to certify that " + F("honorific") + " " + F("student_name") +
      " with enrolment number " + F("enrolment_no") +
      " was admitted to Anant National University in " + F("admission_month_year") +
      " to the " + F("programme_name") + ". The Programme covers " + F("programme_semesters") +
      " semesters spread over " + F("programme_years") + " years. " + F("he_cap") +
      " has successfully completed " + F("his") + " " + F("completed_semester") + " semester of " +
      F("programme_name") + " in " + F("completion_month_year") + " with CGPA " +
      F("cgpa") + " out of " + F("cgpa_scale") + ".</p>" +
      "<p>" + F("he_cap") + " has opted early exit from the programme. The University has no objection to " +
      F("honorific") + " " + F("student_name") + " getting admission to any other University/Institution.</p>" +
      "<p>" + F("his_cap") + " ABC/NAD/APAAR ID is " + F("abc_id") + ".</p>" +
      signatureBlock(cert) + verificationFooter(cert) + typeFooter("Migration \u2014 Early Exit")
    );
  },
  MEDIUM_OF_INSTRUCTION: function (app, cert, F) {
    return (
      refDate(cert) + heading("TO WHOMSOEVER IT MAY CONCERN") +
      "<p>This is to certify that " + F("honorific") + " " + F("student_name") +
      " bearing enrolment number " + F("enrolment_no") +
      " was a student of Anant National University, " + F("programme_name") +
      ". " + F("he_cap") + " joined the programme in academic year " + F("foundation_batch") +
      " and successfully completed it in " + F("completion_year") + " with a CGPA of " +
      F("cgpa") + ".</p>" +
      "<p>This certificate serves to confirm that the medium of instruction at Anant National University is English.</p>" +
      "<p>This certificate is issued upon " + F("student_name") +
      "\u2019s request, in support of " + F("his") + " application for admission to a higher study programme.</p>" +
      signatureBlock(cert) + verificationFooter(cert) + typeFooter("Medium of Instruction")
    );
  },
  VISA_GENERAL: function (app, cert, F) {
    return (
      refDate(cert) + heading("TO WHOMSOEVER IT MAY CONCERN") +
      bonafideOpening(F, F("he_cap")) +
      "<p>As per our record, " + F("he") + " is currently residing at:</p>" +
      "<p>" + F("address") + "</p>" +
      "<p>" + F("visa_sponsorship") + " \u2014 " + F("visa_event") + "</p>" +
      "<p>To enable " + F("student_name") +
      "\u2019s aforementioned visit, Anant National University may provide " + F("him") +
      " with financial support as admissible under university norms. Anant National University will have no financial obligations or implications regarding " +
      F("his") + " visit to " + F("visa_country") + ".</p>" +
      "<p>The university has no objection to " + F("him") + " travelling to " + F("visa_country") +
      " and participating in the " + F("visa_event") + " during the period " + F("visa_dates") + ".</p>" +
      "<p>This certificate is issued on " + F("his") + " request for the purpose of a visa application for travelling to " +
      F("visa_country") + " during the period " + F("visa_dates") + ".</p>" +
      signatureBlock(cert) + verificationFooter(cert) + typeFooter("VISA & Passport \u2014 General")
    );
  },
  BANK_LOAN_FIN_AID: function (app, cert, F, values) {
    return (
      bankRefDate(cert) + bankHeading("TO WHOMSOEVER IT MAY CONCERN") + bankOpening(F) +
      '<p style="text-align:justify;">The fee structure of ' + F("programme_name") + " <b>program</b> with <b>" + F("fin_aid_percent") +
      "</b> scholarship/financial aid on tuition fee is mentioned below.</p>" +
      feeTableFinAid(F, values) + bankDetails(F, ";") +
      '<p style="text-align:justify;">The certificate is issued on receipt of an express request from the student and is valid for the purpose of an education loan from the bank only.</p>' +
      signatureBlock(cert) + bankTypeLine("Bank Loan \u2014 General, with Financial Aid")
    );
  },
  BANK_LOAN_GENERAL: function (app, cert, F, values) {
    return (
      bankRefDate(cert) + bankHeading("TO WHOMSOEVER IT MAY CONCERN") + bankOpening(F) +
      '<p style="text-align:justify;">The fee structure of ' + F("programme_name") + " program is mentioned below.</p>" +
      feeTableGeneral(F, values) + bankDetails(F, "") +
      '<p style="text-align:justify;">The letter is issued on receipt of an express request from the student and is valid for the purpose of an education loan from the bank only.</p>' +
      signatureBlock(cert) + bankTypeLine("Bank Loan \u2014 General")
    );
  },
  BANK_LOAN_ADEPT: function (app, cert, F, values) {
    return (
      bankRefDate(cert) + bankHeading("TO WHOM SO EVER IT MAY CONCERN") + bankOpening(F) +
      '<p style="text-align:justify;">Below are the marks scored by the students in ADEPT- a university level entrance test for Design Programme:</p>' +
      adeptTable(F, values) +
      '<p style="text-align:justify;margin-top:12px;">This certificate is issued on request from the student and valid for purpose of education loan only.</p>' +
      signatureBlock(cert) + bankTypeLine("Bank Loan \u2014 ADEPT Score")
    );
  },
  FIELD_RESEARCH: function (app, cert, F) {
    return (
      refDate(cert) + heading("TO WHOMSOEVER IT MAY CONCERN") +
      bonafideOpening(F, F("he_cap")) +
      "<p>It is certified that, as per university policy for " + F("his") + " field research, " + F("he") +
      " will engage respectfully with local community members through interviews and visual ethnography. We kindly request your support and cooperation to enable " +
      F("him") + " to carry out this academic research. All ethical protocols, including informed consent and confidentiality, will be strictly observed.</p>" +
      "<p>This certificate is issued at " + F("his") + " request to support field research.</p>" +
      signatureBlock(cert) + verificationFooter(cert) + typeFooter("Field Research")
    );
  },
  GOVT_SCHOLARSHIP_GENERAL: function (app, cert, F) {
    return (
      refDate(cert) + heading("TO WHOMSOEVER IT MAY CONCERN") +
      bonafideOpening(F, F("he_cap")) +
      "<p>As per our record " + F("his") + " present address is:</p>" +
      "<p>" + F("address") + "</p>" +
      "<p>This certificate is issued at the request of " + F("honorific") + " " + F("student_name") +
      (app.residency === "HOSTELLER"
        ? ", who has been residing in the hostel since " + F("hostel_since")
        : ", a day scholar of the university,") +
      " for the purpose of applying for a scholarship.</p>" +
      signatureBlock(cert) + verificationFooter(cert) + typeFooter("Government Scholarship \u2014 General")
    );
  },
  MYSY_SCHOLARSHIP: function (app, cert, F) {
    return (
      refDate(cert) + heading("CERTIFICATE") +
      "<p>This is to certify that " + F("honorific") + " " + F("student_name") +
      ", bearing Student ID " + F("enrolment_no") +
      ", is admitted to our institute for Degree " + F("programme_name") +
      " in the academic year " + F("admission_academic_year") + " &amp; has taken admission through " + F("admission_route") +
      " in our university in the first year. Our university has a self-financed hostel facility. " + F("he_cap") +
      " has paid tuition fees " + F("tuition_fee_inr") + " in Semester " + F("current_semester") + ".</p>" +
      "<p>" + F("he_cap") + " has not received any other scholarship assistance under any other scheme. No disciplinary action is pending in accordance with the policy, rules &amp; standards of the university. If " +
      F("he") + " receives assistance from any other scheme, or in case of cancellation/transfer to another institution, " + F("he") +
      " will inform KCG by letter to KCG, Ahmedabad, and by e-mail to " +
      F("mysy_notify_email") + " with a copy to " + F("registry_email") + ".</p>" +
      "<p><i>Signed undertaking from the student is on file with this application.</i></p>" +
      signatureBlock(cert) + verificationFooter(cert) + typeFooter("MYSY Scholarship")
    );
  }
};

function renderCertificateHtml(app, cert, values) {
  const fn = RENDERERS[app.cert_type_code];
  if (!fn) throw new Error("No template renderer for certificate type " + app.cert_type_code);
  return fn(app, cert || null, makeF(values || {}), values || {});
}

// Which registry fields each template uses — derived by actually rendering the
// template with nothing resolved and collecting data-field markers, so the audit
// can never drift from the templates.
function fieldsUsedBy(certTypeCode) {
  const html = renderCertificateHtml({ cert_type_code: certTypeCode, residency: "HOSTELLER" }, null, {});
  const re = /data-field="([a-z_]+)"/g;
  const out = [];
  let m;
  while ((m = re.exec(html))) if (out.indexOf(m[1]) === -1) out.push(m[1]);
  return out;
}

module.exports = { renderCertificateHtml, fieldsUsedBy, RENDERER_CODES: Object.keys(RENDERERS), esc };
