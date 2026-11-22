import { startServer } from "./app.js";
import { APP_NAME } from "./auth.js";
import { readConfig } from "./config.js";

const config = readConfig();
const s = await startServer(config);
console.log(`${APP_NAME} server on :${s.port} (${config.baseUrl})${config.mail ? "" : ": no Resend key, so sign-in codes are printed here"}${config.google ? "" : ", Google sign-in off (no GOOGLE_CLIENT_ID)"}`);
let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    await s.close().catch((e) => console.error(e));
    process.exit(0);
  });
