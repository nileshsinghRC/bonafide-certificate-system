# Digital Bonafide Certificate Issuance System

Anant National University — Node.js/Express + PostgreSQL backend, single-file
HTML/JS frontend. Built to match the existing UniERP stack: Express API,
Postgres on Neon, deploy on Render.

## What's inside

```
server.js              Express app — auth, RBAC, workflow routes, serves public/
src/auth.js             JWT signing + verification, RBAC middleware
src/db.js                Postgres pool (Neon-ready, SSL configurable)
src/certificateTemplates.js   The 10 real ANU certificate texts, field-substituted at issuance
db/schema.sql            Full Postgres schema
db/seed.js                Seeds roles, certificate types, and 8 demo accounts (run: npm run seed)
public/index.html          Frontend — login, student portal, department desks, registrar, user admin
public/assets/               Letterhead header/footer images used on the printed certificate
```

## How the workflow model works

Each certificate type has a `stages` array of department codes it must clear
before the Registrar (who is always the implicit final stage) — e.g.
`["SCHOOL","EXAM"]` for a Migration Certificate. One certificate type,
Government Scholarship, has `warden_conditional = true`: the Warden stage is
appended only when the applicant's residency is `HOSTELLER`, resolved at the
moment the application is created.

An application tracks `current_stage_index` into its own resolved `stages`
array. A department can only act on an application currently sitting at their
stage; approving increments the index. Once the index reaches the end of the
array, the application appears in the Registrar's queue automatically —
there's no separate "pending registrar" status to keep in sync.

## Roles

| Role code | Represents |
|---|---|
| `student` | Applicant |
| `school_admin` | School's Office |
| `exam_admin` | Exam Office |
| `fees_finaid_admin` | Fees & Financial Aid Department |
| `admission_admin` | Admission Office |
| `warden` | Warden (hostel) |
| `registrar_admin` | Office of the Registrar — final signing & issuance |
| `super_admin` | Full oversight + user management |

