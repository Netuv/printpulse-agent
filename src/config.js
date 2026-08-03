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
      poll_interval_ms: 60000 // 1 minute default
    };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf8');
        const parsed = JSON.parse(raw);
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
    // Prevent duplicates
    const idx = this.data.tracked_devices.findIndex(d => d.ip === device.ip || (d.sn && d.sn === device.sn));
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
}

module.exports = new ConfigStore();
