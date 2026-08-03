const { ipcRenderer } = require('electron');

// DOM Elements
const loginView = document.getElementById('login-view');
const dashboardView = document.getElementById('dashboard-view');
const loginForm = document.getElementById('login-form');
const btnLogin = document.getElementById('btn-login');
const loginError = document.getElementById('login-error');

const btnLogout = document.getElementById('btn-logout');
const btnScan = document.getElementById('btn-scan');
const scanText = document.getElementById('scan-text');
const scanProgress = document.getElementById('scan-progress');
const discoveredSection = document.getElementById('discovered-section');
const discoveredList = document.getElementById('discovered-list');
const trackedList = document.getElementById('tracked-list');

// State
let config = {};

// Init
async function init() {
  config = await ipcRenderer.invoke('get-config');
  if (config.token) {
    showDashboard();
  } else {
    showLogin();
  }
}

function showLogin() {
  loginView.classList.remove('hidden');
  dashboardView.classList.add('hidden');
}

function showDashboard() {
  loginView.classList.add('hidden');
  dashboardView.classList.remove('hidden');
  renderTracked();
}

// Login
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;
  
  btnLogin.disabled = true;
  btnLogin.textContent = 'Memproses...';
  loginError.classList.add('hidden');

  try {
    const res = await ipcRenderer.invoke('login', { email, password });
    
    // Update local state and UI
    config = await ipcRenderer.invoke('get-config');
    document.getElementById('user-name').textContent = res.user.nama;
    document.getElementById('tenant-name').textContent = res.user.tenant_nama;
    
    showDashboard();
  } catch (err) {
    loginError.textContent = err.error || 'Login gagal';
    loginError.classList.remove('hidden');
  } finally {
    btnLogin.disabled = false;
    btnLogin.textContent = 'Login';
  }
});

// Logout
btnLogout.addEventListener('click', async () => {
  await ipcRenderer.invoke('logout');
  showLogin();
});

// Scan Network
btnScan.addEventListener('click', async () => {
  btnScan.disabled = true;
  scanText.textContent = 'Scanning...';
  scanProgress.classList.remove('hidden');
  discoveredSection.classList.add('hidden');
  discoveredList.innerHTML = '';

  try {
    const result = await ipcRenderer.invoke('scan-network');
    
    if (result.devices && result.devices.length > 0) {
      renderDiscovered(result.devices);
      discoveredSection.classList.remove('hidden');
    } else {
      alert('Tidak ada mesin printer/MFP yang ditemukan di jaringan lokal.');
    }
  } catch (err) {
    alert('Scan gagal: ' + (err.message || 'Unknown error'));
  } finally {
    btnScan.disabled = false;
    scanText.textContent = 'Scan Network';
    scanProgress.classList.add('hidden');
  }
});

// Render Discovered
function renderDiscovered(devices) {
  discoveredList.innerHTML = devices.map(d => {
    // Check if already tracked
    const isTracked = config.tracked_devices.find(td => td.ip === d.ip);
    
    return `
      <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
        <div>
          <div class="font-semibold text-slate-800">${d.merk_detected} ${d.model_detected || ''}</div>
          <div class="text-sm text-slate-500 font-mono">${d.ip}</div>
          <div class="text-xs text-slate-400 mt-1 max-w-[150px] truncate" title="${d.hostname}">${d.hostname}</div>
        </div>
        <button onclick="trackDevice('${d.ip}', '${d.merk_detected}', '${d.model_detected}', '${d.snmp_result?.sysName || ''}')" 
                class="${isTracked ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-indigo-50 text-indigo-700 hover:bg-indigo-100'} px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
                ${isTracked ? 'disabled' : ''}>
          ${isTracked ? 'Tracked' : 'Track Device'}
        </button>
      </div>
    `;
  }).join('');
}

// Track Device (called from HTML onclick) — shows credential modal first
window.trackDevice = async (ip, merk, model, sn) => {
  // Check if this vendor typically needs web credentials
  const needsCred = detectVendorNeedsCred(merk, model);
  
  if (needsCred) {
    // Show credential modal
    showCredentialModal(ip, merk, model, sn);
  } else {
    // Track without credentials
    await doTrackDevice(ip, merk, model, sn, '', '', false);
  }
}

