require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType } = require('docx');
const { db, ready } = require('./datastore6');
const TursoSessionStore = require('./session-store');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Setup ----------
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024 } });

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(uploadsDir));
// index: false — an old orphaned public/index.html still exists in this repo,
// and express.static's automatic "index.html" lookup would otherwise serve it
// for "/" before our explicit login route below ever runs.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Sessions are stored in the same persistent Turso database (see
// session-store.js) instead of express-session's default in-memory store,
// so logged-in users stay logged in across server restarts / redeploys.
app.use(session({
  store: new TursoSessionStore(db),
  secret: process.env.SESSION_SECRET || 'aec-sdn-bhd-change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 12 } // 12 hours
}));

// Login page lives at public/login.html; serve it explicitly at "/" since
// express.static's automatic "index.html" lookup no longer applies.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ---------- Helpers ----------
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}
function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user || req.session.user.role !== role) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}
function requireAnyRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user || !roles.includes(req.session.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}
// Job Reference is the single job-identifying number end to end (it replaces
// the old separate "Job Sheet No." concept). It's a continuous running
// number in the form K000001, K000002, ... that never resets by year, and
// persists across deploys because it's read back from the database (which
// now lives on Turso rather than a local disk that used to get wiped).
async function genJobRef() {
  const rows = await db.prepare("SELECT job_ref FROM reports WHERE job_ref LIKE 'K%'").all();
  let maxNum = 0;
  rows.forEach((r) => {
    const m = /^K(\d+)$/.exec(r.job_ref || '');
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxNum) maxNum = n;
    }
  });
  return 'K' + String(maxNum + 1).padStart(6, '0');
}

