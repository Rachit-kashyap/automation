// ========================== BACKEND (server.js) ==========================
// Requirements: npm i express cors socket.io nodemailer dotenv
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const nodemailer = require("nodemailer");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// ---------- MIDDLEWARE ----------
app.use(cors());
app.use(express.json());   // FIXED: use JSON parser instead of text()
app.use(express.urlencoded({ extended: true }));

// Global state for active sending session
let activeSending = false;
let stopSending = false;
let currentSendingProcess = null; // reference to promise resolver (optional)

// Helper to reset flags
function resetSendingFlags() {
  stopSending = false;
  activeSending = false;
  currentSendingProcess = null;
}

// ---------- SOCKET.IO events ----------
io.on("connection", (socket) => {
  console.log(`🟢 Client connected: ${socket.id}`);
  socket.emit("message", "Connected to RocketMail backend");

  socket.on("terminate-process", () => {
    if (activeSending) {
      stopSending = true;
      console.log("🛑 Termination requested by client");
      io.emit("terminated", "🛑 Email dispatch terminated by user");
    } else {
      socket.emit("email-status", { message: "ℹ️ No active email process to terminate" });
    }
  });

  socket.on("disconnect", () => {
    console.log(`🔴 Client disconnected: ${socket.id}`);
  });
});

// ---------- EMAIL SENDER ENGINE ----------
async function sendEmails(emailList) {
  // Reset stop flag at the start of actual sending
  stopSending = false;

  const senderAccounts = [
    { user: process.env.EMAIL_USER1, pass: process.env.EMAIL_PASS1 },
    { user: process.env.EMAIL_USER2, pass: process.env.EMAIL_PASS2 },
  ].filter(acc => acc.user && acc.pass);

  if (senderAccounts.length === 0) {
    io.emit("email-error", "No sender email credentials in .env file");
    activeSending = false;
    return;
  }

  const transporters = senderAccounts.map(acc =>
    nodemailer.createTransport({
      service: "gmail",
      auth: { user: acc.user, pass: acc.pass },
    })
  );

  let sentCount = 0;
  const total = emailList.length;
  io.emit("progress", { current: 0, total });

  for (let i = 0; i < total; i++) {
    if (stopSending) {
      console.log("🛑 Sending stopped by terminate signal");
      io.emit("terminated", "🛑 Campaign was terminated before completion");
      activeSending = false;
      return;
    }

    const receiverEmail = emailList[i];
    // rotate sender every 50 emails, fallback to round-robin
    const senderIndex = Math.floor(sentCount / 50) % senderAccounts.length;
    const transporter = transporters[senderIndex];
    const senderEmail = senderAccounts[senderIndex].user;

    try {
      await transporter.sendMail({
        from: `"Rachit Kumar" <${senderEmail}>`,
        to: receiverEmail,
        subject: "Backend Developer Internship Opportunity",
        text: "Hello,\n\nPlease find my resume attached for the Backend Developer Internship role.\nLooking forward to your positive response.\n\nRegards,\nRachit Kumar",
        attachments: [
          {
            filename: "Resume_Rachit.pdf",
            path: path.join(__dirname, "Resume.pdf"),
          },
        ],
      });
      io.emit("email-status", { message: `✅ Delivered to ${receiverEmail}` });
    } catch (error) {
      io.emit("email-status", { message: `❌ Failed: ${receiverEmail} - ${error.message}` });
    }

    sentCount++;
    io.emit("progress", { current: sentCount, total });

    // Delay 5 seconds between emails to respect rate limits
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  io.emit("completed", { message: `🎉 Successfully processed ${sentCount} emails! Campaign finished.` });
  activeSending = false;
  stopSending = false;
}

// ---------- EXTRACT & FILTER EMAILS ----------
function extractValidEmails(rawText) {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const matches = rawText.match(emailRegex) || [];
  const filtered = matches
    .map(e => e.toLowerCase())
    .filter(email => email.endsWith(".com"));
  return [...new Set(filtered)];
}

// ---------- API ROUTE (EMAIL FILTER) ----------
app.post("/api/v1/22343/email-filter", async (req, res) => {
  try {
    const { userId, password, emails } = req.body;

    // Validate authentication from .env
    const validUserId = process.env.USERID;
    const validPassword = process.env.PASSWORD;

    if (!validUserId || !validPassword) {
      return res.status(500).json({ success: false, message: "Server missing auth credentials" });
    }

    if (userId !== validUserId || password !== validPassword) {
      return res.status(401).json({ success: false, message: "Authentication failed: Invalid User ID or Password" });
    }

    if (!emails || typeof emails !== "string") {
      return res.status(400).json({ success: false, message: "Emails field is required and must be text" });
    }

    const uniqueEmails = extractValidEmails(emails);
    if (uniqueEmails.length === 0) {
      return res.status(200).json({
        success: true,
        total: 0,
        message: "No valid .com email addresses found",
        emails: [],
      });
    }

    // Check if another sending process is already active
    if (activeSending) {
      return res.status(409).json({
        success: false,
        message: "Another email campaign is already running. Please wait or terminate it.",
      });
    }

    // Start sending process asynchronously (non-blocking)
    activeSending = true;
    // Fire & forget sending emails
    sendEmails(uniqueEmails).catch((err) => {
      console.error("Email sender crashed", err);
      io.emit("email-error", "Internal error while sending emails");
      activeSending = false;
    });

    return res.json({
      success: true,
      total: uniqueEmails.length,
      emails: uniqueEmails,
      message: `Campaign started for ${uniqueEmails.length} recipients`,
    });
  } catch (err) {
    console.error("API Error:", err);
    if (activeSending) activeSending = false;
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// Optional: health check
app.get("/health", (req, res) => res.json({ status: "ok" }));

// ---------- START SERVER ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 RocketMail backend live on port ${PORT}`);
  console.log(`   - Socket.IO ready`);
  console.log(`   - Make sure .env has USERID, PASSWORD, EMAIL_USER1, EMAIL_PASS1, EMAIL_USER2, EMAIL_PASS2`);
});