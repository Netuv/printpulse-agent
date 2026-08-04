/**
 * scanner-comprehensive.js — SNMP Printer Scanner (MIB Walk Refactor)
 * ====================================================================
 * Discovery mode only: device info + quick RFC 3805 counter.
 * Enqueues unknown printers to MibWalkerService for background OID discovery.
 * Once OIDs verified, PollerService uses OidVerifiedReader for fast direct GET.
 *
 * Per MIB Walk Plan: no table walks, no Python, no fallback cascade, no estimation.
 *
 * @version 3.0.0 — MIB Walk Refactor
 */

const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');
const snmp = require('net-snmp');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const execAsync = promisify(exec);

// =====================================================================
// MINIMAL OIDs — only what discovery needs
// =====================================================================

const OID_DEVICE_MODEL = '1.3.6.1.2.1.43.5.1.1.16.1';
const OID_DEVICE_SERIAL = '1.3.6.1.2.1.43.5.1.1.17.1';
const OID_DEVICE_ID = '1.3.6.1.2.1.43.5.1.1.18.1';
const OID_SYSNAME = '1.3.6.1.2.1.1.5.0';
const OID_SYSLOCATION = '1.3.6.1.2.1.1.6.0';
const OID_SYSDESCR = '1.3.6.1.2.1.1.1.0';
const OID_SYSUPTIME = '1.3.6.1.2.1.1.3.0';
const OID_SYSOBJECTID = '1.3.6.1.2.1.1.2.0';
const OID_HOST_DEVICE_STATUS = '1.3.6.1.2.1.25.3.2.1.5.1';
const OID_MARKER_LIFE_COUNT = '1.3.6.1.2.1.43.10.2.1.4';

// =====================================================================
// VENDOR ENTERPRISE OID LOOKUP (for vendor detection only)
// =====================================================================

const VENDOR_MAP = {
  '1.3.6.1.4.1.1602': 'Canon',
  '1.3.6.1.4.1.2435': 'Brother',
  '1.3.6.1.4.1.367':  'Ricoh',
  '1.3.6.1.4.1.1248': 'Epson',
  '1.3.6.1.4.1.1347': 'Kyocera',
  '1.3.6.1.4.1.11':   'HP',
  '1.3.6.1.4.1.18334':'Konica Minolta',
  '1.3.6.1.4.1.2383': 'Sharp',
  '1.3.6.1.4.1.421':  'Sharp',
  '1.3.6.1.4.1.5005': 'Toshiba',
  '1.3.6.1.4.1.128':  'Xerox',
  '1.3.6.1.4.1.253':  'Xerox',
  '1.3.6.1.4.1.641':  'Lexmark',
  '1.3.6.1.4.1.236':  'Samsung',
};

const HOST_STATUS_MAP = { 1:'Running', 2:'Warning', 3:'Testing', 4:'Down', 5:'Unknown' };

// =====================================================================
// COMPREHENSIVE SCANNER CLASS
// =====================================================================

class ComprehensiveScanner extends EventEmitter {
  constructor(config) {
    this.config = config || {};
    this.snmpConfig = config.snmp || {};
    this.community = this.snmpConfig.default_community || 'public';
    this.timeout = this.snmpConfig.timeout_ms || 5000;
    this.retries = this.snmpConfig.retry || 1;
  }

  // ===================================================================
  // MAIN SCAN ENTRY POINT
  // ===================================================================

