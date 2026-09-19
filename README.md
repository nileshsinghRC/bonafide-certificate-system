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
- **SDMIS integration**: student profile fields (`program`, `school_dept`,
  `residency`, `student_sdmis_id`) are set at account creation here. Replace
  that with a live SDMIS fetch on login, per the integration spec.
- **Certificate PDF**: issuance currently returns styled HTML that the
  Registrar prints to PDF from the browser (`window.print()`). For a fully
  automated pipeline, render that HTML to PDF server-side (e.g. Puppeteer)
  and store it directly in S3/Cloudinary instead.
- **Digital signature**: the signature/seal block is currently a visual
  placeholder. A production system should apply an actual PAdES signature via
  an HSM or signing service, per the earlier architecture spec.
