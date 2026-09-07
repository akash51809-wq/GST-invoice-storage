const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const dotenv = require('dotenv');
const { exchangeAuthorizationCode, getAuthorizationUrl, listExcelFiles, readExcelFile, uploadInvoice } = require('./drive-service');

const rootDirectory = __dirname;
const envPath = path.join(rootDirectory, '.env');
dotenv.config({ path: envPath });

// Keep Google OAuth values clean of accidental spaces/newlines.
for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'GOOGLE_ACCESS_TOKEN', 'GOOGLE_REFRESH_TOKEN']) {
  if (process.env[key]) process.env[key] = process.env[key].trim();
}

console.log('--- Google Drive Config Status ---');
console.log('Client ID Loaded:', process.env.GOOGLE_CLIENT_ID ? 'YES (' + process.env.GOOGLE_CLIENT_ID.substring(0, 10) + '...)' : 'NO / MISSING');
console.log('Client Secret Loaded:', process.env.GOOGLE_CLIENT_SECRET ? 'YES' : 'NO / MISSING');
console.log('Redirect URI:', process.env.GOOGLE_REDIRECT_URI || 'NO / MISSING');
console.log('Refresh Token Loaded:', process.env.GOOGLE_REFRESH_TOKEN ? 'YES' : 'NO');
console.log('-----------------------------------');

const app = express();
const port = Number(process.env.PORT) || 4322;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (request, file, callback) => {
    const allowed = /\.(xlsx|xls|csv|pdf|png|jpe?g)$/i.test(file.originalname);
    callback(allowed ? null : new Error('Only Excel, CSV, PDF, PNG, and JPG files are supported.'), allowed);
  },
});

app.use(express.json({ limit: '16kb' }));
app.use(express.static(rootDirectory));

function cleanConfigValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function saveEnvironmentValues(values) {
  let contents = '';
  try {
    contents = await fs.readFile(envPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const lines = contents.split(/\r?\n/).filter((line) => line.length > 0);
  for (const [key, value] of Object.entries(values)) {
    const escapedValue = value.replace(/\\/g, '\\\\').replace(/\n/g, '');
    const index = lines.findIndex((line) => line.startsWith(`${key}=`));
    if (index >= 0) lines[index] = `${key}=${escapedValue}`;
    else lines.push(`${key}=${escapedValue}`);
    process.env[key] = value;
  }

  for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'GOOGLE_ACCESS_TOKEN', 'GOOGLE_REFRESH_TOKEN']) {
    if (process.env[key]) process.env[key] = process.env[key].trim();
  }

  await fs.writeFile(envPath, `${lines.join('\n')}\n`, { mode: 0o600 });
}

app.post('/api/save-drive-config', async (request, response) => {
  const values = {
    GOOGLE_CLIENT_ID: cleanConfigValue(request.body.clientId),
    GOOGLE_CLIENT_SECRET: cleanConfigValue(request.body.clientSecret),
    GOOGLE_REDIRECT_URI: cleanConfigValue(request.body.redirectUri),
  };

  if (Object.values(values).some((value) => !value) || !/^https?:\/\//i.test(values.GOOGLE_REDIRECT_URI)) {
    return response.status(400).json({ success: false, error: 'Client ID, client secret, and a valid redirect URI are required.' });
  }

  try {
    // Saving the redirect URI is important because the exact same URI must be
    // used when generating the Google authorization URL and exchanging the code.
    await saveEnvironmentValues(values);
    return response.json({ success: true, message: 'Google Drive configuration saved securely on the backend.' });
  } catch (error) {
    console.error('Unable to save Drive configuration:', error.message);
    return response.status(500).json({ success: false, error: 'The server could not save the configuration.' });
  }
});

function getConfiguredRedirectUri() {
  const redirectUri = cleanConfigValue(process.env.GOOGLE_REDIRECT_URI);
  if (!redirectUri) {
    throw new Error('Google Redirect URI is not configured. Open Settings and save the exact callback URL first.');
  }
  return redirectUri;
}