## Local development

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL, JWT_SECRET
psql "$DATABASE_URL" -f db/schema.sql
npm run seed                 # creates roles, cert types, and demo logins
npm start                     # http://localhost:3000
```

Demo logins (username / password), all seeded by `npm run seed`:

```
aarav.mehta   / student123    (Student)
priya.desai   / admin123      (School's Office)
karan.bose    / admin123      (Exam Office)
meera.iyer    / admin123      (Fees & Financial Aid Dept)
arjun.rao     / admin123      (Admission Office)
sunita.varma  / admin123      (Warden)
fatima.qureshi/ admin123      (Registrar's Office)
admin         / super123      (Super Admin)
```

**Change every one of these passwords (or delete and recreate the accounts)
before going anywhere near production.**

## Student account provisioning

Three ways student accounts get into the system, in increasing order of automation:

1. **One at a time** — Super Admin → Users & Roles → Add user. Fine for staff
   accounts, tedious for a whole student roster.
2. **Bulk import (human-facing)** — Super Admin → Users & Roles → "Bulk
   import students". Paste one student per line as
   `email,name,studentSdmisId,program,schoolDept,residency`. New accounts get
   a generated temporary password (shown once, copy it immediately) and are
   forced to set their own password on first login. Existing accounts
   (matched by email) just get their profile fields refreshed — their
   password is never touched.
3. **SDMIS sync (machine-to-machine)** — `POST /api/integrations/students/sync`,
   authenticated with a static `X-API-Key` header (the `INTEGRATION_API_KEY`
   env var), not a user session. Same request/response shape as the bulk
   import route above. Point your SDMIS export job or deployment script here
   to provision or refresh the real student roster without a human in the
   loop:

   ```bash
   curl -X POST https://<your-render-url>/api/integrations/students/sync \
     -H "X-API-Key: $INTEGRATION_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"students":[
       {"email":"aarav.mehta@anu.edu.in","name":"Aarav Mehta","studentSdmisId":"SDM-2023-00451","program":"B.Des","schoolDept":"School of Technology","residency":"HOSTELLER"}
     ]}'
   ```

   Response: `{"created":[{"email":"...","tempPassword":"..."}], "updated":["..."], "errors":[{"email":"...","reason":"..."}]}`.
   Treat the response as sensitive — it contains plaintext temporary
   passwords for every newly created account. Only the calling script should
   see it; don't log it anywhere persistent.

**Validation applied to both bulk paths:**
- Email must be well-formed.
- If `STUDENT_EMAIL_DOMAIN` is set (e.g. `anu.edu.in`), the email must end
  with `@<that domain>` or the record is rejected with a reason, not silently
  dropped.
- A deactivated account (`active = false`) still can't log in even with the
  right password — unchanged from the manual Users & Roles toggle.

**Login hardening**, applied regardless of how the account was created:
- Sign-in is rate-limited per username: 8 failed attempts in 15 minutes
  returns `429 TOO_MANY_ATTEMPTS`. This is in-memory and per-instance — fine
  for a single free-tier Render service, swap for a shared store (Redis) if
  you scale to multiple instances.
- `must_change_password` on the user blocks nothing server-side beyond the
  flag itself — the frontend enforces it by showing a mandatory "set your
  password" screen right after login, before anything else renders. The
  underlying route (`POST /api/me/password`) is just a normal authenticated
  endpoint, so it's also there for any user to change their password
  voluntarily later.

## v2 workflow — granular tracking, return loop, inline editing, e-signature

Six capabilities added on top of the v1 forwarding workflow (§"How the workflow model works" above still holds — this extends it):

1. **Granular status tracking** — `GET /api/applications/:id/tracker` returns the exact level (`SCHOOL`, `FEES_FINAID`, `REGISTRAR`, etc.), the last person who acted (`assigned_reviewer_id`), and pending duration since `level_entered_at`. Every dashboard (student, department, registrar) renders the same step chain via the `trackSteps()` helper in `public/index.html` — no separate tracker UI per role.

2. **SDMIS profile photo + fee-in-words** — login syncs `users.profile_picture_url` (placeholder initials avatar until a real SDMIS photo feed exists — see "known gaps"). `GET /api/applications/:id/certificate-preview` builds a `fee_snapshot` from `users.tuition_fee_amount` / `hostel_fee_amount` (or sensible defaults) and converts both to formal words via the `numberToWords()` helper in `server.js` (Indian numbering system — Lakh/Crore).

3. **Department inline editing** — the same `certificate-preview` call creates a `certificate_draft` JSONB the first time it's viewed; `PATCH /api/department/applications/:id/certificate-draft` merges edits into it. The Registrar's issuance step renders from this draft, not the raw application row, so a department correction actually reaches the printed certificate.

4. **Registrar return / direct resubmit loop** — `POST /api/registrar/applications/:id/return` requires a `comment` and moves the application back one stage (status `RETURNED_TO_DEPARTMENT`). `POST /api/department/applications/:id/resubmit-to-registrar` is only valid from that status and jumps straight back to the Registrar — it does not re-enter any earlier stage the application had already cleared.

5. **Registrar signature upload** — `POST /api/registrar/applications/:id/upload-signature` takes a base64 image (`signatureImageBase64`), generates the certificate number and QR token, stores everything on `certificates`, and returns the rendered HTML in one call. The "notification" is a real hook (`notified_at`/`notification_channel` are set, and the route logs a `[notify] certificate issued email queued for ...` line) but actually sending an email is a stub — see "known gaps".

6. **Activity logs + change password** — `application_events` is now `activity_logs`, with `from_stage`/`to_stage` columns so the same feed reads correctly on every dashboard (`GET /api/applications/:id/activity-log`, scoped so students only see their own). `POST /api/me/password` already existed for the forced first-login change; it's now also reachable any time via the "Change password" link in the header.

## Deploying — GitHub + Neon + Render

1. **Push to GitHub**
   ```bash
   git init
   git add .
   git commit -m "Initial commit — Bonafide Certificate System"
   git remote add origin <your-github-repo-url>
   git push -u origin main
   ```

2. **Create the database on Neon**
   - New project → copy the **pooled connection string** (starts `postgres://...`).
   - Run the schema against it once from your machine:
     ```bash
     psql "postgres://...neon connection string..." -f db/schema.sql
     ```
   - Seed it:
     ```bash
     DATABASE_URL="postgres://...neon..." DB_SSL=true node db/seed.js
     ```

