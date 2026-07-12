# AEC Sdn Bhd - Aircon Service Report Portal

Two connected portals for AEC Sdn Bhd (Brunei):

- **Technician Portal** (`/technician.html`) - field technicians fill in and submit an air-conditioning service report (job & customer details, checklist, work performed, parts used, photos, signatures) which is sent straight to the Head of Department.
- **Head of Department Portal** (`/head.html`) - the head sees every submitted report, can review and edit it, approve it, print/save it as a branded PDF, and email it directly to the customer.

Both portals share one database, so a report submitted by a technician appears instantly for the head - no manual file transfer needed.

## Requirements

- Node.js **22.5 or newer** (the app uses Node's built-in SQLite database, so there is nothing extra to install or compile).

## Running it locally

```
cd aec-aircon-portal
npm install
cp .env.example .env      # then edit .env if you want email sending to work
npm start
```

Open **http://localhost:3000** in a browser.

### Demo logins

| Role | Username | Password |
|---|---|---|
| Technician | `tech1` | `tech1234` |
| Technician | `tech2` | `tech1234` |
| Head of Department | `head` | `head1234` |

**Change these passwords (or create real accounts) before giving this to real staff** - see "Managing users" below.

## What's in the technician's report

- Job reference (auto-generated, e.g. `AEC-2026-0001`), service date and type
- Customer name, phone, email, address, unit location and unit details
- A standard 12-point aircon service checklist
- Work performed and findings/diagnosis
- Parts and materials used
- Up to 8 photos
- Technician notes, recommendations, and next service due date
- On-screen signature pads for both technician and customer

## What the Head of Department can do

- See all incoming reports in one list, filterable by status (submitted / reviewed / approved / sent)
- Open any report, correct or add details, and add internal "Company Remarks"
- Approve the report
- View/print a branded PDF (AEC Sdn Bhd letterhead) at any time
- Email the PDF straight to the customer's email address

## Setting up email sending

The "Send to Customer by Email" button needs SMTP details in `.env`:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM="AEC Sdn Bhd <your-email@gmail.com>"
```

For Gmail, create an **App Password** in Google Account > Security (a normal Gmail password will not work). Any other SMTP provider (Outlook 365, Zoho, a local Brunei ISP's SMTP, or a transactional email service like Brevo/SendGrid) works the same way - just fill in their host/port/user/pass.

Until this is configured, the button shows a clear message instead of failing silently.

## Deploying so both offices/staff can reach it over the internet

This is a normal Node.js web app, so it can be deployed to any Node hosting provider. Two easy, low-cost/free options:

**Render.com**
1. Push this folder to a GitHub repository.
2. On Render, create a new "Web Service" from that repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Add the same environment variables from `.env` in Render's dashboard (Settings > Environment).
5. Render gives you a permanent `https://...onrender.com` URL - share this with technicians and the head.

**Railway.app** works the same way (connect the repo, set environment variables, deploy).

Important: on most hosting providers the filesystem is temporary/ephemeral (files get wiped on redeploy). For a production rollout, ask your host to attach a small persistent disk/volume for the `data/` and `uploads/` folders so reports and photos are not lost between deploys. Render and Railway both support this ("Persistent Disks" / "Volumes").

## Managing users

There is no signup screen on purpose (only AEC staff should have accounts). To add, remove, or reset technicians or heads, edit `database.js`'s seed section, or ask your developer to add a small admin script - happy to add one if you'd like a proper "Add Technician" screen instead of editing code.

## Project structure

```
aec-aircon-portal/
  app.js            <- server entry point (run this, or "npm start")
  database.js       <- database setup, tables, seed accounts
  public/
    index.html       <- login page
    technician.html   <- technician portal
    head.html          <- head of department portal
    style.css
    signature.js       <- signature pad widget
  data/               <- SQLite database file lives here (auto-created)
  uploads/            <- uploaded photos live here (auto-created)
  .env.example        <- copy to .env and fill in for email sending
```

Note: `server.js` and `db.js` in this folder are unused leftover files kept only because they couldn't be removed while building this project - they simply point to `app.js` / `database.js` and are safe to delete.

## Notes / possible next steps

- Passwords are hashed (bcrypt); sessions expire after 12 hours.
- Report photos are stored on the server's disk under `uploads/` and embedded into the PDF.
- Signatures are captured on-screen (finger or mouse) and embedded into the PDF as images.
- If you'd like, this can be extended with: SMS/WhatsApp notifications to the head when a report comes in, a proper admin screen for managing technician accounts, multi-language (English/Malay) labels, or a company logo image in the PDF letterhead instead of text.
