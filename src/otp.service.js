const nodemailer = require("nodemailer");
const crypto = require("crypto");
const { prisma } = require("./prisma");

let transporter = null;

function getEmailTransporter() {
  if (transporter) return transporter;

  const smtpHost = process.env.SMTP_HOST;
  const smtpUser = process.env.SMTP_USER;
  const smtpPassword = process.env.SMTP_PASSWORD;
  const smtpPort = Number(process.env.SMTP_PORT || 587);
  const smtpSecure = process.env.SMTP_SECURE === "true";

  if (smtpHost && smtpUser && smtpPassword) {
    transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      auth: {
        user: smtpUser,
        pass: smtpPassword,
      },
    });
  }
  return transporter;
}

// Generates 6-digit cryptographic numeric OTP
function generateOtpCode() {
  return crypto.randomInt(100000, 999999).toString();
}

async function sendOtpEmail({ email, otp, type = "sign-in" }) {
  let subject = "Your Verification Code";
  if (type === "sign-in") subject = "Your HRMS Sign-in OTP";
  else if (type === "email-verification") subject = "Verify your HRMS email address";
  else if (type === "forget-password") subject = "Reset your HRMS password";

  const mailer = getEmailTransporter();
  const from = process.env.SMTP_FROM || '"HRMS Security" <noreply@hrms.com>';

  if (mailer) {
    try {
      await mailer.sendMail({
        from,
        to: email,
        subject,
        text: `Your HRMS verification code is: ${otp}. It will expire in 5 minutes.`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; padding: 24px; background: #f4f7fb; border-radius: 16px; max-width: 520px; margin: auto; border: 1px solid #e2e8f0;">
            <h2 style="color: #047857; margin-top: 0; font-size: 20px;">HRMS Security Verification</h2>
            <p style="color: #334155; font-size: 14px; line-height: 1.5;">Use the one-time passcode below to verify your identity.</p>
            <div style="font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #0f172a; margin: 24px 0; background: #ffffff; padding: 18px; border-radius: 12px; text-align: center; border: 2px solid #cbd5e1; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
              ${otp}
            </div>
            <p style="color: #64748b; font-size: 12px; margin-bottom: 0;">This code is valid for <b>5 minutes</b>. Never share this code with anyone.</p>
          </div>
        `,
      });
      console.log(`[OTP] Email dispatched successfully to ${email}`);
      return true;
    } catch (err) {
      console.error(`[OTP] Failed to send email to ${email}:`, err);
      throw err;
    }
  } else {
    console.warn(`[OTP] SMTP not configured. OTP generated for ${email} is: ${otp}`);
    return false;
  }
}

async function createAndSendOtp(email, type = "sign-in") {
  const normalizedEmail = email.trim().toLowerCase();
  const otp = generateOtpCode();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 mins

  // Store in verifications table
  await prisma.verification.create({
    data: {
      identifier: normalizedEmail,
      value: otp,
      expiresAt,
    },
  });

  await sendOtpEmail({ email: normalizedEmail, otp, type });
  return { success: true, email: normalizedEmail };
}

async function verifyOtp(email, otp) {
  const normalizedEmail = email.trim().toLowerCase();
  const code = String(otp).trim();

  const record = await prisma.verification.findFirst({
    where: {
      identifier: normalizedEmail,
      value: code,
      expiresAt: { gt: new Date() },
    },
  });

  if (!record) {
    return { valid: false, message: "Invalid or expired OTP code." };
  }

  // Delete once verified to prevent replay attacks
  await prisma.verification.delete({ where: { id: record.id } }).catch(() => null);

  return { valid: true };
}

module.exports = {
  createAndSendOtp,
  verifyOtp,
  sendOtpEmail,
  getEmailTransporter,
};
