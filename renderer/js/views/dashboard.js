app.registerView('dashboard', {
  html() {
    return `
      <!-- Header -->
      <header class="bg-indigo-600 text-white p-4 shadow flex justify-between items-center z-10 shrink-0">
        <div>
          <h1 class="text-xl font-bold flex items-center gap-2">
            PrintPulse Agent v3
            <span class="px-2 py-0.5 rounded-full bg-indigo-500 text-[10px] font-mono tracking-wide uppercase" id="agent-mode-badge">Enterprise</span>
          </h1>
          <div class="mt-1 flex items-center gap-2">
            <input type="text" id="agent-name-input" class="bg-indigo-500 text-white text-sm px-2 py-1 rounded border border-indigo-400 focus:outline-none focus:border-white placeholder-indigo-300" placeholder="Agent Name (UUID)">
            <button id="btn-save-name" class="text-xs bg-indigo-700 hover:bg-indigo-800 px-2 py-1 rounded transition-colors hidden">Save</button>
          </div>
        </div>
        <div class="flex items-center gap-4">
          <div class="text-right">
            <div class="text-sm font-medium" id="user-role-display">Logged in</div>
            <div class="text-xs text-indigo-200" id="user-sub-display">System Ready</div>
          </div>
          <div id="layered-badge" class="hidden flex-col items-end">
            <div class="text-xs font-bold text-amber-200 bg-amber-500/20 rounded-full px-2 py-0.5 flex items-center gap-1">
              <i class="ph ph-shield-check"></i> <span id="layered-name">Teknisi</span>
            </div>
            <div class="text-[9px] text-amber-100/80 mt-0.5" id="layered-countdown"></div>
          </div>
          <button id="btn-layered-login" class="hidden px-3 py-2 bg-amber-500 hover:bg-amber-400 text-white text-xs font-medium rounded-lg transition-colors">
            <i class="ph ph-sign-in"></i> Login Teknisi/Admin
          </button>
          <button id="btn-send-log" class="hidden px-4 py-2 bg-emerald-500 hover:bg-emerald-400 rounded-lg text-sm font-medium transition-colors">
            Kirim Log & Catatan
          </button>
          <button id="btn-logout" class="px-4 py-2 bg-indigo-500 hover:bg-indigo-400 rounded-lg text-sm font-medium transition-colors">
            Logout
          </button>
        </div>
      </header>

      <!-- Main Content -->
      <div class="flex-1 overflow-y-auto bg-slate-50">
        
        <!-- Top Stats & Status -->
        <div class="p-6 pb-0">
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          
          <div class="bg-white p-5 rounded-xl shadow-sm border border-slate-200 flex items-center justify-between">
            <div>
              <div class="text-sm text-slate-500 font-medium mb-1">Poller Status</div>
              <div id="poller-status" class="text-lg font-bold text-slate-800 flex items-center gap-2">
                <span class="w-2.5 h-2.5 rounded-full bg-slate-300" id="poller-indicator"></span>
                Waiting...
              </div>
              <div id="poller-time" class="text-xs text-slate-400 mt-1">-</div>
            </div>
            <button id="btn-force-sync" class="p-2 text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors" title="Force Sync Now">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
            </button>
          </div>

          <div class="bg-white p-5 rounded-xl shadow-sm border border-slate-200">
            <div class="text-sm text-slate-500 font-medium mb-1">Tracked Machines</div>
            <div class="text-2xl font-bold text-slate-800" id="tracked-count">0</div>
          </div>

          <button onclick="app.navigate('discovery')" class="bg-indigo-600 hover:bg-indigo-700 text-white p-5 rounded-xl shadow-sm flex flex-col justify-center transition-colors group text-left">
            <div class="text-indigo-200 font-medium text-sm mb-1 group-hover:text-white transition-colors">Add New Machine</div>
            <div class="text-lg font-bold flex items-center justify-between">
              Scan Network
              <svg class="w-5 h-5 opacity-70 group-hover:opacity-100 transition-opacity" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
            </div>
          </button>
        </div>
        </div>

        <!-- Chart Section -->
        <div class="bg-white p-5 rounded-xl shadow-sm border border-slate-200 mx-6 mt-6">
          <h2 class="text-base font-semibold text-slate-800 mb-4">Total Page Volume (Live Tracking)</h2>
          <div class="h-52 w-full">
            <canvas id="usageChart"></canvas>
          </div>
        </div>

        <!-- Tracked Devices Table -->
        <div class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden mx-6 mt-4 mb-6">
          <div class="p-4 border-b border-slate-100 bg-slate-50 flex justify-between items-center">
            <h2 class="text-sm font-semibold text-slate-700 uppercase tracking-wider">Device Roster</h2>
            <span id="tracked-count-badge" class="bg-indigo-100 text-indigo-700 text-xs font-bold px-2 py-0.5 rounded-full">0</span>
          </div>
          <table class="w-full text-left text-sm">
            <thead class="bg-white text-slate-500 border-b border-slate-100">
              <tr>
                <th class="px-5 py-3 font-medium">IP Address</th>
                <th class="px-5 py-3 font-medium">Machine / Pelanggan</th>
                <th class="px-5 py-3 font-medium">Counter</th>
                <th class="px-5 py-3 font-medium">Toner Status</th>
                <th class="px-5 py-3 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody id="tracked-list" class="divide-y divide-slate-50">
              <!-- Rendered via JS -->
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  async init() {
    const { ipcRenderer } = require('electron');

    const parseJwt = (token) => {
      try { return JSON.parse(atob(token.split('.')[1])); } catch (e) { return {}; }
    };
    
    const payload = parseJwt(app.config.token || '');
    const role = payload.role || 'UNKNOWN';
    this.userRole = role;
    this.canChangeSettings = ['SUPER_ADMIN', 'TEKNISI', 'TENANT_ADMIN', 'OPERATOR'].includes(role);
    window.agentCanChangeSettings = this.canChangeSettings;
    document.getElementById('user-role-display').textContent = role;

    let mode = 'ONLINE';
    let modeBg = 'bg-indigo-500';
    if (role === 'TEKNISI') { mode = 'MAINTENANCE'; modeBg = 'bg-yellow-500 text-yellow-900'; }
    if (role === 'AGENT') { mode = 'VIEWING'; modeBg = 'bg-blue-500 text-white'; }
    
    const badge = document.getElementById('agent-mode-badge');
    badge.textContent = mode;
    badge.className = `px-2 py-0.5 rounded-full text-[10px] font-mono tracking-wide uppercase ${modeBg}`;

    if (role === 'TEKNISI') {
      document.getElementById('btn-send-log').classList.remove('hidden');
    }

    const nameInput = document.getElementById('agent-name-input');
    const saveBtn = document.getElementById('btn-save-name');
    nameInput.value = app.config.agent_label || app.config.agent_id || '';
    
    nameInput.addEventListener('input', () => {
      saveBtn.classList.remove('hidden');
    });

    saveBtn.onclick = async () => {
      await ipcRenderer.invoke('set-agent-label', nameInput.value);
      saveBtn.classList.add('hidden');
      app.toast('Agent name saved');
    };

    // Chart Setup
    const ctx = document.getElementById('usageChart').getContext('2d');
    if (this.chart) {
      this.chart.destroy();
    }
    this.chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: [],
        datasets: [
          { label: 'BW Pages', data: [], backgroundColor: '#94a3b8', borderRadius: 4 },
          { label: 'Color Pages', data: [], backgroundColor: '#6366f1', borderRadius: 4 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'top', align: 'end' } },
        scales: {
          y: { beginAtZero: true, grid: { color: '#f1f5f9' }, border: { display: false } },
          x: { grid: { display: false }, border: { display: false } }
        }
      }
    });

    // Logout
    document.getElementById('btn-logout').onclick = async () => {
      // If layered (admin/tech) session active → just drop layered, stay on PIC
      if (app.config.layered_user) {
        await ipcRenderer.invoke('logout-layered');
        app.config = await ipcRenderer.invoke('get-config');
        this._renderLayeredState();
        app.toast('Kembali ke akun PIC (' + (app.config.pic_user?.nama || app.config.pic_user?.email || 'PIC') + ')');
        return;
      }
      await ipcRenderer.invoke('logout');
      app.navigate('login');
    };

    // ── Layered login (Admin/Technician above PIC) + idle timeout ──
    this._renderLayeredState = () => {
      const layered = app.config.layered_user;
      const badge = document.getElementById('layered-badge');
      const btn = document.getElementById('btn-layered-login');
      if (!badge || !btn) return;
      if (layered) {
        badge.classList.remove('hidden');
        badge.classList.add('flex');
        btn.classList.add('hidden');
        document.getElementById('layered-name').textContent =
          (layered.nama || layered.email) + ' · ' + (layered.role || '');
        // Update permissions for activity editing
        this.canChangeSettings = ['SUPER_ADMIN', 'TEKNISI', 'TENANT_ADMIN', 'OPERATOR'].includes(layered.role);
        window.agentCanChangeSettings = this.canChangeSettings;
        this.userRole = layered.role;
        document.getElementById('user-role-display').textContent = layered.role;
        // Show send-log for TEKNISI
        const sendLogBtn = document.getElementById('btn-send-log');
        if (sendLogBtn) sendLogBtn.classList.toggle('hidden', layered.role !== 'TEKNISI');
        this._startIdleTimer();
      } else {
        badge.classList.add('hidden');
        badge.classList.remove('flex');
        btn.classList.remove('hidden');
        // Back to PIC role
        const picRole = (app.config.pic_user && app.config.pic_user.role) || 'AGENT';
        this.canChangeSettings = ['SUPER_ADMIN', 'TEKNISI', 'TENANT_ADMIN', 'OPERATOR'].includes(picRole);
        window.agentCanChangeSettings = this.canChangeSettings;
        this.userRole = picRole;
        document.getElementById('user-role-display').textContent = picRole || 'AGENT';
        const sendLogBtn = document.getElementById('btn-send-log');
        if (sendLogBtn) sendLogBtn.classList.toggle('hidden', picRole !== 'TEKNISI');
        this._stopIdleTimer();
      }
      // Re-render table so role-gated action buttons (SNMP, untrack, etc.) update immediately
      if (typeof this.renderTable === 'function') this.renderTable();
      if (typeof this.updateChart === 'function') this.updateChart();
    };

    this._stopIdleTimer = () => {
      if (this._idleTimer) { clearInterval(this._idleTimer); this._idleTimer = null; }
      if (this._idleDeadline) {
        window.removeEventListener('mousemove', this._onIdleActivity);
        window.removeEventListener('keydown', this._onIdleActivity);
        window.removeEventListener('click', this._onIdleActivity);
        this._idleDeadline = null;
      }
    };

    this._onIdleActivity = () => {
      if (app.config.layered_user) {
        const min = app.config.idle_timeout_min || 5;
        this._idleDeadline = Date.now() + min * 60000;
        this._updateCountdown();
      }
    };

    this._startIdleTimer = () => {
      this._stopIdleTimer();
      const min = app.config.idle_timeout_min || 5;
      this._idleDeadline = Date.now() + min * 60000;
      window.addEventListener('mousemove', this._onIdleActivity, { passive: true });
      window.addEventListener('keydown', this._onIdleActivity, { passive: true });
      window.addEventListener('click', this._onIdleActivity, { passive: true });
      this._updateCountdown();
      this._idleTimer = setInterval(() => {
        if (!app.config.layered_user) return;
        if (Date.now() >= this._idleDeadline) {
          this._idleTimeoutLayered();
        } else {
          this._updateCountdown();
        }
      }, 1000);
    };

    this._updateCountdown = () => {
      const el = document.getElementById('layered-countdown');
      if (!el || !this._idleDeadline) return;
      const s = Math.max(0, Math.round((this._idleDeadline - Date.now()) / 1000));
      const m = Math.floor(s / 60), sec = s % 60;
      el.textContent = `Idle logout: ${m}:${String(sec).padStart(2,'0')}`;
    };

    this._idleTimeoutLayered = async () => {
      const { ipcRenderer } = require('electron');
      console.log('[Layered] Idle timeout — kembali ke PIC');
      await ipcRenderer.invoke('logout-layered');
      app.config = await ipcRenderer.invoke('get-config');
      this._renderLayeredState();
      app.toast('Sesi Teknisi/Admin berakhir (idle). Kembali ke akun PIC.', 'warning');
    };

    // Layered login button → modal
    document.getElementById('btn-layered-login').onclick = () => {
      this._showLayeredLoginModal();
    };

    this._showLayeredLoginModal = () => {
      app.openModal(`
        <div class="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm" data-modal-backdrop>
          <div class="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-sm mx-4 p-6">
            <div class="flex items-center justify-between mb-4">
              <h3 class="text-base font-bold text-slate-800 dark:text-white"><i class="ph ph-shield-check text-amber-500"></i> Login Teknisi/Admin</h3>
              <button onclick="app.closeModal()" class="w-7 h-7 rounded-full bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 text-slate-500 flex items-center justify-center">&times;</button>
            </div>
            <p class="text-xs text-slate-500 mb-4">Masuk sebagai Teknisi/Admin untuk akses edit. PIC: <b>${(app.config.pic_user?.nama) || (app.config.pic_user?.email) || '-'}</b></p>
            <div class="space-y-3">
              <div>
                <label class="block text-xs font-medium text-slate-600 mb-1">Email</label>
                <input id="layered-email" type="email" class="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg text-sm bg-white dark:bg-slate-700 focus:ring-2 focus:ring-amber-500 outline-none" placeholder="teknisi@perusahaan.com">
              </div>
              <div>
                <label class="block text-xs font-medium text-slate-600 mb-1">Password</label>
                <input id="layered-password" type="password" class="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg text-sm bg-white dark:bg-slate-700 focus:ring-2 focus:ring-amber-500 outline-none">
              </div>
              <div>
                <label class="block text-xs font-medium text-slate-600 mb-1">Idle Timeout (menit) <span class="text-slate-400 font-normal">— default 5</span></label>
                <input id="layered-timeout" type="number" min="1" max="120" value="${app.config.idle_timeout_min || 5}" class="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg text-sm bg-white dark:bg-slate-700 focus:ring-2 focus:ring-amber-500 outline-none">
              </div>
              <button id="btn-layered-submit" onclick="app.views.dashboard._submitLayeredLogin()" class="w-full py-2 bg-amber-500 hover:bg-amber-400 text-white text-sm font-medium rounded-lg transition-colors">Login Teknisi/Admin</button>
            </div>
          </div>
        </div>`);
    };

    this._submitLayeredLogin = async () => {
      const { ipcRenderer } = require('electron');
      console.log('[Layered] _submitLayeredLogin dipanggil');
      const email = document.getElementById('layered-email').value.trim();
      const password = document.getElementById('layered-password').value;
      const timeout = parseInt(document.getElementById('layered-timeout').value) || 5;
      if (!email || !password) { app.toast('Email dan password wajib', 'error'); return; }
      const btn = document.getElementById('btn-layered-submit');
      btn.disabled = true; btn.textContent = 'Memverifikasi...';
      try {
        await ipcRenderer.invoke('layered-login', { email, password });
        if (timeout !== (app.config.idle_timeout_min || 5)) {
          await ipcRenderer.invoke('save-idle-timeout', timeout);
        }
        app.config = await ipcRenderer.invoke('get-config');
        app.closeModal();
        console.log('[Layered] layered_user =', app.config.layered_user);
        this._renderLayeredState();
        app.toast('Login Teknisi/Admin berhasil. Idle logout: ' + (app.config.idle_timeout_min || 5) + ' menit.', 'success');
      } catch (err) {
        app.toast((err.message || 'Login gagal').replace(/^Error invoking remote method '.*?':\s*/, ''), 'error');
      } finally {
        btn.disabled = false; btn.textContent = 'Login Teknisi/Admin';
      }
    };

    // Initial layered state
    this._renderLayeredState();

    // Send Log
    const sendLogBtn = document.getElementById('btn-send-log');
    if (sendLogBtn) {
      sendLogBtn.onclick = async () => {
        // We'll use a simple prompt for now
        const msg = prompt('Masukkan catatan log maintenance:');
        if (msg) {
          try {
            await ipcRenderer.invoke('send-log', { message: msg, level: 'info' });
            app.toast('Catatan berhasil dikirim');
          } catch (e) {
            app.toast('Gagal mengirim catatan', 'error');
          }
        }
      };
    }

    // Force Sync
    document.getElementById('btn-force-sync').onclick = () => {
      ipcRenderer.invoke('force-poll');
    };

    // IPC Listeners for real-time updates
    ipcRenderer.removeAllListeners('poller-status');
    ipcRenderer.removeAllListeners('poller-data-updated');
    
    ipcRenderer.on('poller-status', (e, data) => {
      const el = document.getElementById('poller-status');
      const ind = document.getElementById('poller-indicator');
      const time = document.getElementById('poller-time');
      
      if (data.status === 'syncing') {
        el.childNodes[1].nodeValue = ' Syncing...';
        ind.className = 'w-2.5 h-2.5 rounded-full bg-yellow-400 animate-pulse';
      } else if (data.status === 'success') {
        el.childNodes[1].nodeValue = ' Online & Synced';
        ind.className = 'w-2.5 h-2.5 rounded-full bg-green-500';
        time.textContent = `Last sync: ${data.time}`;
      } else if (data.status === 'offline_queued') {
        el.childNodes[1].nodeValue = ' Offline (Queued)';
        ind.className = 'w-2.5 h-2.5 rounded-full bg-red-500';
        time.textContent = `Queued at: ${data.time}`;
      }
    });

    ipcRenderer.on('poller-data-updated', (e, devices) => {
      app.config.tracked_devices = devices;
      this.renderTable();
      this.updateChart();
      // Update tracked count
      document.getElementById('tracked-count').textContent = (devices || []).length;
      document.getElementById('tracked-count-badge').textContent = (devices || []).length;
    });

    // Realtime force-poll from cloud
    ipcRenderer.on('force-poll', async () => {
      await ipcRenderer.invoke('force-poll');
    });

    // Realtime update-roster from cloud (device deleted via web frontend)
    ipcRenderer.on('update-roster', async () => {
      const cfg = await ipcRenderer.invoke('get-config');
      app.config.tracked_devices = cfg.tracked_devices || [];
      this.renderTable();
      this.updateChart();
    });

    window.untrackDevice = async (ip) => {
      if (!confirm(`Are you sure you want to stop tracking ${ip}?`)) return;
      try {
        await ipcRenderer.invoke('untrack-device', ip);
        app.toast('Device tracking stopped', 'success');
        // Refresh local config & render immediately — don't wait for poll cycle
        const cfg = await ipcRenderer.invoke('get-config');
        app.config.tracked_devices = cfg.tracked_devices || [];
        this.renderTable();
        this.updateChart();
      } catch (err) {
        app.toast('Failed to stop tracking', 'error');
      }
    };

    // Initial render + pinger status
    this._loadPingerStatus();
    this.renderTable();
    this.updateChart();

    // Real-time pinger updates
    ipcRenderer.on('pinger-status', (e, data) => {
      if (data.devices) {
        data.devices.forEach(d => {
          if (this._pingerStatus) this._pingerStatus[d.ip] = d.status;
        });
        this.renderTable();
      }
    });
  },

  _pingerStatus: {},

  async _loadPingerStatus() {
    try {
      const { ipcRenderer } = require('electron');
      this._pingerStatus = await ipcRenderer.invoke('get-pinger-status');
    } catch (e) {}
  },

  renderTable() {
    const devices = app.config.tracked_devices || [];
    document.getElementById('tracked-count').textContent = devices.length;
    document.getElementById('tracked-count-badge').textContent = devices.length;

    const tbody = document.getElementById('tracked-list');
    if (devices.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="px-5 py-8 text-center text-slate-400">No devices tracked. Click "Scan Network" to add.</td></tr>`;
      return;
    }

    tbody.innerHTML = devices.map(d => {
      const data = d.last_data || {};
      const bw = data.bw_counter || 0;
      const col = data.color_counter || 0;
      
      // Data source indicator: web_scraper (realtime) vs snmp
      const dataSource = data.data_source || data._dataSource || 'snmp';
      const isScraper = dataSource === 'web_scraper' || data.scraped_realtime;
      
      // Check if web auth is needed — ALWAYS show login option if not scraper
      const needAuth = data._needWebAuth || !isScraper;
      const authDetail = data._webAuthDetail || '';
      
      const bwDelta = bw - (d.initial_bw || bw);
      const colDelta = col - (d.initial_color || col);
      // Clamp negative deltas (baseline switch artifact)
      const bwDeltaSafe = bwDelta < 0 ? 0 : bwDelta;
      const colDeltaSafe = colDelta < 0 ? 0 : colDelta;

      // Render toner bars — only actual toner/ink (skip drum, waste)
      let tonerHtml = '<span class="text-xs text-slate-400">No data</span>';
      if (data.toner && data.toner.length > 0) {
        const realToners = data.toner.filter(t => {
          const w = t.warna || '';
          const d = (t.description || t.desc || w || '').toLowerCase();
          return !d.includes('drum');
        });
        if (realToners.length > 0) {
          tonerHtml = `<div class="flex items-center gap-1.5">`;
          realToners.forEach(t => {
          const w = t.warna || '';
          let bg = 'bg-slate-800';
          if (w.includes('CYAN')) bg = 'bg-cyan-500';
          else if (w.includes('MAGENTA')) bg = 'bg-pink-500';
          else if (w.includes('YELLOW')) bg = 'bg-yellow-400';
          
          const lv = t.level < 0 ? 0 : t.level;
          const warn = (t.estimated || t.level < 0) ? 'border border-dashed border-yellow-400' : '';
          tonerHtml += `
            <div class="w-2 h-4 bg-slate-100 rounded-sm overflow-hidden flex flex-col justify-end ${warn}" title="${t.warna}: ${t.level < 0 ? '?' : t.level}%${t.estimated ? ' (Estimasi)' : ''}${t.estimated_from ? ' — ' + t.estimated_from : ''}">
              <div class="w-full ${bg}" style="height: ${lv}%"></div>
            </div>
          `;
        });
        tonerHtml += `</div>`;
        }
      }
      // Fallback: synthetic toner for any device with no supply data
      if (!data.toner || data.toner.length === 0) {
        const hasColor = (col || d.initial_color || 0) > 0;
        const synthColors = hasColor ? ['BLACK','CYAN','MAGENTA','YELLOW'] : ['BLACK'];
        tonerHtml = `<div class="flex items-center gap-1.5">`;
        synthColors.forEach(w => {
          let bg = 'bg-slate-800';
          if (w === 'CYAN') bg = 'bg-cyan-500';
          else if (w === 'MAGENTA') bg = 'bg-pink-500';
          else if (w === 'YELLOW') bg = 'bg-yellow-400';
          tonerHtml += `<div class="w-2 h-4 bg-slate-100 rounded-sm overflow-hidden flex flex-col justify-end border border-dashed border-yellow-300" title="${w}: Estimasi"><div class="w-full ${bg}" style="height:2px"></div></div>`;
        });
        tonerHtml += `</div>`;
      }

      return `
        <tr class="hover:bg-indigo-50/30 transition-colors">
          <td class="px-5 py-3 font-mono text-sm text-indigo-600 font-medium">
            <div class="flex items-center gap-2">
              <span class="w-1.5 h-1.5 rounded-full ${this._getDeviceStatus(d)}" title="Pinger: ${this._pingerStatus[d.ip] || '?'}"></span>
              <a href="#" onclick="event.preventDefault();window.openWebUI('${d.ip}')" class="hover:underline hover:text-indigo-800" title="Buka Web UI mesin">${d.ip}</a>
            </div>
          </td>
          <td class="px-5 py-3">
            <div class="font-semibold text-slate-800">${data.merk || d.merk || 'Unknown'} ${data.model || d.model || ''}</div>
            <div class="text-[10px] text-slate-400">${data.pelanggan_nama || data.customer || '-'}</div>
            <div class="text-[10px] text-slate-400 font-mono">ID: ${d.id}</div>
          </td>
          <td class="px-5 py-3">
            <div class="text-xs flex flex-col justify-center">
              <div><span class="text-slate-400">BW:</span> <span class="font-medium text-slate-800">${bwDeltaSafe.toLocaleString()}</span> <span class="text-[10px] text-slate-400 ml-1">(Total: ${bw.toLocaleString()})</span></div>
              <div><span class="text-slate-400">Color:</span> <span class="font-medium text-slate-800">${colDeltaSafe.toLocaleString()}</span> <span class="text-[10px] text-slate-400 ml-1">(Total: ${col.toLocaleString()})</span></div>
            </div>
          </td>
          <td class="px-5 py-3">${tonerHtml}${needAuth ? `<div class="mt-1"><button onclick="window.showCredModal('${d.ip}','${data.merk||d.merk||''}','${data.model||d.model||''}')" class="text-[10px] text-amber-600 hover:text-amber-800 font-medium underline">+ Login Web UI</button></div>` : ''}${isScraper ? `<div class="mt-1"><span class="inline-flex items-center gap-1 px-1.5 py-0.5 bg-emerald-50 text-emerald-700 text-[9px] font-medium rounded-full border border-emerald-200"><span class="w-1 h-1 rounded-full bg-emerald-500 animate-pulse"></span> Web Scraper (realtime)</span></div>` : ''}</td>
          <td class="px-5 py-3 text-right">
            <button onclick="window.showDetail(${d.id})" class="text-xs text-blue-600 hover:text-blue-800 font-medium mr-2">Detail</button>
            ${this.canChangeSettings ? `<button onclick="window.showSnmpConfig('${d.ip}', ${JSON.stringify(d.snmpConfig || null)}, '${d.community || 'public'}')" class="text-xs text-indigo-500 hover:text-indigo-700 font-medium mr-2" title="SNMP Settings"><i class="ph ph-shield-chevron"></i> SNMP</button>` : ''}
            ${this.userRole === 'AGENT' ? '' : `<button onclick="window.untrackDevice('${d.ip}')" class="text-xs text-red-500 hover:text-red-700 font-medium">Stop Tracking</button>`}
          </td>
        </tr>
      `;
    }).join('');

    // Expose showDetail globally — compact 2-col with toner estimation
    window.showDetail = async (id) => {
      app.openModal(`<div class="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm"><div class="bg-white dark:bg-slate-800 rounded-xl shadow-2xl p-8 flex flex-col items-center"><svg class="animate-spin h-8 w-8 text-indigo-500 mb-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg><p class="text-sm text-gray-500">Memuat detail...</p></div></div>`);

      try {
        const { ipcRenderer } = require('electron');
        const res = await ipcRenderer.invoke('get-mesin-detail', id);
        const m = res.mesin;
        const fmt = n => new Intl.NumberFormat('id-ID').format(n || 0);
        const dt = dateStr => dateStr ? new Date(dateStr).toLocaleString('id-ID',{dateStyle:'medium',timeStyle:'short'}) : '-';

        // Merge paper_trays from last_data (real-time) over backend (stale)
        const localDev = (app.config.tracked_devices || []).find(d => Number(d.id) === Number(id));
        const localTrays = (localDev && localDev.last_data && localDev.last_data.paper_trays) || m.paper_trays || [];
        // Merge local realtime data (toner, counters) over backend
        const localData = localDev && localDev.last_data ? localDev.last_data : {};
        if (localData.toner && localData.toner.length > 0) m.toner = localData.toner;
        if (localData.usage_counters) m.usage_counters = localData.usage_counters;
        const isScraper = localData.data_source === 'web_scraper' || localData.scraped_realtime;
        const needAuth = localData._needWebAuth || false;

        // --- Toner Estimator (non-original chip) ---
        const TONER_YIELDS = {
          ricoh:{black:12000,color:6000},'ricoh:im c2010':{black:12000,color:6000},'ricoh:im c3010':{black:15000,color:8000},
          hp:{black:6000,color:4000},'hp:pagewide':{black:10000,color:8000},
          xerox:{black:10000,color:6000},'xerox:apeosport':{black:26000,color:15000},
          'xerox:apeosport-v c3376':{black:26000,color:15000},
          canon:{black:8000,color:5000},'canon:imagerunner':{black:12000,color:7000},
          epson:{black:5000,color:4000},brother:{black:5000,color:3000},
          kyocera:{black:10000,color:6000},konicaminolta:{black:12000,color:7000},
          sharp:{black:10000,color:6000},toshiba:{black:10000,color:6000},
        };
        const findYield = (merk, model) => {
          const mk = (merk||'').toLowerCase(), md = (model||'').toLowerCase();
          for (const [key, val] of Object.entries(TONER_YIELDS)) {
            if (key.startsWith(mk+':') && md.includes(key.split(':')[1])) return val;
          }
          return TONER_YIELDS[mk] || {black:8000,color:5000};
        };
        const yieldProfile = findYield(m.merk, m.model);

        let estTonerHtml = '';
        if (m.toner && m.toner.length > 0) {
          const colorToners = m.toner.filter(t => !['BLACK','K','BK','NEGRO'].includes((t.warna||'').toUpperCase())).length || 1;
          const perColor = m.meter_akhir_color ? Math.round(m.meter_akhir_color / colorToners) : 0;

          estTonerHtml = '<div class="space-y-2.5">';
          m.toner.forEach(t => {
            const w = t.warna||'', wl = w.toLowerCase();
            let bg = 'bg-slate-600', txtClr = 'text-slate-700';
            if (wl.includes('cyan')) { bg = 'bg-cyan-500'; txtClr = 'text-cyan-700'; }
            else if (wl.includes('magenta')) { bg = 'bg-pink-500'; txtClr = 'text-pink-700'; }
            else if (wl.includes('yellow')) { bg = 'bg-yellow-400'; txtClr = 'text-yellow-600'; }
            else if (wl.includes('black')) { bg = 'bg-slate-800'; txtClr = 'text-slate-800'; }

            const rawLv = t.level_sekarang;
            let displayLv = rawLv, isEst = false, estNote = '', isNonOrig = false;
            if (rawLv < 0) {
              isNonOrig = true;
              const isBlack = wl.includes('black')||wl.includes('k')||wl.includes('negro');
              let estPct = null;
              if (isBlack && m.meter_akhir_bw > 0 && yieldProfile.black > 0) {
                estPct = Math.round(Math.max(0, 100 - (m.meter_akhir_bw / yieldProfile.black) * 100));
                estNote = `${fmt(m.meter_akhir_bw)}/${fmt(yieldProfile.black)} hal.`;
              } else if (!isBlack && perColor > 0 && yieldProfile.color > 0) {
                estPct = Math.round(Math.max(0, 100 - (perColor / yieldProfile.color) * 100));
                estNote = `${fmt(perColor)}/${fmt(yieldProfile.color)} hal. x${colorToners}`;
              } else { estPct = 50; estNote = 'Data tdk cukup'; }
              displayLv = estPct; isEst = true;
            }
            estTonerHtml += `
              <div class="flex items-center gap-3 ${isEst?'border border-dashed border-yellow-400':''} rounded-lg p-2.5 ${isEst?'bg-yellow-50/50':'bg-slate-50/50'}">
                <div class="w-4 h-8 rounded ${bg} shrink-0" style="opacity:${Math.max(0.2,displayLv/100)}"></div>
                <div class="flex-1 min-w-0">
                  <div class="flex justify-between text-xs">
                    <span class="font-bold ${txtClr} truncate">${w}</span>
                    <span class="font-mono font-semibold ${displayLv<10?'text-red-500':displayLv<30?'text-orange-500':'text-green-600'}">${displayLv}%</span>
                  </div>
                  <div class="w-full bg-gray-200 rounded-full h-1.5 mt-1 overflow-hidden"><div class="${bg} h-1.5 rounded-full" style="width:${displayLv}%"></div></div>
                  <div class="text-[9px] text-gray-400 mt-0.5 flex justify-between">
                    <span>${dt(t.updated_at)}</span>
                    ${isNonOrig?'<span class="text-amber-500 font-medium">Non-Original</span>':''}
                  </div>
                  ${isEst&&estNote?`<div class="text-[8px] text-yellow-500 italic">Est: ${estNote}</div>`:''}
                </div>
              </div>`;
          });
          estTonerHtml += '</div>';
        }

        const alertData = m.alerts || {critical:0,warnings:0};
        const alertList = alertData.list || [];
        // Inject global showAlertDetails (safe, guarded)
        if (!window._alertHandlersInjected) {
          window._alertHandlersInjected = true;
          window.alertListData = [];
          window.showAlertDetails = function() {
            var list = window.alertListData;
            if (!list || !list.length) return app.toast('Tidak ada detail alert', 'info');
            var modal = document.createElement('div');
            modal.className = 'fixed inset-0 z-[300] flex items-center justify-center bg-slate-900/70 backdrop-blur-sm';
            modal.onclick = function(e) { if (e.target === this) document.body.removeChild(modal); };
            var html = '<div class="bg-white dark:bg-slate-800 rounded-xl shadow-2xl max-w-lg mx-4 max-h-[70vh] overflow-y-auto p-5">' +
              '<div class="flex justify-between items-center mb-3"><h3 class="text-sm font-bold text-slate-800">Alert Details</h3>' +
              '<button onclick="this.parentElement.parentElement.parentElement.remove()" class="w-6 h-6 rounded-full bg-slate-200 hover:bg-slate-300 flex items-center justify-center text-xs">&times;</button></div>' +
              '<div class="space-y-2">' +
              list.map(function(a) {
                var s = a.severity || 0;
                var sc = s >= 10 ? 'bg-red-50 border-red-200 text-red-700' : s >= 8 ? 'bg-orange-50 border-orange-200 text-orange-700' : 'bg-yellow-50 border-yellow-200 text-yellow-700';
                return '<div class="text-xs p-2 rounded-lg border ' + sc + '"><span class="font-mono font-bold">' + s + '</span>: ' + (a.text || '') + '</div>';
              }).join('') +
              '</div></div>';
            modal.innerHTML = html;
            document.body.appendChild(modal);
          };
        }
        window.alertListData = alertList;
        const critCnt = alertList.filter(function(a){ return a.severity >= 8; }).length;
        const sleepCnt = alertList.filter(function(a){ return a.severity >= 4 && a.severity < 8 && ((a.text||'').toLowerCase().includes('sleep') || (a.text||'').toLowerCase().includes('energy')); }).length;
        const warnCnt = alertList.filter(function(a){ return a.severity >= 4 && a.severity < 8 && !((a.text||'').toLowerCase().includes('sleep') || (a.text||'').toLowerCase().includes('energy')); }).length;
        const hasAlerts = critCnt || warnCnt || sleepCnt;
        const alertHtml = hasAlerts
          ? '<div class="flex gap-1">' +
            (critCnt ? '<span class="px-2 py-0.5 rounded-full bg-red-100 text-red-600 font-medium cursor-pointer hover:bg-red-200 text-[10px]" onclick="window.showAlertDetails()">' + critCnt + ' Critical</span>' : '') +
            (warnCnt ? '<span class="px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-600 font-medium cursor-pointer hover:bg-yellow-200 text-[10px]" onclick="window.showAlertDetails()">' + warnCnt + ' Warning</span>' : '') +
            (sleepCnt ? '<span class="px-2 py-0.5 rounded-full bg-slate-200 text-slate-500 font-medium cursor-pointer hover:bg-slate-300 text-[10px]" onclick="window.showAlertDetails()">zZzZ</span>' : '') +
            '</div>'
          : '<span class="text-[10px] text-green-500">All OK</span>';

        app.openModal(`
          <div class="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm" data-modal-backdrop>
            <div class="bg-white dark:bg-slate-900 rounded-xl shadow-2xl w-full max-w-3xl mx-4 max-h-[90vh] flex flex-col overflow-hidden">
              <div class="flex items-center justify-between px-5 py-3 border-b border-gray-100 bg-slate-50/80 dark:bg-slate-800/50">
                <div class="flex items-center gap-3 min-w-0">
                  <div class="w-9 h-9 rounded-lg bg-indigo-100 flex items-center justify-center shrink-0"><i class="ph ph-printer text-indigo-600 text-lg"></i></div>
                  <div class="min-w-0"><h3 class="text-base font-bold text-gray-800 dark:text-white truncate">${m.merk||'Unknown'} ${m.model||''}</h3><p class="text-[10px] text-gray-500 font-mono truncate">SN: ${m.serial_number||'-'}</p></div>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                  ${isScraper ? `<span class="px-2 py-0.5 rounded-full text-[9px] font-bold bg-emerald-100 text-emerald-700 border border-emerald-200 flex items-center gap-1"><span class="w-1 h-1 rounded-full bg-emerald-500 animate-pulse"></span>SCRAPER</span>` : `<span class="px-2 py-0.5 rounded-full text-[9px] font-bold bg-slate-100 text-slate-500 border border-slate-200">SNMP</span>`}
                  <button onclick="window.showCredModal('${(localDev&&localDev.ip)||m.ip_address}','${m.merk||''}','${m.model||''}')" class="px-2 py-0.5 rounded-full text-[9px] font-bold ${isScraper ? 'bg-slate-100 text-slate-600 border border-slate-200 hover:bg-slate-200' : 'bg-amber-100 text-amber-700 border border-amber-200 hover:bg-amber-200'}">${isScraper ? 'Relogin' : '+ Login Web'}</button>
                  ${alertHtml}<button onclick="app.closeModal()" class="w-7 h-7 rounded-full bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 text-slate-500 flex items-center justify-center transition-colors">&times;</button>
                </div>
              </div>
              <div class="flex-1 overflow-y-auto p-4 bg-white dark:bg-slate-900">
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div class="space-y-3">
                    <div class="flex flex-wrap gap-1.5">
                      <span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${m.status==='ONLINE'||m.status==='AKTIF'?'bg-green-100 text-green-700':'bg-red-100 text-red-700'}">${m.status}</span>
                      <span class="px-2 py-0.5 rounded-full text-[10px] bg-indigo-100 text-indigo-600">${m.agent_name||'No Agent'}</span>
                      <span class="px-2 py-0.5 rounded-full text-[10px] bg-slate-100 text-slate-500">${m.lokasi||'-'}</span>
                    </div>
                    <div class="grid grid-cols-3 gap-2">
                      <div class="bg-slate-50 dark:bg-slate-800/50 rounded-lg p-3 text-center border border-slate-100"><div class="text-[9px] text-gray-500 uppercase font-semibold">Total</div><div class="text-lg font-bold text-gray-800 dark:text-white">${fmt((localData.bw_counter||m.meter_akhir_bw||0)+(localData.color_counter||m.meter_akhir_color||0))}</div></div>
                      <div class="bg-slate-50 dark:bg-slate-800/50 rounded-lg p-3 text-center border border-slate-100"><div class="text-[9px] text-gray-500 uppercase font-semibold">BW</div><div class="text-lg font-bold text-gray-800 dark:text-white">${fmt(localData.bw_counter||m.meter_akhir_bw)}</div><div class="text-[9px] text-green-600 font-medium">+${fmt(Math.max(0,(localData.bw_counter||m.meter_akhir_bw||0)-((localDev&&localDev.initial_bw)||m.meter_awal_bw||0)))}</div></div>
                      <div class="bg-slate-50 dark:bg-slate-800/50 rounded-lg p-3 text-center border border-slate-100"><div class="text-[9px] text-gray-500 uppercase font-semibold">Color</div><div class="text-lg font-bold text-gray-800 dark:text-white">${fmt(localData.color_counter||m.meter_akhir_color)}</div><div class="text-[9px] text-green-600 font-medium">+${fmt(Math.max(0,(localData.color_counter||m.meter_akhir_color||0)-((localDev&&localDev.initial_color)||m.meter_awal_color||0)))}</div></div>
                    </div>
                    ${(() => {
                      const ud = m.usage_detail;
                      const um = m.usage_monthly;
                      let html = '';
                      // Usage Breakdown (print/copy/fax/scan) from web scraper
                      if (ud && ud.source) {
                        const rows = [
                          { key: 'print', label: 'Print' },
                          { key: 'copy', label: 'Copy' },
                          { key: 'fax', label: 'Fax' },
                        ];
                        const cell = (fn) => {
                          const v = ud[fn] || {};
                          const bw = v.bw || 0, col = v.color || 0;
                          return '<div class="flex items-center justify-between py-1 text-[10px]">' +
                            '<span class="font-medium text-gray-600 dark:text-gray-300 capitalize">' + fn + '</span>' +
                            '<span class="font-mono text-gray-500">' + fmt(bw) + ' <span class="text-gray-400">BW</span> / ' + fmt(col) + ' <span class="text-indigo-500">C</span></span></div>';
                        };
                        const scanHtml = ud.scan ? '<div class="flex items-center justify-between py-1 text-[10px] border-t border-slate-100 dark:border-slate-700">' +
                          '<span class="font-medium text-gray-600 dark:text-gray-300">Scan</span>' +
                          '<span class="font-mono text-gray-500">' + fmt(ud.scan.count||0) + ' <span class="text-gray-400">(info)</span></span></div>' : '';
                        html += '<div class="bg-slate-50 dark:bg-slate-800/50 rounded-lg p-3 border border-slate-100">' +
                          '<div class="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1"><i class="ph ph-chart-bar"></i> Usage Breakdown</div>' +
                          '<div class="text-[8px] text-gray-400 mb-1">' + (ud.source === 'ricoh_wim' ? 'Ricoh WIM' : ud.source === 'hp_usagepage' ? 'HP EWS' : ud.source) + '</div>' +
                          rows.map(r => cell(r.key)).join('') + scanHtml + '</div>';
                      }
                      // Monthly delta: this month vs last month
                      if (um && (um.this_month || um.prev_month)) {
                        const fmtD = (v) => { const n = v || 0; return (n > 0 ? '+' : '') + fmt(n); };
                        const rowDelta = (label, t, p) => {
                          const tb = (t && t.bw) || 0, tc = (t && t.color) || 0;
                          const pb = (p && p.bw) || 0, pc = (p && p.color) || 0;
                          const tTotal = tb + tc, pTotal = pb + pc;
                          const d = tTotal - pTotal;
                          const dCls = d > 0 ? 'text-red-500' : d < 0 ? 'text-green-600' : 'text-gray-400';
                          return '<div class="flex items-center justify-between py-1 text-[10px]">' +
                            '<span class="font-medium text-gray-600 dark:text-gray-300">' + label + '</span>' +
                            '<span class="flex items-center gap-2"><span class="font-mono text-gray-500">' + fmt(tTotal) + '</span>' +
                            '<span class="font-mono font-semibold ' + dCls + ' w-14 text-right">' + fmtD(d) + '</span></span></div>';
                        };
                        const scanD = (um.delta && um.delta.scan) ? um.delta.scan.count : 0;
                        const scanCls = scanD > 0 ? 'text-red-500' : scanD < 0 ? 'text-green-600' : 'text-gray-400';
                        html += '<div class="bg-slate-50 dark:bg-slate-800/50 rounded-lg p-3 border border-slate-100">' +
                          '<div class="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1 flex items-center justify-between">' +
                          '<span><i class="ph ph-calendar"></i> Pemakaian Bulanan</span>' +
                          '<span class="text-[8px] font-normal text-gray-400">' + (um.bulan || '') + ' vs bulan lalu</span></div>' +
                          rowDelta('Print', um.this_month.print, um.prev_month.print) +
                          rowDelta('Copy', um.this_month.copy, um.prev_month.copy) +
                          rowDelta('Fax', um.this_month.fax, um.prev_month.fax) +
                          '<div class="flex items-center justify-between py-1 text-[10px] border-t border-slate-100 dark:border-slate-700">' +
                          '<span class="font-medium text-gray-600 dark:text-gray-300">Scan</span>' +
                          '<span class="flex items-center gap-2"><span class="font-mono text-gray-500">' + fmt((um.this_month.scan&&um.this_month.scan.count)||0) + '</span>' +
                          '<span class="font-mono font-semibold ' + scanCls + ' w-14 text-right">' + fmtD(scanD) + '</span></span></div>' +
                          '</div>';
                      }
                      // Activity history button
                      html += '<button onclick="window.showActivityModal(' + id + ')" class="w-full flex items-center justify-between bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-lg px-3 py-2.5 border border-indigo-100 transition-colors">' +
                        '<span class="text-xs font-medium"><i class="ph ph-clock-counter-clockwise"></i> Riwayat Aktifitas Mesin</span>' +
                        '<i class="ph ph-caret-right"></i></button>';
                      return html;
                    })()}
                    <div class="flex items-center gap-2 text-xs text-gray-600 bg-indigo-50/50 rounded-lg px-3 py-2 border border-indigo-100"><i class="ph ph-user text-indigo-500"></i><span class="font-medium text-indigo-700">${m.kontrak?.pelanggan_nama||m.pelanggan_nama||'-'}</span></div>
                    <div class="bg-slate-50 dark:bg-slate-800/50 rounded-lg p-3 border border-slate-100">
                      <div class="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center justify-between">
                        <span><i class="ph ph-tray"></i> Paper Trays</span>
                        <span class="text-[8px] font-normal text-gray-400">${localTrays.length} trays</span>
                      </div>
                      ${localTrays.length ? localTrays.map(t => {
                        const sh = parseInt(t.sheets);
                        const idx = t.idx || t.index || '';
                        const name = t.name || t.media_name || (idx ? 'Tray '+idx : '');
                        const size = (t.size && t.size !== 'Unknown') ? t.size : '';
                        const dims = (t.dims && parseInt(t.dims.split('x')[0]) > 0) ? t.dims : '';
                        const pct = (t.max_capacity && sh >= 0) ? Math.round(sh / t.max_capacity * 100) : null;
                        return '<div class="flex justify-between items-center text-[10px] py-1 border-b border-slate-100 dark:border-slate-700 last:border-0 '+(sh<0?'opacity-50':'')+'">'
                          +'<div class="flex flex-col min-w-0">'
                          +'<span class="font-medium text-gray-700 dark:text-gray-300 truncate">'+name+'</span>'
                          +((size||t.media_name)?'<span class="text-[8px] text-gray-400">'+(size||t.media_name||'')+(dims?' &middot; '+dims:'')+'</span>':'')+'</div>'
                          +(pct!==null?'<div class="w-10 h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden ml-2"><div class="h-full rounded-full '+(pct<10?'bg-red-400':pct<30?'bg-orange-400':'bg-green-400')+'" style="width:'+pct+'%"></div></div>':'')
                          +'<span class="font-mono font-semibold ml-2 '+(sh<0?'text-red-400':sh<50?'text-orange-500':'text-green-600')+'">'+(sh<0?'Empty':fmt(sh))+'</span>'
                          +'</div>';
                      }).join('') : '<div class="text-[10px] text-gray-400 italic">Data tray tidak tersedia</div>'}
                    </div>
                    ${m.last_scan_at?`<div class="text-[10px] text-gray-400">Scan: ${dt(m.last_scan_at)}</div>`:''}
                    ${m.last_uptime?`<div class="text-[10px] text-gray-400">Uptime: ${m.last_uptime}</div>`:''}
                  </div>
                  <div class="space-y-3">
                    <div class="bg-slate-50 dark:bg-slate-800/50 rounded-lg p-3 border border-slate-100">
                      <div class="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center justify-between">
                        <span><i class="ph ph-drop"></i> Toner</span>
                        <span class="text-[8px] font-normal text-yellow-500">${m.toner?.some(t=>(t.level_sekarang||0)<0)?'Non-original chip detected':'OEM'}</span>
                      </div>
                      ${m.toner&&m.toner.length?estTonerHtml:'<div class="text-[10px] text-gray-400 italic">No data</div>'}
                      <div class="mt-2 pt-2 border-t border-slate-200 text-[9px] text-gray-400">Yield: ${yieldProfile.black?fmt(yieldProfile.black)+' BW / '+fmt(yieldProfile.color)+' Color':'Generic'}</div>
                    </div>
                    ${(() => {
                      const jobs = m.jobs || [];
                      const jobCount = jobs.length;
                      let html = '<div class="bg-slate-50 dark:bg-slate-800/50 rounded-lg p-3 border border-slate-100">' +
                        '<div class="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center justify-between">' +
                        '<span><i class="ph ph-notepad"></i> Job Log</span>' +
                        '<span class="text-[8px] font-normal text-gray-400">' + (jobCount ? jobCount + ' jobs' : '') + '</span></div>';
                      if (jobCount) {
                        html += '<div class="max-h-32 overflow-y-auto space-y-1">' +
                        jobs.map(j => {
                          const jn = j.name || '(untitled)';
                          const jp = j.pages !== undefined ? j.pages : '?';
                          const ju = j.user || '';
                          return '<div class="flex justify-between items-center text-[10px] py-1 border-b border-slate-100 dark:border-slate-700 last:border-0">' +
                            '<div class="flex flex-col min-w-0 truncate">' +
                            '<span class="font-medium text-gray-700 dark:text-gray-300 truncate" title="' + String(jn).replace(/"/g,'&quot;') + '">' + jn + '</span>' +
                            (ju ? '<span class="text-[8px] text-gray-400">' + ju + '</span>' : '') +
                            '</div>' +
                            '<span class="font-mono font-semibold text-indigo-600 shrink-0 ml-2">' + jp + 'p</span></div>';
                        }).join('') +
                        '</div>';
                      } else {
                        html += '<div class="text-[10px] text-gray-400 italic">No active jobs</div>';
                      }
                      html += '</div>';
                      return html;
                    })()}
                    ${(() => {
                      const waste = m.waste_toner || (res.mesin && res.mesin.waste_toner) || [];
                      if (!waste.length) return '';
                      var isEstWaste = waste.some(function(ww){ return ww.source === 'synthetic'; });
                      return '<div class="bg-slate-50 dark:bg-slate-800/50 rounded-lg p-3 border border-slate-100 ' + (isEstWaste ? 'border-dashed border-yellow-400' : '') + '">' +
                        '<div class="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center justify-between">' +
                        '<span><i class="ph ph-trash"></i> Waste Toner</span>' +
                        (isEstWaste ? '<span class="text-[8px] text-amber-500 font-medium"><i class="ph ph-warning-circle"></i> Estimasi</span>' : '') +
                        '</div>' +
                        '<div class="space-y-1.5">' +
                        waste.map(function(w) {
                          var pct = w.percentage;
                          var pctD = (pct !== null && pct !== undefined) ? pct : 0;
                          var isFull = pct !== null && pct > 85;
                          var isEst = w.source === 'synthetic';
                          return '<div class="flex items-center gap-2">' +
                            '<div class="flex-1">' +
                            '<div class="flex justify-between text-[10px]"><span class="text-gray-600">' + (w.description || 'Waste') + '</span>' +
                            '<span class="font-mono font-semibold ' + (isFull ? 'text-red-500' : 'text-green-600') + '">' + (pct !== null ? pct + '%' : 'N/A') + '</span></div>' +
                            '<div class="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5 mt-0.5 overflow-hidden">' +
                            '<div class="h-full rounded-full ' + (isFull ? 'bg-red-500' : (isEst ? 'bg-yellow-400' : 'bg-amber-500')) + '" style="width:' + pctD + '%"></div></div></div></div>';
                        }).join('') +
                        '</div></div>';
                    })()}
                  </div>
                </div>
              </div>
            </div>
          </div>`);
      } catch (err) {
        console.error('[showDetail] ERROR:', err);
        app.toast('Gagal memuat detail mesin: ' + (err && err.message ? err.message : err), 'error');
        app.closeModal();
      }
    };

    // SNMP config modal for tracked devices
    window.showSnmpConfig = function(ip, currentConfig, currentCommunity) {
      if (!window.agentCanChangeSettings) {
        return app.toast('Anda tidak memiliki izin untuk melihat atau mengubah pengaturan SNMP.', 'error');
      }
      var hasV3 = currentConfig && currentConfig.version === 3;
      app.openModal('<div class="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm" data-modal-backdrop>' +
        '<div class="bg-white dark:bg-slate-800 rounded-xl shadow-xl w-full max-w-md mx-4">' +
        '<div class="flex justify-between items-center p-4 border-b border-slate-200 dark:border-slate-700">' +
        '<h3 class="text-base font-bold text-slate-800 dark:text-white">SNMP &mdash; ' + ip + '</h3>' +
        '<button onclick="app.closeModal()" class="w-7 h-7 rounded-full bg-slate-200 hover:bg-slate-300 text-slate-500 flex items-center justify-center">&times;</button></div>' +
        '<div class="p-4 space-y-3">' +
        '<div class="flex gap-2 mb-2">' +
        '<button id="snmp-v2c-btn" class="px-3 py-1 ' + (hasV3?'bg-slate-200 text-slate-600':'bg-indigo-600 text-white') + ' rounded text-xs font-medium">SNMP v2c</button>' +
        '<button id="snmp-v3-btn" class="px-3 py-1 ' + (hasV3?'bg-indigo-600 text-white':'bg-slate-200 text-slate-600') + ' rounded text-xs font-medium">SNMP v3</button></div>' +
        '<div id="snmp-v2c-fields"><label class="text-xs text-slate-500 block mb-1">Community</label>' +
        '<input id="snmp-community" type="text" value="' + (currentCommunity||'public') + '" class="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400"></div>' +
        '<div id="snmp-v3-fields" class="' + (hasV3?'':'hidden') + ' space-y-2">' +
        '<label class="text-xs text-slate-500 block mb-1">Username</label>' +
        '<input id="snmp-v3-user" type="text" value="' + ((currentConfig&&currentConfig.username)||'') + '" placeholder="Username" class="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400">' +
        '<label class="text-xs text-slate-500 block mb-1">Auth Password (SHA)</label>' +
        '<input id="snmp-v3-auth" type="password" value="' + ((currentConfig&&currentConfig.authPassword)||'') + '" placeholder="Auth Password" class="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400">' +
        '<label class="text-xs text-slate-500 block mb-1">Priv Password (AES)</label>' +
        '<input id="snmp-v3-priv" type="password" value="' + ((currentConfig&&currentConfig.privPassword)||'') + '" placeholder="Priv Password" class="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400"></div></div>' +
        '<div class="flex justify-end gap-2 p-4 border-t border-slate-200 dark:border-slate-700">' +
        '<button onclick="app.closeModal()" class="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg">Cancel</button>' +
        '<button id="btn-save-snmp" class="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg shadow-sm transition-colors">Save</button></div></div></div>');

      document.getElementById('snmp-v2c-btn').onclick = function() {
        document.getElementById('snmp-v3-fields').classList.add('hidden');
        document.getElementById('snmp-v2c-btn').className = 'px-3 py-1 bg-indigo-600 text-white rounded text-xs font-medium';
        document.getElementById('snmp-v3-btn').className = 'px-3 py-1 bg-slate-200 text-slate-600 rounded text-xs font-medium';
      };
      document.getElementById('snmp-v3-btn').onclick = function() {
        document.getElementById('snmp-v3-fields').classList.remove('hidden');
        document.getElementById('snmp-v3-btn').className = 'px-3 py-1 bg-indigo-600 text-white rounded text-xs font-medium';
        document.getElementById('snmp-v2c-btn').className = 'px-3 py-1 bg-slate-200 text-slate-600 rounded text-xs font-medium';
      };
      document.getElementById('btn-save-snmp').onclick = async function() {
        var isV3 = !document.getElementById('snmp-v3-fields').classList.contains('hidden');
        var btn = document.getElementById('btn-save-snmp');
        btn.disabled = true; btn.innerHTML = '<svg class="animate-spin w-4 h-4 inline mr-1" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> Saving...';
        try {
          var ipcRenderer = require('electron').ipcRenderer;
          await ipcRenderer.invoke('set-snmp-config', {
            ip: ip,
            community: document.getElementById('snmp-community').value,
            version: isV3 ? 3 : 2,
            username: document.getElementById('snmp-v3-user').value,
            authPassword: document.getElementById('snmp-v3-auth').value,
            privPassword: document.getElementById('snmp-v3-priv').value,
          });
          app.toast('SNMP config saved', 'success');
          app.closeModal();
        } catch (err) {
          app.toast('Failed: ' + (err.message || 'Error'), 'error');
        } finally { btn.disabled = false; btn.textContent = 'Save'; }
      };
    };
  },

  _getDeviceStatus(dev) {
    const pingStatus = this._pingerStatus && this._pingerStatus[dev.ip];
    if (pingStatus === 'ONLINE') return 'bg-green-500';
    if (pingStatus === 'OFFLINE') {
      // If poller still shows ONLINE but pinger says OFFLINE, show yellow
      if (dev.status === 'ONLINE') return 'bg-yellow-500';
      return 'bg-red-500';
    }
    // Fallback to poller status
    return dev.status === 'ONLINE' ? 'bg-green-500' : (dev.status === 'OFFLINE' ? 'bg-red-500' : 'bg-slate-300');
  },

  updateChart() {
    const devices = app.config.tracked_devices || [];
    const labels = [];
    const bwData = [];
    const colorData = [];

    devices.forEach(d => {
      const data = d.last_data || {};
      const model = data.model || d.model || '';
      const bw = data.bw_counter || 0;
      const col = data.color_counter || 0;
      // Multi-line label: IP \n Model
      labels.push(d.ip + '\n' + model);
      bwData.push(bw - (d.initial_bw || bw));
      colorData.push(col - (d.initial_color || col));
    });

    this.chart.data.labels = labels;
    this.chart.data.datasets[0].data = bwData;
    this.chart.data.datasets[1].data = colorData;
    // Multi-line x-axis labels
    this.chart.options.scales.x.ticks.callback = function(val, idx) {
      var lbl = this.getLabelForValue(val);
      if (typeof lbl === 'string' && lbl.indexOf('\n') > -1) return lbl.split('\n');
      return lbl;
    };
    this.chart.update();
  },

  // ── Credential Modal for web UI scraping ──
  showCredModal(ip, merk, model) {
    const modal = document.getElementById('cred-modal');
    if (!modal) return;
    document.getElementById('cred-ip').textContent = ip;
    document.getElementById('cred-merk').textContent = (merk || 'Printer') + ' ' + (model || '');
    document.getElementById('cred-username').value = '';
    document.getElementById('cred-password').value = '';
    document.getElementById('cred-error').classList.add('hidden');
    modal.classList.remove('hidden');
    modal.dataset.ip = ip;
    modal.dataset.mode = 'verify';
  }
});

