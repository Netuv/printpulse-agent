const fs = require('fs');
const path = require('path');

const configPath = path.join(require('electron').app.getPath('userData'), 'printpulse-agent-config.json');

class ConfigStore {
  constructor() {
    this.data = {
      api_url: 'https://printpulse-api.printpulse-api.workers.dev', // Default cloud API
      token: null,
      tenant_id: null,
      tracked_devices: [],
      poll_interval_ms: 60000, // 1 minute default
      // ── Layered login ──
      pic_user: null,        // PIC agent account (base session)
      pic_agent_id: null,    // agent_id of PIC account
      layered_user: null,    // admin/technician front-layer session (null = none)
      idle_timeout_min: 5    // auto-logout minutes for layered session
    };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.api_url && parsed.api_url.includes('your-worker-name')) {
          delete parsed.api_url; // Prevent overriding with bad placeholder
        }
        this.data = { ...this.data, ...parsed };
      }
    } catch (err) {
      console.error('Error loading config', err);
    }
  }

  save() {
    try {
      fs.writeFileSync(configPath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.error('Error saving config', err);
    }
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  addDevice(device) {
    let idx = -1;
    if (device.sn) {
      idx = this.data.tracked_devices.findIndex(d => d.sn === device.sn);
      if (idx === -1) {
        idx = this.data.tracked_devices.findIndex(d => d.ip === device.ip);
      }
    } else {
      idx = this.data.tracked_devices.findIndex(d => d.ip === device.ip);
    }

    if (idx > -1) {
      this.data.tracked_devices[idx] = { ...this.data.tracked_devices[idx], ...device };
    } else {
      this.data.tracked_devices.push(device);
    }
    this.save();
  }
  
  removeDevice(ip) {
    this.data.tracked_devices = this.data.tracked_devices.filter(d => d.ip !== ip);
    this.save();
  }

  // ── Layered login helpers ──
  setPicSession(user, agentId) {
    this.data.pic_user = user;
    this.data.pic_agent_id = agentId;
    this.save();
  }

  setLayeredUser(user) {
    this.data.layered_user = user;
    this.save();
  }

  clearLayeredUser() {
    this.data.layered_user = null;
    this.save();
  }

  setIdleTimeout(min) {
    this.data.idle_timeout_min = min;
    this.save();
  }
}

module.exports = new ConfigStore();
