// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const nodemailer = require("nodemailer");
const path = require("path");

const app = express();
const server = http.createServer(app);

// ---------- Socket.IO with correct path and CORS ----------
const io = new Server(server, {
  cors: {
    origin: "*", // Restrict to your frontend domain in production
    methods: ["GET", "POST"]
  },
  path: "/socket.io",
  pingTimeout: 60000,
  pingInterval: 25000
});

// ---------- Middleware ----------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// (Optional) Serve frontend static files if you place build output here
// app.use(express.static(path.join(__dirname, "dist")));

// ---------- Global flags ----------
let activeSending = false;
let stopSending = false;

// ---------- Socket events ----------
io.on("connection", (socket) => {
  console.log("✅ Client connected:", socket.id);
  socket.emit("email-status", { message: "✅ Connected to RocketMail backend" });

  socket.on("terminate-process", () => {
    if (activeSending) {
      stopSending = true;
      io.emit("terminated", "🛑 Campaign terminated by user");
    } else {
      socket.emit("email-status", { message: "ℹ️ No active process running" });
    }
  });

  socket.on("disconnect", () => {
    console.log("❌ Client disconnected:", socket.id);
  });
});

// ---------- SMTP Transporter (IPv4 FIX) ----------
const createTransporter = (user, pass) =>
  nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,           // TLS
    family: 4,               // FORCE IPv4 – critical for Render
    auth: { user, pass },
    tls: { rejectUnauthorized: false }
  });

// ---------- Email sending engine ----------
async function sendEmails(emailList) {
  stopSending = false;

  // Load sender accounts from environment variables
  const accounts = [
    { user: process.env.EMAIL_USER1, pass: process.env.EMAIL_PASS1 },
    { user: process.env.EMAIL_USER2, pass: process.env.EMAIL_PASS2 }
  ].filter(acc => acc.user && acc.pass);

  if (accounts.length === 0) {
    io.emit("email-error", "❌ No sender credentials found");
    activeSending = false;
    return;
  }

  const transporters = accounts.map(acc => createTransporter(acc.user, acc.pass));
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
    await new Promise(resolve => setTimeout(resolve, 5000)); // 5s delay
  }

  activeSending = false;
  io.emit("completed", { message: `🎉 Completed ${sent}/${total} emails` });
}

// ---------- Email extraction (.com only) ----------
function extractEmails(text) {
  const regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const found = text.match(regex) || [];
  return [...new Set(found.map(x => x.toLowerCase()))].filter(e => e.endsWith(".com"));
}

// ---------- API endpoint ----------
app.post("/api/v1/22343/email-filter", async (req, res) => {
  try {
    const { userId, password, emails } = req.body;

    // Authentication against environment variables
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
    // Start sending in background; response is sent immediately
    sendEmails(emailList).catch(err => {
      console.error("Email sender error:", err);
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
    console.error("API error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ---------- Health checks ----------
app.get("/health", (req, res) => res.json({ status: "ok" }));
app.get("/", (req, res) => res.send("RocketMail Backend Live 🚀"));

// ---------- Start server ----------
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});