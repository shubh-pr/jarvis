import "dotenv/config";

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  dbPath: process.env.DB_PATH ?? "./jarvis.db",
  authPasscode: required("AUTH_PASSCODE", process.env.AUTH_PASSCODE),
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? "",
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? "",
  vapidSubject: process.env.VAPID_SUBJECT ?? "mailto:you@example.com",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  agentDefaultCwd: process.env.AGENT_DEFAULT_CWD ?? process.cwd(),
  operatorName: process.env.OPERATOR_NAME ?? "Mr. Prakash",
  hooksSecret: required("HOOKS_SECRET", process.env.HOOKS_SECRET),
  // How long a session with messages waiting for it can be silent before
  // Jarvis mentions it (an interrupted turn never sends Stop).
  busyNudgeMs: Number(process.env.BUSY_NUDGE_MS ?? 10 * 60_000),
};
