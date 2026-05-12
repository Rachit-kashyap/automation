// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const nodemailer = require("nodemailer");
const path = require("path");
const dns = require("dns");
const { promisify } = require("util");

const app = express();
const server = http.createServer(app);

// ---------- Socket.IO ----------
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  path: "/socket.io",
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let activeSending = false;
let stopSending = false;

// ---------- FORCE IPv4 for Gmail SMTP ----------
// Option 1: Use `family: 4` in transporter
// Option 2 (fallback): Resolve smtp.gmail.com to IPv4 manually
const getIPv4Address = async () => {
  const { address } = await promisify(dns.lookup)("smtp.gmail.com", { family: 4 });
  return address;
};

// Create transporter with hardcoded IPv4 host if needed
const createTransporter = async (user, pass) => {
  // Try standard method with family:4 first
  let transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    family: 4,
    auth: { user, pass },
    tls: { rejectUnauthorized: false }
  });

  // Verify connection; if it fails with IPv6 error, fallback to direct IPv4
  try {
    await transporter.verify();
  } catch (err) {
    if (err.message.includes("ENETUNREACH") || err.message.includes("IPv6")) {
      console.log("⚠️ IPv6 issue detected, falling back to direct IPv4 address...");
      const ipv4 = await getIPv4Address();
      transporter = nodemailer.createTransport({
        host: ipv4,
        port: 587,
        secure: false,
        auth: { user, pass },
        tls: { rejectUnauthorized: false }
      });
    }
  }
  return transporter;
};

// ---------- Email sending engine (using async transporters) ----------
async function sendEmails(emailList) {
  stopSending = false;

  const accounts = [
    { user: process.env.EMAIL_USER1, pass: process.env.EMAIL_PASS1 },
    { user: process.env.EMAIL_USER2, pass: process.env.EMAIL_PASS2 }
  ].filter(acc => acc.user && acc.pass);

  if (accounts.length === 0) {
    io.emit("email-error", "❌ No sender credentials found");
    activeSending = false;
    return;
  }

  // Build transporters asynchronously
  const transporters = [];
  for (const acc of accounts) {
    const transporter = await createTransporter(acc.user, acc.pass);
    transporters.push(transporter);
  }

  let sent = 0;
  const total = emailList.length;
  io.emit("progress", { current: 0, total });

  for (let i = 0; i < total; i++) {
    if (stopSending) {
      activeSending = false;
      io.emit("terminated", "🛑 Sending stopped");
      return;
    }

    const email = emailList[i];
    const senderIndex = sent % transporters.length;
    const transporter = transporters[senderIndex];
    const senderEmail = accounts[senderIndex].user;

    try {
      await transporter.sendMail({
        from: `"Rachit Kumar" <${senderEmail}>`,
        to: email,
        subject: "Backend Developer Internship Opportunity",
        text: "Hello,\n\nPlease find my resume attached for Backend Developer Internship role.\n\nRegards,\nRachit Kumar",
        attachments: [
          {
            filename: "Resume_Rachit.pdf",
            path: path.join(__dirname, "Resume.pdf")
          }
        ]
      });
      io.emit("email-status", { message: `✅ Delivered to ${email}` });
    } catch (error) {
      io.emit("email-status", { message: `❌ Failed: ${email} - ${error.message}` });
    }

    sent++;
    io.emit("progress", { current: sent, total });
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  activeSending = false;
  io.emit("completed", { message: `🎉 Completed ${sent}/${total} emails` });
}

// ---------- Email extraction ----------
function extractEmails(text) {
  const regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const found = text.match(regex) || [];
  return [...new Set(found.map(x => x.toLowerCase()))].filter(e => e.endsWith(".com"));
}

// ---------- API endpoint ----------
app.post("/api/v1/22343/email-filter", async (req, res) => {
  try {
    const { userId, password, emails } = req.body;

    if (userId !== process.env.USERID || password !== process.env.PASSWORD) {
      return res.status(401).json({ success: false, message: "Invalid login" });
    }

    if (!emails) {
      return res.status(400).json({ success: false, message: "Emails required" });
    }

    const emailList = extractEmails(emails);

    if (emailList.length === 0) {
      return res.json({ success: true, total: 0, emails: [], message: "No valid .com emails found" });
    }

    if (activeSending) {
      return res.status(409).json({ success: false, message: "Campaign already running" });
    }

    activeSending = true;
    sendEmails(emailList).catch(err => {
      console.error(err);
      activeSending = false;
      io.emit("email-error", "Internal sender error");
    });

    return res.json({
      success: true,
      total: emailList.length,
      emails: emailList,
      message: `Campaign started for ${emailList.length} recipients`
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));
app.get("/", (req, res) => res.send("RocketMail Backend Live 🚀"));

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
