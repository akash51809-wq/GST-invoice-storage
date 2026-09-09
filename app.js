const loginView = document.querySelector('#loginView');
const dashboardView = document.querySelector('#dashboardView');
const loginForm = document.querySelector('#loginForm');
const loginError = document.querySelector('#loginError');
const sidebar = document.querySelector('#sidebar');
const dashboardPage = document.querySelector('#dashboardPage');
const uploadPage = document.querySelector('#uploadPage');
const settingsPage = document.querySelector('#settingsPage');
const reportPage = document.querySelector('#reportPage');
const settingsLink = document.querySelector('#settingsLink');
const uploadLink = document.querySelector('#uploadLink');
const reportLink = document.querySelector('#reportLink');
const invoiceTestForm = document.querySelector('#invoiceTestForm');
const invoicePdf = document.querySelector('#invoicePdf');
const invoiceTestButton = document.querySelector('#invoiceTestButton');
const invoiceTestMessage = document.querySelector('#invoiceTestMessage');
const invoiceResult = document.querySelector('#invoiceResult');
let pendingInvoiceToken = '';
const geminiForm = document.querySelector('#geminiForm');
const emailForm = document.querySelector('#emailForm');
const driveConfigForm = document.querySelector('#driveConfigForm');
const geminiModel = document.querySelector('#geminiModel');
const customGeminiModelLabel = document.querySelector('#customGeminiModelLabel');
const customGeminiModel = document.querySelector('#customGeminiModel');

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    return { success: false, error: 'The server returned an invalid response.' };
  }
}

function showMessage(element, message, isError = false) {
  element.className = `settings-message${isError ? ' error' : ' success'}`;
  element.textContent = message;
}

loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const formData = new FormData(loginForm);
  if (String(formData.get('username') || '').trim() === 'admin' && formData.get('password') === 'Admin@123') {
    loginError.textContent = '';
    loginView.classList.add('is-hidden');
    dashboardView.classList.remove('is-hidden');
    loginForm.reset();
  } else {
    loginError.textContent = 'Access denied. Check your username and password.';
    document.querySelector('#password').focus();
  }
});

document.querySelector('#menuButton').addEventListener('click', () => sidebar.classList.toggle('is-open'));

document.querySelectorAll('.main-nav a').forEach((link) => {
  link.addEventListener('click', () => {
    document.querySelectorAll('.main-nav a').forEach((item) => item.classList.remove('active'));
    link.classList.add('active');
    const isSettings = link === settingsLink;
    const isUpload = link === uploadLink;
    const isReport = link === reportLink;
    dashboardPage.classList.toggle('is-hidden', isSettings || isUpload || isReport);
    uploadPage.classList.toggle('is-hidden', !isUpload);
    settingsPage.classList.toggle('is-hidden', !isSettings);
    reportPage.classList.toggle('is-hidden', !isReport);
    document.querySelector('.breadcrumb').innerHTML = isSettings
      ? '<span>Manage</span><b>/</b> Settings'
      : isUpload
        ? '<span>Manage</span><b>/</b> Upload Invoice'
        : isReport
          ? '<span>Reports</span><b>/</b> Show Invoice'
        : '<span>Workspace</span><b>/</b> My Dashboard';
    sidebar.classList.remove('is-open');
    if (isReport) loadInvoiceReport();
  });
});

const reportFilterForm = document.querySelector('#reportFilterForm');
const reportYear = document.querySelector('#reportYear');
const reportMonth = document.querySelector('#reportMonth');
const reportParty = document.querySelector('#reportParty');
const reportType = document.querySelector('#reportType');
const reportTableBody = document.querySelector('#reportTableBody');
const reportEmpty = document.querySelector('#reportEmpty');
const reportCount = document.querySelector('#reportCount');
const reportStatus = document.querySelector('#reportStatus');