  /**
   * Main scan function — discovers and probes all printers on network
   */
  async scan() {
    console.log('🔍 Step 1: Detecting local network...');
    const networkInfo = this.detectNetwork();
    console.log(`   Local IP: ${networkInfo.ip_local}`);
    console.log(`   Gateway: ${networkInfo.gateway}`);
    console.log(`   Subnet: ${networkInfo.subnet}`);

    console.log('\n🔍 Step 2: Scanning network for active devices...');
    const activeHosts = await this.pingSweep(networkInfo.subnet);
    console.log(`   Active hosts: ${activeHosts.length}`);

    console.log('\n🔍 Step 3: Probing devices for SNMP (Concurrent)...');
    const devices = [];
    
    const probePromises = activeHosts.map((host, idx) => 
      this.probeDeviceComprehensive(host).then(deviceInfo => {
        if (deviceInfo) {
          console.log(`   ✓ ${host} - ${deviceInfo.vendor || 'Unknown'} ${deviceInfo.model || ''}`);
          // Streaming: emit as soon as a device is found, so the UI can show
          // devices incrementally instead of waiting for the full sweep.
          this.emit('device-found', {
            ip: deviceInfo.ip || host,
            merk_detected: deviceInfo.vendor,
            model_detected: deviceInfo.model,
            sn: deviceInfo.serial,
            hostname: deviceInfo.hostname,
            status: deviceInfo.status || deviceInfo.host_status,
            total_pages: deviceInfo.total_pages,
            total_bw: deviceInfo.total_bw,
            total_color: deviceInfo.total_color,
            found_count: idx + 1,
            total_hosts: activeHosts.length,
          });
          return deviceInfo;
        }
        return null;
      }).catch(() => null)
    );

    const results = await Promise.allSettled(probePromises);
    results.forEach(res => {
      if (res.status === 'fulfilled' && res.value) {
        devices.push(res.value);
      }
    });

    console.log(`\n✅ Scan complete: ${devices.length} printer(s) found`);

    return {
      scan_id: `scan_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      scan_time: new Date().toISOString(),
      network: networkInfo,
      total_active_hosts: activeHosts.length,
      total_printers: devices.length,
      devices,
      agent_version: '2.0.0',
    };
  }

  // ===================================================================
  // NETWORK DISCOVERY
  // ===================================================================

  /**
   * Detect local network info
   */
  detectNetwork() {
    const interfaces = os.networkInterfaces();
    let localIP = null;
    let gateway = null;

    const virtualKeywords = ['tailscale', 'vethernet', 'virtual', 'vmware', 'wsl', 'loopback', 'pseudo'];

    // Find first non-internal IPv4 interface that isn't a known virtual adapter
    for (const name in interfaces) {
      if (virtualKeywords.some(kw => name.toLowerCase().includes(kw))) {
        continue;
      }
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          localIP = iface.address;
          const parts = localIP.split('.');
          gateway = `${parts[0]}.${parts[1]}.${parts[2]}.1`;
          break;
        }
      }
      if (localIP) break;
    }

    // Fallback if all were virtual
    if (!localIP) {
      for (const name in interfaces) {
        for (const iface of interfaces[name]) {
          if (iface.family === 'IPv4' && !iface.internal) {
            localIP = iface.address;
            const parts = localIP.split('.');
            gateway = `${parts[0]}.${parts[1]}.${parts[2]}.1`;
            break;
          }
        }
        if (localIP) break;
      }
    }

    if (!localIP) {
      throw new Error('Could not detect local network interface');
    }

    const subnet = localIP.substring(0, localIP.lastIndexOf('.'));

    return {
      ip_local: localIP,
      gateway,
      subnet: `${subnet}.0/24`,
    };
  }

  /**
   * Ping sweep to find active hosts
   */
  async pingSweep(subnet) {
    const baseIP = subnet.split('/')[0].replace('.0', '');
    const activeHosts = [];
    const batchSize = 20;

    for (let i = 1; i <= 254; i += batchSize) {
      const batch = [];
      for (let j = 0; j < batchSize && i + j <= 254; j++) {
        const ip = `${baseIP}.${i + j}`;
        batch.push(this.ping(ip));
      }

      const results = await Promise.allSettled(batch);
      results.forEach((result, idx) => {
        if (result.status === 'fulfilled' && result.value) {
          activeHosts.push(`${baseIP}.${i + idx}`);
        }
      });
    }

    return activeHosts;
  }

  /**
   * Ping a single host
   */
  async ping(host) {
    const platform = os.platform();
    const pingCmd = platform === 'win32'
      ? `ping -n 1 -w 1000 ${host}`
      : `ping -c 1 -W 1 ${host}`;

    try {
      await execAsync(pingCmd);
      return true;
    } catch {
      return false;
    }
  }

  // ===================================================================
  // SNMP HELPER FUNCTIONS
  // ===================================================================

  /**
   * Create SNMP session with timeout and retry
   */
  createSession(host, community = null) {
    return snmp.createSession(host, community || this.community, {
      timeout: this.timeout,
      retries: this.retries,
      version: snmp.Version2c,
    });
  }

  /**
   * SNMP GET — get single or multiple OIDs
   */
  snmpGet(session, oids) {
    return new Promise((resolve, reject) => {
      const oidArray = Array.isArray(oids) ? oids : [oids];
      
      session.get(oidArray, (error, varbinds) => {
        if (error) {
          return reject(error);
        }

        // Return raw varbinds (caller handles error checking)
        resolve(varbinds);
      });
    });
  }

  /**
   * SNMP WALK — walk entire subtree
   */
  snmpWalk(session, baseOid) {
    return new Promise((resolve, reject) => {
      const results = [];
      
      const walk = session.walk([baseOid], 100, (varbinds) => {
        // Called for each batch of results
        varbinds.forEach(vb => {
          if (!snmp.isVarbindError(vb)) {
            results.push({
              oid: vb.oid.join('.'),
              value: vb.value,
              type: vb.type,
            });
          }
        });
      }, (error) => {
        // Called when walk completes or errors
        if (error) {
          // Walk error is often just "end of MIB" which is OK
          // Return what we got
          resolve(results);
        } else {
          resolve(results);
        }
      });
    });
  }

  /**
   * SNMP WALK with timeout — safer version that always resolves
   * FIXED: Falls back to manual GETNEXT walk if library walk fails
   */
  async snmpWalkSafe(session, baseOid, timeoutMs = 15000) {
    // Try library walk first
    try {
      const results = await Promise.race([
        this.snmpWalk(session, baseOid),
        new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), timeoutMs))
      ]);
      
      if (results !== 'TIMEOUT' && results.length > 0) {
        return results;
      }
      
      if (results === 'TIMEOUT') {
        console.log(`   ⏱️  Walk timeout for ${baseOid}, trying manual GETNEXT walk...`);
      } else {
        console.log(`   ℹ️  Walk returned 0 results for ${baseOid}, trying manual GETNEXT walk...`);
      }
    } catch (error) {
      console.log(`   ⚠️  Walk error: ${error.message}, trying manual GETNEXT walk...`);
    }
    
    // Fallback: manual GETNEXT walk
    return await this.manualWalk(session, baseOid, timeoutMs);
  }

  /**
   * Manual SNMP walk using GETNEXT (fallback when library walk fails)
   * Some printers (e.g. Ricoh) don't support standard walk operations
   */
  async manualWalk(session, baseOid, timeoutMs = 15000) {
    const results = [];
    let currentOid = baseOid;
    const startTime = Date.now();
    const seenOids = new Set();
    
    try {
      while (Date.now() - startTime < timeoutMs && results.length < 500) {
        const varbinds = await this.snmpGetNext(session, [currentOid]);
        
        if (!varbinds || varbinds.length === 0) break;
        
        const vb = varbinds[0];
        
        // Handle error values
        if (!vb) break;
        
        // Check for end-of-MIB indicators
        if (vb.value === null || vb.value === undefined) break;
        
        const nextOid = Array.isArray(vb.oid) ? vb.oid.join('.') : String(vb.oid);
        
        // Check if we've left the subtree
        if (!nextOid.startsWith(baseOid)) break;
        
        // Check for loop (duplicate OID)
        if (seenOids.has(nextOid)) break;
        seenOids.add(nextOid);
        
        results.push({
          oid: nextOid,
          value: vb.value,
          type: vb.type,
        });
        
        currentOid = nextOid;
      }
    } catch (error) {
      // Return what we got so far
    }
    
    if (results.length > 0) {
      console.log(`   📋 Manual walk got ${results.length} OIDs for ${baseOid}`);
    }
    return results;
  }

  /**
   * SNMP GETNEXT — get next OID
   */
  snmpGetNext(session, oids) {
    return new Promise((resolve, reject) => {
      const oidArray = Array.isArray(oids) ? oids : [oids];
      
      session.getNext(oidArray, (error, varbinds) => {
        if (error) return reject(error);
        resolve(varbinds);
      });
    });
  }

  /**
   * Group walk results by composite index key
   * FIXED: Handles multi-level indices (e.g. Ricoh supplies have index.subindex)
   * Strategy 1: Match against known column prefixes
   * Strategy 2: Fallback to last-OID-segment grouping
   */
  groupTableByIndex(walkResults) {
    // Strategy 1: Match against known column OIDs
    const grouped = {};
    
    // Known printer MIB column OIDs (will match prefix)
    const columnOids = new Set([
      OID_SUPPLY_DESC, OID_SUPPLY_TYPE, OID_SUPPLY_CLASS,
      OID_SUPPLY_LEVEL, OID_SUPPLY_MAX_CAP, OID_SUPPLY_UNIT,
      OID_MARKER_INDEX, OID_MARKER_TECH, OID_MARKER_LIFE_COUNT,
      OID_MARKER_COUNTER_UNIT, OID_MARKER_COLORANT,
      OID_INPUT_INDEX, OID_INPUT_TYPE, OID_INPUT_MAX_CAP,
      OID_INPUT_CURRENT, OID_INPUT_WEIGHT, OID_INPUT_MEDIA_SIZE, OID_INPUT_MEDIA_NAME,
      OID_ALERT_INDEX, OID_ALERT_CODE, OID_ALERT_SEVERITY,
      OID_ALERT_GROUP, OID_ALERT_TIME, OID_ALERT_TEXT,
      OID_JOB_ID, OID_JOB_NAME, OID_JOB_OWNER, OID_JOB_SIZE, OID_JOB_PAGES,
    ]);
    
    for (const item of walkResults) {
      const oidStr = item.oid;
      
      // Find which column OID this belongs to
      let matchedColumn = null;
      let indexKey = null;
      
      for (const colOid of columnOids) {
        if (oidStr.startsWith(colOid)) {
          matchedColumn = colOid;
          indexKey = oidStr.substring(colOid.length);
          break;
        }
      }
      
      if (matchedColumn && indexKey && indexKey.length > 0) {
        if (indexKey.startsWith('.')) indexKey = indexKey.substring(1);
        
        if (!grouped[indexKey]) {
          grouped[indexKey] = {};
        }
        grouped[indexKey][matchedColumn] = this.parseValue(item.value, item.type);
      }
    }
    
    // If strategy 1 found nothing, fallback to last-segment grouping
    if (Object.keys(grouped).length === 0 && walkResults.length > 0) {
      for (const item of walkResults) {
        const oidParts = item.oid.split('.');
        if (oidParts.length < 2) continue;
        const index = oidParts[oidParts.length - 1];
        const baseOid = oidParts.slice(0, -1).join('.');
        if (!grouped[index]) grouped[index] = {};
        grouped[index][baseOid] = this.parseValue(item.value, item.type);
      }
    }
    
    return grouped;
  }

  /**
   * Parse SNMP value based on type
   */
  parseValue(value, type) {
    if (value === null || value === undefined) {
      return null;
    }

    // Check for error values
    if (typeof value === 'object' && value.constructor && value.constructor.name === 'NoSuchInstance') {
      return null;
    }

    // OctetString
    if (Buffer.isBuffer(value)) {
      return value.toString('utf8').replace(/\0/g, '');
    }

    // Integer, Counter, Gauge, TimeTicks
    if (typeof value === 'number') {
      return value;
    }

    // OID
    if (Array.isArray(value)) {
      return value.join('.');
    }

    // Default: convert to string
    return String(value);
  }

  /**
   * Format uptime (timeticks) to human readable
   */
  formatUptime(timeticks) {
    try {
      const seconds = Math.floor(timeticks / 100);
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor((seconds % 86400) / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = seconds % 60;
      return `${days}d ${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } catch {
      return String(timeticks);
    }
  }

  /**
   * Detect vendor from sysObjectID or sysDescr
   */
  detectVendor(sysObjectID, sysDescr) {
    const oid = sysObjectID || '';
    const descr = (sysDescr || '').toUpperCase();

    // Check enterprise OID prefixes
    const oidPrefixes = {
      '1.3.6.1.4.1.1602': 'Canon',
      '1.3.6.1.4.1.2435': 'Brother',
      '1.3.6.1.4.1.367': 'Ricoh',
      '1.3.6.1.4.1.1248': 'Epson',
      '1.3.6.1.4.1.1347': 'Kyocera',
      '1.3.6.1.4.1.11': 'HP',
      '1.3.6.1.4.1.18334': 'Konica Minolta',
      '1.3.6.1.4.1.2383': 'Sharp',
      '1.3.6.1.4.1.5005': 'Toshiba',
      '1.3.6.1.4.1.128': 'Xerox',
      '1.3.6.1.4.1.641': 'Lexmark',
      '1.3.6.1.4.1.236': 'Samsung',
    };

    for (const [prefix, vendor] of Object.entries(oidPrefixes)) {
      if (oid.startsWith(prefix)) {
        return vendor.toLowerCase().replace(/\s+/g, '');
      }
    }

    // Fallback: detect from description
    if (descr.includes('CANON')) return 'canon';
    if (descr.includes('BROTHER')) return 'brother';
    if (descr.includes('RICOH')) return 'ricoh';
    if (descr.includes('EPSON')) return 'epson';
    if (descr.includes('KYOCERA')) return 'kyocera';
    if (descr.includes('HP') || descr.includes('HEWLETT')) return 'hp';
    if (descr.includes('KONICA') || descr.includes('MINOLTA')) return 'konicaminolta';
    if (descr.includes('SHARP')) return 'sharp';
    if (descr.includes('TOSHIBA')) return 'toshiba';
    if (descr.includes('XEROX') || descr.includes('FUJI XEROX')) return 'xerox';
    if (descr.includes('LEXMARK')) return 'lexmark';
    if (descr.includes('SAMSUNG')) return 'samsung';

    return 'unknown';
  }

  /**
   * Detect model name from sysDescr
   */
  detectModel(sysDescr) {
    if (!sysDescr) return null;
    
    // Extract model pattern (alphanumeric with optional dashes)
    const match = sysDescr.match(/\b([A-Z]+[\d]+[A-Za-z\d\-]*)\b/);
    return match ? match[1] : null;
  }

  /**
   * Check if device is a printer based on sysDescr and vendor
   */
  isPrinter(sysDescr) {
    if (!sysDescr) return false;
    const upper = sysDescr.toUpperCase();
    
    // Positive match: printer/copier/MFP keywords
    const printerKeywords = /(PRINTER|MFP|MFC|M[CF]P|COPIER|XEROX|LASERJET|PAGEWIDE|OFFICEJET|WORKFORCE|IMAGERUNNER|TASKALFA|ECOSYS|BIZHUB|MULTIFUNCTION|DIGITAL\s+COPIER)\b/i;
    if (printerKeywords.test(upper)) return true;
    
    // Negative match: definitely not a printer
    const nonPrinterKeywords = /(SWITCH|ROUTER|ACCESS\s+POINT|FIREWALL|GATEWAY|APC\s+|UPS\s+|SERVER\s+|NVR|DVR|\bIP\s+PHONE|POWER\s+OVER\s+ETHERNET|TELNET|SSH\s+|RACK\s+PDU|\bPDU\b)/i;
    if (nonPrinterKeywords.test(upper)) return false;
    
    // Check for SNMPv3-only clues: printer-related OIDs
    // If it has printer MIB entries, it's a printer
    return false; // Unknown — let Node.js probe decide (snmpy already returned if available)
  }

  // ===================================================================
  // DATA COLLECTION METHODS
  // ===================================================================

  /**
   * Collect basic device information
   * IMPROVED: More robust parsing, handles partial failures
   */
  async collectDeviceInfo(session) {
    const info = {};
    
    try {
      // Get basic system info
      const basicOids = [
        OID_DEVICE_MODEL,
        OID_DEVICE_SERIAL,
        OID_DEVICE_ID,
        OID_SYSNAME,
        OID_SYSLOCATION,
        OID_SYSDESCR,
        OID_SYSUPTIME,
        OID_SYSOBJECTID,
        OID_HOST_DEVICE_STATUS,
      ];
      
      const varbinds = await this.snmpGet(session, basicOids);
      
      // Parse each value with error handling
      varbinds.forEach((vb, idx) => {
        if (!snmp.isVarbindError(vb)) {
          const val = this.parseValue(vb.value, vb.type);
          const keys = ['model', 'serial', 'device_id', 'hostname', 'location', 
                        'sys_descr', 'uptime_raw', 'sys_object_id', 'host_status_raw'];
          if (idx < keys.length && val !== null) {
            info[keys[idx]] = val;
          }
        }
      });
      
      // Detect vendor from sysObjectID or sysDescr
      info.vendor = this.detectVendor(info.sys_object_id, info.sys_descr);
      
      // Format uptime
      if (info.uptime_raw) {
        info.uptime_human = this.formatUptime(info.uptime_raw);
      }
      
      // Map host status
      info.host_status = HOST_STATUS_MAP[info.host_status_raw] || (info.host_status_raw !== undefined ? `Unknown(${info.host_status_raw})` : null);
      
    } catch (error) {
      console.error(`   ⚠️  Device info collection error: ${error.message}`);
    }
    
    return info;
  }

  /**
   * Probe device — simplified per MIB Walk Plan.
   * Returns basic info + quick RFC 3805 counter, status UNVERIFIED.
   * Once OIDs verified, PollerService uses OidVerifiedReader.
   */
  async probeDeviceComprehensive(host) {
    let session = null;
    try {
      session = this.createSession(host);
      const info = await this.collectDeviceInfo(session);
      if (!info.vendor || info.vendor === 'unknown') return null;

      // Quick single GET for RFC 3805 total counter
      let total = 0;
      try {
        const oidArr = '1.3.6.1.2.1.43.10.2.1.4.1.1'.split('.').map(Number);
        const vb = await new Promise((resolve, reject) => {
          session.get([oidArr], (err, vbs) => {
            if (err) return reject(err);
            resolve(vbs);
          });
        });
        if (vb && !snmp.isVarbindError(vb[0])) {
          total = parseInt(this.parseValue(vb[0].value, vb[0].type)) || 0;
        }
      } catch (e) {}

      return {
        ip: host,
        hostname: info.hostname || host,
        vendor: info.vendor,
        model: info.model || info.sys_descr,
        serial: info.serial,
        location: info.location,
        uptime: info.uptime_human,
        host_status: info.host_status || 'UNKNOWN',
        total_pages: total,
        total_bw: total,
        total_color: 0,
        counter_source: 'rfc3805_unverified',
        status: 'UNVERIFIED',
        scan_time: new Date().toISOString(),
        device_info: info,
      };
    } catch (error) {
      console.error(`   Probe failed (${host}): ${error.message || error}`);
      return null;
    } finally {
      if (session) try { session.close(); } catch(e) {}
    }
  }
}


module.exports = ComprehensiveScanner;
