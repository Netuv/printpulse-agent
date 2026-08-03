const config = require('./config');
const api = require('./api');
const snmp = require('net-snmp');

class Poller {
  constructor() {
    this.intervalId = null;
    this.isRunning = false;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    const ms = config.get('poll_interval_ms') || 60000;
    
    // Start interval
    this.intervalId = setInterval(() => {
      this.pollOnce();
    }, ms);
    
    console.log(`Poller started. Interval: ${ms}ms`);
    api.sendLog('Agent background poller started').catch(()=>null);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.log('Poller stopped.');
  }

  async pollOnce() {
    const devices = config.get('tracked_devices') || [];
    if (!devices.length || !config.get('token')) return; // No devices or not logged in

    const syncPayload = { devices: [] };

    for (const dev of devices) {
      try {
        const data = await this.readPrinterSNMP(dev.ip);
        syncPayload.devices.push({
          id: dev.id,
          ip: dev.ip,
          status: 'ONLINE',
          ...data
        });
      } catch (err) {
        // Printer Offline or SNMP Failed
        syncPayload.devices.push({
          id: dev.id,
          ip: dev.ip,
          status: 'OFFLINE'
        });
      }
    }

    // Push to backend
    if (syncPayload.devices.length > 0) {
      try {
        await api.syncPolledData(syncPayload);
        console.log(`Sync success for ${syncPayload.devices.length} devices.`);
      } catch (err) {
        console.error('Failed to sync to cloud', err);
      }
    }
  }

  readPrinterSNMP(ip) {
    return new Promise((resolve, reject) => {
      const session = snmp.createSession(ip, 'public', { timeout: 3000, retries: 1 });
      
      // We read standard prtMarkerLifeCount for BW/Color and prtMarkerSuppliesLevel for toner
      // Since OIDs vary wildly by vendor, we try a few common ones
      const oids = [
        '1.3.6.1.2.1.43.10.2.1.4.1.1', // BW Counter
        '1.3.6.1.2.1.43.10.2.1.4.1.2', // Color Counter
        
        // Supplies Max Capacity (Black, Cyan, Magenta, Yellow)
        '1.3.6.1.2.1.43.11.1.1.8.1.1', 
        '1.3.6.1.2.1.43.11.1.1.8.1.2', 
        '1.3.6.1.2.1.43.11.1.1.8.1.3', 
        '1.3.6.1.2.1.43.11.1.1.8.1.4', 

        // Supplies Current Level
        '1.3.6.1.2.1.43.11.1.1.9.1.1', 
        '1.3.6.1.2.1.43.11.1.1.9.1.2', 
        '1.3.6.1.2.1.43.11.1.1.9.1.3', 
        '1.3.6.1.2.1.43.11.1.1.9.1.4'
      ];

      session.get(oids, (error, varbinds) => {
        session.close();
        
        if (error) {
          return reject(error);
        }

        const parseVal = (vb) => snmp.isVarbindError(vb) ? 0 : parseInt(vb.value);
        
        const bw = parseVal(varbinds[0]);
        const color = parseVal(varbinds[1]);
        
        // Calculate % for toner
        const getPct = (maxVb, curVb) => {
          const max = parseVal(maxVb);
          const cur = parseVal(curVb);
          if (max <= 0) return null;
          let pct = Math.round((cur / max) * 100);
          if (pct < 0) pct = 0;
          return pct;
        };

        const toner = [];
        const blackPct = getPct(varbinds[2], varbinds[6]);
        if (blackPct !== null) toner.push({ warna: 'BLACK', level: blackPct });
        
        const cyanPct = getPct(varbinds[3], varbinds[7]);
        if (cyanPct !== null) toner.push({ warna: 'CYAN', level: cyanPct });
        
        const magPct = getPct(varbinds[4], varbinds[8]);
        if (magPct !== null) toner.push({ warna: 'MAGENTA', level: magPct });
        
        const yelPct = getPct(varbinds[5], varbinds[9]);
        if (yelPct !== null) toner.push({ warna: 'YELLOW', level: yelPct });

        resolve({
          bw_counter: bw,
          color_counter: color,
          toner
        });
      });
    });
  }
}

module.exports = Poller;
