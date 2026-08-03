/**
 * PingerService.js — Parallel device reachability checker
 * ======================================================
 * Pings every tracked device in parallel every 15s.
 * Exposes status per-IP: ONLINE (ping ok) or OFFLINE (no response).
 * Fires IPC events for real-time UI updates.
 * Syncs status to backend API so web frontend sees correct status.
 * 
 * Uses ICMP ping (via system ping command) — works on Windows, macOS, Linux.
 * Falls back to TCP port 161 (SNMP) connect check if ping blocked.
 */

const { exec } = require('child_process');
const net = require('net');
const config = require('../config');

const PING_INTERVAL_MS = 15000;
const PING_TIMEOUT_MS = 5000;
const MAX_CONCURRENT = 32;

class PingerService {
  constructor() {
    this._interval = null;
    this._running = false;
    this._statuses = {};    // ip -> 'ONLINE'|'OFFLINE'
    this._ipcController = null;
    this._api = null;
  }

  start(ipcController, api) {
    if (this._interval) return;
    this._ipcController = ipcController;
    this._api = api;
    console.log('[Pinger] Started (15s interval)');
    this._run();
    this._interval = setInterval(() => this._run(), PING_INTERVAL_MS);
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    this._running = false;
    console.log('[Pinger] Stopped');
  }

  async _run() {
    if (this._running) return;
    this._running = true;
    try {
      const devices = config.get('tracked_devices') || [];
      if (devices.length === 0) return;

      const ips = devices.map(d => d.ip).filter(Boolean);
      const results = [];

      // Parallel ping in batches of MAX_CONCURRENT
      for (let i = 0; i < ips.length; i += MAX_CONCURRENT) {
        const batch = ips.slice(i, i + MAX_CONCURRENT);
        const batchResults = await Promise.all(batch.map(ip => this._ping(ip)));
        results.push(...batchResults);
      }

      // Process results
      const changed = [];
      for (const { ip, online } of results) {
        const newStatus = online ? 'ONLINE' : 'OFFLINE';
        if (this._statuses[ip] !== newStatus) {
          this._statuses[ip] = newStatus;
          changed.push({ ip, status: newStatus });
        }
      }

      if (changed.length > 0) {
        if (this._ipcController) {
          this._ipcController.emitToUI('pinger-status', { devices: changed, timestamp: Date.now() });
        }
        // Sync changed statuses to backend
        this._syncStatuses(changed);
      }
    } catch (err) {
      console.warn('[Pinger] Error:', err.message);
    } finally {
      this._running = false;
    }
  }

  /**
   * Ping a single IP. Returns { ip, online: bool }
   * Uses OS ping command (ICMP). Fallback: TCP connect port 161 (SNMP).
   */
  _ping(ip) {
    return new Promise(resolve => {
      const isWin = process.platform === 'win32';
      const cmd = isWin
        ? `ping -n 1 -w ${Math.min(PING_TIMEOUT_MS, 3000)} ${ip}`
        : `ping -c 1 -W 3 ${ip}`;

      exec(cmd, { timeout: PING_TIMEOUT_MS }, (err, stdout) => {
        if (!err) {
          // Check for "Destination host unreachable" or 100% loss
          const out = (stdout || '').toLowerCase();
          if (isWin) {
            if (out.includes('ttl=') || out.includes('reply from')) {
              return resolve({ ip, online: true });
            }
          } else {
            if (out.includes('1 received') || out.includes('1 packets received')) {
              return resolve({ ip, online: true });
            }
          }
        }
        // Ping failed — try TCP connect to port 161 (SNMP) as fallback
        this._tcpCheck(ip).then(online => resolve({ ip, online })).catch(() => resolve({ ip, online: false }));
      });
    });
  }

  /**
   * TCP connect check (fallback when ICMP blocked).
   * Tries port 161 (SNMP) — open on most printers.
   */
  _tcpCheck(ip) {
    return new Promise(resolve => {
      const sock = new net.Socket();
      sock.setTimeout(2000);
      sock.on('connect', () => { sock.destroy(); resolve(true); });
      sock.on('error', () => { sock.destroy(); resolve(false); });
      sock.on('timeout', () => { sock.destroy(); resolve(false); });
      sock.connect(161, ip);
    });
  }

  /**
   * Sync changed statuses to backend API
   */
  async _syncStatuses(changed) {
    if (!this._api || !config.get('token')) return;
    try {
      await this._api.request('POST', '/api/agent/devices/status', {
        devices: changed,
        agent_id: config.get('agent_id'),
      });
    } catch (err) {
      // Silently ignore — will retry on next ping cycle
    }
  }

  /**
   * Get current status for an IP
   */
  getStatus(ip) {
    return this._statuses[ip] || 'UNKNOWN';
  }

  /**
   * Get all current statuses
   */
  getAllStatuses() {
    return { ...this._statuses };
  }
}

module.exports = new PingerService();
