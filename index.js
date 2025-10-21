// mailserver.js
const express = require("express");
const multer = require("multer");
const nodemailer = require("nodemailer");
const cors = require("cors");
const readXlsxFile = require("read-excel-file/node");
const dotenv = require("dotenv");
const { neon } = require("@neondatabase/serverless");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
dotenv.config();

const admin = require('firebase-admin');
if (!process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
  console.error("❌ Missing FIREBASE_SERVICE_ACCOUNT_BASE64");
  process.exit(1);
}
const serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8"));
admin.initializeApp({credential: admin.credential.cert(serviceAccount)});
const db = admin.firestore();


const app = express();
const PORT = process.env.PORT || 3001;
const client = neon(process.env.DATABASE_URL);

app.use(express.json());
app.use(cors());

// ------------------ UPLOAD FOLDER ------------------
const upload = multer({ dest: "uploads/" });
const uploadPath = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath);

// ------------------ DATABASE ------------------
(async () => {
  try {
    await client`
      CREATE TABLE IF NOT EXISTS sent_emails (
        id SERIAL PRIMARY KEY,
        name TEXT,
        email TEXT,
        subject TEXT,
        message TEXT,
        filename TEXT,
        sent_at TIMESTAMP DEFAULT NOW()
      )
    `;
    await client`
      CREATE TABLE IF NOT EXISTS received_emails (
        id TEXT PRIMARY KEY,
        from_email TEXT,
        to_email TEXT,
        subject TEXT,
        date TIMESTAMP
      )
    `;
    await client`
      CREATE TABLE IF NOT EXISTS emails (
        id TEXT PRIMARY KEY,
        from_email TEXT,
        to_email TEXT,
        subject TEXT,
        date TIMESTAMP,
        snippet TEXT
      )
    `;
    await client`
      CREATE TABLE IF NOT EXISTS emails1 (
        message_id TEXT PRIMARY KEY,
        thread_id TEXT,
        history_id TEXT,
        from_email TEXT,
        subject TEXT,
        received_at TIMESTAMP,
        snippet TEXT
      )
    `;
    await client`
      CREATE TABLE IF NOT EXISTS gmail_sync_state (
        id SERIAL PRIMARY KEY,
        history_id BIGINT UNIQUE
      )
    `;
    console.log("✅ Tables ready");
  } catch (err) {
    console.error("❌ Error creating tables:", err);
  }
})();

// ------------------ GOOGLE OAUTH2 ------------------
function getAuth() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  if (process.env.GOOGLE_REFRESH_TOKEN) {
    auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  }
  return auth;
}

// ------------------ SMTP TRANSPORTER ------------------
function createTransporterSMTP() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

// ------------------ SEND SINGLE EMAIL ------------------
app.post("/api/send-emails", upload.single("attachment"), async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;
    const file = req.file;
    const transporter = createTransporterSMTP();
    const attachments = file ? [{ filename: file.originalname, path: file.path }] : [];

    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: email,
      subject,
      text: message,
      attachments,
    });

    await client`
      INSERT INTO sent_emails (name, email, subject, message, filename)
      VALUES (${name}, ${email}, ${subject}, ${message}, ${file ? file.originalname : null})
      RETURNING *
    `;

    const savedId = Math.floor(1000000000 + Math.random() * 9000000000).toString();
    const savedEmail = { id: savedId, From:process.env.SMTP_USER,to:email, subject, message, sent_at: new Date().toISOString(),};
    await db.collection("sent_emails").doc(savedId.toString()).set(savedEmail);

    res.status(200).json({ message: "✅ Email sent successfully!", email: savedEmail });
  } catch (err) {
    console.error("❌ Error sending email:", err);
    res.status(500).json({ message: "Failed to send email" });
  }
});

// ------------------ BULK EMAIL IMPORT ------------------
app.post("/api/import-emails", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    const { subject: commonSubject, message: commonMessage } = req.body;
    if (!commonSubject || !commonMessage)
      return res.status(400).json({ message: "Subject and message are required" });

    const rows = await readXlsxFile(req.file.path);
    const headerRow = rows[0].map((c) => c.toString().toLowerCase());
    const dataRows = headerRow.includes("email") ? rows.slice(1) : rows;

    const transporter = createTransporterSMTP();
    const failedEmails = [];

    for (const row of dataRows) {
      let name = null;
      let email = null;
      let subject = commonSubject;
      let message = commonMessage;

      if (row.length === 1) email = row[0];
      else if (row.length === 2) {
        name = row[0];
        email = row[1];
      } else if (row.length >= 4) {
        name = row[0];
        email = row[1];
        subject = row[2] || commonSubject;
        message = row[3] || commonMessage;
      }

      if (!email) continue;

      try {
        // Send email
        await transporter.sendMail({ from: process.env.SMTP_USER, to: email, subject, text: message });

        // Store in Neon (serverless client)
        const neonResult = await client`
          INSERT INTO sent_emails (name, email, subject, message, filename)
          VALUES (${name}, ${email}, ${subject}, ${message}, ${req.file.originalname})
          RETURNING id
        `;

        // Store in Firebase
        const savedId = Math.floor(1000000000 + Math.random() * 9000000000).toString();
        const savedEmail = { id: savedId, From:process.env.SMTP_USER,to:email, subject, message, sent_at: new Date().toISOString(),};
        await db.collection("sent_emails").doc(savedId.toString()).set(savedEmail);

      } catch (err) {
        console.error(`❌ Failed to send/store ${email}:`, err.message || err);
        failedEmails.push(email);
      }
    }

    res.json({ message: "✅ Bulk emails processed", failedEmails });
  } catch (err) {
    console.error("❌ Bulk import error:", err);
    res.status(500).json({ message: "Failed to send bulk emails" });
  }
});


