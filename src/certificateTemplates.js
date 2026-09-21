// src/certificateTemplates.js
//
// Renders the final certificate body (HTML fragment, meant to be dropped into
// the letterhead print view) for each certificate type. `app` is the
// application row (with joined cert_type code) and `cert` is the issued
// certificate row (number, token, issued_at).

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
// A field the office fills in manually or the system has not resolved yet —
// rendered highlighted, exactly like the source Word templates.
function f(text) {
  return '<mark>' + esc(text) + '</mark>';
}

function refDate(cert) {
  return (
    '<p>Ref: <mark>' + esc(cert.certificate_number) + '</mark>' +
    '&nbsp;&nbsp;&nbsp;&nbsp;Date: <mark>' + new Date(cert.issued_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) + '</mark></p>'
  );
}
function heading(text) {
  return '<h2 class="cert-heading">' + esc(text) + '</h2>';
}
function signatureBlock(cert) {
  var sigStyle = "";
  var sealStyle = "";
  if (cert && cert.signature_position) {
    var sp = cert.signature_position;
    sigStyle = ' style="position:absolute;top:' + (sp.top || 78) + '%;left:' + (sp.left || 8) + '%;max-width:150px;max-height:60px;"';
  }
  if (cert && cert.seal_position) {
    var kp = cert.seal_position;
    sealStyle = ' style="position:absolute;top:' + (kp.top || 70) + '%;left:' + (kp.left || 60) + '%;max-width:110px;max-height:110px;"';
  }
  var sigImg = (cert && cert.registrar_signature_data)
    ? '<img src="' + esc(cert.registrar_signature_data) + '"' + sigStyle + ' alt="Registrar signature">'
    : f('(E-Signature)');
  var sealImg = (cert && cert.registrar_seal_data)
    ? '<img src="' + esc(cert.registrar_seal_data) + '"' + sealStyle + ' alt="Official seal">'
    : f('(E-Stamp)');
  return (
    '<div class="sig-marks" style="position:relative;min-height:70px;">' + sigImg + '&nbsp;&nbsp;&nbsp;' + sealImg + '</div>' +
    '<p class="sig-name">Sanjay Bhatnagar</p>' +
    '<p class="sig-title">Registrar</p>'
  );
}
function verificationFooter(cert) {
  var token = cert && cert.qr_verification_token ? cert.qr_verification_token : "";
  return (
    '<p class="verify-footer">This certificate is issued digitally and does not require a physical signature. ' +
    'To verify its authenticity, scan the QR code above or visit the verification portal and enter reference ' +
    '<strong>' + esc(cert && cert.certificate_number) + '</strong> (verification token <code>' + esc(token) + '</code>).</p>'
  );
}
function typeFooter(label) {
  return '<p class="cert-type-footer">(Type of Certificate: ' + esc(label) + ')</p>';
}