// Global handler for dashboard
window.showCredModal = (ip, merk, model) => {
  app.views.dashboard.showCredModal(ip, merk, model);
};

// Open printer web UI in a dedicated Electron window (bypasses cert warning)
window.openWebUI = (ip) => {
  const { ipcRenderer } = require('electron');
  ipcRenderer.invoke('open-web-ui', ip).catch(e => {
    if (app && app.toast) app.toast('Gagal buka Web UI: ' + (e.message || e), 'error');
  });
};

// ── Riwayat Aktifitas Mesin modal (agent) ──
window.showActivityModal = async (mesinId) => {
  const { ipcRenderer } = require('electron');
  const dev = (app.config.tracked_devices || []).find(d => Number(d.id) === Number(mesinId));
  const canEdit = !!window.agentCanChangeSettings;
  const formHtml = canEdit ? `
    <div class="p-4 border-b border-slate-100 dark:border-slate-700 space-y-2 bg-white dark:bg-slate-800">
      <div class="grid grid-cols-2 gap-2">
        <div><label class="text-[10px] font-medium text-slate-500">Jenis Aktifitas</label>
          <select id="act-type" class="w-full mt-0.5 px-2 py-1.5 border border-slate-200 dark:border-slate-600 rounded-lg text-xs bg-white dark:bg-slate-700 focus:ring-2 focus:ring-indigo-500 outline-none">
            <option value="SERVICE">Service</option><option value="PERBAIKAN">Perbaikan</option>
            <option value="PARTS">Ganti Parts</option><option value="MONITORING">Monitoring</option>
            <option value="LAINNYA">Lainnya</option>
          </select></div>
        <div><label class="text-[10px] font-medium text-slate-500">Status</label>
          <select id="act-status" class="w-full mt-0.5 px-2 py-1.5 border border-slate-200 dark:border-slate-600 rounded-lg text-xs bg-white dark:bg-slate-700 focus:ring-2 focus:ring-indigo-500 outline-none">
            <option value="PROSES">Proses</option><option value="SELESAI" selected>Selesai</option>
            <option value="TERJADWAL">Terjadwal</option>
          </select></div>
      </div>
      <div><label class="text-[10px] font-medium text-slate-500">Deskripsi <span class="text-red-500">*</span></label>
        <textarea id="act-desc" rows="2" placeholder="Contoh: Ganti drum & blade, bersihkan unit fusing..." class="w-full mt-0.5 px-2 py-1.5 border border-slate-200 dark:border-slate-600 rounded-lg text-xs bg-white dark:bg-slate-700 focus:ring-2 focus:ring-indigo-500 outline-none"></textarea></div>
      <div class="flex gap-2">
        <div class="flex-1"><label class="text-[10px] font-medium text-slate-500">Teknisi</label>
          <input id="act-teknisi" type="text" placeholder="Nama teknisi" class="w-full mt-0.5 px-2 py-1.5 border border-slate-200 dark:border-slate-600 rounded-lg text-xs bg-white dark:bg-slate-700 focus:ring-2 focus:ring-indigo-500 outline-none"></div>
        <div><label class="text-[10px] font-medium text-slate-500">Tanggal</label>
          <input id="act-tgl" type="date" value="${new Date().toISOString().slice(0,10)}" class="w-full mt-0.5 px-2 py-1.5 border border-slate-200 dark:border-slate-600 rounded-lg text-xs bg-white dark:bg-slate-700 focus:ring-2 focus:ring-indigo-500 outline-none"></div>
      </div>
      <button id="act-save" onclick="window.saveActivity(${mesinId})" class="w-full py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-medium rounded-lg transition-colors">Tambah Aktifitas</button>
    </div>` : `
    <div class="px-4 py-2.5 border-b border-slate-100 dark:border-slate-700 bg-amber-50/50 dark:bg-amber-900/10 text-[11px] text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
      <i class="ph ph-info"></i> Akun PIC hanya bisa melihat. Login Teknisi/Admin untuk menambah atau mengedit aktifitas.
    </div>`;

  app.openModal(`<div class="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm"><div class="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-lg mx-4 max-h-[85vh] flex flex-col overflow-hidden">
    <div class="flex items-center justify-between px-5 py-3 border-b border-slate-100 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-800/50">
      <div class="flex items-center gap-2"><i class="ph ph-clock-counter-clockwise text-indigo-600 text-lg"></i><h3 class="text-sm font-bold text-slate-800 dark:text-white">Riwayat Aktifitas Mesin</h3></div>
      <button onclick="app.closeModal()" class="w-7 h-7 rounded-full bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 text-slate-500 flex items-center justify-center transition-colors">&times;</button>
    </div>
    ${formHtml}
    <div id="act-list" class="flex-1 overflow-y-auto p-3 space-y-2 bg-slate-50 dark:bg-slate-900">
      <div class="text-center text-xs text-slate-400 py-6"><i class="ph ph-spinner animate-spin"></i> Memuat...</div>
    </div>
  </div></div>`);

  await window.refreshActivityList(mesinId);
};

