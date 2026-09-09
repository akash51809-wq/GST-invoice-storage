const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const express = require('express');
const multer = require('multer');
const dotenv = require('dotenv');
const nodemailer = require('nodemailer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { downloadInvoiceFile, exchangeAuthorizationCode, getAuthorizationUrl, uploadInvoiceFile } = require('./drive-service');

const rootDirectory = __dirname;
const envPath = path.join(rootDirectory, '.env');
const extractedInvoicesPath = path.join(rootDirectory, 'data', 'extracted_invoices.json');
const pendingInvoiceUploads = new Map();
const dotenvResult = dotenv.config({ path: envPath });

console.log('--- Application Config Loaded ---');
console.log('Environment File:', envPath);
console.log('Environment Parse:', dotenvResult.error ? `ERROR: ${dotenvResult.error.message}` : 'OK');
console.log('Gemini API Key:', process.env.GEMINI_API_KEY ? 'YES' : 'NO');
console.log('Gemini Model:', process.env.GEMINI_MODEL || 'not configured');
console.log('SMTP Configured:', process.env.SMTP_HOST ? 'YES' : 'NO');
console.log('---------------------------------');

const app = express();
const port = Number(process.env.PORT) || 4322;
const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (request, file, callback) => {
    const supported = new Set(['application/pdf', 'image/png', 'image/jpeg']);
    const isSupported = supported.has(file.mimetype) || /\.(pdf|png|jpe?g)$/i.test(file.originalname);
    callback(isSupported ? null : new Error('Only PDF, PNG, and JPG invoice files are supported.'), isSupported);
  },
});

app.use(express.json({ limit: '16kb' }));
app.use('/data', (request, response) => response.status(404).json({ success: false, error: 'Not found.' }));
app.use(express.static(rootDirectory));

