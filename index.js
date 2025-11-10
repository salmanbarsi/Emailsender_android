// ---------------------- IMPORTS ----------------------
const express = require("express");
const multer = require("multer");
const { google } = require("googleapis");
const cors = require("cors");
const readXlsxFile = require("read-excel-file/node");
const dotenv = require("dotenv");
const { neon } = require("@neondatabase/serverless");
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

dotenv.config();

// ---------------------- FIREBASE INIT ----------------------
if (!process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
  console.error("❌ Missing FIREBASE_SERVICE_ACCOUNT_BASE64");
  process.exit(1);
}
const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8")
);

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ---------------------- EXPRESS INIT ----------------------
const app = express();
const PORT = process.env.PORT || 3001;
const client = neon(process.env.DATABASE_URL);

app.use(express.json());
app.use(cors());

// ---------------------- GOOGLE AUTH: GENERATE REFRESH TOKEN ----------------------
app.get("/auth/google", (req, res) => {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/userinfo.email",
      "openid",
    ],
  });

  console.log("🔗 Visit this URL to authorize:", authUrl);
  res.redirect(authUrl);
});

app.get("/auth/google/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send("❌ Missing 'code' query parameter.");

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  try {
    const { tokens } = await oauth2Client.getToken(code);
    console.log("✅ REFRESH TOKEN:", tokens.refresh_token);

    if (tokens.refresh_token) {
      await db.collection("oauth_tokens").doc("gmail").set({
        refresh_token: tokens.refresh_token,
        created_at: new Date().toISOString(),
      });
    }

    res.send(
      "✅ Refresh token generated successfully! Check your console logs or Firestore collection 'oauth_tokens/gmail'."
    );
  } catch (err) {
    console.error("❌ OAuth callback failed:", err);
    res.status(500).send("OAuth failed: " + err.message);
  }
});

// ---------------------- FILE UPLOAD ----------------------
const upload = multer({ dest: "uploads/" });
const uploadPath = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath);

// ---------------------- DATABASE INIT ----------------------
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
      );
    `;
    await client`
      CREATE TABLE IF NOT EXISTS gmail_sync_state (
        history_id TEXT PRIMARY KEY
      );
    `;
    await client`
      CREATE TABLE IF NOT EXISTS emails (
        id TEXT PRIMARY KEY,
        from_email TEXT,
        to_email TEXT,
        subject TEXT,
        date TEXT,
        snippet TEXT
      );
    `;
    console.log("✅ Tables ready");
  } catch (err) {
    console.error("❌ Error creating tables:", err);
  }
})();

// ---------------------- GOOGLE AUTH (GET AUTH) ----------------------
async function getAuth() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  let refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!refreshToken) {
    try {
      const doc = await db.collection("oauth_tokens").doc("gmail").get();
      if (doc.exists) refreshToken = doc.data().refresh_token;
    } catch (err) {
      console.warn("⚠️ Could not load refresh token from Firestore:", err.message);
    }
  }

  if (refreshToken) {
    auth.setCredentials({ refresh_token: refreshToken });
  } else {
    console.warn("⚠️ No refresh token found. Visit /auth/google to generate one.");
  }

  return auth;
}

// ---------------------- GMAIL SEND FUNCTION ----------------------
async function sendMail({ to, subject, text, attachments = [] }) {
  const auth = await getAuth();
  const gmail = google.gmail({ version: "v1", auth });

  const messageParts = [
    `From: ${process.env.SMTP_USER}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: multipart/mixed; boundary=boundary_string",
    "",
    "--boundary_string",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    text,
  ];

  for (const file of attachments) {
    const fileContent = fs.readFileSync(file.path).toString("base64");
    messageParts.push(
      "--boundary_string",
      `Content-Type: application/octet-stream; name="${file.filename}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${file.filename}"`,
      "",
      fileContent
    );
  }

  messageParts.push("--boundary_string--");

  const raw = Buffer.from(messageParts.join("\n"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });
}