3. **Deploy on Render**
   - New → Web Service → connect the GitHub repo.
   - Build command: `npm install`
   - Start command: `npm start`
   - Environment variables:
     | Key | Value |
     |---|---|
     | `DATABASE_URL` | the Neon pooled connection string |
     | `DB_SSL` | `true` |
     | `JWT_SECRET` | a long random string — generate with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
     | `JWT_EXPIRY` | `8h` |
     | `STUDENT_EMAIL_DOMAIN` | e.g. `anu.edu.in` — leave unset to allow any email during initial rollout |
     | `INTEGRATION_API_KEY` | a long random string (same generation command as `JWT_SECRET`) — leave unset to disable the SDMIS sync endpoint |
   - Render sets `PORT` itself — don't add it manually.
   - Manual Deploy after the first push, then it redeploys on every push to `main`.

4. **Smoke test** — open the Render URL, sign in with `admin` / `super123`
   (from the seed step), then change that password immediately via the
   Users & Roles screen or by re-seeding with different values.

## Certificate templates

`src/certificateTemplates.js` holds the exact wording for all 10 issuable
certificate types (Migration — General/Early Exit, Medium of Instruction,
VISA & Passport, Bank Loan — General/with Financial Aid/ADEPT Score, Field
Research, Government Scholarship, MYSY Scholarship), each rendered with the
application's real data and printed against the letterhead images in
`public/assets/`. The companion Word document
(`ANU_Bonafide_Certificate_Templates.docx`, delivered separately) is the
office-facing reference copy of the same templates plus the full forwarding
sequence table — keep the two in sync if either changes.

The MYSY Undertaking is not a certificate type of its own; it's a required
attachment (`requires_undertaking` on `MYSY_SCHOLARSHIP`) the student
confirms before submitting.

## Known gaps to close before production

- **File uploads** are currently simulated (a filename string, no real
  storage). Wire `documents.storage_url` to Cloudinary, matching the
  `/api/v1/upload` pattern already used elsewhere in the ERP.
- **SDMIS integration**: the roster itself is now bulk-provisionable via
  `POST /api/integrations/students/sync` (see "Student account provisioning"
  above), so student accounts no longer have to be created one at a time.
  What's still missing is a *live* per-request fetch — e.g. dues status,
  the real profile photo, or real fee figures at the moment a student opens
  the application form — which this endpoint doesn't cover; `profile_picture_url`
  is a generated initials avatar and `fee_snapshot` falls back to defaults
  unless `tuition_fee_amount`/`hostel_fee_amount` are set on the user. Both
  are real integration points, just not wired to a live SDMIS feed yet.
- **Certificate PDF**: issuance currently returns styled HTML that the
  Registrar prints to PDF from the browser (`window.print()`). For a fully
  automated pipeline, render that HTML to PDF server-side (e.g. Puppeteer)
  and store it directly in S3/Cloudinary instead.
- **Digital signature**: the Registrar's uploaded signature image is composited
  visually (`certificates.registrar_signature_data`), but there's no
  cryptographic PAdES signature yet — a production system should add one via
  an HSM or signing service, per the earlier architecture spec, so the PDF
  is tamper-evident and not just visually signed.
- **Email delivery**: `POST /registrar/applications/:id/upload-signature` sets
  `notified_at`/`notification_channel` and logs a `[notify] ...` line, but no
  SMTP provider is connected — wire `sendEmail()` (currently just a
  `console.log`) to an actual provider (SES, SendGrid, etc.) to make the
  "automated email with a download link" real rather than a stub.
