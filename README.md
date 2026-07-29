# Tally Private Cloud

Tally is a single-owner, offline-first iPhone PWA with encrypted cross-device sync. Vercel serves the app and authenticated API; Neon (connected through the Vercel Marketplace) hosts Postgres.

## What is private

- Public account creation is disabled.
- A one-time setup token is required to create the only owner.
- A database trigger and transaction-level advisory lock prevent a second user record.
- Every ledger API request validates the signed-in session on the server.
- Ledger snapshots are validated, then encrypted with AES-256-GCM before Postgres receives them.
- API, login, setup, and account responses use `Cache-Control: private, no-store`.
- The service worker caches only app code and icons. It never caches an auth or ledger API response.
- No analytics, remote fonts, third-party scripts, or advertising code are included.
- Robots directives request no indexing, but authorization—not `robots.txt`—is the actual data boundary.

The empty HTML/CSS/JavaScript app shell is ordinary public web code. It contains no ledger content. A bot may discover the URL or download that shell, but an unauthenticated API request receives no data.

## Important limits

- Neon, not Vercel itself, operates the Postgres service when installed through Vercel Marketplace.
- Authentication tables necessarily contain your username, private account email, password hash, session metadata, and rate-limit records. The activity ledger is the part encrypted with the separate Tally data key.
- A running Vercel function can decrypt the ledger because it has the encryption key. An attacker who obtains both your Vercel environment secrets and database access could therefore read it.
- The offline copy in IndexedDB is plaintext on the device so Tally works without a connection. Protect the device with its normal lock. Use **Data → Sign out & remove device copy** on a shared browser.
- Losing `TALLY_DATA_ENCRYPTION_KEY` makes the cloud ledger unreadable. Keep that key in a password manager outside Vercel.
- Cloud sync is redundancy, not a replacement for complete JSON/CSV backups.

See [SECURITY.md](SECURITY.md) for the complete threat model.

## Windows deployment

The full walkthrough is in [DEPLOY-WINDOWS.md](DEPLOY-WINDOWS.md). The short version is:

```powershell
npm install
npm run generate:secrets
npx vercel login
npx vercel link
```

Then connect Neon in the Vercel Marketplace, add the generated secrets and `BETTER_AUTH_URL` to Vercel, and pull them locally:

```powershell
npx vercel env pull .env.local --environment=production
npm run db:migrate
npm run check
npx vercel deploy --prod
```

Open `https://YOUR-PROJECT.vercel.app/setup` once, paste the setup token, and create the owner. After signing in, restore the latest **complete JSON** or **complete CSV** backup from the old local app. Wait until Data says the encrypted cloud is up to date before opening the app on another device.

## Local development

1. Copy `.env.example` to `.env.local`.
2. Fill all values with a development database and development origin.
3. Run `npm install`.
4. Run `npm run db:migrate`.
5. Run `npm run dev`.
6. Open `http://localhost:3000/setup`.

Set `BETTER_AUTH_URL=http://localhost:3000` for local development. Never commit `.env.local`.

## Scripts

| Command | Purpose |
|---|---|
| `npm run generate:secrets` | Generate independent auth, setup, and data-encryption secrets |
| `npm run db:migrate` | Create/update Better Auth and Tally tables plus the single-owner guard |
| `npm run account:recover` | Interactively reset the one owner password and revoke all sessions |
| `npm run audit:prod` | Check production dependencies for known moderate-or-higher vulnerabilities |
| `npm run dev` | Start local development |
| `npm test` | Run server/security tests and the browser math/persistence/sync regression suite |
| `npm run typecheck` | Run strict TypeScript checking |
| `npm run build` | Make the production Next.js build |
| `npm run check` | Typecheck, test, and build |

## Sync model

Tally remains local-first:

1. Every change is validated and durably written to IndexedDB.
2. The newest state is queued for authenticated cloud upload.
3. Postgres compares the expected cloud revision atomically.
4. If another device wrote first, the client performs a three-way merge from the last shared state.
5. Direct conflicts preserve a local recovery snapshot and require review; independent entries are retained.
6. The server stores the current encrypted state and ten encrypted prior revisions.

Unknown days, milestone rules, backup reminders, complete JSON/CSV backup and restore, dashed history gaps, statistics, and forecasts remain part of the original Tally client.

Credit habits always award their configured point value. Their individual streak
is informational only; automatic milestone rewards remain the configurable way to
award longer-term consistency.

On the Today tab, use the date navigator to backfill an earlier tracked day
directly with the same credit, debit, and bonus buttons. Credits, debits, and
bonus entries can each be divided into named custom sections. In Manual mode,
use the six-dot handle to reorder an entry or drag it into another section of
the same type. Automatic alphabetical, usage, and point-value sorting remains
available within each section. Groups, task assignments, manual order, and sort
preferences sync across devices and are included in complete JSON/CSV backups.

## Updating

Run the full check before deployment:

```powershell
npm run check
npx vercel deploy --prod
```

If dependencies or database schema change, run `npm run db:migrate` against the intended database before the production deployment.
