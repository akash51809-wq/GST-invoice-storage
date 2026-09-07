# GST Invoice Storage

Dark GST invoice command center with Google Drive configuration and invoice upload.

## Run locally

```bash
npm install
cp .env.example .env
npm start
```

Open `http://localhost:4322` and sign in with `admin` / `Admin@123`.

## Google Drive setup

1. Create OAuth 2.0 Web application credentials in Google Cloud Console.
2. Create a Drive folder for invoices and copy its folder ID into `GOOGLE_DRIVE_FOLDER_ID` in `.env`.
3. Add the redirect URI from `.env` to the OAuth client's authorized redirect URIs.
4. Open **Settings** in the dashboard and save the Client ID, Client Secret, and Redirect URI.
5. Use **Login / Authorize with Google** to grant Drive file access.

After changing the OAuth scope, authorize the connection again so the refresh token includes upload permission.

The backend writes `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, and (after OAuth consent) `GOOGLE_REFRESH_TOKEN` to the root `.env` file. The `.env` file is ignored by git and secret values are never returned to the frontend.

Available backend routes:

- `POST /api/save-drive-config` saves the OAuth configuration values.
- `GET /auth/google` starts the Google OAuth flow.
- `GET /auth/google/callback` stores access and refresh tokens after consent.
- `GET /api/drive/auth-url` and `GET /api/drive/callback` remain compatibility aliases.
- `GET /api/drive/files` lists Excel files in the connected Drive.
- `GET /api/drive/files/:fileId` reads an Excel file as binary data.
- `POST /api/upload-invoice` uploads an Excel, CSV, PDF, PNG, or JPG file to the configured Drive folder.
