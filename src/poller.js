const config = require('./config');
const api = require('./api');
const snmp = require('net-snmp');
const ComprehensiveScanner = require('./scanner-comprehensive');
const MibWalkerService = require('./services/MibWalkerService');

class Poller {
  constructor() {
    this.intervalId = null;
    this.isRunning = false;
    this.scanner = new ComprehensiveScanner(config.getAll());
    this.mibWalker = new MibWalkerService(config.dataDir);
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    const ms = config.get('poll_interval_ms') || 60000;
    
    // Run an immediate poll first, without awaiting it so we don't block
    setTimeout(() => {
      this.pollOnce();
    }, 1000);

    // Start interval
    this.intervalId = setInterval(() => {
      this.pollOnce();
    }, ms);
    
    console.log(`Poller started. Interval: ${ms}ms`);
    api.sendLogs('Agent background poller started').catch(()=>null);
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
    if (!devices.length || !config.get('token')) return;

    const syncPayload = { devices: [] };
    let last_poll_ok = 0;
    let last_poll_fail = 0;

    for (const dev of devices) {
      try {
        const data = await this.readPrinterComprehensive(dev);
        syncPayload.devices.push({
          id: dev.id,
          ip: dev.ip,
          status: 'ONLINE',
          ...data
        });
        last_poll_ok++;
      } catch (err) {
        syncPayload.devices.push({
          id: dev.id,
          ip: dev.ip,
          status: 'OFFLINE'
        });
        last_poll_fail++;
      }
    }

    // Deduplicate
    const uniquePayloadDevices = [];
    const seenIds = new Set();
    for (const d of syncPayload.devices) {
      if (!seenIds.has(d.id)) {
        seenIds.add(d.id);
        uniquePayloadDevices.push(d);
      }
    }
    syncPayload.devices = uniquePayloadDevices;

    // Push to backend
    if (syncPayload.devices.length > 0) {
      try {
        const res = await api.syncPolledData(syncPayload);
        console.log(`Sync success for ${syncPayload.devices.length} devices.`);
        
        if (res && Array.isArray(res.valid_device_ids)) {
          const currentDevices = config.get('tracked_devices') || [];
          const validSet = new Set(res.valid_device_ids);
          let updated = false;
          
          const updatedDevices = currentDevices.filter(d => validSet.has(d.id)).map(d => {
            if (res.initial_meters && res.initial_meters[d.id]) {
              const im = res.initial_meters[d.id];
              if (d.initial_bw !== im.bw || d.initial_color !== im.color) {
                 updated = true;
                 return { ...d, initial_bw: im.bw, initial_color: im.color };
              }
            }
            return d;
          });
          
          if (updatedDevices.length !== currentDevices.length || updated) {
            config.set('tracked_devices', updatedDevices);
            console.log(`Updated local device config. Removed ${currentDevices.length - updatedDevices.length} invalid devices.`);
          }
        }
      } catch (err) {
        console.error('Failed to sync to cloud', err);
      }
    }
    
    // Send Heartbeat
    try {
      await api.sendHeartbeat({
        machines_tracked: devices.length,
        last_poll_ok,
        last_poll_fail
      });
    } catch (err) {
      console.error('Failed to send heartbeat', err);
    }
  }

  // Wrapper for fallback v2c -> v1 -> v3
  async snmpGetWithFallback(ip, oids, customCreds = null) {
    // Try snmpy GET first
    try {
      const res = await this.snmpy.getOids(ip, 'public', Array.isArray(oids) ? oids : [oids], 3);
      const oidArray = Array.isArray(oids) ? oids : [oids];
      return oidArray.map(oid => ({ oid, value: res[oid] }));
    } catch (e) {
      console.log(`[Poller] snmpy GET failed for ${ip}, falling back to node net-snmp: ${e.message}`);
    }

    try {
      return await this.doSnmpGet(ip, oids, snmp.Version2c, 'public');
    } catch (e) {
      console.log(`[Poller] v2c failed for ${ip}, trying v1...`);
    }
    
    try {
      return await this.doSnmpGet(ip, oids, snmp.Version1, 'public');
    } catch (e) {
      console.log(`[Poller] v1 failed for ${ip}.`);
    }

    if (customCreds && customCreds.version === 3) {
      try {
        console.log(`[Poller] trying v3 for ${ip}...`);
        return await this.doSnmpV3Get(ip, oids, customCreds);
      } catch (e) {
        console.log(`[Poller] v3 failed for ${ip}.`);
      }
    }

    throw new Error('All SNMP versions failed');
  }