const RENDERERS = {
  MIGRATION_GENERAL: function (app, cert) {
    return (
      refDate(cert) + heading('MIGRATION CERTIFICATE') +
      '<p>This is to certify that ' + f('Mr./Ms.') + ' ' + f(app.student_name) +
      ' with enrolment number ' + f(app.student_sdmis_id) +
      ' was admitted to Anant National University in ' + f('(Month/Year)') +
      '. The Programme covers ' + f('(08/10)') + ' semesters spread over ' + f('(4/5 years)') +
      '. ' + f('(He/She)') + ' has successfully completed ' + f('(his/her)') + ' ' + f('(____)') +
      ' semester of ' + f(app.program || '(Programme Name)') + ' in ' + f('(Completion Month/Year)') +
      ' with CGPA ' + f('(____)') + ' out of ' + f('(____)') + '.</p>' +
      '<p>The University has no objection to ' + f('Mr./Ms.') + ' ' + f(app.student_name) +
      ' getting admission to any other University/Institution.</p>' +
      '<p>His/her ABC/NAD/APAAR ID is ' + f('(ID No.)') + '.</p>' +
      signatureBlock(cert) + verificationFooter(cert) + typeFooter('Migration — General')
    );
  },
  MIGRATION_EARLY_EXIT: function (app, cert) {
    return (
      refDate(cert) + heading('MIGRATION CERTIFICATE') +
      '<p>This is to certify that ' + f('Mr./Ms.') + ' ' + f(app.student_name) +
      ' with enrolment number ' + f(app.student_sdmis_id) +
      ' was admitted to Anant National University in ' + f('(Month/Year)') +
      ' to the ' + f(app.program || '(Programme Name)') + '. The Programme covers ' + f('(08/10)') +
      ' semesters spread over ' + f('(4/5 years)') + '. ' + f('(He/She)') +
      ' has successfully completed ' + f('(his/her)') + ' ' + f('(____)') + ' semester of ' +
      f(app.program || '(Programme Name)') + ' in ' + f('(Completion Month/Year)') + ' with CGPA ' +
      f('(____)') + ' out of ' + f('(____)') + '.</p>' +
      '<p>(He/She) has opted early exit from the programme. The University has no objection to ' +
      f('Mr./Ms.') + ' ' + f(app.student_name) + ' getting admission to any other University/Institution.</p>' +
      '<p>His/her ABC/NAD/APAAR ID is ' + f('(ID No.)') + '.</p>' +
      signatureBlock(cert) + verificationFooter(cert) + typeFooter('Migration — Early Exit')
    );
  },
  MEDIUM_OF_INSTRUCTION: function (app, cert) {
    return (
      refDate(cert) + heading('TO WHOMSOEVER IT MAY CONCERN') +
      '<p>This is to certify that ' + f('Ms./Mr.') + ' ' + f(app.student_name) +
      ' bearing enrolment number ' + f(app.student_sdmis_id) +
      ' was a student of Anant National University, ' + f(app.program || '(Programme Name)') +
      '. She/He joined the programme in academic year ' + f('(Foundation Batch)') +
      ' and successfully completed it in ' + f('(Year of Completion)') + ' with a CGPA of ' +
      f('(CGPA)') + '.</p>' +
      '<p>This certificate serves to confirm that the medium of instruction at Anant National University is English.</p>' +
      '<p>This certificate is issued upon ' + f(app.student_name) +
      '\u2019s request, in support of his/her application for admission to a higher study programme.</p>' +
      signatureBlock(cert) + verificationFooter(cert) + typeFooter('Medium of Instruction')
    );
  },
  VISA_GENERAL: function (app, cert) {
    return (
      refDate(cert) + heading('TO WHOMSOEVER IT MAY CONCERN') +
      '<p>This is to certify that ' + f('Ms./Mr.') + ' ' + f(app.student_name) +
      ', bearing Student ID No ' + f(app.student_sdmis_id) +
      ', is a bonafide student of Anant National University. He/She is currently pursuing the ' +
      f('(1st\u201310th)') + ' semester of the ' + f('(four/five)') + '-year ' + f(app.program || '(Programme Name)') +
      ' programme for the batch ' + f('(____________)') + '.</p>' +
      '<p>As per our record, he/she is currently residing at:</p>' +
      '<p>' + f('(Address)') + '</p>' +
      '<p>' + f('(Sponsored) / (Non-Sponsored) / (event or programme name)') + '</p>' +
      '<p>To enable ' + f(app.student_name) +
      '\u2019s aforementioned visit, Anant National University may provide him/her with financial support as admissible under university norms. Anant National University will have no financial obligations or implications regarding his/her visit to ' +
      f('(Country)') + '.</p>' +
      '<p>The university has no objection to her/him travelling to ' + f('(Country)') +
      ' and participating in the ' + f('(Programme/Event Name)') + ' during the period ' + f('(Date range)') + '.</p>' +
      '<p>This certificate is issued on his/her request for the purpose of a visa application for travelling to ' +
      f('(Country)') + ' during the period ' + f('(Date range)') + '.</p>' +
      signatureBlock(cert) + verificationFooter(cert) + typeFooter('VISA & Passport — General')
    );
  },
  BANK_LOAN_FIN_AID: function (app, cert) {
    return (
      refDate(cert) + heading('TO WHOMSOEVER IT MAY CONCERN') +
      '<p>This is to certify that ' + f('Ms./Mr.') + ' ' + f(app.student_name) +
      ', bearing Student ID No ' + f(app.student_sdmis_id) +
      ', is a bonafide student of Anant National University. He/She is currently pursuing the ' +
      f('(1st\u201310th)') + ' semester of the ' + f('(four/five)') + '-year ' + f(app.program || '(Programme Name)') +
      ' programme for the batch ' + f('(____________)') + '.</p>' +
      '<p>The fee structure of the ' + f(app.program || '(Programme Name)') + ' programme, with ' +
      f('(% scholarship/financial aid on tuition fee)') + ', is mentioned below (see fee schedule provided separately by the Fees & Financial Aid Department).</p>' +
      '<p><b>Bank Account Details of the University:</b><br>Name of account: Anant National University<br>Account Number: ' +
      f('(as per university records)') + '<br>IFSC Code: ' + f('(as per university records)') +
      '<br>Bank: Axis Bank<br>Branch: Bopal, Ahmedabad \u00b7 Branch code: 878</p>' +
      '<p>The certificate is issued on receipt of an express request from the student and is valid for the purpose of an education loan from the bank only.</p>' +
      signatureBlock(cert) + verificationFooter(cert) + typeFooter('Bank Loan — General, with Financial Aid')
    );
  },
  BANK_LOAN_GENERAL: function (app, cert) {
    return (
      refDate(cert) + heading('TO WHOMSOEVER IT MAY CONCERN') +
      '<p>This is to certify that ' + f('Ms./Mr.') + ' ' + f(app.student_name) +
      ', bearing Student ID No ' + f(app.student_sdmis_id) +
      ', is a bonafide student of Anant National University. He/She is currently pursuing the ' +
      f('(1st\u201310th)') + ' semester of the ' + f('(four/five)') + '-year ' + f(app.program || '(Programme Name)') +
      ' programme for the batch ' + f('(____________)') + '.</p>' +
      '<p>The fee structure of the ' + f(app.program || '(Programme Name)') + ' programme is mentioned below (see fee schedule provided separately by the Fees Department).</p>' +
      '<p><b>Bank Account Details of the University:</b><br>Name of account: Anant National University<br>Account Number: ' +
      f('(as per university records)') + '<br>IFSC Code: ' + f('(as per university records)') +
      '<br>Bank: Axis Bank<br>Branch: Bopal, Ahmedabad \u00b7 Branch code: 878</p>' +
      '<p>The letter is issued on receipt of an express request from the student and is valid for the purpose of an education loan from the bank only.</p>' +
      signatureBlock(cert) + verificationFooter(cert) + typeFooter('Bank Loan — General')
    );
  },
  BANK_LOAN_ADEPT: function (app, cert) {
    return (
      refDate(cert) + heading('TO WHOMSOEVER IT MAY CONCERN') +
      '<p>This is to certify that ' + f('Ms./Mr.') + ' ' + f(app.student_name) +
      ', bearing Student ID No ' + f(app.student_sdmis_id) +
      ', is a bonafide student of Anant National University. He/She is currently pursuing the ' +
      f('(1st\u201310th)') + ' semester of the ' + f('(four/five)') + '-year ' + f(app.program || '(Programme Name)') +
      ' programme for the batch ' + f('(____________)') + '.</p>' +
      '<p>Below are the marks scored by the student in ADEPT \u2014 a university-level entrance test for the Design Programme (score sheet provided separately by the Admission Office):</p>' +
      '<p>This certificate is issued on request from the student and is valid for the purpose of an education loan only.</p>' +
      signatureBlock(cert) + verificationFooter(cert) + typeFooter('Bank Loan — ADEPT Score')
    );
  },
  FIELD_RESEARCH: function (app, cert) {
    return (
      refDate(cert) + heading('TO WHOMSOEVER IT MAY CONCERN') +
      '<p>This is to certify that ' + f('Ms./Mr.') + ' ' + f(app.student_name) +
      ', bearing Student ID No ' + f(app.student_sdmis_id) +
      ', is a bonafide student of Anant National University. She/He is currently pursuing the ' +
      f('(1st\u201310th)') + ' semester of the ' + f('(four/five)') + '-year ' + f(app.program || '(Programme Name)') +
      ' programme for the batch ' + f('(____________)') + '.</p>' +
      '<p>It is certified that, as per university policy for her/his field research, she/he will engage respectfully with local community members through interviews and visual ethnography. We kindly request your support and cooperation to enable her/him to carry out this academic research. All ethical protocols, including informed consent and confidentiality, will be strictly observed.</p>' +
      '<p>This certificate is issued at his/her request to support field research.</p>' +
      signatureBlock(cert) + verificationFooter(cert) + typeFooter('Field Research')
    );
  },
  GOVT_SCHOLARSHIP_GENERAL: function (app, cert) {
    return (
      refDate(cert) + heading('TO WHOMSOEVER IT MAY CONCERN') +
      '<p>This is to certify that ' + f('Ms./Mr.') + ' ' + f(app.student_name) +
      ', bearing Student ID No ' + f(app.student_sdmis_id) +
      ', is a bonafide student of Anant National University. He/She is currently pursuing the ' +
      f('(1st\u201310th)') + ' semester of the ' + f('(four/five)') + '-year ' + f(app.program || '(Programme Name)') +
      ' programme for the batch ' + f('(____________)') + '.</p>' +
      '<p>As per our record his/her present address is:</p>' +
      '<p>' + f('(Address)') + '</p>' +
      '<p>This certificate is issued at the request of ' + f('Mr./Ms.') + ' ' + f(app.student_name) +
      (app.residency === 'HOSTELLER'
        ? ', who has been residing in the hostel since ' + f('(Month/Year)')
        : ', a day scholar of the university,') +
      ' for the purpose of applying for a scholarship.</p>' +
      signatureBlock(cert) + verificationFooter(cert) + typeFooter('Government Scholarship — General')
    );
  },
  MYSY_SCHOLARSHIP: function (app, cert) {
    return (
      refDate(cert) + heading('CERTIFICATE') +
      '<p>This is to certify that ' + f('Mr./Ms.') + ' ' + f(app.student_name) +
      ', bearing Student ID ' + f(app.student_sdmis_id) +
      ', is admitted to our institute for Degree ' + f(app.program || '(Programme Name)') +
      ' in the academic year ' + f('(20__)') + ' & has taken admission through ' + f('(NATA/ACPC/ADEPT)') +
      ' in our university in the first year. Our university has a self-financed hostel facility. He/She has paid tuition fees ' +
      f('(Tuition fee in INR)') + ' in Semester ' + f('(1st\u201310th)') + '.</p>' +
      '<p>He/She has not received any other scholarship assistance under any other scheme. No disciplinary action is pending in accordance with the policy, rules & standards of the university. If he/she receives assistance from any other scheme, or in case of cancellation/transfer to another institution, he/she will inform KCG by letter to KCG, Ahmedabad, and by e-mail to ' +
      f('mysy-kcg@gujgov.edu.in') + ' with a copy to ' + f('ro@anu.edu.in') + '.</p>' +
      '<p><i>Signed undertaking from the student is on file with this application.</i></p>' +
      signatureBlock(cert) + verificationFooter(cert) + typeFooter('MYSY Scholarship')
    );
  }
};

function renderCertificateHtml(app, cert) {
  const fn = RENDERERS[app.cert_type_code];
  if (!fn) throw new Error('No template renderer for certificate type ' + app.cert_type_code);
  return fn(app, cert);
}

module.exports = { renderCertificateHtml, esc };
