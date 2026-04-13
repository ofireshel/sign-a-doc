# SIGN-A-DOC

Cloudflare-hosted PDF signing application with:

- React + Vite frontend
- Cloudflare Pages Functions backend
- D1 for documents and audit events
- R2 for original and signed PDFs
- AES-GCM encryption for PDFs stored temporarily in R2
- Supabase Auth for Google plus email/password login
- Resend for signing notifications

## Current status

The app code compiles and the D1 schema has already been created remotely.

Still required before production use:

1. Enable and create the `sign-a-doc-documents` R2 bucket in the Cloudflare dashboard.
2. Create a Supabase project and configure Google auth.
3. Create a Resend account and verified sender domain.
4. Add frontend and backend environment variables to Cloudflare Pages.
5. Add a document encryption secret.
6. Redeploy the Pages project.

## Local development

1. Copy `.env.example` to `.env`.
2. Copy `.dev.vars.example` to `.dev.vars`.
3. Install dependencies:

```bash
npm install
```

4. Run the frontend:

```bash
npm run dev
```

## Cloudflare resources

### D1

Already created:

- Database name: `sign-a-doc`
- Database id: `679f4132-915a-4b4b-bf59-cecd6eca3fe7`

Migration already applied from `migrations/0001_initial.sql`.

### R2

Bucket name expected by `wrangler.toml`:

- `sign-a-doc-documents`

Cloudflare returned `Please enable R2 through the Cloudflare Dashboard`, so create or enable R2 there first.

## Required environment variables

### Frontend (`.env` or Pages build variables)

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

### Backend (`.dev.vars` or Pages environment variables / secrets)

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `DOCUMENT_ENCRYPTION_KEY`
- `RESEND_API_KEY`
- `RESEND_FROM_EMAIL`
- `APP_BASE_URL`

## Supabase setup

1. Create a Supabase project.
2. Enable:
   - Email/password auth
   - Google auth provider
3. Add the site URLs:
   - `https://sign-a-doc.work`
   - `https://www.sign-a-doc.work`
4. Copy the project URL and anon key into the frontend and backend environment variables.

## Resend setup

1. Create a Resend API key.
2. Verify a sending domain or sender address for `sign-a-doc.work`.
3. Set `RESEND_FROM_EMAIL` to that verified sender, for example:
   - `notifications@sign-a-doc.work`

## Pages deployment

When the environment variables are ready:

```bash
npm run cf:deploy
```

## App flow included in this codebase

### Sender

1. Log in with Google or email/password.
2. Upload a PDF.
3. Click the preview to place the signature field.
4. Enter recipient details and send the document.

### Recipient

1. Receive a signing email from Resend.
2. Log in with the invited email address.
3. Review the PDF.
4. Draw or type a signature.
5. Finalize the signed PDF.
6. The owner receives the signed PDF by email.

### Audit trail

The backend records:

- document upload
- sign request sent
- sign request viewed
- document signed
- temporary encrypted file cleanup

## Important notes

- This version uses sender-confirmed signature placement, not fully automatic LLM placement.
- Documents are encrypted before they are written to R2 and are deleted from temporary storage after the signed PDF is emailed to the owner.
- The signing route uses hash routing (`/#/sign/<token>`) so it works on Pages without extra SPA rewrite rules.
- The code emails the signed PDF to the owner instead of keeping a readable copy in Cloudflare storage.
- The UI does not yet expose multi-signer workflows.
