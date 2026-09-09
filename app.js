const sidebar = document.querySelector('#sidebar');
const dashboardPage = document.querySelector('#dashboardPage');
const uploadPage = document.querySelector('#uploadPage');
const invoicesPage = document.querySelector('#invoicesPage');
const settingsPage = document.querySelector('#settingsPage');
const invoiceFile = document.querySelector('#invoiceFile');
const dropZone = document.querySelector('#dropZone');
const browseButton = document.querySelector('#browseButton');
const selectedFile = document.querySelector('#selectedFile');
const saveInvoiceButton = document.querySelector('#saveInvoiceButton');
const mappingFields = document.querySelector('#mappingFields');
const uploadMessage = document.querySelector('#uploadMessage');
const previewCard = document.querySelector('#previewCard');
const previewArea = document.querySelector('#previewArea');
const previewTitle = document.querySelector('#previewTitle');
const pageCount = document.querySelector('#pageCount');
const mappingTitle = document.querySelector('#mappingTitle');
const mappingBadge = document.querySelector('#mappingBadge');
const mappingHelp = document.querySelector('#mappingHelp');
const classificationBox = document.querySelector('#classificationBox');
const classificationText = document.querySelector('#classificationText');
const driveConfigForm = document.querySelector('#driveConfigForm');
const driveConfigMessage = document.querySelector('#driveConfigMessage');

const GOOGLE_CLIENT_ID_DEFAULT = '470355717619-v0vof30kb84cljoec6eo99a5eo7s3ft3.apps.googleusercontent.com';
const GOOGLE_REDIRECT_URI_DEFAULT = 'https://urban-zebra-96j7xv69wvqx6w-4322.app.github.dev/auth/google/callback';
let prepared = null;
let currentObjectUrl = null;

function initializeDriveConfigDefaults() {
  if (!driveConfigForm) return;
  const clientId = driveConfigForm.querySelector('[name="clientId"]');
  const redirectUri = driveConfigForm.querySelector('[name="redirectUri"]');
  if (clientId && !clientId.value) clientId.value = GOOGLE_CLIENT_ID_DEFAULT;
  if (redirectUri && !redirectUri.value) redirectUri.value = GOOGLE_REDIRECT_URI_DEFAULT;
}
initializeDriveConfigDefaults();

function showPage(page) {
  const pages = { dashboard: dashboardPage, upload: uploadPage, invoices: invoicesPage, settings: settingsPage };
  Object.entries(pages).forEach(([key, element]) => element?.classList.toggle('is-hidden', key !== page));
  document.querySelectorAll('.main-nav a[data-page]').forEach((link) => link.classList.toggle('active', link.dataset.page === page));
  const labels = { dashboard: 'My Dashboard', upload: 'Upload Invoice', invoices: 'Invoices', settings: 'Settings' };
  document.querySelector('#breadcrumbPage').textContent = labels[page] || 'My Dashboard';
  sidebar?.classList.remove('is-open');
  if (page === 'settings') initializeDriveConfigDefaults();
  if (page === 'invoices') loadInvoices();
}

document.querySelectorAll('.main-nav a[data-page]').forEach((link) => link.addEventListener('click', (event) => { event.preventDefault(); showPage(link.dataset.page); }));
document.querySelector('#menuButton')?.addEventListener('click', () => sidebar?.classList.toggle('is-open'));
document.querySelector('#dashboardUploadButton')?.addEventListener('click', () => showPage('upload'));