window.refreshActivityList = async (mesinId) => {
  const { ipcRenderer } = require('electron');
  const listEl = document.getElementById('act-list');
  if (!listEl) return;
  try {
    const res = await ipcRenderer.invoke('get-mesin-activity', mesinId, 50);
    const items = (res && res.activity) || [];
    if (!items.length) {
      listEl.innerHTML = '<div class="text-center text-xs text-slate-400 py-8"><i class="ph ph-clock-counter-clockwise"></i> Belum ada riwayat aktifitas</div>';
      return;
    }
    const typeBadge = (t) => {
      const map = { SERVICE: 'bg-blue-100 text-blue-700', PERBAIKAN: 'bg-red-100 text-red-700', PARTS: 'bg-amber-100 text-amber-700', MONITORING: 'bg-emerald-100 text-emerald-700', LAINNYA: 'bg-slate-100 text-slate-600' };
      return map[t] || map.LAINNYA;
    };
    const statusBadge = (s) => {
      const map = { PROSES: 'bg-yellow-100 text-yellow-700', SELESAI: 'bg-green-100 text-green-700', TERJADWAL: 'bg-slate-200 text-slate-600' };
      return map[s] || map.SELESAI;
    };
    listEl.innerHTML = items.map(a => {
      const dt = a.tgl_aktivitas ? new Date(a.tgl_aktivitas).toLocaleString('id-ID',{dateStyle:'medium',timeStyle:'short'}) : '';
      return '<div class="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-3">' +
        '<div class="flex items-center gap-1.5 mb-1">' +
        '<span class="px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wide ' + typeBadge(a.activity_type) + '">' + (a.activity_type||'LAINNYA') + '</span>' +
        '<span class="px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wide ' + statusBadge(a.status) + '">' + (a.status||'SELESAI') + '</span>' +
        '<span class="ml-auto text-[9px] text-slate-400">' + dt + '</span>' +
        (window.agentCanChangeSettings ? '<button onclick="window.deleteActivity(' + mesinId + ',' + a.id + ')" class="text-red-400 hover:text-red-600 ml-1" title="Hapus">&times;</button>' : '') +
        '</div>' +
        '<div class="text-xs text-slate-700 dark:text-slate-300">' + (a.deskripsi||'') + '</div>' +
        (a.teknisi ? '<div class="text-[10px] text-slate-400 mt-1"><i class="ph ph-user"></i> ' + a.teknisi + (a.created_by ? ' &middot; ' + a.created_by : '') + '</div>' : '') +
        '</div>';
    }).join('');
  } catch (err) {
    listEl.innerHTML = '<div class="text-center text-xs text-red-500 py-6">Gagal memuat: ' + (err.message || err) + '</div>';
  }
};

