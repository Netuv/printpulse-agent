const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');
const snmp = require('net-snmp');
const crypto = require('crypto');

const execAsync = promisify(exec);

class Scanner {
  constructor(config) {
    this.config = config;
    this.snmpConfig = config.snmp || {};
  }

  /**
   * Main scan function
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

    console.log('\n🔍 Step 3: Probing devices for SNMP...');
    const devices = [];
    
    for (const host of activeHosts) {
      try {
        const deviceInfo = await this.probeDevice(host);
        if (deviceInfo) {
          devices.push(deviceInfo);
          console.log(`   ✓ ${host} - ${deviceInfo.merk_detected || 'Unknown'} ${deviceInfo.model_detected || ''}`);
        }
      } catch (error) {
        // Silent fail for non-printer devices
      }
    }

    console.log(`\n   Printers found: ${devices.length}`);

    return {
      scan_id: `scan_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
      network: networkInfo,
      total_devices: activeHosts.length,
      devices,
      agent_version: '1.0.0',
    };
  }

  /**
   * Detect local network info
   */
  detectNetwork() {
    const interfaces = os.networkInterfaces();
    let localIP = null;
    let gateway = null;

    // Find first non-internal IPv4 interface
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

  /**
   * Probe device via SNMP
   */
  async probeDevice(host) {
    try {
      const session = snmp.createSession(host, this.snmpConfig.default_community || 'public', {
        timeout: this.snmpConfig.timeout_ms || 5000,
        retries: this.snmpConfig.retry || 1,
        version: snmp.Version2c,
      });

      // OIDs to query
      const oids = {
        sysDescr: '1.3.6.1.2.1.1.1.0',
        sysObjectID: '1.3.6.1.2.1.1.2.0',
        sysName: '1.3.6.1.2.1.1.5.0',
      };

      const varbinds = await this.snmpGet(session, Object.values(oids));
      session.close();

      if (!varbinds || varbinds.length === 0) {
        return null;
      }

      // Parse results
      const sysDescr = varbinds[0]?.value?.toString() || '';
      const sysObjectID = varbinds[1]?.value?.toString() || '';
      const sysName = varbinds[2]?.value?.toString() || '';

      // Detect if it's a printer based on sysDescr
      const isPrinter = /printer|mfp|copier|xerox|hp|epson|ricoh|canon|brother|kyocera|sharp|konica|fuji/i.test(sysDescr);

      if (!isPrinter) {
        return null; // Not a printer, skip
      }

      // Detect vendor from OID or description
      const merk = this.detectVendor(sysObjectID, sysDescr);
      const model = this.detectModel(sysDescr);

      // Try to read counters (optional)
      let counterBW = null;
      let counterColor = null;

      try {
        const counterSession = snmp.createSession(host, this.snmpConfig.default_community || 'public', {
          timeout: 2000,
          retries: 1,
        });

        // Try common counter OIDs (vendor-agnostic)
        const counterOids = [
          '1.3.6.1.2.1.43.10.2.1.4.1.1', // prtMarkerLifeCount (BW)
          '1.3.6.1.2.1.43.10.2.1.4.1.2', // Color counter (if exists)
        ];

        const counterBinds = await this.snmpGet(counterSession, counterOids);
        counterSession.close();

        if (counterBinds && counterBinds.length > 0) {
          counterBW = parseInt(counterBinds[0]?.value || 0);
          counterColor = parseInt(counterBinds[1]?.value || 0);
        }
      } catch {
        // Counters not available, that's OK
      }

      return {
        ip: host,
        hostname: sysName || host,
        merk_detected: merk,
        model_detected: model,
        snmp_result: {
          sysDescr,
          sysObjectID,
          sysName,
          total_counter_bw: counterBW,
          total_counter_color: counterColor,
        },
      };
    } catch (error) {
      return null; // SNMP failed, not a printer or not accessible
    }
  }

  /**
   * SNMP GET helper
   */
  snmpGet(session, oids) {
    return new Promise((resolve, reject) => {
      session.get(oids, (error, varbinds) => {
        if (error) {
          return reject(error);
        }

        // Filter out errors
        const validBinds = varbinds.filter(vb => !snmp.isVarbindError(vb));
        resolve(validBinds);
      });
    });
  }

  /**
   * Detect vendor from OID or description
   */
  detectVendor(oid, descr) {
    const oidPrefixes = {
      '1.3.6.1.4.1.253': 'Xerox',
      '1.3.6.1.4.1.11': 'HP',
      '1.3.6.1.4.1.124': 'Epson',
      '1.3.6.1.4.1.367': 'Ricoh',
      '1.3.6.1.4.1.1602': 'Canon',
      '1.3.6.1.4.1.2435': 'Brother',
      '1.3.6.1.4.1.1347': 'Kyocera',
      '1.3.6.1.4.1.18334': 'Konica Minolta',
      '1.3.6.1.4.1.238': 'Sharp',
    };

    for (const [prefix, vendor] of Object.entries(oidPrefixes)) {
      if (oid.startsWith(prefix)) {
        return vendor;
      }
    }

    // Fallback: detect from description
    if (/xerox|fuji xerox/i.test(descr)) return 'Xerox';
    if (/hewlett|hp laserjet|hp color/i.test(descr)) return 'HP';
    if (/epson/i.test(descr)) return 'Epson';
    if (/ricoh/i.test(descr)) return 'Ricoh';
    if (/canon/i.test(descr)) return 'Canon';
    if (/brother/i.test(descr)) return 'Brother';
    if (/kyocera/i.test(descr)) return 'Kyocera';
    if (/konica|minolta/i.test(descr)) return 'Konica Minolta';
    if (/sharp/i.test(descr)) return 'Sharp';

    return 'Unknown';
  }

  /**
   * Detect model from description
   */
  detectModel(descr) {
    // Extract model number pattern (e.g., "C405", "MFP M436", "L15160")
    const match = descr.match(/\b([A-Z]+[\d]+[A-Za-z\d]*)\b/);
    return match ? match[1] : null;
  }
}

module.exports = Scanner;
