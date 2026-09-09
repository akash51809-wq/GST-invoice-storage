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
  return getOAuth2Client(redirectUri).generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: DRIVE_SCOPES });
}

async function exchangeAuthorizationCode(code, redirectUri) {
  const { tokens } = await getOAuth2Client(redirectUri).getToken(code);
  return tokens;
}

function getDriveClient() {
  const client = getOAuth2Client();
  if (!process.env.GOOGLE_REFRESH_TOKEN) throw new Error('Google Drive has not been authorized yet.');
  client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.drive({ version: 'v3', auth: client });
}

function escapeDriveQueryValue(value) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function findOrCreateFolder(drive, name, parentId) {
  const response = await drive.files.list({
    q: `'${escapeDriveQueryValue(parentId)}' in parents and name = '${escapeDriveQueryValue(name)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id,name)',
    pageSize: 1,
  });
  if (response.data.files?.[0]) return response.data.files[0].id;
  const created = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id',
  });
  return created.data.id;
}

async function getInvoiceFolder(drive, folderNames) {
  let parentId = process.env.GOOGLE_DRIVE_FOLDER_ID?.trim() || 'root';
  for (const name of folderNames) parentId = await findOrCreateFolder(drive, name, parentId);
  return parentId;
}

async function uploadInvoiceFile(file, folderNames, targetName) {
  const drive = getDriveClient();
  const folderId = await getInvoiceFolder(drive, folderNames);
  const response = await drive.files.create({
    requestBody: { name: targetName, mimeType: file.mimetype, parents: [folderId] },
    media: { mimeType: file.mimetype, body: Readable.from(file.buffer) },
    fields: 'id,name,mimeType,webViewLink,size',
  });
  return { ...response.data, folderPath: folderNames.join(' / ') };
}

async function downloadInvoiceFile(fileId) {
  if (!fileId || !/^[a-zA-Z0-9_-]+$/.test(fileId)) throw new Error('A valid Google Drive file ID is required.');
  const drive = getDriveClient();
  const metadata = await drive.files.get({ fileId, fields: 'name,mimeType,fileExtension' });
  const file = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return {
    buffer: Buffer.from(file.data),
    name: metadata.data.name || 'invoice-file',
    mimeType: metadata.data.mimeType || 'application/octet-stream',
    extension: metadata.data.fileExtension || '',
  };
}

module.exports = { downloadInvoiceFile, exchangeAuthorizationCode, getAuthorizationUrl, uploadInvoiceFile };