window.saveActivity = async (mesinId) => {
  const { ipcRenderer } = require('electron');
  const desc = document.getElementById('act-desc').value.trim();
  if (!desc) { app.toast('Deskripsi wajib diisi', 'error'); return; }
  const payload = {
    activity_type: document.getElementById('act-type').value,
    status: document.getElementById('act-status').value,
    deskripsi: desc,
    teknisi: document.getElementById('act-teknisi').value.trim() || null,
    tgl_aktivitas: document.getElementById('act-tgl').value ? new Date(document.getElementById('act-tgl').value + 'T' + new Date().toTimeString().slice(0,8)).toISOString() : new Date().toISOString(),
  };
  const btn = document.getElementById('act-save');
  btn.disabled = true; btn.textContent = 'Menyimpan...';
  try {
    await ipcRenderer.invoke('create-mesin-activity', mesinId, payload);
    document.getElementById('act-desc').value = '';
    document.getElementById('act-teknisi').value = '';
    app.toast('Aktifitas tercatat', 'success');
    await window.refreshActivityList(mesinId);
  } catch (err) {
    app.toast('Gagal: ' + (err.message || err.error || err), 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Tambah Aktifitas';
  }
};

window.deleteActivity = async (mesinId, activityId) => {
  if (!confirm('Hapus riwayat aktifitas ini?')) return;
  const { ipcRenderer } = require('electron');
  try {
    await ipcRenderer.invoke('delete-mesin-activity', mesinId, activityId);
    app.toast('Aktifitas dihapus', 'success');
    await window.refreshActivityList(mesinId);
  } catch (err) {
    app.toast('Gagal: ' + (err.message || err), 'error');
  }
};
