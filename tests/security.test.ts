import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

test("CSP blocks inline scripts and framing", () => {
  const config = read("next.config.ts");
  const scriptDirective = config.match(/"script-src ([^"]+)"/)?.[1] || "";
  assert.equal(scriptDirective.includes("unsafe-inline"), false);
  assert.match(config, /frame-ancestors 'none'/);
  assert.match(config, /X-Robots-Tag/);
  assert.match(config, /noindex, nofollow, noarchive/);
});

test("Tally shell contains no personal data or inline executable script", () => {
  const html = read("public/tally.html");
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i);
  assert.doesNotMatch(html, /(?:src|href)="https?:\/\//i);
  assert.match(html, /meta name="robots" content="noindex,nofollow/);
});

test("service worker never caches auth or ledger APIs", () => {
  const worker = read("public/sw.js");
  assert.equal(worker.includes('url.pathname.startsWith("/api/")'), true);
  assert.equal(worker.includes('url.pathname === "/login"'), true);
  assert.doesNotMatch(worker.match(/SHELL_ASSETS = \[([\s\S]*?)\]/)?.[1] || "", /\/api\//);
});

test("single-owner enforcement exists at auth, setup, and database layers", () => {
  const auth = read("lib/auth.ts");
  const setup = read("app/api/setup/route.ts");
  const migration = read("scripts/migrate.ts");
  assert.match(auth, /export const auth = createTallyAuth\(false\)/);
  assert.match(setup, /await ownerExists\(\)/);
  assert.match(setup, /timingSafeEqual/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /tally_single_owner_guard/);
});

test("all ledger routes require a server session and no-store responses", () => {
  const sync = read("app/api/sync/route.ts");
  const account = read("app/api/account/route.ts");
  assert.match(sync, /requireSession\(request\)/);
  assert.match(account, /requireSession\(request\)/);
  assert.match(read("lib/http.ts"), /private, no-store/);
});

test("cloud table stores encrypted bytes with authenticated metadata", () => {
  const migration = read("scripts/migrate.ts");
  const crypto = read("lib/crypto.ts");
  assert.match(migration, /ciphertext BYTEA NOT NULL/);
  assert.match(migration, /nonce BYTEA NOT NULL CHECK \(octet_length\(nonce\) = 12\)/);
  assert.match(migration, /auth_tag BYTEA NOT NULL CHECK \(octet_length\(auth_tag\) = 16\)/);
  assert.match(crypto, /aes-256-gcm/);
  assert.match(crypto, /setAAD/);
  assert.match(crypto, /setAuthTag/);
});

test("cloud conflict and retry protections are present", () => {
  const store = read("lib/state-store.ts");
  assert.match(store, /SELECT revision,[\s\S]*FOR UPDATE/);
  assert.match(store, /current\.last_operation_id === operationId/);
  assert.match(store, /currentRevision !== baseRevision/);
  assert.match(store, /tally_state_history/);
  assert.match(store, /LIMIT 10/);
});

test("current backup reminder and unknown-day behavior remain in the deployed client", () => {
  const client = read("public/tally.js");
  assert.match(client, /backupReminderDays/);
  assert.match(client, /Unknown days are excluded and pause your success streak/);
  assert.match(client, /chart-score-gap/);
  assert.match(client, /scoreGapPath/);
});

test("top banners respect the device safe area without stacking the inset", () => {
  const css = read("public/tally.css");
  assert.match(css, /\.banner\.show\s*\{[^}]*padding-top:calc\(8px \+ env\(safe-area-inset-top\)\)/s);
  assert.match(css, /\.banner\.show\s*~\s*\.banner\.show\s*\{\s*padding-top:8px;/);
  assert.match(css, /\.banner\.show\s*~\s*header\.top\s*\{\s*padding-top:12px;/);
});
