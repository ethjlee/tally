import {
  createCipheriv,
  createDecipheriv,
  randomBytes
} from "node:crypto";
import { dataEncryptionKey, dataKeyVersion } from "./env";

const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const AAD_PREFIX = "tally-ledger-state";

export type EncryptedState = {
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  keyVersion: number;
};

function additionalAuthenticatedData(userId: string, keyVersion: number): Buffer {
  return Buffer.from(`${AAD_PREFIX}\0${keyVersion}\0${userId}`, "utf8");
}

export function encryptState(userId: string, state: unknown): EncryptedState {
  const keyVersion = dataKeyVersion();
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, dataEncryptionKey(), nonce, {
    authTagLength: AUTH_TAG_BYTES
  });
  cipher.setAAD(additionalAuthenticatedData(userId, keyVersion));

  const plaintext = Buffer.from(JSON.stringify(state), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    ciphertext,
    nonce,
    authTag: cipher.getAuthTag(),
    keyVersion
  };
}

export function decryptState<T>(
  userId: string,
  encrypted: EncryptedState
): T {
  if (encrypted.keyVersion !== dataKeyVersion()) {
    throw new Error(
      `Unsupported Tally data key version ${encrypted.keyVersion}. Restore the matching key before reading this ledger.`
    );
  }
  if (encrypted.nonce.length !== NONCE_BYTES || encrypted.authTag.length !== AUTH_TAG_BYTES) {
    throw new Error("Encrypted ledger metadata is invalid.");
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    dataEncryptionKey(),
    encrypted.nonce,
    { authTagLength: AUTH_TAG_BYTES }
  );
  decipher.setAAD(additionalAuthenticatedData(userId, encrypted.keyVersion));
  decipher.setAuthTag(encrypted.authTag);
  const plaintext = Buffer.concat([
    decipher.update(encrypted.ciphertext),
    decipher.final()
  ]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}
