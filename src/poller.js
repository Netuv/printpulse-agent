const fs = require('fs');
const path = require('path');
const snmp = require('net-snmp');

class Poller {
  constructor(config) {
    this.config = config;
    this.snmpConfig = config.snmp || {};
    this.cachePath = path.join(__dirname, 'poll-cache.json');
    this.cache = this.loadCache();
  }

  /**
   * Load polling cache (last counter values)
   */
  loadCache() {
    try {
      if (fs.existsSync(this.cachePath)) {
        return JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      }
    } catch (error) {
      console.error('Warning: Failed to load cache:', error.message);
    }
    return {};
  }

  /**
   * Save polling cache
   */
  saveCache() {
    try {
      fs.writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2));
    } catch (error) {
      console.error('Warning: Failed to save cache:', error.message);
    }
  }

  /**
   * Poll a single machine
   */
  async pollMachine(machine) {
    if (!machine.ip_address) {
      throw new Error('Machine has no IP address');
    }

    const session = snmp.createSession(
      machine.ip_address,
      machine.snmp_community || this.snmpConfig.default_community || 'public',
      {
        timeout: this.snmpConfig.timeout_ms || 5000,
        retries: this.snmpConfig.retry || 2,
        version: this.getSnmpVersion(machine.snmp_version || this.snmpConfig.default_version),
        port: machine.snmp_port || this.snmpConfig.default_port || 161,
      }
    );

    try {
      // Get OID profile for this machine (if configured)
      const oids = this.getOidsForMachine(machine);

      // Poll counters
      const counterBinds = await this.snmpGet(session, [
        oids.total_bw || '1.3.6.1.2.1.43.10.2.1.4.1.1',
        oids.total_color || '1.3.6.1.2.1.43.10.2.1.4.1.2',
      ]);

      const currentBW = parseInt(counterBinds[0]?.value || 0);
      const currentColor = parseInt(counterBinds[1]?.value || 0);

      // Get toner levels
      const tonerOids = [
        oids.toner_black || '1.3.6.1.2.1.43.11.1.1.9.1.1',
        oids.toner_cyan || '1.3.6.1.2.1.43.11.1.1.9.1.2',
        oids.toner_magenta || '1.3.6.1.2.1.43.11.1.1.9.1.3',
        oids.toner_yellow || '1.3.6.1.2.1.43.11.1.1.9.1.4',
      ];

      const tonerBinds = await this.snmpGet(session, tonerOids).catch(() => []);
      const tonerLevels = {
        BLACK: this.calculateTonerPercent(tonerBinds[0]),
        CYAN: this.calculateTonerPercent(tonerBinds[1]),
        MAGENTA: this.calculateTonerPercent(tonerBinds[2]),
        YELLOW: this.calculateTonerPercent(tonerBinds[3]),
      };

      // Get device status
      let deviceStatus = 'ONLINE';
      try {
        const statusOid = oids.device_status || '1.3.6.1.2.1.25.3.5.1.1.1';
        const statusBind = await this.snmpGet(session, [statusOid]);
        deviceStatus = this.parseDeviceStatus(statusBind[0]);
      } catch {
        // Status not available
      }

      session.close();

      // Calculate delta
      const cacheKey = `machine_${machine.id}`;
      const lastPoll = this.cache[cacheKey] || { bw: 0, color: 0 };

      let deltaBW = currentBW - lastPoll.bw;
      let deltaColor = currentColor - lastPoll.color;

      // Handle counter rollover (rare, but possible)
      if (deltaBW < 0) deltaBW = currentBW;
      if (deltaColor < 0) deltaColor = currentColor;

      // Update cache
      this.cache[cacheKey] = {
        bw: currentBW,
        color: currentColor,
        timestamp: new Date().toISOString(),
      };
      this.saveCache();

      return {
        mesin_id: machine.id,
        delta_bw: deltaBW,
        delta_color: deltaColor,
        current_bw: currentBW,
        current_color: currentColor,
        toner_levels: tonerLevels,
        device_status: deviceStatus,
        polled_at: new Date().toISOString(),
      };
    } catch (error) {
      session.close();
      throw new Error(`SNMP poll failed for ${machine.ip_address}: ${error.message}`);
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
   * Get OIDs for machine based on profile or defaults
   */
  getOidsForMachine(machine) {
    // If machine has oid_profile configured, use that
    // For now, return defaults (can be enhanced to fetch from API)
    return {
      total_bw: machine.oid_total_bw || null,
      total_color: machine.oid_total_color || null,
      toner_black: machine.oid_toner_black || null,
      toner_cyan: machine.oid_toner_cyan || null,
      toner_magenta: machine.oid_toner_magenta || null,
      toner_yellow: machine.oid_toner_yellow || null,
      device_status: machine.oid_device_status || null,
    };
  }

  /**
   * Get SNMP version enum
   */
  getSnmpVersion(versionString) {
    switch ((versionString || 'v2c').toLowerCase()) {
      case 'v1':
        return snmp.Version1;
      case 'v2c':
      case 'v2':
        return snmp.Version2c;
      case 'v3':
        return snmp.Version3;
      default:
        return snmp.Version2c;
    }
  }

  /**
   * Calculate toner percentage from SNMP value
   */
  calculateTonerPercent(varbind) {
    if (!varbind || !varbind.value) {
      return null;
    }

    try {
      const value = parseInt(varbind.value);
      
      // Some printers report as percentage (0-100)
      if (value >= 0 && value <= 100) {
        return value;
      }

      // Some report as capacity remaining vs max
      // This is a simplified calculation
      // In production, you'd fetch both current and max capacity
      if (value > 100 && value < 10000) {
        // Assume value is raw units, normalize to percentage
        return Math.min(100, Math.round((value / 100)));
      }

      return value;
    } catch {
      return null;
    }
  }

  /**
   * Parse device status from SNMP value
   */
  parseDeviceStatus(varbind) {
    if (!varbind || !varbind.value) {
      return 'UNKNOWN';
    }

    const value = parseInt(varbind.value);

    // hrPrinterStatus values (RFC 2790)
    switch (value) {
      case 1:
        return 'OTHER';
      case 2:
        return 'UNKNOWN';
      case 3:
        return 'IDLE';
      case 4:
        return 'PRINTING';
      case 5:
        return 'WARMUP';
      default:
        return 'ONLINE';
    }
  }

  /**
   * Bulk poll all machines
   */
  async pollAll(machines) {
    const results = [];

    for (const machine of machines) {
      if (!machine.ip_address) {
        console.log(`Skipping ${machine.merk} ${machine.model}: No IP address`);
        continue;
      }

      try {
        const result = await this.pollMachine(machine);
        results.push({
          success: true,
          machine_id: machine.id,
          result,
        });
      } catch (error) {
        results.push({
          success: false,
          machine_id: machine.id,
          error: error.message,
        });
      }
    }

    return results;
  }
}

module.exports = Poller;
