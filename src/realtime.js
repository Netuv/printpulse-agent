const WebSocket = require('ws');
const { ipcMain } = require('electron');
const config = require('./config');

class RealtimeClient {
  constructor() {
    this.ws = null;
    this.reconnectTimer = null;
    this.isConnected = false;
  }

  connect() {
    if (this.ws) return;

    const token = config.get('token');
    const apiUrl = config.get('api_url') || 'https://printpulse-api.printpulse-api.workers.dev';
    
    if (!token) return;

    // Convert http(s) to ws(s)
    let wsUrl = apiUrl.replace('http://', 'ws://').replace('https://', 'wss://');
    wsUrl = `${wsUrl}/api/realtime?token=${token}`;

    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      this.isConnected = true;
      console.log('Real-time WebSocket connected');
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      // Send PING every 20s to keep CF DO WS alive (30s idle timeout)
      this._pingTimer = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send('PING');
        }
      }, 20000);
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        this.handleMessage(msg);
      } catch (e) {
        if (data.toString() === 'PONG') return;
        console.error('Failed to parse WS message', e);
      }
    });

    this.ws.on('close', () => {
      this.isConnected = false;
      this.ws = null;
      if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
      console.log('Real-time WebSocket disconnected');
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error('Real-time WebSocket error:', err.message);
      if (this.ws) this.ws.close();
    });
  }

  handleMessage(msg) {
    const { BrowserWindow } = require('electron');
    
    if (msg.type === 'DELETE_DEVICE') {
      const deviceId = String(msg.device_id);
      const devices = config.get('tracked_devices') || [];
      const updatedDevices = devices.filter(d => String(d.id) !== deviceId);
      
      if (devices.length !== updatedDevices.length) {
        config.set('tracked_devices', updatedDevices);
        console.log(`Device ${deviceId} was deleted via Dashboard, removed locally.`);
        BrowserWindow.getAllWindows().forEach(win => win.webContents.send('update-roster'));
      }
    }
    
    if (msg.type === 'SYNC_DEVICES') {
      // Agent's own sync already broadcasts this — ignore to prevent infinite loop
      // Other clients (web frontend) should reload, not the originating agent
      console.log('Realtime: SYNC_DEVICES ignored (agent syncs on its own schedule).');
    }
  }

  scheduleReconnect() {
    if (!this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, 5000);
    }
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

module.exports = new RealtimeClient();
