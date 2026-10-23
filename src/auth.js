const { betterAuth } = require("better-auth");
const { prismaAdapter } = require("better-auth/adapters/prisma");
const { emailOTP } = require("better-auth/plugins");
const nodemailer = require("nodemailer");
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

const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET,
  database: prismaAdapter(prisma, {
    provider: "postgresql",
    schema: {
      user: "betterAuthUser",
      session: "betterAuthSession",
      account: "betterAuthAccount",
      verification: "verification",
    },
  }),
  emailAndPassword: {
    enabled: true,
  },
  plugins: [
    emailOTP({
      async sendVerificationOTP({ email, otp, type }) {
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
                <div style="font-family: sans-serif; padding: 20px; background: #f4f7fb; border-radius: 12px; max-width: 500px; margin: auto;">
                  <h2 style="color: #047857;">HRMS Authentication</h2>
                  <p style="color: #334155; font-size: 14px;">Here is your verification OTP code:</p>
                  <div style="font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #0f172a; margin: 24px 0; background: #fff; padding: 16px; border-radius: 8px; text-align: center; border: 1px solid #e2e8f0;">
                    ${otp}
                  </div>
                  <p style="color: #64748b; font-size: 12px;">This one-time passcode will expire in 5 minutes. If you did not request this, you can safely ignore this email.</p>
                </div>
              `,
            });
            console.log(`[BetterAuth] OTP email sent successfully to ${email}`);
          } catch (err) {
            console.error(`[BetterAuth] Failed to send OTP email to ${email}:`, err);
          }
        } else {
          console.warn(`[BetterAuth] SMTP not configured. OTP for ${email} is: ${otp}`);
        }
      },
      otpLength: 6,
      expiresIn: 300, // 5 minutes
    }),
  ],
  advanced: {
    disableCSRFCheck: true,
  },
});

module.exports = { auth };
