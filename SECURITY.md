# Tally security model

## Protected assets

- Activity entries and dates.
- Habit, bonus, and milestone definitions.
- Completed-day marks.
- Scoring, start-date, history-range, and backup-reminder settings.
- Account and session access.
- Availability of local and cloud copies.

## Trust boundaries

| Component | What it can see |
|---|---|
| Browser on a signed-in/trusted device | Plaintext ledger for display and offline use |
| Vercel function runtime | Plaintext while validating, encrypting, decrypting, and syncing |
| Neon Postgres | Encrypted ledger bytes; auth tables and operational metadata |
| Search crawler / unauthenticated visitor | Empty app shell and generic `401`/redirect responses |
| External JSON/CSV backup location | Plaintext complete backup |

## Controls

### Identity

- Better Auth username/password authentication.
- Password minimum 14 characters; password hashes are managed by Better Auth.
- Secure, HttpOnly, SameSite=Strict cookies in production.
- Database-backed rate limiting, including five username/password attempts per minute.
- No OAuth, public registration, or account-list endpoint.
- One-time setup token with constant-time comparison.
- Database-level single-user insert guard protected by a Postgres advisory transaction lock.

### Ledger confidentiality and integrity

- AES-256-GCM with a random 96-bit nonce for every write.
- Owner ID and key version are additional authenticated data.
- Encryption key exists only in Vercel environment variables and an external owner-held copy.
- Server validates a strict, size-limited schema before encryption.
- Unknown fields, duplicate IDs/dates, wrong point signs, malformed dates, and oversized payloads are rejected.

### Sync correctness and recovery

- Atomic row locking and expected-revision comparison.
- Idempotency operation ID for response-loss retries.
- Three-way device merge using the last confirmed common cloud snapshot.
- Recovery snapshot before a client conflict merge.
- Ten encrypted previous cloud revisions.
- IndexedDB current, previous, recovery, and emergency/fallback mirrors remain.
- Complete JSON and complete CSV exports remain independent recovery paths.

### Web exposure

- No personal data in the static shell.
- Auth and ledger routes require a server session.
- Mutating custom APIs enforce same-origin/fetch-metadata checks.
- CSP denies third-party scripts, objects, framing, and cross-origin connections.
- `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `nosniff`, restrictive Permissions Policy.
- `X-Robots-Tag` and `robots.txt` discourage indexing but are not treated as authorization.
- No analytics or external content.
- Service worker explicitly bypasses `/api`, `/login`, `/setup`, `/account`, and `/`.

## Known residual risks

- A stolen Vercel account or exposed runtime secrets can defeat application-layer ledger encryption.
- A stolen/unlocked trusted device can expose its offline IndexedDB data.
- A compromised dependency, browser, operating system, Vercel runtime, or Neon control plane may create additional risk.
- Traffic metadata, IP addresses, user agent, session metadata, record sizes, revision counts, and update times are not hidden by ledger encryption.
- No automated password-reset email is configured. The local `npm run account:recover` command requires database access plus the setup token, then revokes every session; still preserve the password in a password manager.
- Deleting the Vercel project, Neon project, browser site data, external backups, or encryption key can cause permanent loss.
- This is carefully hardened personal software, not a claim of absolute security or 100% retention.

## Secret handling

- Never prefix secrets with `NEXT_PUBLIC_`.
- Never commit `.env.local`.
- Store `BETTER_AUTH_SECRET`, `TALLY_SETUP_TOKEN`, and `TALLY_DATA_ENCRYPTION_KEY` separately from the database.
- Preserve old data keys before any rotation. This version supports the active key version only.
- Rotate the setup token after account creation if desired; the endpoint is already disabled by the existing owner.
- If any secret is exposed, treat the deployment as compromised: rotate auth/setup secrets, revoke sessions, create a new data key, restore from a trusted external backup, and replace the cloud ledger.

## Verification

`npm run check` runs strict type checking, cryptographic tamper tests, schema/HTTP/security tests, randomized statistics and milestone tests, IndexedDB persistence/race tests, simulated cross-device cloud conflict tests, and a production build.
