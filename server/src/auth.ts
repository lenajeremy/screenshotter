/**
 * Accounts and teams (Better Auth): sign in with an emailed code or Google; teams (Better Auth's
 * "organizations") with owners, admins and members, joined by emailed invitation; and the Mac
 * app's sign-in, which works like `pier login`: the app shows a code, the person approves it in
 * their browser, and the app gets a token of its own (sent as a Bearer header).
 */
import { betterAuth } from "better-auth";
import { bearer, deviceAuthorization, emailOTP, organization } from "better-auth/plugins";
import type { Pool } from "pg";
import type { Config } from "./config.js";
import { letter, mailer } from "./mail.js";

export const APP_NAME = process.env.APP_NAME || "Glassine";
/** The Mac app's client id in the device sign-in. */
export const MAC_CLIENT_ID = "glassine-mac";

export function makeAuth(config: Config, pool: Pool) {
  const send = mailer(config);
  return betterAuth({
    appName: APP_NAME,
    baseURL: config.baseUrl,
    basePath: "/api/auth",
    secret: config.secret,
    database: pool,
    trustedOrigins: config.trustedOrigins,
    emailAndPassword: { enabled: false },
    socialProviders: config.google ? { google: { clientId: config.google.clientId, clientSecret: config.google.clientSecret, prompt: "select_account" } } : {},
    session: { expiresIn: 60 * 60 * 24 * 60, updateAge: 60 * 60 * 24 },
    rateLimit: { enabled: config.production },
    advanced: { useSecureCookies: config.baseUrl.startsWith("https://") },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: 10 * 60,
        allowedAttempts: 5,
        async sendVerificationOTP({ email, otp }) {
          const spaced = `${otp.slice(0, 3)} ${otp.slice(3)}`;
          await send({
            to: email,
            subject: `${spaced} is your ${APP_NAME} code`,
            ...letter({ heading: `Your ${APP_NAME} sign-in code`, lines: ["Type this code where you asked for it. It works for 10 minutes.", "If you didn't ask for it, you can ignore this email."], code: spaced }),
          });
        },
      }),
      organization({
        // Anyone signed in can start a team; whoever starts it owns it.
        allowUserToCreateOrganization: true,
        creatorRole: "owner",
        invitationExpiresIn: 60 * 60 * 24 * 7,
        async sendInvitationEmail(data) {
          const url = `${config.baseUrl}/invite/${encodeURIComponent(data.id)}`;
          const who = data.inviter.user.name || data.inviter.user.email;
          await send({
            to: data.email,
            subject: `${who} invited you to ${data.organization.name} on ${APP_NAME}`,
            ...letter({ heading: `Join ${data.organization.name} on ${APP_NAME}`, lines: [`${who} invited you to design with the ${data.organization.name} team.`, "The invitation works for 7 days."], button: { label: "Join the team", url } }),
          });
        },
      }),
      bearer(),
      deviceAuthorization({
        expiresIn: "15m",
        interval: "2s",
        userCodeLength: 8,
        verificationUri: `${config.baseUrl}/device`,
        validateClient: (id) => id === MAC_CLIENT_ID,
      }),
    ],
  });
}

export type Auth = ReturnType<typeof makeAuth>;
