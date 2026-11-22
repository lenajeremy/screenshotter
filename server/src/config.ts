/**
 * The server's settings, from its environment. In production (on Pier) they're the project's
 * variables; locally, a .env file or the shell.
 */
export interface Config {
  port: number;
  /** Where people reach the server, e.g. https://glassine.thesunset.live (sign-in links, the Mac's sign-in page). */
  baseUrl: string;
  databaseUrl: string;
  /** Signs sessions and cookies: 32+ random characters, kept secret. */
  secret: string;
  google?: { clientId: string; clientSecret: string };
  /** Sending sign-in codes and invitations by email (Resend). Without it, they're printed in the log. */
  mail?: { resendKey: string; from: string };
  /** Origins the app's pages are opened from (the Mac app's local engine), allowed to call the API. */
  trustedOrigins: string[];
  production: boolean;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === "production";
  const port = Number(env.PORT || 8080);
  const baseUrl = (env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, "");
  const databaseUrl = env.DATABASE_URL || "";
  if (!databaseUrl) throw new Error("DATABASE_URL isn't set: the server keeps accounts, teams and boards in Postgres.");
  const secret = env.AUTH_SECRET || env.BETTER_AUTH_SECRET || "";
  if (production && secret.length < 32) throw new Error("AUTH_SECRET must be at least 32 random characters in production.");
  return {
    port,
    baseUrl,
    databaseUrl,
    secret: secret || "development-only-secret-not-for-production-use",
    google: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } : undefined,
    mail: env.RESEND_API_KEY && env.MAIL_FROM ? { resendKey: env.RESEND_API_KEY, from: env.MAIL_FROM } : undefined,
    trustedOrigins: [baseUrl, ...(env.TRUSTED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean)],
    production,
  };
}
