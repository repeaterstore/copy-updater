/**
 * AES-256-GCM for provider API keys at rest.
 *
 * Keys are decrypted only inside server-side AI calls and are never returned to
 * the client, not even masked — the UI renders a mask from metadata alone.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "./env";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

function key(): Buffer {
  const raw = Buffer.from(env.encryptionKey, "base64");
  if (raw.length !== 32) {
    throw new Error(
      "APP_ENCRYPTION_KEY must be 32 bytes base64-encoded. Generate with: openssl rand -base64 32",
    );
  }
  return raw;
}

/** Returns `iv.ciphertext.tag`, all base64. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [iv, ciphertext, tag].map((b) => b.toString("base64")).join(".");
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(".");
  if (parts.length !== 3) {
    throw new Error("Stored secret is malformed.");
  }
  const [iv, ciphertext, tag] = parts.map((p) => Buffer.from(p, "base64"));
  const decipher = createDecipheriv(ALGORITHM, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

/** A display-only hint, derived without decrypting anything sensitive. */
export function maskKey(plaintext: string): string {
  if (plaintext.length <= 8) return "••••";
  return `${plaintext.slice(0, 3)}••••${plaintext.slice(-4)}`;
}
