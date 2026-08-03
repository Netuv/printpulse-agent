app.registerView('discovery', {
  html() {
    return `
      <div class="h-full bg-slate-50 flex flex-col relative">
        
        <!-- Header -->
        <header class="bg-white border-b border-slate-200 p-4 flex items-center gap-4 shrink-0">
          <button onclick="app.navigate('dashboard')" class="p-2 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"></path></svg>
          </button>
          <div>
            <h1 class="text-lg font-bold text-slate-800">Discovery</h1>
            <p class="text-xs text-slate-500 text-ellipsis overflow-hidden">Scan, add & manage printers</p>
          </div>
          <div class="ml-auto flex gap-2">
            <button id="btn-add-manual" class="px-3 py-2 border border-indigo-300 text-indigo-700 hover:bg-indigo-50 text-sm font-medium rounded-lg transition-colors flex items-center gap-1.5">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>
              Manual
            </button>
            <button id="btn-scan" class="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg shadow transition-colors flex items-center gap-2">
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
              <span id="scan-text">Scan</span>
            </button>
          </div>
        </header>

        <!-- Main Content -->
        <div class="flex-1 p-6 overflow-y-auto min-h-0">
          
          <!-- Scan Progress -->
          <div id="scan-progress" class="hidden mb-6 bg-white p-5 rounded-xl shadow-sm border border-indigo-100">
            <div class="flex items-center gap-4 mb-3">
              <div class="w-10 h-10 rounded-full bg-indigo-50 flex items-center justify-center animate-pulse">
                <svg class="w-5 h-5 text-indigo-600 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
              </div>
              <div class="flex-1">
                <div class="text-sm font-semibold text-slate-800">Scanning SNMP endpoints...</div>
                <div class="text-xs text-slate-500 mt-0.5" id="scan-status">Detecting printers on subnet</div>
              </div>
            </div>
            <div class="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
              <div class="bg-indigo-600 h-1.5 rounded-full w-full animate-pulse origin-left"></div>
            </div>
          </div>

          <!-- Manual Add Panel (togglable) -->
          <div id="manual-panel" class="hidden mb-6 bg-white p-5 rounded-xl shadow-sm border border-indigo-100">
            <div class="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
              <svg class="w-4 h-4 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>
              Add Printer Manually
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-4 gap-3 mb-3">
              <input id="manual-ip" type="text" placeholder="IP Address *" class="px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400">
              <input id="manual-merk" type="text" placeholder="Merk (e.g. Ricoh)" class="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400">
              <input id="manual-model" type="text" placeholder="Model (e.g. IM C2010)" class="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400">
              <input id="manual-serial" type="text" placeholder="Serial Number" class="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400">
            </div>
            <div class="flex justify-end gap-2">
              <button onclick="document.getElementById('manual-panel').classList.add('hidden')" class="px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100 rounded-lg transition-colors">Cancel</button>
              <button id="btn-manual-save" class="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg shadow-sm transition-colors">Register Printer</button>
            </div>
          </div>

          <!-- Empty State -->
          <div id="empty-state" class="flex flex-col items-center justify-center h-48 text-slate-400">
            <svg class="w-12 h-12 mb-3 opacity-20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>
            <p class="text-sm">Click "Scan" to auto-discover printers, or "Manual" to add by IP.</p>
            <button id="btn-scan-empty" class="mt-4 px-5 py-2 bg-indigo-100 text-indigo-700 hover:bg-indigo-200 rounded-lg text-sm font-medium transition-colors">Start Network Scan</button>
          </div>

          <!-- Stats bar (after scan) -->
          <div id="scan-stats" class="hidden mb-4 flex flex-wrap gap-2 text-xs">
            <span id="stat-new" class="px-2 py-1 rounded-full bg-green-100 text-green-700 font-medium hidden">New</span>
            <span id="stat-removed" class="px-2 py-1 rounded-full bg-red-100 text-red-700 font-medium hidden">Removed</span>
            <span id="stat-same" class="px-2 py-1 rounded-full bg-slate-100 text-slate-600 hidden">Same</span>
            <span id="stat-total" class="px-2 py-1 rounded-full bg-indigo-100 text-indigo-700"></span>
            <span id="stat-timestamp" class="text-slate-400 py-1"></span>
          </div>

          <!-- Cached / Previous Scan (shown before first scan) -->
          <div id="cached-section" class="hidden mb-6">
            <div class="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-3">Previously Discovered</div>
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-4" id="cached-list"></div>
          </div>

          <!-- Discovered Devices (fresh scan) -->
          <div id="discovered-section" class="hidden">
            <div class="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-3">Discovered Devices</div>
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-4" id="discovered-list"></div>
          </div>

        </div>
      </div>
    `;
  },

  async init() {
    const { ipcRenderer } = require('electron');

    const btnScan = document.getElementById('btn-scan');
    const btnScanEmpty = document.getElementById('btn-scan-empty');
    const btnManual = document.getElementById('btn-add-manual');
    const manualPanel = document.getElementById('manual-panel');
    const btnManualSave = document.getElementById('btn-manual-save');
    const scanText = document.getElementById('scan-text');
    const scanProgress = document.getElementById('scan-progress');
    const discoveredSection = document.getElementById('discovered-section');
    const discoveredList = document.getElementById('discovered-list');
    const cachedSection = document.getElementById('cached-section');
    const cachedList = document.getElementById('cached-list');
    const emptyState = document.getElementById('empty-state');
    const scanStats = document.getElementById('scan-stats');
    const statTotal = document.getElementById('stat-total');
    const statTimestamp = document.getElementById('stat-timestamp');

    // Show cached scan on load
    const cache = app.config.last_scan_cache;
    if (cache && cache.devices && cache.devices.length) {
      this.renderCached(cache.devices, cache.scan_time);
      cachedSection.classList.remove('hidden');
    }

    // Manual add toggle
    btnManual.addEventListener('click', () => {
      manualPanel.classList.toggle('hidden');
    });

    // Manual save
    btnManualSave.addEventListener('click', async () => {
      const ip = document.getElementById('manual-ip').value.trim();
      if (!ip) { app.toast('IP Address wajib diisi', 'error'); return; }
      
      const btn = btnManualSave;
      btn.disabled = true; btn.innerHTML = '<svg class="animate-spin w-4 h-4 inline mr-1" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> Registering...';
      
      try {
        const merk = document.getElementById('manual-merk').value.trim() || 'UNKNOWN';
        const model = document.getElementById('manual-model').value.trim() || 'UNKNOWN';
        const serial = document.getElementById('manual-serial').value.trim() || `MANUAL-${ip}`;
        
        await ipcRenderer.invoke('track-device', {
          ip, merk_detected: merk, model_detected: model,
          serial_number: serial,
          snmp_result: { sysName: serial },
        });
        
        app.config = await ipcRenderer.invoke('get-config');
        manualPanel.classList.add('hidden');
        document.getElementById('manual-ip').value = '';
        document.getElementById('manual-merk').value = '';
        document.getElementById('manual-model').value = '';
        document.getElementById('manual-serial').value = '';
        app.toast(`Printer ${ip} registered`, 'success');
      } catch (err) {
        app.toast('Gagal: ' + (err.error || err.message || 'Unknown'), 'error');
      } finally {
        btn.disabled = false; btn.textContent = 'Register Printer';
      }
    });

    const doScan = async () => {
      btnScan.disabled = true;
      btnScan.classList.add('opacity-70');
      scanText.textContent = 'Scanning...';
      
      emptyState.classList.add('hidden');
      scanProgress.classList.remove('hidden');
      discoveredSection.classList.add('hidden');
      cachedSection.classList.add('hidden');
      scanStats.classList.add('hidden');
      discoveredList.innerHTML = '';

      try {
        const result = await ipcRenderer.invoke('scan-network');
        
        // Update cache in local app.config
        app.config = await ipcRenderer.invoke('get-config');
        
        if (result.devices && result.devices.length > 0) {
          // Diff with cache
          const prevCache = app.config.last_scan_cache;
          const prevIps = prevCache ? new Set(prevCache.ips || []) : new Set();
          const currIps = new Set(result.devices.map(d => d.ip));
          
          let newIps = result.devices.filter(d => !prevIps.has(d.ip));
          let sameIps = result.devices.filter(d => prevIps.has(d.ip));
          let removed = prevCache ? (prevCache.ips || []).filter(ip => !currIps.has(ip)) : [];
          
          // Update stats
          statTotal.textContent = result.devices.length + ' printers';
          statTimestamp.textContent = 'Scan: ' + new Date(result.scan_time).toLocaleString('id-ID', {dateStyle:'short',timeStyle:'short'});
          
          if (newIps.length) {
            document.getElementById('stat-new').classList.remove('hidden');
            document.getElementById('stat-new').textContent = '+' + newIps.length + ' New';
          } else document.getElementById('stat-new').classList.add('hidden');
          
          if (removed.length) {
            document.getElementById('stat-removed').classList.remove('hidden');
            document.getElementById('stat-removed').textContent = '-' + removed.length + ' Removed';
            
            // Show removed devices inline
            const removedHtml = '<div class="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-3 mt-4">Gone since last scan</div>' +
              removed.map(ip => '<div class="bg-red-50 p-4 rounded-xl border border-red-200 flex items-center gap-3"><span class="w-2 h-2 rounded-full bg-red-400"></span><span class="font-mono text-sm text-red-700">' + ip + '</span></div>').join('');
            discoveredList.innerHTML += removedHtml;
          } else document.getElementById('stat-removed').classList.add('hidden');
          
          document.getElementById('stat-same').classList[prevCache ? 'remove' : 'add']('hidden');
          if (prevCache) document.getElementById('stat-same').textContent = sameIps.length + ' Unchanged';
          
          scanStats.classList.remove('hidden');
          
          this.renderDiscovered(result.devices, prevIps);
          discoveredSection.classList.remove('hidden');
        } else {
          emptyState.classList.remove('hidden');
          emptyState.innerHTML = '<p class="text-sm text-red-500">No MFP devices detected.</p>';
        }
      } catch (err) {
        app.toast('Scan failed: ' + (err.message || 'Error'), 'error');
        emptyState.classList.remove('hidden');
      } finally {
        btnScan.disabled = false;
        btnScan.classList.remove('opacity-70');
        scanText.textContent = 'Scan';
        scanProgress.classList.add('hidden');
      }
    };

    btnScan.addEventListener('click', doScan);
    btnScanEmpty.addEventListener('click', doScan);

    // Make global for onclick handlers — always track directly
    // Web scraping will auto-detect if credentials are needed during polling
    window.trackDevice = async (ip, merk, model, sn) => {
      await doTrackDevice(ip, merk, model, sn, '', '', null);
    };

    // ── Credential Modal for vendors that need web auth ──
    let _pendingCred = null;

    window.showCredentialModal = (ip, merk, model, sn) => {
      _pendingCred = { ip, merk, model, sn };
      const modal = document.getElementById('cred-modal');
      if (!modal) return doTrackDevice(ip, merk, model, sn, '', '', null); // fallback if no modal
      document.getElementById('cred-ip').textContent = ip;
      document.getElementById('cred-merk').textContent = (merk || 'Printer') + ' ' + (model || '');
      document.getElementById('cred-username').value = '';
      document.getElementById('cred-password').value = '';
      document.getElementById('cred-error').classList.add('hidden');
      // Unify with global handlers via dataset
      modal.dataset.ip = ip;
      modal.dataset.mode = 'track';
      modal.dataset.merk = merk || '';
      modal.dataset.model = model || '';
      modal.dataset.sn = sn || '';
      modal.classList.remove('hidden');
    };

    window.closeCredModal = () => {
      document.getElementById('cred-modal').classList.add('hidden');
      _pendingCred = null;
    };

    window.doTrackDevice = doTrackDevice;

    async function doTrackDevice(ip, merk, model, sn, webUser, webPass, webSsl) {
      try {
        // Find button by IP in onclick
        const btns = document.querySelectorAll('button[onclick*=\'' + ip + '\']');
        const btn = btns[0];
        if (btn) { btn.innerHTML = 'Syncing...'; btn.disabled = true; }

        await ipcRenderer.invoke('track-device', {
          ip, merk_detected: merk, model_detected: model,
          snmp_result: { sysName: sn },
          web_username: webUser, web_password: webPass, web_ssl: webSsl
        });

        app.config = await ipcRenderer.invoke('get-config');
        if (btn) {
          btn.innerHTML = 'Tracked &#10003;';
          btn.className = 'bg-slate-100 text-slate-400 cursor-not-allowed px-4 py-2 rounded-lg text-sm font-medium transition-colors w-full sm:w-auto text-center';
        }
        app.toast('Tracked ' + ip);
      } catch (err) {
        const msg = err.message || err.error || 'Unknown';
        app.toast('Failed: ' + msg, 'error');
        // If token expired, auto-navigate to login
        if (msg.includes('Token') || msg.includes('token') || msg.includes('Unauthorized')) {
          setTimeout(() => app.navigate('login'), 1500);
        }
        const btns = document.querySelectorAll('button[onclick*=\'' + ip + '\']');
        if (btns[0]) { btns[0].textContent = 'Track Device'; btns[0].disabled = false; }
      }
    }
  },

  renderCached(devices, scanTime) {
    const list = document.getElementById('cached-list');
    const cfgDevices = (app.config.tracked_devices || []).map(d => d.ip);
    
    list.innerHTML = devices.map(d => {
      const tracked = cfgDevices.includes(d.ip);
      return '<div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">' +
        '<div><div class="font-semibold text-slate-800">' + (d.vendor || 'Unknown') + ' ' + (d.model || '') + '</div>' +
        '<div class="text-sm font-mono text-indigo-600 mt-0.5"><a href="#" onclick="event.preventDefault();window.openWebUI(\'' + d.ip + '\')" class="hover:underline">' + d.ip + '</a></div>' +
        '<div class="text-xs text-slate-400 mt-0.5">' + (d.serial || d.hostname || '') + '</div></div>' +
        (tracked ? '<span class="px-3 py-1 rounded-lg bg-slate-100 text-slate-400 text-sm">Tracked</span>' :
         '<button onclick="event.currentTarget.disabled=true;event.currentTarget.textContent=\'Tracking...\';window.trackDevice(\'' + d.ip + '\',\'' + (d.vendor||'') + '\',\'' + (d.model||'') + '\',\'' + (d.serial||'') + '\')" class="px-3 py-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-lg text-sm font-medium transition-colors">Track</button>') +
      '</div>';
    }).join('');
    if (scanTime) {
      document.getElementById('cached-section').querySelector('.text-sm.font-semibold').textContent = 'Previous Scan: ' + new Date(scanTime).toLocaleString('id-ID', {dateStyle:'medium',timeStyle:'short'});
    }
  },

  renderDiscovered(devices, prevIps) {
    const list = document.getElementById('discovered-list');
    
    list.innerHTML = devices.map(d => {
      const isTracked = app.config.tracked_devices.find(td => td.ip === d.ip);
      const isNew = prevIps && !prevIps.has(d.ip);
      
      const parseJwt = (token) => {
        try { return JSON.parse(atob(token.split('.')[1])); } catch (e) { return {}; }
      };
      const payload = parseJwt(app.config.token || '');
      const userRole = payload.role || 'UNKNOWN';
      const canTrack = ['SUPER_ADMIN', 'TEKNISI', 'TENANT_ADMIN'].includes(userRole);

      let btnHtml = '';
      if (isTracked) {
        btnHtml = '<button disabled class="bg-slate-100 text-slate-400 cursor-not-allowed px-4 py-2 rounded-lg text-sm font-medium w-full sm:w-auto text-center">Tracked &#10003;</button>';
      } else if (!canTrack) {
        btnHtml = '<span class="text-xs text-slate-400">View Only</span>';
      } else {
        btnHtml = '<div class="flex flex-col gap-2 w-full sm:w-auto mt-3 sm:mt-0">' +
          '<details class="text-xs text-slate-500 bg-slate-50 p-2 rounded border border-slate-100 cursor-pointer">' +
            '<summary class="font-medium text-slate-600 hover:text-indigo-600 outline-none">SNMPv3 (opt)</summary>' +
            '<div class="mt-2 flex flex-col gap-2 cursor-default">' +
              '<input type="text" id="v3-user-' + d.ip.replace(/\./g,'-') + '" placeholder="Username" class="px-2 py-1 border rounded w-full">' +
              '<input type="password" id="v3-auth-' + d.ip.replace(/\./g,'-') + '" placeholder="Auth Password" class="px-2 py-1 border rounded w-full">' +
              '<input type="password" id="v3-priv-' + d.ip.replace(/\./g,'-') + '" placeholder="Priv Password" class="px-2 py-1 border rounded w-full">' +
            '</div></details>' +
          '<button onclick="trackDevice(\'' + d.ip + '\',\'' + (d.merk_detected||d.vendor||'') + '\',\'' + (d.model_detected||d.model||'') + '\',\'' + ((d.snmp_result&&d.snmp_result.sysName)||d.serial||'') + '\')" class="bg-indigo-50 text-indigo-700 hover:bg-indigo-100 px-4 py-2 rounded-lg text-sm font-medium transition-colors w-full text-center shadow-sm">Track Device</button></div>';
      }

      const borderCls = isNew ? 'border-green-300 bg-green-50/30' : 'border-slate-200';
      const badge = isNew ? '<span class="text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-medium ml-2">New</span>' : '';

      return '<div class="bg-white p-5 rounded-xl border shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4 transition-all hover:shadow-md ' + borderCls + '">' +
        '<div><div class="font-bold text-slate-800 text-base">' + (d.merk_detected||d.vendor||'Unknown') + ' <span class="font-normal text-slate-600">' + (d.model_detected||d.model||'') + '</span>' + badge + '</div>' +
        '<div class="flex items-center gap-3 mt-1.5"><span class="inline-flex items-center gap-1.5 text-sm font-mono text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"></path></svg><a href="#" onclick="event.preventDefault();window.openWebUI(\'' + d.ip + '\')" class="hover:underline">' + d.ip + '</a></span></div>' +
        '<div class="text-xs text-slate-400 mt-2 font-mono truncate">' + ((d.snmp_result&&d.snmp_result.sysName)||d.serial||d.hostname||'') + '</div></div>' +
        '<div class="shrink-0 flex items-center">' + btnHtml + '</div></div>';
    }).join('');
  }
});
