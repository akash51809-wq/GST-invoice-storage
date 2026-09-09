# GST Command Center

GST application dashboard with server-side Gemini, SMTP, and Google Drive OAuth settings. Invoice upload and classification remain intentionally removed.

## Run locally

```bash
npm install
cp .env.example .env
npm start
```

Open `http://localhost:4322` and sign in with the configured development credentials.

## Settings

The Settings page sends service configuration to `POST /api/save-app-settings`. Values are stored in the root `.env` file. API keys and passwords are never returned to the browser; leaving either password field blank preserves its existing value.

Supported model values are `gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-2.0-flash`, or a manually entered model name. SMTP encryption accepts `TLS` or `SSL`.

The Settings page has separate Gemini, Email, and Google Drive tabs. Each tab saves only its own values to the root `.env` file. Google Drive authorization starts from `/auth/google` after saving the OAuth client credentials.

Upload Invoice now uses a review-before-save flow. Gemini extracts every page, duplicate identities are checked using `invoiceNumber + invoiceDate`, and the Save button uploads each unique invoice file to Google Drive using `Financial Year / Purchase or Sell / Month / Party Name` folders. Only after Drive upload succeeds is metadata written to `data/extracted_invoices.json`.
