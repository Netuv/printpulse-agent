const { ipcMain } = require('electron');
const config = require('../config');
const api = require('../api');
const Scanner = require('../scanner');
const realtime = require('../realtime');

class IpcController {
  constructor() {
    this.mainWindow = null;
  }

  setWindow(win) {
    this.mainWindow = win;
  }

  register(poller) {
    ipcMain.handle('get-config', () => config.data);
    
    ipcMain.handle('login', async (e, { email, password, agent_label }) => {
      try {
        // PIC base login (or layered when pic_agent_id linked — handled via layered-login)
        // Agent name = PIC name (UUID) — auto-set from user.nama, not company
        const res = await api.login(email, password, agent_label);
        realtime.connect();

        if (res.is_layered && res.pic_user) {
          // Shouldn't normally happen via this path, but keep safe
          config.setLayeredUser({
            id: res.user.id, email: res.user.email, nama: res.user.nama,
            role: res.user.role, tenant_id: res.user.tenant_id,
          });
          if (res.idle_timeout_min) config.setIdleTimeout(res.idle_timeout_min);
        } else {
          // PIC base login — agent name = PIC name (UUID)
          const picName = (res.user && (res.user.nama || res.user.email)) || agent_label;
          config.set('agent_label', picName);
          config.setPicSession(res.user, res.agent_id);
          if (res.user && res.user.idle_timeout_min) config.setIdleTimeout(res.user.idle_timeout_min);
          config.clearLayeredUser();
        }
        return res;
      } catch (err) {
        throw new Error(err.error || err.message || 'Unknown error');
      }
    });

    // Layered: admin/tech login above PIC (validates, returns info, keeps PIC token)
    ipcMain.handle('layered-login', async (e, { email, password }) => {
      try {
        // Fallback: if pic_agent_id not set (pre-update PIC login), use agent_id
        const picAgentId = config.get('pic_agent_id') || config.get('agent_id');
        console.log('[Layered] pic_agent_id =', picAgentId);
        const res = await api.layeredLogin(email, password, picAgentId);
        console.log('[Layered] login res is_layered =', res.is_layered, 'pic_user =', res.pic_user ? res.pic_user.nama : null);
        if (res.is_layered && res.pic_user) {
          config.setLayeredUser({
            id: res.user.id,
            email: res.user.email,
            nama: res.user.nama,
            role: res.user.role,
            tenant_id: res.user.tenant_id,
          });
          if (res.idle_timeout_min) config.setIdleTimeout(res.idle_timeout_min);
        } else {
          // Not layered — likely pic_agent_id mismatch. Surface clear error.
          throw new Error('Login Teknisi/Admin gagal: akun PIC tidak terhubung. Silakan logout lalu login ulang dengan akun PIC terlebih dahulu.');
        }
        return res;
      } catch (err) {
        throw new Error(err.error || err.message || 'Unknown error');
      }
    });

    // Logout layered (back to PIC) — no re-input of PIC credentials
    ipcMain.handle('logout-layered', () => {
      config.clearLayeredUser();
      return { pic_user: config.get('pic_user') };
    });

    ipcMain.handle('logout', () => {
      config.set('token', null);
      config.set('tenant_id', null);
      config.clearLayeredUser();
      realtime.disconnect();
      return true;
    });

    ipcMain.handle('save-idle-timeout', async (e, minutes) => {
      try {
        const res = await api.saveIdleTimeout(minutes);
        if (res && res.idle_timeout_min) config.setIdleTimeout(res.idle_timeout_min);
        return res;
      } catch (err) {
        throw new Error(err.error || err.message || 'Unknown error');
      }
    });

    ipcMain.handle('set-agent-label', async (e, label) => {
      config.set('agent_label', label);
      // Immediately send heartbeat to sync with cloud
      if (poller) await poller.pollOnce();
      return true;
    });

    ipcMain.handle('send-log', async (e, { message, level }) => {
      return await api.sendLogs(message, level);
    });

    ipcMain.handle('scan-network', async (e) => {
      const scanner = new Scanner(config.data);
      // Stream discovered devices to UI as they're found (no wait for full sweep)
      scanner.on('device-found', (dev) => {
        try {
          e.sender.send('scan-device-found', dev);
        } catch (err) { /* renderer closed */ }
      });
      const result = await scanner.scan();
      
      // Cache last scan for diff on next scan
      if (result.devices) {
        const cache = {
          scan_time: result.scan_time,
          ips: result.devices.map(d => d.ip),
          devices: result.devices.map(d => ({
            ip: d.ip, vendor: d.vendor, model: d.model, serial: d.serial,
            hostname: d.hostname,
          })),
        };
        config.set('last_scan_cache', cache);
      }
      
      return result;
    });

    ipcMain.handle('track-device', async (e, device) => {
      let res;
      try {
        res = await api.registerDevice({
          ip_address: device.ip || device.ip_address,
          merk: device.merk || device.merk_detected || 'UNKNOWN',
          model: device.model || device.model_detected || 'UNKNOWN',
          serial_number: device.serial_number || device.sn || device.snmp_result?.sysName || `UNKNOWN-${device.ip}`,
          agent_id: config.get('agent_id')
        });
      } catch (err) {
        // Check for auth errors — show re-login prompt
        const msg = err.error || err.message || String(err);
        if (msg.includes('Unauthorized') || msg.includes('token') || err.status === 401) {
          throw new Error('Token expired — silakan login ulang. Klik tombol Login di pojok kanan atas.');
        }
        throw new Error(msg);
      }
      
      const localDevice = {
        id: res.mesin.id,
        ip: device.ip || device.ip_address,
        sn: device.serial_number || device.snmp_result?.sysName || device.sn || null,
        merk: device.merk || device.merk_detected || 'UNKNOWN',
        model: device.model || device.model_detected || 'UNKNOWN',
        snmpConfig: device.snmpConfig || null,
        web_username: device.web_username || '',
        web_password: device.web_password || '',
        web_ssl: device.web_ssl || false,
        last_sync: null
      };
      config.addDevice(localDevice);
      
      if (poller) poller.pollOnce();
      return res.mesin;
    });

    ipcMain.handle('untrack-device', async (e, ip) => {
      config.removeDevice(ip);
      // Also notify backend to unlink this device from agent
      try {
        await api.request('POST', '/api/agent/device/unlink', { ip_address: ip });
      } catch (err) {
        console.warn('[IPC] Backend unlink failed (device may already be deleted):', err.message);
      }
      return true;
    });

    ipcMain.handle('update-device-cred', async (e, ip, username, password) => {
      const devices = config.get('tracked_devices') || [];
      const dev = devices.find(d => d.ip === ip);
      if (!dev) return { ok: false, error: 'Device tidak ditemukan' };

      // Save credentials temporarily to verify
      dev.web_username = username || '';
      dev.web_password = password || '';
      dev.web_ssl = false;
      config.set('tracked_devices', devices);

      // Verify credentials by trying to scrape web UI (all pages)
      try {
        const PollerService = require('../services/PollerService');
        const pollerSvc = new PollerService();
        const result = await pollerSvc.scrapeAllWebUI(ip, dev);
        
        if (result.status === 'ok' && result.toner.length > 0) {
          console.log(`[IPC] Credentials verified for ${ip}: ${result.toner.length} toner(s)`);
          // Force re-poll with verified credentials
          if (poller) setTimeout(() => poller.pollOnce(), 500);
          return { ok: true, toner: result.toner };
        } else {
          // Credentials wrong — remove them
          dev.web_username = '';
          dev.web_password = '';
          config.set('tracked_devices', devices);
          console.log(`[IPC] Credential verification failed for ${ip}: ${result.detail}`);
          return { ok: false, error: result.detail || 'Login gagal' };
        }
      } catch (err) {
        // Verification failed — remove credentials
        dev.web_username = '';
        dev.web_password = '';
        config.set('tracked_devices', devices);
        return { ok: false, error: 'Verifikasi gagal: ' + (err.message || err) };
      }
    });

    ipcMain.handle('force-poll', async () => {
      if (poller) await poller.pollOnce();
      return true;
    });

    ipcMain.handle('get-pinger-status', () => {
      const PingerService = require('../services/PingerService');
      return PingerService.getAllStatuses();
    });

    ipcMain.handle('get-mesin-detail', async (e, id) => {
      const res = await api.request('GET', `/api/mesin/${id}`);
      // Attach pinger status
      const PingerService = require('../services/PingerService');
      if (res && res.mesin) {
        res.mesin.pinger_status = PingerService.getStatus(res.mesin.ip_address) || 'UNKNOWN';
      }
      return res;
    });

    // ── Riwayat Aktifitas Mesin ──
    // Wrap errors so Electron IPC returns a readable message (not [object Object])
    ipcMain.handle('get-mesin-activity', async (e, id, limit = 50, type, days = 0) => {
      try {
        return await api.getMesinActivity(id, limit, type, days);
      } catch (err) {
        throw new Error(err.error || err.message || String(err));
      }
    });

    ipcMain.handle('create-mesin-activity', async (e, id, payload) => {
      try {
        return await api.createMesinActivity(id, payload);
      } catch (err) {
        throw new Error(err.error || err.message || String(err));
      }
    });

    ipcMain.handle('delete-mesin-activity', async (e, id, activityId) => {
      try {
        return await api.deleteMesinActivity(id, activityId);
      } catch (err) {
        throw new Error(err.error || err.message || String(err));
      }
    });

    // Open printer web UI in a dedicated Electron window.
    // Uses Electron's own Chromium with rejectUnauthorized disabled, so the
    // "Your connection is not secure" warning never blocks the page.
    ipcMain.handle('open-web-ui', async (e, ip) => {
      const { BrowserWindow } = require('electron');
      const devices = config.get('tracked_devices') || [];
      const dev = devices.find(d => d.ip === ip);
      const ssl = (dev && dev.web_ssl) || false;
      const protocol = ssl ? 'https' : 'http';
      const url = `${protocol}://${ip}/`;

      const win = new BrowserWindow({
        width: 1100,
        height: 800,
        title: `Web UI — ${ip}`,
        autoHideMenuBar: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          // Accept self-signed / invalid certs (printers use them)
          webSecurity: true
        }
      });
      // Bypass certificate errors for printer HTTPS
      win.webContents.session.setCertificateVerifyProc((request, callback) => {
        callback(0); // 0 = accept
      });
      win.loadURL(url);
      return true;
    });

    ipcMain.handle('set-snmp-config', async (e, { ip, community, version, username, authPassword, privPassword }) => {
      const devices = config.get('tracked_devices') || [];
      const dev = devices.find(d => d.ip === ip);
      if (!dev) return false;
      
      if (version === 3) {
        dev.snmpConfig = { version: 3, username, authProtocol: 'sha', authPassword, privProtocol: 'aes', privPassword };
      } else {
        dev.snmpConfig = null; // v2c, use community
        dev.community = community || 'public';
      }
      config.set('tracked_devices', devices);
      return true;
    });
  }
  
  emitToUI(channel, data) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }
}

module.exports = new IpcController();
