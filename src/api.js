const { net } = require('electron');
const fetch = net.fetch;
const config = require('./config');

class ApiClient {
  constructor() {}

  get url() {
    return config.get('api_url').replace(/\/$/, '');
  }

  get headers() {
    const h = { 'Content-Type': 'application/json' };
    const token = config.get('token');
    const tenantId = config.get('tenant_id');
    if (token) h['Authorization'] = `Bearer ${token}`;
    if (tenantId) h['X-Tenant-ID'] = tenantId.toString();
    return h;
  }

  async request(method, path, body = null) {
    const opts = { method, headers: this.headers };
    if (body) opts.body = JSON.stringify(body);

    console.log(`[API] ${method} ${this.url}${path}`, opts);
    let res;
    try {
      res = await fetch(`${this.url}${path}`, opts);
    } catch (e) {
      console.error('[API] Fetch Error:', e);
      throw { error: e.message };
    }
    
    let data;
    try {
      data = await res.json();
    } catch (parseErr) {
      const text = await res.text().catch(() => 'could not read text');
      throw { status: res.status, error: `Failed to parse JSON: ${parseErr.message}. Raw response: ${text.substring(0, 100)}` };
    }

    if (!res.ok) {
      throw { status: res.status, error: data?.error || res.statusText };
    }
    return data;
  }

  async login(email, password, agent_label, pic_agent_id) {
    const os = require('os');
    const config = require('./config');
    let version = '1.0.0';
    try { version = require('../../package.json').version; } catch(e){}

    const payload = { 
      email, 
      password,
      agent_id: config.get('agent_id') || undefined,
      hostname: os.hostname(),
      agent_version: version
    };
    if (agent_label) payload.agent_label = agent_label;
    if (pic_agent_id) payload.pic_agent_id = pic_agent_id;

    const res = await this.request('POST', '/api/agent/login', payload);
    // Layered login (admin/tech above PIC): do NOT overwrite the PIC token.
    // Only PIC base login replaces the session token.
    if (!res.is_layered) {
      config.set('token', res.access_token);
      config.set('tenant_id', res.tenant_id);
      if (res.agent_id) config.set('agent_id', res.agent_id);
    }
    if (agent_label) config.set('agent_label', agent_label);
    return res;
  }

  /**
   * Layered login: validate admin/tech credentials against the linked PIC
   * agent without replacing the PIC session token/identity.
   */
  async layeredLogin(email, password, pic_agent_id) {
    const os = require('os');
    const config = require('./config');
    let version = '1.0.0';
    try { version = require('../../package.json').version; } catch(e){}

    const payload = {
      email, password,
      agent_id: config.get('agent_id') || undefined,
      hostname: os.hostname(),
      agent_version: version,
      pic_agent_id,
    };
    const res = await this.request('POST', '/api/agent/login', payload);
    // Never overwrite token — this is a front layer only
    return res;
  }

  async verifyToken() {
    return this.request('GET', '/api/agent/verify');
  }

  // --- Device APIs ---

  async registerDevice(devicePayload) {
    // devicePayload: { ip_address, merk, model, serial_number, mac_address }
    return this.request('POST', '/api/agent/device/register', devicePayload);
  }

  async syncPolledData(payload) {
    // payload: { devices: [ { id, ip, status, bw, color, toner: [...] } ] }
    return this.request('POST', '/api/agent/device/sync', payload);
  }

  // ── Riwayat Aktifitas Mesin ──
  async getMesinActivity(mesinId, limit = 50) {
    return this.request('GET', `/api/mesin/${mesinId}/activity?limit=${limit}`);
  }

  async createMesinActivity(mesinId, payload) {
    return this.request('POST', `/api/mesin/${mesinId}/activity`, payload);
  }

  async deleteMesinActivity(mesinId, activityId) {
    return this.request('DELETE', `/api/mesin/${mesinId}/activity/${activityId}`);
  }

  // SYSTEM auto-log (bypasses PIC view-only gate) — used by alert auto-logging
  async logDeviceActivity(payload) {
    return this.request('POST', '/api/agent/device/activity', payload);
  }

  // ── Layered login (PIC + Admin/Technician front layer) ──
  async getLoginState() {
    return this.request('GET', '/api/agent/login-state');
  }

  async saveIdleTimeout(idleTimeoutMin) {
    return this.request('PUT', '/api/agent/idle-timeout', { idle_timeout_min: idleTimeoutMin });
  }
  
  async sendHeartbeat(payload) {
    const config = require('./config');
    const fullPayload = { ...payload, agent_id: config.get('agent_id'), agent_label: config.get('agent_label') };
    return this.request('POST', '/api/agent/heartbeat', fullPayload);
  }

  async sendLogs(message, level = 'info') {
    return this.request('POST', '/api/agent/logs', { message, level });
  }
}

module.exports = new ApiClient();