// ---------- Auth routes ----------
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    req.session.user = { id: user.id, name: user.name, role: user.role, username: user.username };
    res.json({ user: req.session.user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

// ---------- Technicians list (for scheduler assignment dropdown) ----------
app.get('/api/technicians', requireAuth, async (req, res) => {
  try {
    const rows = await db.prepare("SELECT id, name, username FROM users WHERE role = 'technician' ORDER BY name").all();
    res.json({ technicians: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load technicians' });
  }
});

// ---------- Customer blocklist ----------
// Visible to Head (who manages it) and Scheduler (who needs to see the
// warning while creating a new job). Tags persist independently of any one
// report until the Head removes them.
app.get('/api/blocklist', requireAuth, requireAnyRole('head', 'scheduler'), async (req, res) => {
  try {
    const rows = await db.prepare('SELECT * FROM customer_blocklist ORDER BY tagged_at DESC').all();
    res.json({ blocklist: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load blocklist' });
  }
});

app.post('/api/blocklist', requireAuth, requireRole('head'), async (req, res) => {
  try {
    const b = req.body;
    const name = (b.customer_name || '').trim();
    const phone = (b.customer_phone || '').trim();
    const address = (b.customer_address || '').trim();
    if (!name && !phone && !address) {
      return res.status(400).json({ error: 'At least one of customer name, phone, or address is required' });
    }
    const info = await db.prepare(`INSERT INTO customer_blocklist
      (customer_name, customer_phone, customer_address, reason, tagged_by)
      VALUES (?,?,?,?,?)`).run(name, phone, address, b.reason || '', req.session.user.name);
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to blocklist customer' });
  }
});

app.delete('/api/blocklist/:id', requireAuth, requireRole('head'), async (req, res) => {
  try {
    await db.prepare('DELETE FROM customer_blocklist WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove from blocklist' });
  }
});

// ---------- Scheduler: create a job assignment ----------
app.post('/api/jobs', requireAuth, requireRole('scheduler'), async (req, res) => {
  try {
    const b = req.body;
    const customerName = (b.customer_name || '').trim();
    const customerAddress = (b.customer_address || '').trim();
    const customerPhone = (b.customer_phone || '').trim();

    // Customer Name, Address, and Contact Number must all be filled in
    // before a job can be assigned to a technician. The Job Reference
    // number is auto-assigned by the system, so there is nothing for the
    // scheduler to type in for that.
    if (!customerName) {
      return res.status(400).json({ error: 'Customer name is required' });
    }
    if (!customerAddress) {
      return res.status(400).json({ error: 'Customer address is required' });
    }
    if (!customerPhone) {
      return res.status(400).json({ error: 'Contact number is required' });
    }
    if (!b.technician_id || !b.complaint_description) {
      return res.status(400).json({ error: 'Technician and nature of complaint are required' });
    }
    const tech = await db.prepare("SELECT * FROM users WHERE id = ? AND role = 'technician'").get(b.technician_id);
    if (!tech) return res.status(400).json({ error: 'Selected technician not found' });

    const jobRef = await genJobRef();
    const stmt = db.prepare(`INSERT INTO reports
      (job_ref, technician_id, technician_name, service_date, service_type,
       customer_name, customer_address, customer_phone, complaint_description,
       amount, discount, payment_method, assigned_by, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const info = await stmt.run(
      jobRef,
      tech.id,
      tech.name,
      b.service_date || '',
      b.service_type || '',
      customerName,
      customerAddress,
      customerPhone,
      b.complaint_description,
      b.amount || '',
      b.discount || '',
      b.payment_method || '',
      req.session.user.id,
      'assigned'
    );
    res.json({ ok: true, id: info.lastInsertRowid, job_ref: jobRef });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create job' });
  }
});

// Scheduler: cancel a job — only while it's still unstarted ('assigned'),
// i.e. before the technician has submitted a completed report. A reason is
// required.
app.post('/api/jobs/:id/cancel', requireAuth, requireRole('scheduler'), async (req, res) => {
  try {
    const row = await db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.assigned_by !== req.session.user.id) return res.status(403).json({ error: 'Forbidden' });
    if (row.cancelled_at) return res.status(400).json({ error: 'This job is already cancelled' });
    if (row.status !== 'assigned') {
      return res.status(400).json({ error: 'This job can no longer be cancelled — the technician has already submitted a report for it.' });
    }
    const reason = (req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A cancellation reason is required' });
    await db.prepare("UPDATE reports SET cancelled_at = datetime('now'), cancel_reason = ?, updated_at = datetime('now') WHERE id = ?").run(reason, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to cancel job' });
  }
});

// Scheduler: edit an already-assigned job — technician, address, nature of
// complaint, amount, and preferred service date only. Allowed only while
// the job is still 'assigned' (before the technician submits).
app.put('/api/jobs/:id/scheduler-edit', requireAuth, requireRole('scheduler'), async (req, res) => {
  try {
    const row = await db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.assigned_by !== req.session.user.id) return res.status(403).json({ error: 'Forbidden' });
    if (row.cancelled_at) return res.status(400).json({ error: 'This job has been cancelled' });
    if (row.status !== 'assigned') {
      return res.status(400).json({ error: 'This job can no longer be edited by the scheduler — the technician has already submitted a report for it.' });
    }
    const b = req.body;
    const updates = [];
    const values = [];
    let technicianName = row.technician_name;
    if (b.technician_id !== undefined && String(b.technician_id) !== String(row.technician_id)) {
      const tech = await db.prepare("SELECT * FROM users WHERE id = ? AND role = 'technician'").get(b.technician_id);
      if (!tech) return res.status(400).json({ error: 'Selected technician not found' });
      technicianName = tech.name;
      updates.push('technician_id = ?', 'technician_name = ?');
      values.push(tech.id, tech.name);
    }
    if (b.customer_address !== undefined) { updates.push('customer_address = ?'); values.push(b.customer_address); }
    if (b.complaint_description !== undefined) { updates.push('complaint_description = ?'); values.push(b.complaint_description); }
    if (b.amount !== undefined) { updates.push('amount = ?'); values.push(b.amount); }
    if (b.discount !== undefined) { updates.push('discount = ?'); values.push(b.discount); }
    if (b.payment_method !== undefined) { updates.push('payment_method = ?'); values.push(b.payment_method); }
    if (b.service_date !== undefined) { updates.push('service_date = ?'); values.push(b.service_date); }
    if (!updates.length) return res.json({ ok: true });
    updates.push("updated_at = datetime('now')");
    values.push(req.params.id);
    await db.prepare(`UPDATE reports SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    res.json({ ok: true, technician_name: technicianName });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save changes' });
  }
});

// Head: approve a newly-assigned job so it becomes visible/startable for
// the technician. Every job created by a scheduler starts out unapproved
// (head_approved_at is NULL) — the Head of Department must review and
// approve it here first, before the technician is allowed to open/start
// the work. See the matching check in POST /api/reports/:id/complete below.
app.post('/api/jobs/:id/approve', requireAuth, requireRole('head'), async (req, res) => {
  try {
    const row = await db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.cancelled_at) return res.status(400).json({ error: 'This job has been cancelled.' });
    if (row.status !== 'assigned') {
      return res.status(400).json({ error: 'Only a newly assigned job awaiting approval can be approved here.' });
    }
    await db.prepare("UPDATE reports SET head_approved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to approve job assignment' });
  }
});

// ---------- Report routes ----------

// Create report (technician, ad-hoc / walk-in job with no scheduler involved)
app.post('/api/reports', requireAuth, requireRole('technician'), upload.array('photos', 8), async (req, res) => {
  try {
    const b = req.body;
    if (!b.date_started || !b.date_finished) {
      return res.status(400).json({ error: 'Date Started and Date Finished are required.' });
    }
    if (!b.technician_signature || !b.customer_signature) {
      return res.status(400).json({ error: 'Both the technician and customer signatures are required before the report can be submitted.' });
    }
    const jobRef = await genJobRef();
    const photos = (req.files || []).map(f => f.filename);

    const stmt = db.prepare(`INSERT INTO reports
      (job_ref, technician_id, technician_name, service_date, service_type,
       customer_name, customer_address, customer_email, customer_phone,
       unit_location, units_json,
       written_name, team_members, amount, discount, payment_method,
       checklist_json, work_performed, findings,
       parts_json, photos_json, technician_notes, recommendations, date_started, date_finished,
       technician_signature, customer_signature, customer_ack, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    // Job Reference is auto-assigned by the system (genJobRef above) —
    // technicians never set it themselves, even on ad-hoc/walk-in reports.
    const info = await stmt.run(
      jobRef,
      req.session.user.id,
      req.session.user.name,
      b.service_date || new Date().toISOString().slice(0, 10),
      b.service_type || '',
      b.customer_name || '',
      b.customer_address || '',
      b.customer_email || '',
      b.customer_phone || '',
      b.unit_location || '',
      b.units_json || '[]',
      b.written_name || '',
      b.team_members || '',
      b.amount || '',
      b.discount || '',
      b.payment_method || '',
      b.checklist_json || '[]',
      b.work_performed || '',
      b.findings || '',
      b.parts_json || '[]',
      JSON.stringify(photos),
      b.technician_notes || '',
      b.recommendations || '',
      b.date_started || '',
      b.date_finished || '',
      b.technician_signature || '',
      b.customer_signature || '',
      b.customer_ack ? 1 : 0,
      'submitted'
    );

    res.json({ ok: true, id: info.lastInsertRowid, job_ref: jobRef });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save report' });
  }
});

// Technician: complete a job that was assigned to them by a scheduler
app.post('/api/reports/:id/complete', requireAuth, requireRole('technician'), upload.array('photos', 8), async (req, res) => {
  try {
    const row = await db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.technician_id !== req.session.user.id) return res.status(403).json({ error: 'Forbidden' });
    if (row.cancelled_at) return res.status(400).json({ error: 'This job has been cancelled by the scheduler.' });
    if (row.status !== 'assigned') return res.status(400).json({ error: 'This job has already been completed' });
    if (!row.head_approved_at) return res.status(400).json({ error: 'This job is awaiting Head of Department approval and cannot be started yet.' });

    const b = req.body;
    if (!b.date_started || !b.date_finished) {
      return res.status(400).json({ error: 'Date Started and Date Finished are required.' });
    }
    if (!b.technician_signature || !b.customer_signature) {
      return res.status(400).json({ error: 'Both the technician and customer signatures are required before the report can be submitted.' });
    }
    const newPhotos = (req.files || []).map(f => f.filename);
    let existingPhotos = [];
    try { existingPhotos = JSON.parse(row.photos_json || '[]'); } catch (e) {}
    const photos = existingPhotos.concat(newPhotos);

    // Job Reference is not touched here — it was auto-assigned when the job
    // was created and stays as-is; only the head can change it.
    await db.prepare(`UPDATE reports SET
        service_date = ?, service_type = ?,
        customer_name = ?, customer_address = ?, customer_email = ?, customer_phone = ?,
        unit_location = ?, units_json = ?,
        written_name = ?, team_members = ?, amount = ?, discount = ?, payment_method = ?,
        checklist_json = ?, work_performed = ?, findings = ?,
        parts_json = ?, photos_json = ?, technician_notes = ?, recommendations = ?,
        date_started = ?, date_finished = ?, technician_signature = ?, customer_signature = ?, customer_ack = ?,
        status = 'submitted', updated_at = datetime('now')
      WHERE id = ?`).run(
      b.service_date || new Date().toISOString().slice(0, 10),
      b.service_type || '',
      b.customer_name || row.customer_name,
      b.customer_address || row.customer_address,
      b.customer_email || '',
      b.customer_phone || row.customer_phone,
      b.unit_location || '',
      b.units_json || '[]',
      b.written_name || '',
      b.team_members || '',
      b.amount || '',
      b.discount || '',
      b.payment_method || '',
      b.checklist_json || '[]',
      b.work_performed || '',
      b.findings || '',
      b.parts_json || '[]',
      JSON.stringify(photos),
      b.technician_notes || '',
      b.recommendations || '',
      b.date_started || '',
      b.date_finished || '',
      b.technician_signature || '',
      b.customer_signature || '',
      b.customer_ack ? 1 : 0,
      req.params.id
    );

    res.json({ ok: true, job_ref: row.job_ref });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to complete job' });
  }
});

// List reports / jobs
app.get('/api/reports', requireAuth, async (req, res) => {
  try {
    let rows;
    if (req.session.user.role === 'head' || req.session.user.role === 'account') {
      rows = await db.prepare('SELECT * FROM reports ORDER BY created_at DESC').all();
    } else if (req.session.user.role === 'scheduler') {
      rows = await db.prepare('SELECT * FROM reports WHERE assigned_by = ? ORDER BY created_at DESC').all(req.session.user.id);
    } else {
      rows = await db.prepare('SELECT * FROM reports WHERE technician_id = ? ORDER BY created_at DESC').all(req.session.user.id);
    }
    res.json({ reports: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load reports' });
  }
});

// Get single report
app.get('/api/reports/:id', requireAuth, async (req, res) => {
  try {
    const row = await db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const role = req.session.user.role;
    if (role === 'technician' && row.technician_id !== req.session.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (role === 'scheduler' && row.assigned_by !== req.session.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.json({ report: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load report' });
  }
});

// Update / review report (head only)
app.put('/api/reports/:id', requireAuth, requireRole('head'), async (req, res) => {
  try {
    const row = await db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const b = req.body;

    // Job Reference is the single job-identifying number (it replaced the old
    // separate "Job Sheet No."). The Head of Department is the only role
    // allowed to change it after the job has been created.
    if (b.job_ref !== undefined) {
      const newRef = String(b.job_ref).trim();
      if (!newRef) {
        return res.status(400).json({ error: 'Job Reference cannot be empty' });
      }
      if (newRef !== row.job_ref) {
        const clash = await db.prepare('SELECT id FROM reports WHERE job_ref = ? AND id != ?').get(newRef, req.params.id);
        if (clash) {
          return res.status(400).json({ error: 'That Job Reference is already in use by another job' });
        }
      }
    }

    const fields = ['customer_name','customer_address','customer_email','customer_phone',
      'unit_location',
      'complaint_description','job_ref','written_name','team_members','amount','discount','payment_method',
      'work_performed','findings','technician_notes',
      'recommendations','date_started','date_finished','head_remarks','service_type','status'];
    const updates = [];
    const values = [];
    fields.forEach(f => {
      if (b[f] !== undefined) { updates.push(`${f} = ?`); values.push(f === 'job_ref' ? String(b[f]).trim() : b[f]); }
    });
    if (b.parts_json !== undefined) { updates.push('parts_json = ?'); values.push(b.parts_json); }
    if (b.checklist_json !== undefined) { updates.push('checklist_json = ?'); values.push(b.checklist_json); }
    if (b.units_json !== undefined) { updates.push('units_json = ?'); values.push(b.units_json); }
    updates.push("updated_at = datetime('now')");
    values.push(req.params.id);
    await db.prepare(`UPDATE reports SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save changes' });
  }
});

// Technician: edit a report they've already submitted. Only a limited set
// of fields (amount, address, unit(s) serviced, contact number) — allowed
// any time after submission, but locked once Accounts has been sent the
// report for invoicing. If the report was sent back by Head with a reject
// reason, saving an edit here counts as fixing and resubmitting it, so the
// reject reason is cleared and it re-enters Head's review queue.
app.put('/api/reports/:id/technician-edit', requireAuth, requireRole('technician'), async (req, res) => {
  try {
    const row = await db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.technician_id !== req.session.user.id) return res.status(403).json({ error: 'Forbidden' });
    if (row.status === 'assigned') return res.status(400).json({ error: 'Submit the report first before editing it.' });
    if (row.cancelled_at) return res.status(400).json({ error: 'This job has been cancelled.' });
    if (row.accounts_sent_at) return res.status(400).json({ error: 'This report has already been sent to Accounts and can no longer be edited.' });

    const b = req.body;
    const updates = [];
    const values = [];
    if (b.amount !== undefined) { updates.push('amount = ?'); values.push(b.amount); }
    if (b.discount !== undefined) { updates.push('discount = ?'); values.push(b.discount); }
    if (b.payment_method !== undefined) { updates.push('payment_method = ?'); values.push(b.payment_method); }
    if (b.customer_address !== undefined) { updates.push('customer_address = ?'); values.push(b.customer_address); }
    if (b.customer_phone !== undefined) { updates.push('customer_phone = ?'); values.push(b.customer_phone); }
    if (b.units_json !== undefined) { updates.push('units_json = ?'); values.push(b.units_json); }
    if (!updates.length) return res.json({ ok: true });
    // Editing after a rejection is treated as "fixed, please look again".
    if (row.reject_reason) { updates.push('reject_reason = NULL'); }
    updates.push("updated_at = datetime('now')");
    values.push(req.params.id);
    await db.prepare(`UPDATE reports SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save changes' });
  }
});

// Approve report (head only)
app.post('/api/reports/:id/approve', requireAuth, requireRole('head'), async (req, res) => {
  try {
    const row = await db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.cancelled_at) return res.status(400).json({ error: 'This job has been cancelled.' });
    await db.prepare("UPDATE reports SET status = 'approved', reject_reason = NULL, updated_at = datetime('now') WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to approve report' });
  }
});

// Reject report (head only) — sends it back to the technician with a
// required reason. The technician can then edit it (see technician-edit
// above), which automatically clears the reason and puts it back in front
// of Head for another look.
app.post('/api/reports/:id/reject', requireAuth, requireRole('head'), async (req, res) => {
  try {
    const row = await db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.cancelled_at) return res.status(400).json({ error: 'This job has been cancelled.' });
    if (!['submitted', 'reviewed'].includes(row.status)) {
      return res.status(400).json({ error: 'Only a submitted report awaiting review can be rejected.' });
    }
    const reason = (req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required to reject a report.' });
    await db.prepare("UPDATE reports SET reject_reason = ?, updated_at = datetime('now') WHERE id = ?").run(reason, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to reject report' });
  }
});

// Send an approved report to the Accounts department for invoicing (head
// only). This is a separate step from emailing the customer, and is the
// point at which the technician is locked out of further edits.
app.post('/api/reports/:id/send-to-accounts', requireAuth, requireRole('head'), async (req, res) => {
  try {
    const row = await db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.status !== 'approved') {
      return res.status(400).json({ error: 'Only an approved report can be sent to Accounts.' });
    }
    if (row.accounts_sent_at) return res.status(400).json({ error: 'This report has already been sent to Accounts.' });
    await db.prepare("UPDATE reports SET accounts_sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send report to Accounts' });
  }
});

// ---------- PDF generation ----------
function money(v) {
  const n = parseFloat(v);
  return isNaN(n) ? '0.00' : n.toFixed(2);
}

// Renders report content into an already-created PDFDocument. Caller owns
// creating the document and piping/collecting its output. Laid out as an
// invoice-style job sheet — a bordered job info box (name/company, address,
// job sheet no., date, phone/email), a description/qty/price/amount table,
// a Sub Total / Discount / Net Total summary, and the company's bank
// account details — matching the paper job sheet AEC technicians fill in
// the field, followed by the full text of the report (unit details,
// findings, checklist, parts, notes, photos, and signatures).
function renderReportPdf(doc, report) {
  const LEFT = 50, RIGHT = 545, WIDTH = RIGHT - LEFT;
  const NAVY = '#0b3d63';
  const GREY = '#999';

  // Letterhead
  doc.fillColor(NAVY).fontSize(20).font('Helvetica-Bold').text('AEC Sdn Bhd', LEFT, 50);
  doc.fillColor('#444').fontSize(8.5).font('Helvetica')
    .text('Air Conditioning Sales, Installation & Maintenance Services', LEFT)
    .text('SPG 1923, Lot 19598, Kiarong Pengkalan Batu, P.O. Box 2666, Bandar Seri Begawan BS8675, Negara Brunei Darussalam', LEFT);
  doc.x = LEFT;
  doc.moveTo(LEFT, doc.y + 8).lineTo(RIGHT, doc.y + 8).strokeColor(NAVY).lineWidth(1.5).stroke();
  doc.moveDown(1.1);

  doc.fillColor(NAVY).fontSize(13).font('Helvetica-Bold').text('AIR-CONDITIONING SERVICE REPORT / JOB SHEET', LEFT, doc.y, { align: 'center', width: WIDTH });
  doc.moveDown(0.6);
  doc.fillColor('#000');

  const line = (label, value) => {
    doc.font('Helvetica-Bold').fontSize(10).text(label, { continued: true });
    doc.font('Helvetica').fontSize(10).text('  ' + (value || '-'));
  };

  // ---- Job info box: Name/Company + Address (left) | Job Sheet No, Date, Phone/Email (right) ----
  const boxX = LEFT, boxY = doc.y, boxW = WIDTH, boxH = 82;
  const midX = boxX + boxW * 0.6;
  const rowH = boxH / 3;
  doc.rect(boxX, boxY, boxW, boxH).strokeColor(GREY).lineWidth(0.75).stroke();
  doc.moveTo(midX, boxY).lineTo(midX, boxY + boxH).strokeColor(GREY).stroke();
  doc.moveTo(midX, boxY + rowH).lineTo(boxX + boxW, boxY + rowH).stroke();
  doc.moveTo(midX, boxY + rowH * 2).lineTo(boxX + boxW, boxY + rowH * 2).stroke();

  doc.fillColor('#000');
  doc.font('Helvetica-Bold').fontSize(8).text('NAME / COMPANY', boxX + 8, boxY + 6);
  doc.font('Helvetica-Bold').fontSize(10).text(report.customer_name || '-', boxX + 8, boxY + 17, { width: midX - boxX - 16 });
  doc.font('Helvetica-Bold').fontSize(8).text('ADDRESS', boxX + 8, boxY + 40);
  doc.font('Helvetica').fontSize(8.5).text(report.customer_address || '-', boxX + 8, boxY + 51, { width: midX - boxX - 16, height: 26, ellipsis: true });

  doc.font('Helvetica-Bold').fontSize(8).text('JOB SHEET NO', midX + 8, boxY + 6);
  doc.font('Helvetica-Bold').fontSize(10).text(report.job_ref || '-', midX + 8, boxY + 17);
  doc.font('Helvetica-Bold').fontSize(8).text('DATE', midX + 8, boxY + rowH + 6);
  doc.font('Helvetica').fontSize(9).text(report.service_date || '-', midX + 8, boxY + rowH + 17);
  doc.font('Helvetica-Bold').fontSize(8).text('PHONE / EMAIL', midX + 8, boxY + rowH * 2 + 6);
  doc.font('Helvetica').fontSize(8.5).text([report.customer_phone, report.customer_email].filter(Boolean).join('  /  ') || '-', midX + 8, boxY + rowH * 2 + 17, { width: boxX + boxW - midX - 16 });

  doc.x = LEFT;
  doc.y = boxY + boxH + 10;
  doc.fillColor('#000');

  // ---- Service type / technician ----
  let units = [];
  try { units = JSON.parse(report.units_json || '[]'); } catch (e) {}
  doc.font('Helvetica-Bold').fontSize(9).fillColor(NAVY).text('SERVICE TYPE:', LEFT, doc.y, { continued: true });
  doc.font('Helvetica').fillColor('#000').fontSize(9).text('  ' + (report.service_type || '-'));
  doc.font('Helvetica-Bold').fontSize(9).fillColor(NAVY).text('TECHNICIAN:', LEFT, doc.y + 2, { continued: true });
  doc.font('Helvetica').fillColor('#000').fontSize(9).text('  ' + (report.technician_name || '-'));
  doc.moveDown(0.4);

  // ---- Unit Type / Model / Serial No. table, each row paired with its own
  // Job Location so it's clear which unit belongs to which room/area rather
  // than listing all locations in one separate line. ----
  if (units.length) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(NAVY).text('UNIT TYPE / MODEL / SERIAL NO (BY JOB LOCATION)', LEFT, doc.y);
    doc.moveDown(0.15);

    const uX = LEFT, uW = WIDTH;
    const colNoW = uW * 0.05, colLocW = uW * 0.20, colModelW = uW * 0.20, colSerialW = uW * 0.20, colPsiW = uW * 0.175, colAmpW = uW * 0.175;
    const uHeadH = 16;

    doc.font('Helvetica').fontSize(8);
    const rowHeights = units.map(u => {
      const cells = [String(u.location || '-'), String(u.model || '-'), String(u.serial || '-'), String(u.psi || '-'), String(u.ampere || '-')];
      const widths = [colLocW, colModelW, colSerialW, colPsiW, colAmpW];
      const h = Math.max(...cells.map((t, i) => doc.heightOfString(t, { width: widths[i] - 8 })));
      return Math.max(16, h + 8);
    });
    const uTableH = uHeadH + rowHeights.reduce((a, b) => a + b, 0);
    if (doc.y + uTableH > 760) doc.addPage();

    const uY = doc.y;
    doc.rect(uX, uY, uW, uHeadH).fillAndStroke('#eef2f8', GREY);
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(7.5);
    let hx = uX;
    doc.text('NO', hx + 4, uY + 4, { width: colNoW - 6 }); hx += colNoW;
    doc.text('JOB LOCATION', hx + 4, uY + 4, { width: colLocW - 6 }); hx += colLocW;
    doc.text('MODEL', hx + 4, uY + 4, { width: colModelW - 6 }); hx += colModelW;
    doc.text('SERIAL NO', hx + 4, uY + 4, { width: colSerialW - 6 }); hx += colSerialW;
    doc.text('PRESSURE (PSI)', hx + 4, uY + 4, { width: colPsiW - 6, align: 'center' }); hx += colPsiW;
    doc.text('CURRENT (A)', hx + 4, uY + 4, { width: colAmpW - 6, align: 'center' });

    let ry = uY + uHeadH;
    doc.fillColor('#000').font('Helvetica').fontSize(8);
    units.forEach((u, i) => {
      const rh = rowHeights[i];
      doc.rect(uX, ry, uW, rh).strokeColor(GREY).lineWidth(0.75).stroke();
      let cx = uX;
      doc.text(String(i + 1), cx + 4, ry + 4, { width: colNoW - 6 });
      cx += colNoW;
      doc.moveTo(cx, ry).lineTo(cx, ry + rh).strokeColor(GREY).stroke();
      doc.text(u.location || '-', cx + 4, ry + 4, { width: colLocW - 8 });
      cx += colLocW;
      doc.moveTo(cx, ry).lineTo(cx, ry + rh).strokeColor(GREY).stroke();
      doc.text(u.model || '-', cx + 4, ry + 4, { width: colModelW - 8 });
      cx += colModelW;
      doc.moveTo(cx, ry).lineTo(cx, ry + rh).strokeColor(GREY).stroke();
      doc.text(u.serial || '-', cx + 4, ry + 4, { width: colSerialW - 8 });
      cx += colSerialW;
      doc.moveTo(cx, ry).lineTo(cx, ry + rh).strokeColor(GREY).stroke();
      doc.text(u.psi || '-', cx + 4, ry + 4, { width: colPsiW - 8, align: 'center' });
      cx += colPsiW;
      doc.moveTo(cx, ry).lineTo(cx, ry + rh).strokeColor(GREY).stroke();
      doc.text(u.ampere || '-', cx + 4, ry + 4, { width: colAmpW - 8, align: 'center' });
      ry += rh;
    });
    doc.y = ry + 8;
    doc.x = LEFT;
    doc.fillColor('#000');
  }

  // ---- Job description / cost table ----
  const tX = LEFT, tW = WIDTH;
  const colDescW = tW * 0.58, colQtyW = tW * 0.1, colPriceW = tW * 0.15, colAmtW = tW * 0.17;
  const descText = report.work_performed || report.complaint_description || report.service_type || '-';
  doc.font('Helvetica').fontSize(9);
  const descH = Math.max(18, doc.heightOfString(descText, { width: colDescW - 12 }) + 8);
  if (doc.y + 16 + descH > 760) doc.addPage();
  const tY = doc.y;
  const headH = 16;

  doc.rect(tX, tY, tW, headH).fillAndStroke('#eef2f8', GREY);
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(8.5);
  doc.text('JOB DESCRIPTION', tX + 6, tY + 4, { width: colDescW - 12 });
  doc.text('QTY', tX + colDescW, tY + 4, { width: colQtyW, align: 'center' });
  doc.text('U-PRICE (BND)', tX + colDescW + colQtyW, tY + 4, { width: colPriceW, align: 'center' });
  doc.text('AMOUNT (BND)', tX + colDescW + colQtyW + colPriceW, tY + 4, { width: colAmtW, align: 'center' });

  const rowY = tY + headH;
  doc.rect(tX, rowY, tW, descH).strokeColor(GREY).lineWidth(0.75).stroke();
  [colDescW, colDescW + colQtyW, colDescW + colQtyW + colPriceW].forEach(off => {
    doc.moveTo(tX + off, rowY).lineTo(tX + off, rowY + descH).stroke();
  });
  doc.fillColor('#000').font('Helvetica').fontSize(9);
  doc.text(descText, tX + 6, rowY + 4, { width: colDescW - 12 });
  doc.text('1', tX + colDescW, rowY + 4, { width: colQtyW, align: 'center' });
  doc.text(report.amount ? money(report.amount) : '-', tX + colDescW + colQtyW, rowY + 4, { width: colPriceW, align: 'center' });
  doc.text(report.amount ? money(report.amount) : '-', tX + colDescW + colQtyW + colPriceW, rowY + 4, { width: colAmtW, align: 'center' });

  doc.y = rowY + descH + 8;
  doc.x = LEFT;

  // ---- Sub Total / Discount / Net Total ----
  const subtotal = parseFloat(report.amount) || 0;
  const discount = parseFloat(report.discount) || 0;
  const net = subtotal - discount;
  const sumW = 200, sumX = RIGHT - sumW, sumRowH = 15;
  if (doc.y + sumRowH * 3 > 770) doc.addPage();
  const sumY = doc.y;
  const sumRows = [
    ['SUB TOTAL (BND)', money(subtotal)],
    ['DISCOUNT (BND)', money(discount)],
    ['NET TOTAL (BND)', money(net)]
  ];
  doc.rect(sumX, sumY, sumW, sumRowH * sumRows.length).strokeColor(GREY).lineWidth(0.75).stroke();
  sumRows.forEach(([label, value], i) => {
    const ry = sumY + i * sumRowH;
    if (i > 0) doc.moveTo(sumX, ry).lineTo(sumX + sumW, ry).strokeColor(GREY).stroke();
    const bold = i === sumRows.length - 1;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(bold ? NAVY : '#000');
    doc.text(label, sumX + 8, ry + 4, { width: sumW * 0.55 });
    doc.text(value, sumX + sumW * 0.55, ry + 4, { width: sumW * 0.45 - 8, align: 'right' });
  });

  doc.y = sumY + sumRowH * sumRows.length + 12;
  doc.x = LEFT;
  doc.fillColor('#000');

  // ---- Payment note & bank details ----
  doc.font('Helvetica').fontSize(7.5).fillColor('#555').text(
    'Kindly note that the customer hereby accepts the above goods and/or services and agrees to make full payment by the due date. In the event of non-payment, the customer agrees to bear all costs and expenses (including legal fees on a full indemnity basis) incurred by AEC Sdn Bhd in enforcing payment.',
    LEFT, doc.y, { width: WIDTH }
  );
  doc.moveDown(0.5);

  // Terms of Payment — ticks whichever method was recorded (Scheduler or
  // Technician), so it's clear at a glance how the customer paid.
  const paymentLabels = { cash: 'Cash', bank_transfer: 'Bank Transfer', check: 'Check' };
  const paymentKey = (report.payment_method || '').toLowerCase();
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(NAVY).text('Terms of Payment:', LEFT, doc.y, { continued: true });
  doc.font('Helvetica').fillColor('#000');
  Object.entries(paymentLabels).forEach(([key, label], i) => {
    doc.text('   ' + (paymentKey === key ? '[x] ' : '[ ] ') + label, { continued: i < Object.keys(paymentLabels).length - 1 });
  });
  doc.moveDown(0.4);

  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(NAVY).text('Account Name: AEC Sdn Bhd', LEFT, doc.y);
  doc.font('Helvetica').fontSize(8.5).fillColor('#000');
  doc.text('BIBD Account: 00-001-01-0019720');
  doc.text('Baiduri Account: 01-00-110-288838');
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(NAVY).text('AEC Service Centre: ', LEFT, doc.y, { continued: true });
  doc.font('Helvetica').fillColor('#000').text('2449431 / 8349431 / 8369431 / 8728726');
  doc.moveDown(0.8);
  doc.fillColor('#000');

  if (report.complaint_description) {
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#0b3d63').text('Nature of Complaint (as reported)');
    doc.fillColor('#000').font('Helvetica').fontSize(10).text(report.complaint_description);
    doc.moveDown(0.5);
  }

  doc.font('Helvetica-Bold').fontSize(11).fillColor('#0b3d63').text('Work Performed & Findings');
  doc.fillColor('#000').font('Helvetica').fontSize(10);
  doc.text(report.work_performed || '-', { align: 'left' });
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').fontSize(10).text('Findings / Diagnosis:');
  doc.font('Helvetica').text(report.findings || '-');
  doc.moveDown(0.5);

  let checklist = [];
  try { checklist = JSON.parse(report.checklist_json || '[]'); } catch (e) {}
  if (checklist.length) {
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#0b3d63').text('Checklist');
    doc.fillColor('#000').font('Helvetica').fontSize(10);
    checklist.forEach(item => {
      doc.text(`[${item.done ? 'x' : ' '}] ${item.label}`);
    });
    doc.moveDown(0.5);
  }

  let parts = [];
  try { parts = JSON.parse(report.parts_json || '[]'); } catch (e) {}
  if (parts.length) {
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#0b3d63').text('Parts / Materials Used');
    doc.fillColor('#000').font('Helvetica').fontSize(10);
    parts.forEach(p => {
      doc.text(`- ${p.name}  x${p.qty}`);
    });
    doc.moveDown(0.5);
  }

  if (report.technician_notes) {
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#0b3d63').text('Technician Notes');
    doc.fillColor('#000').font('Helvetica').fontSize(10).text(report.technician_notes);
    doc.moveDown(0.5);
  }
  if (report.recommendations) {
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#0b3d63').text('Recommendations');
    doc.fillColor('#000').font('Helvetica').fontSize(10).text(report.recommendations);
    doc.moveDown(0.3);
  }
  if (report.date_started || report.date_finished) {
    line('Date Started:', report.date_started);
    line('Date Finished:', report.date_finished);
  }
  if (report.head_remarks) {
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#0b3d63').text('Company Remarks');
    doc.fillColor('#000').font('Helvetica').fontSize(10).text(report.head_remarks);
  }

  // Photos
  let photos = [];
  try { photos = JSON.parse(report.photos_json || '[]'); } catch (e) {}
  if (photos.length) {
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#0b3d63').text('Photos');
    doc.moveDown(0.5);
    photos.forEach(fname => {
      const fpath = path.join(uploadsDir, fname);
      if (fs.existsSync(fpath)) {
        try {
          doc.image(fpath, { fit: [480, 300], align: 'center' });
          doc.moveDown(0.5);
        } catch (e) { /* skip bad image */ }
      }
    });
  }

  // Technician / team sign-off (hand-entered, bottom portion of the report)
  if (report.written_name || report.team_members) {
    doc.moveDown(0.5);
    if (doc.y > 650) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#0b3d63').text('Technician Sign-Off');
    doc.fillColor('#000').font('Helvetica').fontSize(10);
    line('Technician Name:', report.written_name);
    line('Team Member(s):', report.team_members);
    doc.moveDown(0.3);
  }

  // Signatures
  doc.moveDown(1);
  if (doc.y > 680) doc.addPage();
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#0b3d63').text('Signatures');
  doc.fillColor('#000').font('Helvetica').fontSize(10);
  doc.moveDown(0.3);

  const drawSignature = (label, value, fallback) => {
    if (doc.y > 650) doc.addPage();
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#000').text(label);
    const startX = doc.x;
    const startY = doc.y;
    if (value && value.startsWith('data:image')) {
      try {
        const base64 = value.split(',')[1];
        const buf = Buffer.from(base64, 'base64');
        // Place the image at a fixed position and manually advance the cursor
        // past it — doc.image() does not move doc.y on its own, which caused
        // the next signature block to overlap this one.
        doc.image(buf, startX, startY, { fit: [200, 70] });
        doc.y = startY + 75;
      } catch (e) {
        doc.font('Helvetica').text(fallback);
      }
    } else {
      doc.font('Helvetica').text(value || fallback);
    }
    doc.moveDown(0.6);
  };

  drawSignature('Technician:', report.technician_signature, report.technician_name);
  drawSignature('Customer:', report.customer_signature, report.customer_ack ? 'Acknowledged on site' : 'Not signed');
  doc.moveDown(0.5);
  doc.fontSize(8).fillColor('#888').text(`Generated by AEC Sdn Bhd Service Portal on ${new Date().toISOString().slice(0,10)}`, { align: 'center' });
}

// ---------- Excel / Word exports (Accounts department) ----------
function unitsSummary(unitsJson) {
  let units = [];
  try { units = JSON.parse(unitsJson || '[]'); } catch (e) {}
  return units.map((u, i) => `${i + 1}. ${u.location ? u.location + ' - ' : ''}${u.model || '-'} (SN ${u.serial || '-'})`).join('; ');
}

async function renderReportsXlsx(rows) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AEC Sdn Bhd Service Portal';
  const sheet = wb.addWorksheet('Service Reports');
  sheet.columns = [
    { header: 'Job Ref', key: 'job_ref', width: 12 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Service Date', key: 'service_date', width: 14 },
    { header: 'Customer Name', key: 'customer_name', width: 24 },
    { header: 'Phone', key: 'customer_phone', width: 16 },
    { header: 'Address', key: 'customer_address', width: 30 },
    { header: 'Technician', key: 'technician_name', width: 18 },
    { header: 'Unit(s) Serviced', key: 'units', width: 40 },
    { header: 'Amount (BND)', key: 'amount', width: 14 },
    { header: 'Sent to Accounts', key: 'accounts_sent_at', width: 18 },
    { header: 'Emailed to Customer', key: 'sent_at', width: 18 },
    { header: 'Cancelled', key: 'cancelled_at', width: 12 }
  ];
  sheet.getRow(1).font = { bold: true };
  rows.forEach((r) => {
    sheet.addRow({
      job_ref: r.job_ref,
      status: r.cancelled_at ? 'cancelled' : r.status,
      service_date: r.service_date || '',
      customer_name: r.customer_name || '',
      customer_phone: r.customer_phone || '',
      customer_address: r.customer_address || '',
      technician_name: r.technician_name || '',
      units: unitsSummary(r.units_json),
      amount: r.amount || '',
      accounts_sent_at: r.accounts_sent_at || '',
      sent_at: r.sent_at || '',
      cancelled_at: r.cancelled_at || ''
    });
  });
  return wb.xlsx.writeBuffer();
}

async function renderReportDocx(report) {
  let units = [];
  try { units = JSON.parse(report.units_json || '[]'); } catch (e) {}

  const cell = (text, opts) => new TableCell({
    width: { size: 50, type: WidthType.PERCENTAGE },
    children: [new Paragraph({ children: [new TextRun({ text: text || '-', bold: !!(opts && opts.bold) })] })]
  });
  const row = (label, value) => new TableRow({ children: [cell(label, { bold: true }), cell(value)] });

  const children = [
    new Paragraph({ text: 'AEC Sdn Bhd', heading: HeadingLevel.TITLE }),
    new Paragraph({ text: 'Air Conditioning Sales, Installation & Maintenance Services — Brunei Darussalam' }),
    new Paragraph({ text: '' }),
    new Paragraph({ text: `AIR-CONDITIONING SERVICE REPORT — ${report.job_ref}`, heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ text: '' }),
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        row('Service Date', report.service_date),
        row('Technician', report.technician_name),
        row('Amount Charged (BND)', report.amount),
        row('Customer Name', report.customer_name),
        row('Address', report.customer_address),
        row('Phone', report.customer_phone),
        row('Email', report.customer_email)
      ]
    }),
    new Paragraph({ text: '' }),
    new Paragraph({ text: 'Unit(s) Serviced', heading: HeadingLevel.HEADING_2 })
  ];

  if (units.length) {
    units.forEach((u, i) => {
      children.push(new Paragraph({ text: `${i + 1}. Location: ${u.location || '-'}   Model: ${u.model || '-'}   Serial No.: ${u.serial || '-'}   Operating Pressure (PSI): ${u.psi || '-'}   Current (Ampere): ${u.ampere || '-'}` }));
    });
  } else {
    children.push(new Paragraph({ text: 'No units recorded.' }));
  }

  children.push(new Paragraph({ text: '' }));
  children.push(new Paragraph({ text: 'Work Performed & Findings', heading: HeadingLevel.HEADING_2 }));
  children.push(new Paragraph({ text: report.work_performed || '-' }));
  children.push(new Paragraph({ text: 'Findings: ' + (report.findings || '-') }));

  if (report.head_remarks) {
    children.push(new Paragraph({ text: '' }));
    children.push(new Paragraph({ text: 'Company Remarks', heading: HeadingLevel.HEADING_2 }));
    children.push(new Paragraph({ text: report.head_remarks }));
  }

  children.push(new Paragraph({ text: '' }));
  children.push(new Paragraph({ text: `Generated by AEC Sdn Bhd Service Portal on ${new Date().toISOString().slice(0, 10)}` }));

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

app.get('/api/reports/:id/export.docx', requireAuth, requireAnyRole('head', 'account'), async (req, res) => {
  try {
    const row = await db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const buf = await renderReportDocx(row);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${row.job_ref}.docx"`);
    res.send(buf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate Word document' });
  }
});

// NOTE: registered as /api/export/reports.xlsx (not /api/reports/export.xlsx)
// so it can never be shadowed by the "GET /api/reports/:id" route above,
// which would otherwise treat "export.xlsx" as an :id value.
app.get('/api/export/reports.xlsx', requireAuth, requireAnyRole('head', 'account'), async (req, res) => {
  try {
    const rows = await db.prepare('SELECT * FROM reports ORDER BY created_at DESC').all();
    const buf = await renderReportsXlsx(rows);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="AEC-service-reports.xlsx"');
    res.send(buf);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate Excel export' });
  }
});

app.get('/api/reports/:id/pdf', requireAuth, async (req, res) => {
  try {
    const row = await db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (req.session.user.role === 'technician' && row.technician_id !== req.session.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (req.session.user.role === 'scheduler' && row.assigned_by !== req.session.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${row.job_ref}.pdf"`);
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    doc.pipe(res);
    renderReportPdf(doc, row);
    doc.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

// ---------- Email to customer ----------
app.post('/api/reports/:id/send', requireAuth, requireRole('head'), async (req, res) => {
  try {
    const row = await db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!row.customer_email) return res.status(400).json({ error: 'Customer email not set on this report' });

    if (!process.env.SMTP_HOST) {
      return res.status(400).json({ error: 'Email is not configured on this server yet. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM in the .env file.' });
    }

    // Render PDF to buffer
    const chunks = [];
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    doc.on('data', c => chunks.push(c));
    const done = new Promise(resolve => doc.on('end', resolve));
    renderReportPdf(doc, row);
    doc.end();
    await done;
    const pdfBuffer = Buffer.concat(chunks);

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: row.customer_email,
      subject: `AEC Sdn Bhd - Service Report ${row.job_ref}`,
      text: `Dear ${row.customer_name},\n\nPlease find attached the service report for your air-conditioning unit (Job Ref: ${row.job_ref}).\n\nThank you for choosing AEC Sdn Bhd.\n\nRegards,\nAEC Sdn Bhd`,
      attachments: [{ filename: `${row.job_ref}.pdf`, content: pdfBuffer }]
    });

    await db.prepare("UPDATE reports SET status = 'sent', sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send email: ' + err.message });
  }
});

// Wait for the database (schema + migrations + account upserts) to be ready
// before accepting traffic.
ready.then(() => {
  app.listen(PORT, () => {
    console.log(`AEC Sdn Bhd portal running on http://localhost:${PORT}`);
  });
}).catch((err) => {
  console.error('Failed to start server — database was not ready:', err);
  process.exit(1);
});
