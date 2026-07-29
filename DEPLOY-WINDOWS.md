# Deploy Tally from Windows to Vercel

This guide uses PowerShell and Vercel CLI. GitHub is optional.

## 1. Install prerequisites

Install:

- Node.js LTS, version 20.9 or newer.
- A password manager for the three secrets.
- Optional: Git for version history.

Extract this project ZIP, open the `tally-private-cloud` folder in File Explorer, right-click inside it, and choose **Open in Terminal**.

```powershell
node --version
npm install
npm run typecheck
npm test
```

Do not continue if the tests fail.

## 2. Generate and save secrets

```powershell
npm run generate:secrets
```

The command prints:

- `BETTER_AUTH_SECRET`
- `TALLY_SETUP_TOKEN`
- `TALLY_DATA_ENCRYPTION_KEY`

Save all three in a password manager. Do not email them, commit them, paste them into source files, or store the only copy in Vercel.

`TALLY_DATA_ENCRYPTION_KEY` is especially important. If it is lost, the encrypted cloud ledger cannot be decrypted. A complete JSON/CSV backup can still be restored after configuring a new key.

## 3. Create and link the Vercel project

```powershell
npx vercel login
npx vercel link
```

Choose your personal Vercel account, create a new project, and give it a unique name such as `my-private-tally`. The intended production origin will normally be:

`https://my-private-tally.vercel.app`

Do not deploy yet.

## 4. Add Neon Postgres

In the Vercel dashboard:

1. Open the new Tally project.
2. Open **Storage** or **Marketplace**.
3. Install **Neon Postgres**.
4. Create a database and connect it only to this Tally project.
5. Enable the connection for Production. Enable Development too if you intentionally want local commands to use the same database.
6. Confirm that `DATABASE_URL` now appears in Project Settings → Environment Variables.

Neon operates this database; Vercel supplies the integration and environment variable.

## 5. Add production environment variables

In Vercel → Project Settings → Environment Variables, add:

| Name | Value | Environment |
|---|---|---|
| `BETTER_AUTH_URL` | Exact production origin, no trailing slash | Production |
| `BETTER_AUTH_SECRET` | Generated value | Production |
| `TALLY_SETUP_TOKEN` | Generated value | Production |
| `TALLY_DATA_ENCRYPTION_KEY` | Generated base64 value | Production |
| `TALLY_DATA_KEY_VERSION` | `1` | Production |

Mark secrets as sensitive when Vercel offers that option. `DATABASE_URL` comes from Neon.

Preview deployments cannot share production auth cleanly when their origin differs. For the initial private app, deploy only the Production environment. If you later use previews, give each preview its own database and matching `BETTER_AUTH_URL`.

## 6. Pull the production variables and migrate

From PowerShell in the project folder:

```powershell
npx vercel env pull .env.local --environment=production
npm run db:migrate
```

The migration:

- Creates Better Auth user, account, session, verification, and database-backed rate-limit tables.
- Adds username fields.
- Creates encrypted current-state and ten-revision history tables.
- Adds the database-enforced single-owner trigger.
- Revokes the database `PUBLIC` role from application tables, functions, and sequences.

`.env.local` is ignored by Git. Still treat it as sensitive and delete it from an untrusted computer.

## 7. Verify and deploy

```powershell
npm run check
npx vercel deploy --prod
```

Open the production URL. It should redirect to `/setup`.

## 8. Create the one owner

On `/setup`:

1. Paste `TALLY_SETUP_TOKEN`.
2. Choose a username.
3. Enter a private email. It is stored for account identity but this build does not send password-reset email.
4. Choose a unique password of at least 14 characters and save it in your password manager.
5. Create the owner, then sign in with username and password.

The setup endpoint stops working once that account exists. The normal Better Auth signup endpoint is disabled independently.

If you later forget the password but still control the project secrets and database, pull the production variables into `.env.local` and run:

```powershell
npm run account:recover
```

The interactive recovery requires the current setup token, hides both password inputs, updates the one credential record, and revokes every session.

## 9. Move existing Tally data

On the old standalone app:

1. Export a new **complete JSON backup**. A complete CSV backup also works, but keeping both is sensible.
2. Save it outside browser storage.

On the Vercel app after signing in:

1. Open **Data → Backup & restore**.
2. Restore the complete JSON or complete CSV.
3. Confirm all counts.
4. Wait for **Encrypted cloud is up to date**.
5. Export a fresh post-migration backup.

Do not use the activity-analysis CSV as a backup; only the explicitly labeled complete CSV is restorable.

## 10. Install on iPhone

1. Open the production URL in Safari.
2. Sign in and confirm the cloud status is up to date.
3. Tap Share.
4. Tap **Add to Home Screen**.
5. Launch Tally from the new icon.
6. Test one entry, force-close, reopen offline, reconnect, and confirm sync.

To use the Windows desktop too, open the same production URL and sign in. Independent changes reconcile through cloud revisions.

## 11. Recovery drills

After deployment, test these deliberately:

- Wrong password returns a generic error.
- `/api/sync` in a signed-out private window returns `401` and no ledger.
- A complete JSON export can restore into a clean browser.
- A complete CSV export can restore into a clean browser.
- An offline entry survives force-close and uploads after reconnection.
- Two devices can add different entries, then each sees both after **Sync now**.
- **Sign out & remove device copy** refuses to clear local data unless cloud sync is confirmed.

Keep at least two recent external backups and the encryption key outside Vercel.

## Updating the production app

```powershell
npm install
npm run check
npx vercel deploy --prod
```

Run `npm run db:migrate` first if a future version changes database/auth schema.
