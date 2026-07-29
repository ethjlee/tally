const missing = (name: string): never => {
  throw new Error(`Missing required environment variable: ${name}`);
};

export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  return value || missing(name);
}

export function authOrigin(): string {
  const raw = requiredEnv("BETTER_AUTH_URL");
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("BETTER_AUTH_URL must use HTTPS outside local development.");
  }
  return url.origin;
}

export function requireStrongSecret(name: string, minimumBytes = 32): string {
  const value = requiredEnv(name);
  if (Buffer.byteLength(value, "utf8") < minimumBytes) {
    throw new Error(`${name} must contain at least ${minimumBytes} bytes.`);
  }
  return value;
}

export function dataEncryptionKey(): Buffer {
  const raw = requiredEnv("TALLY_DATA_ENCRYPTION_KEY");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32 || key.toString("base64").replace(/=+$/, "") !== raw.replace(/=+$/, "")) {
    throw new Error("TALLY_DATA_ENCRYPTION_KEY must be a canonical base64-encoded 32-byte key.");
  }
  return key;
}

export function dataKeyVersion(): number {
  const value = Number(process.env.TALLY_DATA_KEY_VERSION || "1");
  if (!Number.isSafeInteger(value) || value < 1 || value > 32767) {
    throw new Error("TALLY_DATA_KEY_VERSION must be a positive small integer.");
  }
  return value;
}
