const { google } = require('googleapis');
const { Readable } = require('node:stream');

const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.file'];

function getOAuth2Client(redirectUri = process.env.GOOGLE_REDIRECT_URI) {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !(redirectUri || GOOGLE_REDIRECT_URI)) {
    throw new Error('Google Drive OAuth configuration is incomplete.');
  }
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, redirectUri || GOOGLE_REDIRECT_URI);
}

function getAuthorizationUrl(redirectUri) {
  const client = getOAuth2Client(redirectUri);
  return client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: DRIVE_SCOPES });
}

async function exchangeAuthorizationCode(code, redirectUri) {
  const client = getOAuth2Client(redirectUri);
  const { tokens } = await client.getToken(code);
  return tokens;
}

function getDriveClient() {
  const client = getOAuth2Client();
  if (!process.env.GOOGLE_REFRESH_TOKEN) {
    throw new Error('Google Drive has not been authorized yet.');
  }
  client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.drive({ version: 'v3', auth: client });
}

async function listExcelFiles() {
  const drive = getDriveClient();
  const response = await drive.files.list({
    q: "trashed = false and (mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' or mimeType = 'application/vnd.ms-excel')",
    fields: 'files(id,name,mimeType,modifiedTime,size,webViewLink)',
    orderBy: 'modifiedTime desc',
  });
  return response.data.files || [];
}

async function readExcelFile(fileId) {
  if (!fileId || !/^[a-zA-Z0-9_-]+$/.test(fileId)) throw new Error('A valid Google Drive file ID is required.');
  const drive = getDriveClient();
  const response = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return response.data;
}

async function uploadInvoice(file) {
  const drive = getDriveClient();
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) throw new Error('Google Drive invoice folder is not configured.');
  const response = await drive.files.create({
    requestBody: { name: file.originalname, mimeType: file.mimetype, parents: [folderId] },
    media: { mimeType: file.mimetype, body: Readable.from(file.buffer) },
    fields: 'id,name,mimeType,size,webViewLink',
  });
  return response.data;
}

module.exports = { DRIVE_SCOPES, exchangeAuthorizationCode, getAuthorizationUrl, listExcelFiles, readExcelFile, uploadInvoice };