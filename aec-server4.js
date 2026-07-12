require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const db = require('./datastore4');

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

app.use(session({
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
function genJobRef() {
  const year = new Date().getFullYear();
  const row = db.prepare("SELECT COUNT(*) AS c FROM reports WHERE job_ref LIKE ?").get(`AEC-${year}-%`);
  const seq = String(row.c + 1).padStart(4, '0');
  return `AEC-${year}-${seq}`;
}

// ---------- Auth routes ----------
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  req.session.user = { id: user.id, name: user.name, role: user.role, username: user.username };
  res.json({ user: req.session.user });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

// ---------- Technicians list (for scheduler assignment dropdown) ----------
app.get('/api/technicians', requireAuth, (req, res) => {
  const rows = db.prepare("SELECT id, name, username FROM users WHERE role = 'technician' ORDER BY name").all();
  res.json({ technicians: rows });
});

// ---------- Scheduler: create a job assignment ----------
app.post('/api/jobs', requireAuth, requireRole('scheduler'), (req, res) => {
  try {
    const b = req.body;
    const jobSheetNo = (b.job_sheet_no || '').trim();
    const customerName = (b.customer_name || '').trim();
    const customerAddress = (b.customer_address || '').trim();
    const customerPhone = (b.customer_phone || '').trim();

    // Job Sheet No., Customer Name, Address, and Contact Number must all be
    // filled in before a job can be assigned to a technician.
    if (!jobSheetNo || jobSheetNo.toUpperCase() === 'K') {
      return res.status(400).json({ error: 'Job Sheet No. is required' });
    }
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
    const tech = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'technician'").get(b.technician_id);
    if (!tech) return res.status(400).json({ error: 'Selected technician not found' });

    const jobRef = genJobRef();
    const stmt = db.prepare(`INSERT INTO reports
      (job_ref, technician_id, technician_name, service_date, service_type,
       customer_name, customer_address, customer_phone, complaint_description,
       job_sheet_no, amount, assigned_by, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const info = stmt.run(
      jobRef,
      tech.id,
      tech.name,
      b.service_date || '',
      b.service_type || '',
      customerName,
      customerAddress,
      customerPhone,
      b.complaint_description,
      jobSheetNo,
      b.amount || '',
      req.session.user.id,
      'assigned'
    );
    res.json({ ok: true, id: info.lastInsertRowid, job_ref: jobRef });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create job' });
  }
});

// ---------- Report routes ----------

// Create report (technician, ad-hoc / walk-in job with no scheduler involved)
app.post('/api/reports', requireAuth, requireRole('technician'), upload.array('photos', 8), (req, res) => {
  try {
    const b = req.body;
    if (!b.date_started || !b.date_finished) {
      return res.status(400).json({ error: 'Date Started and Date Finished are required.' });
    }
    if (!b.technician_signature || !b.customer_signature) {
      return res.status(400).json({ error: 'Both the technician and customer signatures are required before the report can be submitted.' });
    }
    const jobRef = genJobRef();
    const photos = (req.files || []).map(f => f.filename);

    const stmt = db.prepare(`INSERT INTO reports
      (job_ref, technician_id, technician_name, service_date, service_type,
       customer_name, customer_address, customer_email, customer_phone,
       unit_location, unit_details, job_sheet_no, written_name, team_members, amount,
       checklist_json, work_performed, findings,
       parts_json, photos_json, technician_notes, recommendations, date_started, date_finished,
       technician_signature, customer_signature, customer_ack, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    // Job Sheet No. is assigned by the scheduler (or later by the head) —
    // technicians never set it themselves, even on ad-hoc/walk-in reports.
    const info = stmt.run(
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
      b.unit_details || '',
      'K',
      b.written_name || '',
      b.team_members || '',
      b.amount || '',
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
app.post('/api/reports/:id/complete', requireAuth, requireRole('technician'), upload.array('photos', 8), (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.technician_id !== req.session.user.id) return res.status(403).json({ error: 'Forbidden' });
    if (row.status !== 'assigned') return res.status(400).json({ error: 'This job has already been completed' });

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

    // Job Sheet No. is not touched here — it was set by the scheduler when
    // the job was created and stays as-is; only the head can change it.
    db.prepare(`UPDATE reports SET
        service_date = ?, service_type = ?,
        customer_name = ?, customer_address = ?, customer_email = ?, customer_phone = ?,
        unit_location = ?, unit_details = ?, written_name = ?, team_members = ?, amount = ?,
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
      b.unit_details || '',
      b.written_name || '',
      b.team_members || '',
      b.amount || '',
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
app.get('/api/reports', requireAuth, (req, res) => {
  let rows;
  if (req.session.user.role === 'head') {
    rows = db.prepare('SELECT * FROM reports ORDER BY created_at DESC').all();
  } else if (req.session.user.role === 'scheduler') {
    rows = db.prepare('SELECT * FROM reports WHERE assigned_by = ? ORDER BY created_at DESC').all(req.session.user.id);
  } else {
    rows = db.prepare('SELECT * FROM reports WHERE technician_id = ? ORDER BY created_at DESC').all(req.session.user.id);
  }
  res.json({ reports: rows });
});

// Get single report
app.get('/api/reports/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const role = req.session.user.role;
  if (role === 'technician' && row.technician_id !== req.session.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (role === 'scheduler' && row.assigned_by !== req.session.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json({ report: row });
});

// Update / review report (head only)
app.put('/api/reports/:id', requireAuth, requireRole('head'), (req, res) => {
  const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const b = req.body;
  const fields = ['customer_name','customer_address','customer_email','customer_phone',
    'unit_location','unit_details','complaint_description','job_sheet_no','written_name','team_members','amount',
    'work_performed','findings','technician_notes',
    'recommendations','date_started','date_finished','head_remarks','service_type','status'];
  const updates = [];
  const values = [];
  fields.forEach(f => {
    if (b[f] !== undefined) { updates.push(`${f} = ?`); values.push(b[f]); }
  });
  if (b.parts_json !== undefined) { updates.push('parts_json = ?'); values.push(b.parts_json); }
  if (b.checklist_json !== undefined) { updates.push('checklist_json = ?'); values.push(b.checklist_json); }
  updates.push("updated_at = datetime('now')");
  values.push(req.params.id);
  db.prepare(`UPDATE reports SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json({ ok: true });
});

// Approve report (head only)
app.post('/api/reports/:id/approve', requireAuth, requireRole('head'), (req, res) => {
  db.prepare("UPDATE reports SET status = 'approved', updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ---------- PDF generation ----------
// Renders report content into an already-created PDFDocument. Caller owns
// creating the document and piping/collecting its output.
function renderReportPdf(doc, report) {
  // Letterhead
  doc.fillColor('#0b3d63').fontSize(20).font('Helvetica-Bold').text('AEC Sdn Bhd', 50, 50);
  doc.fillColor('#444').fontSize(9).font('Helvetica')
    .text('Air Conditioning Sales, Installation & Maintenance Services', 50)
    .text('Brunei Darussalam', 50);
  const afterLetterheadY = doc.y;

  // Job Sheet No. — top right corner, prefilled to start with "K"
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#0b3d63')
    .text('Job Sheet No.', 350, 50, { width: 195, align: 'right' });
  doc.fontSize(14).font('Helvetica-Bold').fillColor('#000')
    .text(report.job_sheet_no || 'K', 350, 63, { width: 195, align: 'right' });

  doc.y = afterLetterheadY;
  doc.x = 50;
  doc.moveTo(50, doc.y + 8).lineTo(545, doc.y + 8).strokeColor('#0b3d63').lineWidth(1.5).stroke();
  doc.moveDown(1.5);

  doc.fillColor('#0b3d63').fontSize(14).font('Helvetica-Bold').text('AIR-CONDITIONING SERVICE REPORT', { align: 'center' });
  doc.moveDown(0.8);
  doc.fillColor('#000');

  const line = (label, value) => {
    doc.font('Helvetica-Bold').fontSize(10).text(label, { continued: true });
    doc.font('Helvetica').fontSize(10).text('  ' + (value || '-'));
  };

  doc.font('Helvetica-Bold').fontSize(11).text('Job Reference: ' + report.job_ref);
  doc.moveDown(0.3);
  line('Service Date:', report.service_date);
  line('Service Type:', report.service_type);
  line('Technician:', report.technician_name);
  if (report.amount) {
    line('Amount Charged (BND):', report.amount);
  }
  doc.moveDown(0.5);

  doc.font('Helvetica-Bold').fontSize(11).fillColor('#0b3d63').text('Customer Details');
  doc.fillColor('#000');
  line('Name:', report.customer_name);
  line('Address:', report.customer_address);
  line('Phone:', report.customer_phone);
  line('Email:', report.customer_email);
  line('Unit Location:', report.unit_location);
  line('Unit Details:', report.unit_details);
  doc.moveDown(0.5);

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

app.get('/api/reports/:id/pdf', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
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
});

// ---------- Email to customer ----------
app.post('/api/reports/:id/send', requireAuth, requireRole('head'), async (req, res) => {
  const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!row.customer_email) return res.status(400).json({ error: 'Customer email not set on this report' });

  if (!process.env.SMTP_HOST) {
    return res.status(400).json({ error: 'Email is not configured on this server yet. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM in the .env file.' });
  }

  try {
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

    db.prepare("UPDATE reports SET status = 'sent', sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send email: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`AEC Sdn Bhd portal running on http://localhost:${PORT}`);
});