function showSelectedFile(file) {
  if (!file) return;
  selectedFile.classList.remove('is-hidden');
  selectedFile.querySelector('strong').textContent = file.name;
  selectedFile.querySelector('small').textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB • ${file.type || 'document'}`;
  uploadMessage.textContent = '';
  previewCard.classList.remove('is-hidden');
  previewTitle.textContent = file.name;
  previewArea.innerHTML = '';
  if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
  currentObjectUrl = URL.createObjectURL(file);
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    const frame = document.createElement('iframe'); frame.src = currentObjectUrl; frame.title = 'Invoice PDF preview'; previewArea.appendChild(frame);
  } else if (file.type.startsWith('image/')) {
    const image = document.createElement('img'); image.src = currentObjectUrl; image.alt = 'Invoice preview'; previewArea.appendChild(image);
  } else {
    previewArea.innerHTML = '<div class="preview-placeholder">Preview is available after processing. The file itself will remain unchanged in Google Drive.</div>';
  }
  saveInvoiceButton.disabled = false;
}

browseButton?.addEventListener('click', () => invoiceFile.click());
dropZone?.addEventListener('click', (event) => { if (event.target !== browseButton) invoiceFile.click(); });
dropZone?.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') invoiceFile.click(); });
invoiceFile?.addEventListener('change', () => showSelectedFile(invoiceFile.files[0]));
['dragenter', 'dragover'].forEach((name) => dropZone?.addEventListener(name, (event) => { event.preventDefault(); dropZone.classList.add('is-dragging'); }));
['dragleave', 'drop'].forEach((name) => dropZone?.addEventListener(name, (event) => { event.preventDefault(); dropZone.classList.remove('is-dragging'); }));
dropZone?.addEventListener('drop', (event) => { const file = event.dataTransfer.files[0]; if (file) { const transfer = new DataTransfer(); transfer.items.add(file); invoiceFile.files = transfer.files; showSelectedFile(file); } });
document.querySelector('#removeFile')?.addEventListener('click', () => resetUpload());

function resetUpload() {
  invoiceFile.value = '';
  selectedFile.classList.add('is-hidden');
  previewCard.classList.add('is-hidden');
  mappingFields.innerHTML = '';
  classificationBox.classList.add('is-hidden');
  saveInvoiceButton.disabled = true;
  prepared = null;
  uploadMessage.textContent = '';
}

async function readJson(response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : {}; } catch (_) { return { success: false, error: 'Invalid server response.' }; }
}

function renderMapping(result) {
  prepared = result;
  const fields = result.fields || [];
  mappingTitle.textContent = result.mappingFound ? 'Known format detected' : 'New invoice format';
  mappingBadge.textContent = result.mappingFound ? 'AUTO MAPPING' : 'NEW FORMAT';
  mappingBadge.classList.toggle('known', Boolean(result.mappingFound));
  mappingHelp.textContent = result.mappingFound ? 'The saved source mapping was found. Review the fetched values before saving.' : 'Fill the value and source label for the first upload. Example source label: Invoice No, GSTIN, Grand Total.';
  pageCount.textContent = `${result.pages?.length || 1} page(s)`;
  mappingFields.innerHTML = '';
  fields.forEach((field) => {
    const item = result.mapping?.fields?.[field.key] || {};
    const value = result.values?.[field.key] || result.invoices?.[0]?.[field.key] || '';
    const row = document.createElement('div'); row.className = 'mapping-row'; row.dataset.key = field.key;
    row.innerHTML = `<div class="mapping-label"><label>${field.label}${field.required ? ' <em>*</em>' : ''}</label><span>${item.page ? `Page ${item.page}` : 'Page 1'}</span></div><input class="mapping-value" data-field="value" value="${escapeHtml(value)}" placeholder="Enter ${field.label}" /><div class="mapping-source"><span>FETCH FROM</span><input data-field="source" value="${escapeHtml(item.sourceLabel || '')}" placeholder="Source label / anchor text" /></div>`;
    mappingFields.appendChild(row);
  });
  classificationBox.classList.remove('is-hidden');
  updateClassification();
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char])); }
function collectValues() { const values = {}; mappingFields.querySelectorAll('.mapping-row').forEach((row) => { values[row.dataset.key] = row.querySelector('[data-field="value"]').value.trim(); }); return values; }
function collectMapping() { const fields = {}; mappingFields.querySelectorAll('.mapping-row').forEach((row) => { fields[row.dataset.key] = { sourceLabel: row.querySelector('[data-field="source"]').value.trim(), label: row.querySelector('label').textContent.replace(' *','').trim(), page: 1 }; }); return fields; }
function updateClassification() {
  const values = collectValues();
  const buyer = (values.buyerName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const seller = (values.sellerName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const company = 'easyrechargesolution';
  const type = buyer.includes(company) ? 'BUY INVOICE' : seller.includes(company) ? 'SELLER INVOICE' : 'REVIEW REQUIRED';
  classificationText.textContent = type;
  classificationText.className = type === 'REVIEW REQUIRED' ? 'review' : type === 'BUY INVOICE' ? 'buy' : 'sell';
}
mappingFields?.addEventListener('input', updateClassification);

async function prepareInvoice() {
  const file = invoiceFile.files[0];
  if (!file) return;
  saveInvoiceButton.disabled = true;
  uploadMessage.className = 'settings-message'; uploadMessage.textContent = 'Inspecting invoice format...';
  const body = new FormData(); body.append('invoice', file);
  try {
    const response = await fetch('/api/invoice/prepare', { method: 'POST', body });
    const result = await readJson(response);
    if (!response.ok) throw new Error(result.error || 'Invoice processing failed.');
    renderMapping(result);
    uploadMessage.textContent = result.mappingFound ? 'Known format loaded. Values were fetched using the saved mapping.' : 'New format. Complete the mapping once and it will be remembered.';
    saveInvoiceButton.disabled = false;
  } catch (error) { uploadMessage.className = 'settings-message error'; uploadMessage.textContent = error.message; }
}

invoiceFile?.addEventListener('change', prepareInvoice);
dropZone?.addEventListener('drop', () => setTimeout(prepareInvoice, 0));

saveInvoiceButton?.addEventListener('click', async () => {
  if (!prepared || !invoiceFile.files[0]) return;
  saveInvoiceButton.disabled = true; uploadMessage.className = 'settings-message'; uploadMessage.textContent = 'Saving mapping, invoice record and original file...';
  const body = new FormData();
  body.append('invoice', invoiceFile.files[0]);
  body.append('data', JSON.stringify({ signature: prepared.signature, fields: collectMapping(), values: collectValues() }));
  try {
    const response = await fetch('/api/invoice/save', { method: 'POST', body });
    const result = await readJson(response);
    if (!response.ok) throw new Error(result.error || 'Unable to save invoice.');
    uploadMessage.className = 'settings-message success'; uploadMessage.textContent = `${result.saved || 0} invoice record(s) saved. Format mapping remembered. Original uploaded to Google Drive.`;
    await loadInvoices();
    setTimeout(() => showPage('invoices'), 700);
  } catch (error) { uploadMessage.className = 'settings-message error'; uploadMessage.textContent = error.message; saveInvoiceButton.disabled = false; }
});

function renderRecords(records) {
  const list = document.querySelector('#recentInvoices');
  const table = document.querySelector('#invoiceTable');
  const rows = records.map((invoice) => `<div class="invoice-row"><strong>${escapeHtml(invoice.invoiceNumber)}</strong><span>${escapeHtml(invoice.invoiceDate || '—')}</span><span>${escapeHtml(invoice.buyerName || '—')}</span><span>${escapeHtml(invoice.sellerName || '—')}</span><b class="status-${invoice.classification}">${invoice.classification === 'buy' ? 'BUY' : invoice.classification === 'sell' ? 'SELL' : 'REVIEW'}</b></div>`).join('');
  const content = rows || '<div class="empty-state">No invoices stored yet.</div>';
  list.innerHTML = content;
  table.innerHTML = `<div class="invoice-table-head"><span>Invoice</span><span>Date</span><span>Buyer</span><span>Seller</span><span>Type</span></div>${content}`;
  document.querySelector('#invoiceCount').textContent = records.length;
  document.querySelector('#metricTotal').textContent = records.length;
  document.querySelector('#metricBuy').textContent = records.filter((x) => x.classification === 'buy').length;
  document.querySelector('#metricSell').textContent = records.filter((x) => x.classification === 'sell').length;
  document.querySelector('#metricReview').textContent = records.filter((x) => x.classification === 'review').length;
}
async function loadInvoices() {
  try { const response = await fetch('/api/invoices'); const result = await readJson(response); if (response.ok) renderRecords(result.invoices || []); } catch (_) {}
}

driveConfigForm?.addEventListener('submit', async (event) => {
  event.preventDefault(); driveConfigMessage.textContent = 'Saving securely...'; driveConfigMessage.className = 'settings-message';
  try { const response = await fetch('/api/save-drive-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(driveConfigForm).entries())) }); const result = await readJson(response); if (!response.ok) throw new Error(result.error || 'Unable to save configuration.'); driveConfigMessage.className = 'settings-message success'; driveConfigMessage.textContent = result.message; }
  catch (error) { driveConfigMessage.className = 'settings-message error'; driveConfigMessage.textContent = error.message; }
});

loadInvoices();