function setReportOptions(select, values, label) {
  const current = select.value;
  select.replaceChildren(new Option(label, ''));
  [...new Set(values.filter(Boolean))].sort().forEach((value) => select.append(new Option(value, value)));
  select.value = values.includes(current) ? current : '';
}

async function loadInvoiceReport() {
  reportStatus.textContent = 'LOADING';
  const query = new URLSearchParams({ year: reportYear.value, month: reportMonth.value, party: reportParty.value, type: reportType.value });
  try {
    const response = await fetch(`/api/invoices?${query}`);
    const result = await readJsonResponse(response);
    if (!response.ok) throw new Error(result.error || 'Unable to load invoice report.');
    const invoices = result.invoices || [];
    setReportOptions(reportYear, invoices.map((item) => item.financialYear), 'All years');
    setReportOptions(reportMonth, invoices.map((item) => item.month), 'All months');
    setReportOptions(reportParty, invoices.map((item) => item.partyName), 'All parties');
    reportTableBody.replaceChildren();
    reportEmpty.classList.toggle('is-hidden', invoices.length > 0);
    reportCount.textContent = `${invoices.length} record${invoices.length === 1 ? '' : 's'}`;
    invoices.forEach((invoice) => {
      const row = document.createElement('tr');
      [invoice.invoiceNumber || '-', invoice.invoiceDate || '-', invoice.partyName || '-', invoice.transactionType || '-', invoice.month || '-', invoice.invoiceAmount || '-'].forEach((value) => {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      });
      const actions = document.createElement('td');
      actions.className = 'report-actions';
      [['View', 'data-view-id'], ['Download', 'data-download-id'], ['Email', 'data-email-id']].forEach(([label, attribute]) => {
        const button = document.createElement('button');
        button.className = 'report-action';
        button.type = 'button';
        button.textContent = label;
        button.setAttribute(attribute, invoice.id);
        actions.append(button);
      });
      row.append(actions);
      reportTableBody.append(row);
    });
    reportStatus.textContent = 'INDEX READY';
  } catch (error) {
    reportStatus.textContent = 'UNAVAILABLE';
    reportEmpty.textContent = error.message;
    reportEmpty.classList.remove('is-hidden');
  }
}

[reportYear, reportMonth, reportParty, reportType].forEach((select) => select.addEventListener('change', loadInvoiceReport));
document.querySelector('#clearReportFilters').addEventListener('click', () => { reportFilterForm.reset(); loadInvoiceReport(); });
reportTableBody.addEventListener('click', async (event) => {
  const viewButton = event.target.closest('[data-view-id]');
  const downloadButton = event.target.closest('[data-download-id]');
  const emailButton = event.target.closest('[data-email-id]');
  const invoiceId = viewButton?.dataset.viewId || downloadButton?.dataset.downloadId || emailButton?.dataset.emailId;
  if (!invoiceId) return;
  if (viewButton) { window.open(`/api/invoices/${encodeURIComponent(invoiceId)}/view`, '_blank', 'noopener'); return; }
  if (downloadButton) { window.location.href = `/api/invoices/${encodeURIComponent(invoiceId)}/download`; return; }
  const recipient = window.prompt('Recipient email address:');
  if (!recipient) return;
  const response = await fetch(`/api/invoices/${encodeURIComponent(invoiceId)}/email`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: recipient }) });
  const result = await readJsonResponse(response);
  window.alert(result.message || result.error || 'Email request completed.');
});

document.querySelectorAll('[data-settings-tab]').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('[data-settings-tab]').forEach((item) => {
      const active = item === tab;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('[data-settings-panel]').forEach((panel) => {
      panel.classList.toggle('is-hidden', panel.dataset.settingsPanel !== tab.dataset.settingsTab);
    });
  });
});

geminiModel.addEventListener('change', () => {
  const isCustom = geminiModel.value === 'custom';
  customGeminiModel.classList.toggle('is-hidden', !isCustom);
  customGeminiModelLabel.classList.toggle('is-hidden', !isCustom);
  customGeminiModel.required = isCustom;
});