// --------------- FETCH LAST 30 DAYS EMAILS ---------------
async function fetchLastMonthEmails() {
  const gmail = google.gmail({ version: "v1", auth: getAuth() });
  const query = "newer_than:30d";

  const listRes = await gmail.users.messages.list({ userId: "me", maxResults: 100, q: query,});

  const messages = listRes.data.messages || [];
  const emails = [];

  for (const msg of messages) {
    const email = await gmail.users.messages.get({ userId: "me", id: msg.id, format: "metadata", metadataHeaders: ["From", "Subject", "Date"],});

    const headers = email.data.payload?.headers || [];
    emails.push({
      id: msg.id,
      threadId: msg.threadId,
      historyId: email.data.historyId || null,
      from: headers.find((h) => h.name === "From")?.value || null,
      subject: headers.find((h) => h.name === "Subject")?.value || null,
      date: headers.find((h) => h.name === "Date")?.value || null,
      snippet: email.data.snippet || null,
    });
  }

  return { emails };
}

// --------------- FETCH NEW EMAILS USING HISTORY ---------------
async function fetchNewEmails(startHistoryId) {
  if (!startHistoryId) return [];

  const gmail = google.gmail({ version: "v1", auth: getAuth() });

  const historyRes = await gmail.users.history.list({
    userId: "me",
    startHistoryId,
    historyTypes: ["messageAdded"],
    maxResults: 100,
  });

  const history = historyRes.data.history || [];
  const newMessages = [];

  for (const h of history) {
    if (!h.messagesAdded) continue;
    for (const m of h.messagesAdded) {
      const email = await gmail.users.messages.get({
        userId: "me",
        id: m.message.id,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date"],
      });

      const headers = email.data.payload?.headers || [];
      newMessages.push({
        id: m.message.id,
        threadId: m.message.threadId,
        historyId: email.data.historyId || null,
        from: headers.find((h) => h.name === "From")?.value || null,
        subject: headers.find((h) => h.name === "Subject")?.value || null,
        date: headers.find((h) => h.name === "Date")?.value || null,
        snippet: email.data.snippet || null,
      });
    }
  }

  return newMessages;
}

// ------------------ READ MAILS ENDPOINT ------------------
app.get("/read-mails", async (req, res) => {
  try {
    const lastSync = await client`
      SELECT history_id FROM gmail_sync_state ORDER BY history_id DESC LIMIT 1
    `;
    const lastHistoryId = lastSync[0]?.history_id || null;

    const emailsRef = db.collection("inbox");
    let emailsToSync = [];

    try {
      if (lastHistoryId) {
        // Try fetching new emails via history
        emailsToSync = await fetchNewEmails(lastHistoryId);
      } else {
        throw new Error("No historyId, fallback to last 30 days fetch");
      }
    } catch (err) {
      console.warn("⚠️ History fetch failed, falling back to last 30 days fetch:", err.message);
      const { emails } = await fetchLastMonthEmails();
      emailsToSync = emails;
    }

    const syncedEmails = [];

    for (const e of emailsToSync) {
      const date = e.date ? new Date(e.date) : new Date();
      if (!e.from || e.from.includes(process.env.SMTP_USER)) continue;

      // Insert into NeonDB
      await client`
        INSERT INTO emails (id, from_email, to_email, subject, date, snippet)
        VALUES (${e.id}, ${e.from}, ${process.env.SMTP_USER}, ${e.subject}, ${date.toISOString()}, ${e.snippet})
        ON CONFLICT (id) DO NOTHING
      `;

      // Insert into Firebase
      await emailsRef.doc(e.id).set({ id: e.id, from: e.from, to: process.env.SMTP_USER, subject: e.subject, message: e.snippet, received_at: date.toISOString(),});

      syncedEmails.push(e);
    }

    // Update latest historyId if available
    const newestHistoryId = emailsToSync[emailsToSync.length - 1]?.historyId;
    if (newestHistoryId) {
      await client`
        INSERT INTO gmail_sync_state (history_id)
        VALUES (${newestHistoryId})
        ON CONFLICT (history_id) DO NOTHING
      `;
    }

    res.json({
      message: "✅ Emails synced",
      added: syncedEmails.length,
      emails: syncedEmails,
    });
  } catch (err) {
    console.error("❌ Error in /read-mails:", err);
    res.status(500).json({ error: "Failed to fetch emails" });
  }
});


// ------------------ START SERVER ------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