  doSnmpGet(ip, oids, version, community) {
    return new Promise((resolve, reject) => {
      const session = snmp.createSession(ip, community, { timeout: 3000, retries: 1, version });
      session.get(oids, (error, varbinds) => {
        session.close();
        if (error) return reject(error);
        try {
          const mapped = (varbinds || []).map(vb => {
            let oidStr = vb && vb.oid ? (Array.isArray(vb.oid) ? vb.oid.join('.') : String(vb.oid)) : null;
            let value = (vb && vb.value !== undefined) ? vb.value : null;
            if (vb && typeof vb === 'object' && snmp.isVarbindError && snmp.isVarbindError(vb)) value = null;
            return { oid: oidStr, value };
          });
          resolve(mapped);
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  doSnmpV3Get(ip, oids, creds) {
    return new Promise((resolve, reject) => {
      const user = {
        name: creds.username,
        level: snmp.SecurityLevel.authPriv,
        authProtocol: snmp.AuthProtocols[creds.authProtocol || 'sha'],
        authKey: creds.authPassword,
        privProtocol: snmp.PrivProtocols[creds.privProtocol || 'aes'],
        privKey: creds.privPassword
      };
      const session = snmp.createV3Session(ip, user, { timeout: 3000, retries: 1 });
      session.get(oids, (error, varbinds) => {
        session.close();
        if (error) return reject(error);
        try {
          const mapped = (varbinds || []).map(vb => {
            let oidStr = vb && vb.oid ? (Array.isArray(vb.oid) ? vb.oid.join('.') : String(vb.oid)) : null;
            let value = (vb && vb.value !== undefined) ? vb.value : null;
            if (vb && typeof vb === 'object' && snmp.isVarbindError && snmp.isVarbindError(vb)) value = null;
            return { oid: oidStr, value };
          });
          resolve(mapped);
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  /**
   * Comprehensive printer read — uses verified OID reader or quick RFC 3805
   * Enqueues unknown printers to MibWalker for background discovery
   */
  async readPrinterComprehensive(dev) {
    // Check if this device model has verified OIDs
    const model = dev.model || '';
    const verifiedOids = this.mibWalker.db.getVerifiedForModel(model);
    if (verifiedOids) {
      try {
        const OidVerifiedReader = require('./services/OidVerifiedReader');
        const reader = new OidVerifiedReader(verifiedOids);
        const verifiedResult = await reader.read(dev.ip);
        if (verifiedResult && verifiedResult.total_pages > 0) {
          console.log(`   ✓ Verified OID read: ${dev.ip} = ${verifiedResult.total_pages} pages`);
          return this.formatComprehensivePoll({
            ...verifiedResult,
            ip: dev.ip, serial: dev.serial || '', status: 'VERIFIED',
          });
        }
      } catch (e) {
        console.log(`   Verified read failed for ${dev.ip}, falling back: ${e.message}`);
      }
    }

    // Not verified — use simplified scanner probe + enqueue for MIB walk
    try {
      const result = await this.scanner.probeDeviceComprehensive(dev.ip);
      if (result) {
        // Enqueue for background MIB walk
        this.mibWalker.enqueue({
          ip: result.ip, model: result.model, vendor: result.vendor, id: result.ip,
        });
        return this.formatComprehensivePoll(result);
      }
    } catch (err) {
      console.log(`[Poller] Probe failed for ${dev.ip}: ${err.message}`);
    }
    
    // Fallback to legacy direct OID method
    return await this.readPrinterLegacy(dev);
  }

  /**
   * Format comprehensive scan result for poll submission (per MIB Walk Plan)
   * Simplified: basic counters, enqueue for MIB walk if UNVERIFIED
   */
  formatComprehensivePoll(result) {
    const poll = {
      bw_counter: result.total_bw || 0,
      color_counter: result.total_color || 0,
      total_pages: result.total_pages || 0,
      toner: (result.toner_levels || []).map(t => ({
        warna: (t.color || t.description || '?').toUpperCase(),
        level: t.percentage,
        status: t.status || 'Unknown',
      })),
      waste_toner: (result.waste_toner || []).map(w => ({
        description: w.description || 'Waste',
        percentage: w.percentage,
        status: w.status || 'Unknown',
      })),
      paper_trays: (result.paper_trays || []).map(t => ({
        index: t.index,
        media: t.media || t.media_name,
        percentage: t.percentage,
        sheets: t.sheets,
      })),
      alerts: {
        critical: result.critical_alerts || 0,
        warnings: result.warnings || 0,
      },
      active_jobs: result.active_jobs || 0,
      uptime: result.uptime || '',
      status: result.status || result.host_status || 'UNKNOWN',
      serial: result.serial || '',
      hostname: result.hostname || '',
      location: result.location || '',
      scan_time: result.scan_time || new Date().toISOString(),
      counter_source: result.counter_source || 'rfc3805',
      status_verified: result.status !== 'UNVERIFIED',
    };

    // Enqueue for MIB walk if unverified
    if (result.status === 'UNVERIFIED') {
      this.mibWalker.enqueue({ ip: result.ip, model: result.model, vendor: result.vendor, id: result.ip });
    }

    return poll;
  }

  /**
   * Legacy method for backward compatibility
   */
  async readPrinterLegacy(dev) {
    const ip = dev.ip;
    const vendor = (dev.merk || '').toLowerCase();

    let bwOid = '1.3.6.1.2.1.43.10.2.1.4.1.1';
    let colorOid = '1.3.6.1.2.1.43.10.2.1.4.1.2';

    if (vendor.includes('hp')) {
      bwOid = '1.3.6.1.4.1.11.2.3.9.4.2.1.4.1.2.6.0';
      colorOid = '1.3.6.1.4.1.11.2.3.9.4.2.1.4.1.2.7.0';
    } else if (vendor.includes('ricoh')) {
      bwOid = '1.3.6.1.4.1.367.3.2.1.2.19.5.1.9.22';
      colorOid = '1.3.6.1.4.1.367.3.2.1.2.19.5.1.9.21';
    } else if (vendor.includes('fuji') || vendor.includes('xerox')) {
      bwOid = '1.3.6.1.4.1.253.8.53.13.2.1.6.1.20.34';
      colorOid = '1.3.6.1.4.1.253.8.53.13.2.1.6.1.20.33';
    }

    const oids = [
      bwOid,
      colorOid,
      '1.3.6.1.2.1.43.10.2.1.4.1.1',
      // Toner Max
      '1.3.6.1.2.1.43.11.1.1.8.1.1',
      '1.3.6.1.2.1.43.11.1.1.8.1.2',
      '1.3.6.1.2.1.43.11.1.1.8.1.3',
      '1.3.6.1.2.1.43.11.1.1.8.1.4',
      // Toner Cur
      '1.3.6.1.2.1.43.11.1.1.9.1.1',
      '1.3.6.1.2.1.43.11.1.1.9.1.2',
      '1.3.6.1.2.1.43.11.1.1.9.1.3',
      '1.3.6.1.2.1.43.11.1.1.9.1.4'
    ];

    const varbinds = await this.snmpGetWithFallback(ip, oids, dev.snmpConfig);

    const parseVal = (vb) => {
      if (!vb) return 0;
      try {
        if (typeof vb === 'object') {
          if (snmp.isVarbindError && snmp.isVarbindError(vb)) return 0;
          const v = vb.value !== undefined ? vb.value : null;
          const n = parseInt(v);
          return (isNaN(n) || n < 0) ? 0 : n;
        }
        const n = parseInt(vb);
        return (isNaN(n) || n < 0) ? 0 : n;
      } catch { return 0; }
    };
    
    let bw = parseVal(varbinds[0]);
    let color = parseVal(varbinds[1]);
    const total = parseVal(varbinds[2]);

    if (bw === 0 && color === 0 && total > 0) {
      bw = total;
    }

    const getPct = (maxVb, curVb) => {
      const max = parseVal(maxVb);
      const cur = parseVal(curVb);
      if (max <= 0 || max === 255) return null;
      let pct = Math.round((cur / max) * 100);
      if (pct < 0) pct = 0;
      if (pct > 100) pct = 100;
      return pct;
    };

    const toner = [];
    const blackPct = getPct(varbinds[3], varbinds[7]);
    if (blackPct !== null) toner.push({ warna: 'BLACK', level: blackPct });
    
    const cyanPct = getPct(varbinds[4], varbinds[8]);
    if (cyanPct !== null) toner.push({ warna: 'CYAN', level: cyanPct });
    
    const magPct = getPct(varbinds[5], varbinds[9]);
    if (magPct !== null) toner.push({ warna: 'MAGENTA', level: magPct });
    
    const yelPct = getPct(varbinds[6], varbinds[10]);
    if (yelPct !== null) toner.push({ warna: 'YELLOW', level: yelPct });

    return {
      bw_counter: bw,
      color_counter: color,
      toner
    };
  }
}

module.exports = Poller;