async function submitSettings(form, endpoint, messageId, clearFields = []) {
  const message = document.querySelector(`#${messageId}`);
  message.className = 'settings-message';
  message.textContent = 'Saving securely...';
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(form).entries())),
    });
    const result = await readJsonResponse(response);
    if (!response.ok) throw new Error(result.error || 'Unable to save settings.');
    clearFields.forEach((selector) => { form.querySelector(selector).value = ''; });
    showMessage(message, result.message);
  } catch (error) {
    showMessage(message, error.message.includes('Failed to fetch') ? 'Backend unavailable. Start the Node server and try again.' : error.message, true);
  }
}

geminiForm.addEventListener('submit', (event) => {
  event.preventDefault();
  submitSettings(geminiForm, '/api/save-gemini-settings', 'geminiMessage', ['[name="geminiApiKey"]']);
});

emailForm.addEventListener('submit', (event) => {
  event.preventDefault();
  submitSettings(emailForm, '/api/save-email-settings', 'emailMessage', ['[name="smtpPassword"]']);
});

driveConfigForm.addEventListener('submit', (event) => {
  event.preventDefault();
  submitSettings(driveConfigForm, '/api/save-drive-config', 'driveMessage');
});

invoiceTestForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = invoicePdf.files[0];
  if (!file) return;
  invoiceTestButton.disabled = true;
  invoiceResult.classList.add('is-hidden');
  invoiceTestMessage.className = 'settings-message';
  invoiceTestMessage.textContent = 'Extracting details and saving to Google Drive...';
  try {
    const body = new FormData();
    body.append('invoice', file);
    const response = await fetch('/api/test-invoice-extraction', { method: 'POST', body });
    const result = await readJsonResponse(response);
    if (!response.ok) throw new Error(result.error || 'Unable to extract invoice details.');
    document.querySelector('#invoiceResultFilename').textContent = result.filename || 'Invoice details';
    pendingInvoiceToken = result.pendingToken || '';
    document.querySelector('#invoiceResultSummary').textContent = `${result.uniqueCount} unique page${result.uniqueCount === 1 ? '' : 's'} found. ${result.duplicateCount} existing or repeated duplicate${result.duplicateCount === 1 ? '' : 's'} detected. Review before saving.`;
    const resultsList = document.querySelector('#invoiceResultsList');
    resultsList.replaceChildren();
    (result.details || []).forEach((details, index) => {
      const card = document.createElement('article');
      card.className = 'extracted-page';
      const pageTitle = document.createElement('strong');
      pageTitle.textContent = `Page ${details.pageNumber || index + 1}`;
      card.append(pageTitle);
      [['Buyer', details.buyerName], ['Seller', details.sellerName], ['Date', details.invoiceDate], ['Number', details.invoiceNumber], ['Amount', details.invoiceAmount]].forEach(([label, value]) => {
        const field = document.createElement('div');
        const fieldLabel = document.createElement('span');
        const fieldValue = document.createElement('b');
        fieldLabel.textContent = label;
        fieldValue.textContent = value || '-';
        field.append(fieldLabel, fieldValue);
        card.append(field);
      });
      resultsList.append(card);
    });
    invoiceResult.classList.remove('is-hidden');
    const saveResponse = await fetch('/api/save-invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingToken: pendingInvoiceToken }),
    });
    const saveResult = await readJsonResponse(saveResponse);
    if (!saveResponse.ok) throw new Error(saveResult.error || 'Unable to save invoice to Google Drive.');
    pendingInvoiceToken = '';
    invoiceTestMessage.className = 'settings-message success';
    invoiceTestMessage.textContent = `${saveResult.message} Extracted details are shown below.`;
  } catch (error) {
    invoiceTestMessage.className = 'settings-message error';
    invoiceTestMessage.textContent = error.message.includes('Failed to fetch')
      ? 'Backend unavailable. Start the Node server and try again.'
      : error.message;
  } finally {
    invoiceTestButton.disabled = false;
  }
});