function detectVendorNeedsCred(merk, model) {
  // Vendors that typically need HTTP Basic Auth for toner data
  const credVendors = ['xerox', 'fuji', 'sharp', 'toshiba'];
  const m = (merk || '').toLowerCase();
  return credVendors.some(v => m.includes(v));
}

let _pendingTrack = null;

function showCredentialModal(ip, merk, model, sn) {
  _pendingTrack = { ip, merk, model, sn };
  const modal = document.getElementById('cred-modal');
  document.getElementById('cred-ip').textContent = ip;
  document.getElementById('cred-merk').textContent = merk + ' ' + (model || '');
  document.getElementById('cred-username').value = '';
  document.getElementById('cred-password').value = '';
  document.getElementById('cred-error').classList.add('hidden');
  modal.classList.remove('hidden');
}

window.closeCredModal = () => {
  document.getElementById('cred-modal').classList.add('hidden');
  _pendingTrack = null;
}

window.submitCredModal = async () => {
  if (!_pendingTrack) return;
  const username = document.getElementById('cred-username').value;
  const password = document.getElementById('cred-password').value;
  document.getElementById('cred-modal').classList.add('hidden');
  await doTrackDevice(_pendingTrack.ip, _pendingTrack.merk, _pendingTrack.model, _pendingTrack.sn, username, password, false);
  _pendingTrack = null;
}

window.skipCredModal = async () => {
  if (!_pendingTrack) return;
  document.getElementById('cred-modal').classList.add('hidden');
  await doTrackDevice(_pendingTrack.ip, _pendingTrack.merk, _pendingTrack.model, _pendingTrack.sn, '', '', false);
  _pendingTrack = null;
}

async function doTrackDevice(ip, merk, model, sn, webUser, webPass, webSsl) {
  try {
    const btn = document.querySelector(`button[onclick*="'${ip}'"]`);
    if (btn) { btn.textContent = 'Syncing...'; btn.disabled = true; }

    await ipcRenderer.invoke('track-device', {
      ip, merk_detected: merk, model_detected: model,
      snmp_result: { sysName: sn },
      web_username: webUser, web_password: webPass, web_ssl: webSsl
    });
    
    config = await ipcRenderer.invoke('get-config');
    renderTracked();
    
    if (btn) {
      btn.textContent = 'Tracked';
      btn.className = 'bg-slate-100 text-slate-400 cursor-not-allowed px-3 py-1.5 rounded-lg text-sm font-medium transition-colors';
    }
  } catch (err) {
    alert('Gagal meregistrasi mesin: ' + (err.message || err.error || String(err)));
    const btn = document.querySelector(`button[onclick*="'${ip}'"]`);
    if (btn) { btn.textContent = 'Track Device'; btn.disabled = false; }
  }
}

// Render Tracked
function renderTracked() {
  const devices = config.tracked_devices || [];
  
  if (devices.length === 0) {
    trackedList.innerHTML = `
      <tr><td colspan="3" class="px-4 py-8 text-center text-slate-500 text-sm">Belum ada mesin yang ditrack. Silakan Scan Network.</td></tr>
    `;
    return;
  }

  trackedList.innerHTML = devices.map(d => `
    <tr class="hover:bg-slate-50 transition-colors">
      <td class="px-4 py-3 font-mono text-indigo-600">${d.ip}</td>
      <td class="px-4 py-3">
        <div class="font-medium text-slate-800">${(d.last_data?.merk || d.merk || 'Unknown')} ${(d.last_data?.model || d.model || '')}</div>
        <div class="text-xs text-slate-500">ID Cloud: ${d.id}</div>
      </td>
      <td class="px-4 py-3 text-right">
        <button onclick="untrackDevice('${d.ip}')" class="text-red-500 hover:text-red-700 text-sm px-2 py-1 rounded hover:bg-red-50 transition-colors">Untrack</button>
      </td>
    </tr>
  `).join('');
}

window.untrackDevice = async (ip) => {
  if (confirm(`Stop tracking IP ${ip}? Data tidak akan dihapus dari Cloud.`)) {
    await ipcRenderer.invoke('untrack-device', ip);
    config = await ipcRenderer.invoke('get-config');
    renderTracked();
  }
}

init();