function beginGoogleAuthorization(request, response) {
  try {
    const redirectUri = getConfiguredRedirectUri();
    console.log('Starting Google OAuth with redirect URI:', redirectUri);
    return response.redirect(getAuthorizationUrl(redirectUri));
  } catch (error) {
    console.error('Unable to start Google authorization:', error.message);
    return response.status(503).json({ success: false, error: error.message });
  }
}

async function completeGoogleAuthorization(request, response) {
  try {
    if (request.query.error) {
      const reason = request.query.error_description || request.query.error;
      return response.status(400).send(`Google authorization was cancelled or denied: ${reason}`);
    }
    if (!request.query.code) {
      return response.status(400).json({ success: false, error: 'Authorization code is missing.' });
    }

    // Use exactly the same redirect URI that was used to create the OAuth URL.
    // Google rejects the token exchange if even one character is different.
    const redirectUri = getConfiguredRedirectUri();
    const tokens = await exchangeAuthorizationCode(request.query.code, redirectUri);
    const tokenValues = {};

    if (tokens.access_token) tokenValues.GOOGLE_ACCESS_TOKEN = tokens.access_token;
    if (tokens.refresh_token) tokenValues.GOOGLE_REFRESH_TOKEN = tokens.refresh_token;
    if (tokens.expiry_date) tokenValues.GOOGLE_TOKEN_EXPIRY = String(tokens.expiry_date);

    if (!tokenValues.GOOGLE_ACCESS_TOKEN && !tokenValues.GOOGLE_REFRESH_TOKEN) {
      return response.status(502).json({ success: false, error: 'Google did not return usable authorization tokens.' });
    }

    await saveEnvironmentValues(tokenValues);
    console.log('Google Drive authorization completed successfully.');
    return response.redirect('/#settings?connected=true');
  } catch (error) {
    console.error('Google authorization failed:', error.message);
    return response.status(502).json({ success: false, error: `Google authorization failed: ${error.message}` });
  }
}

app.get('/auth/google', beginGoogleAuthorization);
app.get('/auth/google/callback', completeGoogleAuthorization);
app.get('/api/drive/auth-url', beginGoogleAuthorization);
app.get('/api/drive/callback', completeGoogleAuthorization);

app.get('/api/drive/status', async (request, response) => {
  return response.json({
    success: true,
    configured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI),
    authorized: Boolean(process.env.GOOGLE_REFRESH_TOKEN),
    redirectUri: process.env.GOOGLE_REDIRECT_URI || null,
  });
});

app.get('/api/drive/files', async (request, response) => {
  try {
    return response.json({ success: true, files: await listExcelFiles() });
  } catch (error) {
    return response.status(503).json({ success: false, error: error.message });
  }
});

app.get('/api/drive/files/:fileId', async (request, response) => {
  try {
    const file = await readExcelFile(request.params.fileId);
    response.type('application/octet-stream').send(Buffer.from(file));
  } catch (error) {
    response.status(503).json({ success: false, error: error.message });
  }
});

app.post('/api/upload-invoice', (request, response) => {
  upload.single('invoice')(request, response, async (uploadError) => {
    if (uploadError) {
      return response.status(400).json({
        success: false,
        error: uploadError.code === 'LIMIT_FILE_SIZE' ? 'Invoice must be 10 MB or smaller.' : uploadError.message,
      });
    }
    if (!request.file) return response.status(400).json({ success: false, error: 'Select an invoice file to upload.' });

    try {
      const file = await uploadInvoice(request.file);
      return response.status(201).json({ success: true, message: 'Invoice uploaded successfully.', file });
    } catch (error) {
      console.error('Unable to upload invoice:', error.message);
      return response.status(503).json({ success: false, error: error.message });
    }
  });
});

app.use((request, response) => response.status(404).json({ success: false, error: 'Endpoint not found.' }));

app.use((error, request, response, next) => {
  if (response.headersSent) return next(error);
  console.error('Unhandled request error:', error.message);
  return response.status(500).json({ success: false, error: 'Unexpected server error.' });
});

app.listen(port, () => console.log(`GST/Ops server listening on http://localhost:${port}`));