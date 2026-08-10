/**
 * Environment access with clear failure messages.
 *
 * Reads lazily: Next evaluates module-level code during `next build`, when
 * runtime secrets legitimately are not present. Throwing at import time would
 * make the Docker build fail for no reason.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example.`,
    );
  }
  return value;
}

export const env = {
  get databaseUrl(): string {
    return required("DATABASE_URL");
  },
  get encryptionKey(): string {
    return required("APP_ENCRYPTION_KEY");
  },
  get dataDir(): string {
    return process.env.DATA_DIR?.trim() || "./data";
  },
  /** Email domains permitted to sign in. */
  get allowedEmailDomains(): string[] {
    const raw = process.env.ALLOWED_EMAIL_DOMAINS ?? "waveform.com,rsrf.com";
    return raw
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter((d) => d !== "");
  },
};