function extractFirstJsonValue(text) {
  const responseText = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const firstObject = responseText.indexOf('{');
  const firstArray = responseText.indexOf('[');
  const firstCharacter = firstObject >= 0 && (firstArray < 0 || firstObject < firstArray) ? firstObject : firstArray;
  if (firstCharacter < 0) throw new Error('Gemini returned no JSON value.');
  const openingCharacter = responseText[firstCharacter];
  const closingCharacter = openingCharacter === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  let escaped = false;
  let endCharacter = -1;
  for (let index = firstCharacter; index < responseText.length; index += 1) {
    const character = responseText[index];
    if (escaped) { escaped = false; continue; }
    if (character === '\\' && inString) { escaped = true; continue; }
    if (character === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (character === openingCharacter || character === (openingCharacter === '[' ? '{' : '[')) depth += 1;
    if (character === closingCharacter || character === (closingCharacter === ']' ? '}' : ']')) depth -= 1;
    if (depth === 0) { endCharacter = index; break; }
  }
  if (endCharacter < firstCharacter) throw new Error('Gemini returned an incomplete JSON value.');
  return JSON.parse(responseText.slice(firstCharacter, endCharacter + 1));
}

function parseGeminiInvoices(text) {
  const parsed = extractFirstJsonValue(text);
  const pages = Array.isArray(parsed) ? parsed : [parsed];
  return pages.map((page, index) => ({
    pageNumber: Number(page.pageNumber) || index + 1,
    buyerName: String(page.buyerName || '').trim(),
    sellerName: String(page.sellerName || '').trim(),
    invoiceDate: String(page.invoiceDate || '').trim(),
    invoiceNumber: String(page.invoiceNumber || '').trim(),
    invoiceAmount: String(page.invoiceAmount || '').trim(),
    transactionType: /purchase/i.test(page.transactionType) ? 'Purchase' : /sell|sale/i.test(page.transactionType) ? 'Sell' : '',
    partyName: String(page.partyName || '').trim(),
  }));
}

function invoiceIdentity(invoice) {
  const number = String(invoice.invoiceNumber || '').toLowerCase().replace(/\s+/g, '');
  const date = String(invoice.invoiceDate || '').toLowerCase().replace(/\s+/g, '');
  return number && date ? `${number}|${date}` : '';
}

async function readStoredInvoices() {
  try {
    const records = JSON.parse(await fs.readFile(extractedInvoicesPath, 'utf8'));
    return Array.isArray(records) ? records : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function saveStoredInvoices(records) {
  await fs.mkdir(path.dirname(extractedInvoicesPath), { recursive: true });
  const temporaryPath = `${extractedInvoicesPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporaryPath, extractedInvoicesPath);
}

app.post('/api/test-invoice-extraction', (request, response) => {
  pdfUpload.single('invoice')(request, response, async (uploadError) => {
    if (uploadError) return response.status(400).json({ success: false, error: uploadError.message });
    if (!request.file) return response.status(400).json({ success: false, error: 'Select a PDF invoice first.' });
    if (!process.env.GEMINI_API_KEY) return response.status(503).json({ success: false, error: 'GEMINI_API_KEY is not configured.' });
    const isPdf = request.file.mimetype === 'application/pdf' || /\.pdf$/i.test(request.file.originalname);
    if (isPdf && request.file.buffer.subarray(0, 5).toString() !== '%PDF-') return response.status(400).json({ success: false, error: 'The uploaded file is not a valid PDF.' });

    try {
      const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = client.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-flash-lite-latest' });
      const prompt = 'Read every page of this invoice file. Return only a JSON array with one object per invoice page, including pageNumber, buyerName, sellerName, invoiceDate, invoiceNumber, invoiceAmount, transactionType (Purchase or Sell), and partyName. For Purchase use the seller as partyName; for Sell use the buyer. Use empty strings for missing values. Normalize unambiguous dates to YYYY-MM-DD. Do not merge pages or omit pages. No explanation.';
      const requestBody = {
        contents: [{
          role: 'user',
          parts: [
            { text: prompt },
            { inlineData: { mimeType: request.file.mimetype, data: request.file.buffer.toString('base64') } },
          ],
        }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 1024, candidateCount: 1 },
      };
      let result;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          result = await model.generateContent(requestBody);
          break;
        } catch (error) {
          if (![429, 500, 502, 503].includes(error.status) || attempt === 2) throw error;
          await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
        }
      }
      const extractedPages = parseGeminiInvoices(result.response.text());
      const uniquePages = [];
      const seenInUpload = new Set();
      for (const page of extractedPages) {
        const identity = invoiceIdentity(page);
        if (identity && seenInUpload.has(identity)) continue;
        if (identity) seenInUpload.add(identity);
        uniquePages.push(page);
      }
      const storedInvoices = await readStoredInvoices();
      const storedIdentities = new Set(storedInvoices.map(invoiceIdentity).filter(Boolean));
      const duplicateCount = extractedPages.length - uniquePages.length + uniquePages.filter((page) => invoiceIdentity(page) && storedIdentities.has(invoiceIdentity(page))).length;
      const pendingToken = randomUUID();
      pendingInvoiceUploads.set(pendingToken, {
        file: { buffer: request.file.buffer, mimetype: request.file.mimetype, originalname: request.file.originalname },
        pages: uniquePages,
        createdAt: Date.now(),
      });
      const expiryTimer = setTimeout(() => pendingInvoiceUploads.delete(pendingToken), 15 * 60 * 1000);
      expiryTimer.unref();
      return response.json({
        success: true,
        filename: request.file.originalname,
        details: uniquePages,
        extractedCount: extractedPages.length,
        uniqueCount: uniquePages.length,
        pendingToken,
        savedCount: 0,
        duplicateCount,
      });
    } catch (error) {
      console.error('Unable to extract invoice details with Gemini:', {
        name: error.name,
        status: error.status,
        message: error.message,
      });
      const errorMessage = error.status === 404
        ? 'The configured Gemini model is unavailable. Choose another model in Settings.'
        : [429, 500, 502, 503].includes(error.status)
          ? 'Gemini is temporarily busy. Please retry the PDF in a moment.'
          : error.message.includes('JSON')
            ? 'Gemini returned an unreadable result for this PDF. Try a clearer invoice PDF.'
            : 'Gemini could not read this PDF. Check that it is a valid, readable invoice PDF.';
      return response.status(502).json({ success: false, error: errorMessage });
    }
  });
});

function cleanDriveName(value, fallback) {
  return String(value || fallback).replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || fallback;
}

function getInvoiceFolderDetails(invoice) {
  const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(invoice.invoiceDate) ? new Date(`${invoice.invoiceDate}T00:00:00Z`) : new Date();
  const year = parsedDate.getUTCFullYear();
  const monthNumber = parsedDate.getUTCMonth() + 1;
  const financialYearStart = monthNumber >= 4 ? year : year - 1;
  const financialYear = `${financialYearStart}-${String(financialYearStart + 1).slice(-2)}`;
  const month = parsedDate.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  const transactionType = invoice.transactionType === 'Purchase' ? 'Purchase' : 'Sell';
  const partyName = invoice.partyName || (transactionType === 'Purchase' ? invoice.sellerName : invoice.buyerName) || 'Unknown Party';
  return { financialYear, transactionType, month, partyName: cleanDriveName(partyName, 'Unknown Party') };
}

app.post('/api/save-invoice', async (request, response) => {
  const pendingToken = cleanConfigValue(request.body?.pendingToken);
  const pending = pendingInvoiceUploads.get(pendingToken);
  if (!pending) return response.status(400).json({ success: false, error: 'This invoice preview has expired. Upload the file again.' });
  if (!process.env.GOOGLE_REFRESH_TOKEN) return response.status(503).json({ success: false, error: 'Google Drive is not authorized. Authorize Google Drive in Settings first.' });

  try {
    const storedInvoices = await readStoredInvoices();
    const storedIdentities = new Set(storedInvoices.map(invoiceIdentity).filter(Boolean));
    const recordsToSave = [];
    const skippedIdentities = new Set();
    for (const page of pending.pages) {
      const identity = invoiceIdentity(page);
      if (identity && storedIdentities.has(identity)) {
        skippedIdentities.add(identity);
        continue;
      }
      const folder = getInvoiceFolderDetails(page);
      const fileName = cleanDriveName(`${folder.partyName} - ${page.invoiceNumber || 'invoice'} - ${pending.file.originalname}`, pending.file.originalname);
      const driveFile = await uploadInvoiceFile(pending.file, [folder.financialYear, folder.transactionType, folder.month, folder.partyName], fileName);
      const record = { id: randomUUID(), ...page, ...folder, sourceFile: pending.file.originalname, driveFileId: driveFile.id, driveFileName: driveFile.name, driveWebViewLink: driveFile.webViewLink || '', savedAt: new Date().toISOString() };
      recordsToSave.push(record);
      if (identity) storedIdentities.add(identity);
    }
    await saveStoredInvoices([...storedInvoices, ...recordsToSave]);
    pendingInvoiceUploads.delete(pendingToken);
    return response.status(201).json({ success: true, message: `${recordsToSave.length} invoice record${recordsToSave.length === 1 ? '' : 's'} saved to Google Drive.`, savedCount: recordsToSave.length, duplicateCount: skippedIdentities.size, records: recordsToSave });
  } catch (error) {
    console.error('Unable to save invoice files to Google Drive:', error.message);
    return response.status(502).json({ success: false, error: 'Invoice details were extracted, but Google Drive could not save the file. Check Drive authorization and folder permissions.' });
  }
});

function getInvoiceRecordId(record) {
  return String(record.id || record.driveFileId || '');
}

async function findStoredInvoice(recordId) {
  const records = await readStoredInvoices();
  return records.find((record) => getInvoiceRecordId(record) === String(recordId));
}

app.get('/api/invoices', async (request, response) => {
  try {
    const year = cleanConfigValue(request.query.year);
    const month = cleanConfigValue(request.query.month);
    const party = cleanConfigValue(request.query.party);
    const type = cleanConfigValue(request.query.type);
    const records = (await readStoredInvoices()).filter((record) => (
      (!year || String(record.financialYear || '').toLowerCase() === year.toLowerCase())
      && (!month || String(record.month || '').toLowerCase() === month.toLowerCase())
      && (!party || String(record.partyName || '').toLowerCase() === party.toLowerCase())
      && (!type || String(record.transactionType || '').toLowerCase() === type.toLowerCase())
    ));
    return response.json({ success: true, invoices: records.map((record) => ({ ...record, id: getInvoiceRecordId(record) })) });
  } catch (error) {
    console.error('Unable to read invoice report:', error.message);
    return response.status(500).json({ success: false, error: 'Unable to load invoice report.' });
  }
});

async function sendInvoiceFile(request, response, disposition) {
  const invoice = await findStoredInvoice(request.params.invoiceId);
  if (!invoice) return response.status(404).json({ success: false, error: 'Invoice was not found in the local index.' });
  const file = await downloadInvoiceFile(invoice.driveFileId);
  response.type(file.mimeType);
  response.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
  return response.send(file.buffer);
}

app.get('/api/invoices/:invoiceId/view', async (request, response) => {
  try { return await sendInvoiceFile(request, response, 'inline'); }
  catch (error) { return response.status(502).json({ success: false, error: 'Unable to load the invoice from Google Drive.' }); }
});

app.get('/api/invoices/:invoiceId/download', async (request, response) => {
  try { return await sendInvoiceFile(request, response, 'attachment'); }
  catch (error) { return response.status(502).json({ success: false, error: 'Unable to download the invoice from Google Drive.' }); }
});

app.post('/api/invoices/:invoiceId/email', async (request, response) => {
  const recipient = cleanConfigValue(request.body?.to);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) return response.status(400).json({ success: false, error: 'Enter a valid recipient email address.' });
  if (!process.env.SMTP_HOST || !process.env.SMTP_USERNAME || !process.env.SMTP_PASSWORD) return response.status(503).json({ success: false, error: 'SMTP settings are incomplete. Configure the email password first.' });
  try {
    const invoice = await findStoredInvoice(request.params.invoiceId);
    if (!invoice) return response.status(404).json({ success: false, error: 'Invoice was not found in the local index.' });
    const file = await downloadInvoiceFile(invoice.driveFileId);
    const secure = String(process.env.SMTP_ENCRYPTION || '').toUpperCase() === 'SSL';
    const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: secure ? 465 : 587, secure, auth: { user: process.env.SMTP_USERNAME, pass: process.env.SMTP_PASSWORD } });
    await transporter.sendMail({
      from: process.env.SMTP_USERNAME,
      to: recipient,
      subject: `Invoice ${invoice.invoiceNumber || invoice.driveFileName || ''}`.trim(),
      text: `Invoice attached.\nParty: ${invoice.partyName || ''}\nDate: ${invoice.invoiceDate || ''}\nAmount: ${invoice.invoiceAmount || ''}`,
      attachments: [{ filename: file.name, content: file.buffer, contentType: file.mimeType }],
    });
    return response.json({ success: true, message: `Invoice emailed to ${recipient}.` });
  } catch (error) {
    console.error('Unable to email invoice:', error.message);
    return response.status(502).json({ success: false, error: 'Unable to send invoice email. Check SMTP settings.' });
  }
});

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

  const lines = contents.split(/\r?\n/);
  for (const [key, value] of Object.entries(values)) {
    const safeValue = JSON.stringify(String(value).replace(/[\r\n]/g, ''));
    const keyPattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*=`);
    const index = lines.findIndex((line) => keyPattern.test(line));
    if (index >= 0) lines[index] = `${key}=${safeValue}`;
    else {
      if (lines.length && lines[lines.length - 1] !== '') lines.push('');
      lines.push(`${key}=${safeValue}`);
    }
    process.env[key] = value;
  }

  const temporaryEnvPath = `${envPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryEnvPath, `${lines.join('\n')}\n`, { mode: 0o600 });
  await fs.rename(temporaryEnvPath, envPath);
}

const allowedGeminiModels = new Set(['gemini-flash-lite-latest', 'gemini-3.6-flash', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash']);

app.post('/api/save-app-settings', async (request, response) => {
  const body = request.body || {};
  const geminiApiKey = cleanConfigValue(body.geminiApiKey);
  const geminiModel = cleanConfigValue(body.geminiModel);
  const customGeminiModel = cleanConfigValue(body.customGeminiModel);
  const smtpProvider = cleanConfigValue(body.smtpProvider);
  const smtpHost = cleanConfigValue(body.smtpHost);
  const smtpUsername = cleanConfigValue(body.smtpUsername);
  const smtpPassword = typeof body.smtpPassword === 'string' ? body.smtpPassword : '';
  const smtpEncryption = cleanConfigValue(body.smtpEncryption).toLowerCase();
  const selectedGeminiModel = geminiModel === 'custom' ? customGeminiModel : geminiModel;

  if (geminiApiKey && !/^AIza[\w-]{20,}$/i.test(geminiApiKey)) {
    return response.status(400).json({ success: false, error: 'Enter a valid Gemini API key.' });
  }
  if (geminiModel === 'custom' ? !/^[a-z0-9][a-z0-9._-]{1,99}$/i.test(selectedGeminiModel) : !allowedGeminiModels.has(selectedGeminiModel)) {
    return response.status(400).json({ success: false, error: 'Select a supported Gemini model.' });
  }
  if (!smtpProvider || !smtpHost || !smtpUsername || !['tls', 'ssl'].includes(smtpEncryption)) {
    return response.status(400).json({ success: false, error: 'Email provider, host, username, and TLS or SSL encryption are required.' });
  }
  if (smtpPassword && smtpPassword.length > 512) {
    return response.status(400).json({ success: false, error: 'SMTP password is too long.' });
  }

  const values = {
    GEMINI_MODEL: selectedGeminiModel,
    SMTP_PROVIDER: smtpProvider,
    SMTP_HOST: smtpHost,
    SMTP_USERNAME: smtpUsername,
    SMTP_ENCRYPTION: smtpEncryption.toUpperCase(),
  };
  if (geminiApiKey) values.GEMINI_API_KEY = geminiApiKey;
  if (smtpPassword) values.SMTP_PASSWORD = smtpPassword;

  try {
    await saveEnvironmentValues(values);
    return response.json({ success: true, message: 'Gemini and email settings saved securely.' });
  } catch (error) {
    console.error('Unable to save application settings:', error.message);
    return response.status(500).json({ success: false, error: 'The server could not save the settings.' });
  }
});

app.post('/api/save-gemini-settings', async (request, response) => {
  const apiKey = cleanConfigValue(request.body?.geminiApiKey);
  const model = cleanConfigValue(request.body?.geminiModel);
  const customModel = cleanConfigValue(request.body?.customGeminiModel);
  const selectedModel = model === 'custom' ? customModel : model;
  if (apiKey && !/^AIza[\w-]{20,}$/i.test(apiKey)) return response.status(400).json({ success: false, error: 'Enter a valid Gemini API key.' });
  if (model === 'custom' ? !/^[a-z0-9][a-z0-9._-]{1,99}$/i.test(selectedModel) : !allowedGeminiModels.has(selectedModel)) {
    return response.status(400).json({ success: false, error: 'Select a supported Gemini model.' });
  }
  try {
    const values = { GEMINI_MODEL: selectedModel };
    if (apiKey) values.GEMINI_API_KEY = apiKey;
    await saveEnvironmentValues(values);
    return response.json({ success: true, message: 'Gemini settings saved securely.' });
  } catch (error) {
    console.error('Unable to save Gemini settings:', error.message);
    return response.status(500).json({ success: false, error: 'The server could not save Gemini settings.' });
  }
});

app.post('/api/save-email-settings', async (request, response) => {
  const values = {
    SMTP_PROVIDER: cleanConfigValue(request.body?.smtpProvider),
    SMTP_HOST: cleanConfigValue(request.body?.smtpHost),
    SMTP_USERNAME: cleanConfigValue(request.body?.smtpUsername),
    SMTP_ENCRYPTION: cleanConfigValue(request.body?.smtpEncryption).toUpperCase(),
  };
  const password = typeof request.body?.smtpPassword === 'string' ? request.body.smtpPassword : '';
  if (!values.SMTP_PROVIDER || !values.SMTP_HOST || !values.SMTP_USERNAME || !['TLS', 'SSL'].includes(values.SMTP_ENCRYPTION)) {
    return response.status(400).json({ success: false, error: 'Provider, host, username, and TLS or SSL encryption are required.' });
  }
  if (password.length > 512) return response.status(400).json({ success: false, error: 'SMTP password is too long.' });
  if (password) values.SMTP_PASSWORD = password;
  try {
    await saveEnvironmentValues(values);
    return response.json({ success: true, message: 'Email settings saved securely.' });
  } catch (error) {
    console.error('Unable to save email settings:', error.message);
    return response.status(500).json({ success: false, error: 'The server could not save email settings.' });
  }
});

function getConfiguredRedirectUri(request) {
  return cleanConfigValue(process.env.GOOGLE_REDIRECT_URI) || `${request.protocol}://${request.get('host')}/auth/google/callback`;
}

app.post('/api/save-drive-config', async (request, response) => {
  const values = {
    GOOGLE_CLIENT_ID: cleanConfigValue(request.body?.clientId),
    GOOGLE_CLIENT_SECRET: cleanConfigValue(request.body?.clientSecret),
  };
  const redirectUri = cleanConfigValue(request.body?.redirectUri);
  if (redirectUri) values.GOOGLE_REDIRECT_URI = redirectUri;
  if (!values.GOOGLE_CLIENT_ID || !values.GOOGLE_CLIENT_SECRET || (redirectUri && !/^https?:\/\//i.test(redirectUri))) {
    return response.status(400).json({ success: false, error: 'Client ID and client secret are required, and redirect URI must be valid.' });
  }
  try {
    await saveEnvironmentValues(values);
    return response.json({ success: true, message: 'Google Drive configuration saved securely.' });
  } catch (error) {
    console.error('Unable to save Drive configuration:', error.message);
    return response.status(500).json({ success: false, error: 'The server could not save Google Drive configuration.' });
  }
});

app.get('/auth/google', (request, response) => {
  try {
    return response.redirect(getAuthorizationUrl(getConfiguredRedirectUri(request)));
  } catch (error) {
    return response.status(503).json({ success: false, error: error.message });
  }
});

app.get('/auth/google/callback', async (request, response) => {
  try {
    if (request.query.error) return response.status(400).send(`Google authorization was cancelled: ${request.query.error}`);
    if (!request.query.code) return response.status(400).json({ success: false, error: 'Authorization code is missing.' });
    const tokens = await exchangeAuthorizationCode(request.query.code, getConfiguredRedirectUri(request));
    const tokenValues = {};
    if (tokens.access_token) tokenValues.GOOGLE_ACCESS_TOKEN = tokens.access_token;
    if (tokens.refresh_token) tokenValues.GOOGLE_REFRESH_TOKEN = tokens.refresh_token;
    if (tokens.expiry_date) tokenValues.GOOGLE_TOKEN_EXPIRY = String(tokens.expiry_date);
    if (!Object.keys(tokenValues).length) return response.status(502).json({ success: false, error: 'Google returned no usable authorization tokens.' });
    await saveEnvironmentValues(tokenValues);
    return response.redirect('/#settings?connected=true');
  } catch (error) {
    console.error('Google authorization failed:', error.message);
    return response.status(502).json({ success: false, error: `Google authorization failed: ${error.message}` });
  }
});

app.use((request, response) => response.status(404).json({ success: false, error: 'Endpoint not found.' }));

app.use((error, request, response, next) => {
  if (response.headersSent) return next(error);
  console.error('Unhandled request error:', error.message);
  return response.status(500).json({ success: false, error: 'Unexpected server error.' });
});

app.listen(port, () => console.log(`GST/Ops server listening on http://localhost:${port}`));