// ---------------------- SINGLE EMAIL ----------------------
app.post("/api/send-emails", upload.single("attachment"), async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;
    const file = req.file;
    const attachments = file ? [{ filename: file.originalname, path: file.path }] : [];

    await sendMail({ to: email, subject, text: message, attachments });

    await client`
      INSERT INTO sent_emails (name, email, subject, message, filename)
      VALUES (${name}, ${email}, ${subject}, ${message}, ${file ? file.originalname : null});
    `;

    const savedId = Math.floor(1000000000 + Math.random() * 9000000000).toString();
    const savedEmail = {
      id: savedId,
      from: process.env.SMTP_USER,
      to: email,
      subject,
      message,
      sent_at: new Date().toISOString(),
    };
    await db.collection("sent_emails").doc(savedId.toString()).set(savedEmail);

    res.json({ message: "✅ Email sent successfully!", email: savedEmail });
  } catch (err) {
    console.error("❌ Error sending email:", err);
    res.status(500).json({ message: "Failed to send email" });
  }
});

// ---------------------- BULK EMAIL ----------------------
app.post("/api/import-emails", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    const { subject: commonSubject, message: commonMessage } = req.body;
    if (!commonSubject || !commonMessage)
      return res.status(400).json({ message: "Subject and message are required" });

    const rows = await readXlsxFile(req.file.path);
    const headerRow = rows[0].map((c) => c.toString().toLowerCase());
    const dataRows = headerRow.includes("email") ? rows.slice(1) : rows;

    const failedEmails = [];

    for (const row of dataRows) {
      let name = null,
        email = null,
        subject = commonSubject,
        message = commonMessage;

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
        await sendMail({ to: email, subject, text: message });

        await client`
          INSERT INTO sent_emails (name, email, subject, message, filename)
          VALUES (${name}, ${email}, ${subject}, ${message}, ${req.file.originalname});
        `;

        const savedId = Math.floor(1000000000 + Math.random() * 9000000000).toString();
        const savedEmail = {
          id: savedId,
          from: process.env.SMTP_USER,
          to: email,
          subject,
          message,
          sent_at: new Date().toISOString(),
        };
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
  const auth = await getAuth();
  const gmail = google.gmail({ version: "v1", auth });
  const query = "newer_than:30d";

  const listRes = await gmail.users.messages.list({
    userId: "me",
    maxResults: 50,
    q: query,
  });

  const messages = listRes.data.messages || [];
  const emails = [];

  for (const msg of messages) {
    const email = await gmail.users.messages.get({
      userId: "me",
      id: msg.id,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"],
    });

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

  const auth = await getAuth();
  const gmail = google.gmail({ version: "v1", auth });

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
      SELECT history_id FROM gmail_sync_state ORDER BY history_id DESC LIMIT 1;
    `;
    const lastHistoryId = lastSync[0]?.history_id || null;

    const emailsRef = db.collection("inbox");
    let emailsToSync = [];

    try {
      if (lastHistoryId) {
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

      await client`
        INSERT INTO emails (id, from_email, to_email, subject, date, snippet)
        VALUES (${e.id}, ${e.from}, ${process.env.SMTP_USER}, ${e.subject}, ${date.toISOString()}, ${e.snippet})
        ON CONFLICT (id) DO NOTHING;
      `;

      await emailsRef.doc(e.id).set({
        id: e.id,
        from: e.from,
        to: process.env.SMTP_USER,
        subject: e.subject,
        message: e.snippet,
        received_at: date.toISOString(),
      });

      syncedEmails.push(e);
    }

    const newestHistoryId = emailsToSync[emailsToSync.length - 1]?.historyId;
    if (newestHistoryId) {
      await client`
        INSERT INTO gmail_sync_state (history_id)
        VALUES (${newestHistoryId})
        ON CONFLICT (history_id) DO NOTHING;
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

// ---------------------- START SERVER ----------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
