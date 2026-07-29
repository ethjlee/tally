import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { decryptState, encryptState } from "../lib/crypto";

process.env.TALLY_DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.TALLY_DATA_KEY_VERSION = "1";

test("ledger encryption round-trips without exposing plaintext", () => {
  const ledger = {
    app: "Tally",
    privateNote: "wearing data that must never appear in Postgres plaintext",
    points: [100, 120, 90]
  };
  const encrypted = encryptState("owner_123", ledger);
  const combined = Buffer.concat([
    encrypted.ciphertext,
    encrypted.nonce,
    encrypted.authTag
  ]).toString("utf8");

  assert.equal(combined.includes(ledger.privateNote), false);
  assert.deepEqual(decryptState("owner_123", encrypted), ledger);
  assert.equal(encrypted.nonce.length, 12);
  assert.equal(encrypted.authTag.length, 16);
});

test("authenticated encryption rejects a different owner identity", () => {
  const encrypted = encryptState("owner_a", { score: 123 });
  assert.throws(() => decryptState("owner_b", encrypted));
});

test("authenticated encryption rejects ciphertext tampering", () => {
  const encrypted = encryptState("owner", { score: 123 });
  const tampered = {
    ...encrypted,
    ciphertext: Buffer.from(encrypted.ciphertext)
  };
  tampered.ciphertext[0] ^= 1;
  assert.throws(() => decryptState("owner", tampered));
});

test("a changed encryption key cannot silently decrypt old data", () => {
  const originalKey = process.env.TALLY_DATA_ENCRYPTION_KEY;
  const encrypted = encryptState("owner", { score: 123 });
  process.env.TALLY_DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  assert.throws(() => decryptState("owner", encrypted));
  process.env.TALLY_DATA_ENCRYPTION_KEY = originalKey;
});
