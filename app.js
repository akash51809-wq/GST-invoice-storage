const loginView = document.querySelector('#loginView');
const dashboardView = document.querySelector('#dashboardView');
const loginForm = document.querySelector('#loginForm');
const loginError = document.querySelector('#loginError');
const sidebar = document.querySelector('#sidebar');
const dashboardPage = document.querySelector('#dashboardPage');
const settingsPage = document.querySelector('#settingsPage');
const uploadPage = document.querySelector('#uploadPage');
const settingsLink = document.querySelector('#settingsLink');
const uploadLink = document.querySelector('#uploadLink');
const driveConfigForm = document.querySelector('#driveConfigForm');
const driveConfigMessage = document.querySelector('#driveConfigMessage');
const invoiceUploadForm = document.querySelector('#invoiceUploadForm');
const invoiceFile = document.querySelector('#invoiceFile');
const dropZone = document.querySelector('#dropZone');
const browseButton = document.querySelector('#browseButton');
const selectedFile = document.querySelector('#selectedFile');
const uploadButton = document.querySelector('#uploadButton');
const uploadMessage = document.querySelector('#uploadMessage');
const uploadProgress = document.querySelector('#uploadProgress');

loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const formData = new FormData(loginForm);
  const username = formData.get('username').trim();
  const password = formData.get('password');

  if (username === 'admin' && password === 'Admin@123') {
    loginError.textContent = '';
    loginView.classList.add('is-hidden');
    dashboardView.classList.remove('is-hidden');
    document.querySelector('#username').value = '';
    document.querySelector('#password').value = '';
  } else {
    loginError.textContent = 'Access denied. Check your username and password.';
    document.querySelector('#password').focus();
  }
});

document.querySelector('#menuButton').addEventListener('click', () => {
  sidebar.classList.toggle('is-open');
});

document.querySelectorAll('.main-nav a').forEach((link) => {
  link.addEventListener('click', () => {
    document.querySelectorAll('.main-nav a').forEach((item) => item.classList.remove('active'));
    link.classList.add('active');
    const isSettings = link === settingsLink;
    const isUpload = link === uploadLink;
    dashboardPage.classList.toggle('is-hidden', isSettings || isUpload);
    settingsPage.classList.toggle('is-hidden', !isSettings);
    uploadPage.classList.toggle('is-hidden', !isUpload);
    document.querySelector('.breadcrumb').innerHTML = isSettings || isUpload
      ? `<span>Manage</span><b>/</b> ${isUpload ? 'Upload Invoice' : 'Settings'}`
      : '<span>Workspace</span><b>/</b> My Dashboard';
    sidebar.classList.remove('is-open');
  });
});

function showSelectedFile(file) {
  if (!file) return;
  selectedFile.classList.remove('is-hidden');
  selectedFile.querySelector('strong').textContent = file.name;
  selectedFile.querySelector('small').textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB`;
  uploadButton.disabled = false;
  uploadMessage.textContent = '';
}

browseButton.addEventListener('click', () => invoiceFile.click());
dropZone.addEventListener('click', (event) => { if (event.target !== browseButton) invoiceFile.click(); });
dropZone.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') invoiceFile.click(); });
invoiceFile.addEventListener('change', () => showSelectedFile(invoiceFile.files[0]));
['dragenter', 'dragover'].forEach((eventName) => dropZone.addEventListener(eventName, (event) => {
  event.preventDefault();
  dropZone.classList.add('is-dragging');
}));
['dragleave', 'drop'].forEach((eventName) => dropZone.addEventListener(eventName, (event) => {
  event.preventDefault();
  dropZone.classList.remove('is-dragging');
}));
dropZone.addEventListener('drop', (event) => {
  const [file] = event.dataTransfer.files;
  showSelectedFile(file);
  if (file) { const transfer = new DataTransfer(); transfer.items.add(file); invoiceFile.files = transfer.files; }
});
document.querySelector('#removeFile').addEventListener('click', () => {
  invoiceFile.value = '';
  selectedFile.classList.add('is-hidden');
  uploadButton.disabled = true;
});

async function readJsonResponse(response) {
  const responseText = await response.text();
  if (!responseText.trim()) return {};
  try {
    return JSON.parse(responseText);
  } catch (error) {
    return { success: false, error: 'The server returned an invalid response.' };
  }
}

invoiceUploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = invoiceFile.files[0];
  if (!file) return;
  uploadButton.disabled = true;
  uploadProgress.classList.remove('is-hidden');
  uploadMessage.className = 'settings-message';
  uploadMessage.textContent = '';
  const progressBar = uploadProgress.querySelector('i');
  const progressLabel = uploadProgress.querySelector('b');
  progressBar.style.width = '12%';
  progressLabel.textContent = '12%';
  const body = new FormData();
  body.append('invoice', file);
  try {
    const response = await fetch('/api/upload-invoice', { method: 'POST', body });
    progressBar.style.width = '100%';
    progressLabel.textContent = '100%';
    const result = await readJsonResponse(response);
    if (!response.ok) throw new Error(result.error || result.message || 'Invoice upload failed.');
    uploadMessage.className = 'settings-message success';
    uploadMessage.textContent = 'Invoice uploaded and saved to Google Drive successfully!';
    invoiceUploadForm.reset();
    selectedFile.classList.add('is-hidden');
  } catch (error) {
    uploadMessage.className = 'settings-message error';
    uploadMessage.textContent = error.message.includes('Failed to fetch') ? 'Backend unavailable. Start the Node server and try again.' : error.message;
    uploadButton.disabled = false;
  } finally {
    setTimeout(() => uploadProgress.classList.add('is-hidden'), 500);
  }
});

driveConfigForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  driveConfigMessage.className = 'settings-message';
  driveConfigMessage.textContent = 'Saving securely...';
  const formData = new FormData(driveConfigForm);

  try {
    const response = await fetch('/api/save-drive-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(formData.entries())),
    });
    const result = await readJsonResponse(response);
    if (!response.ok) throw new Error(result.error || result.message || 'Unable to save configuration.');
    driveConfigMessage.className = 'settings-message success';
    driveConfigMessage.textContent = result.message;
    driveConfigForm.reset();
  } catch (error) {
    driveConfigMessage.className = 'settings-message error';
    driveConfigMessage.textContent = error.message.includes('Failed to fetch')
      ? 'Backend unavailable. Start the Node server and try again.'
      : error.message;
  }
});