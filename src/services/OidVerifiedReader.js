/**
 * OidVerifiedReader.js — Direct GET Reader (AMCS-Style)
 * =====================================================
 * Once model OIDs are verified, reads counters via direct GET
 * — same as AMCS GetSNMP0-8: 3-4 OIDs, <1s, no ambiguity.
 *
 * @version 1.0.0
 */

const snmp = require('net-snmp');

class OidVerifiedReader {
  /**
   * @param {Object} oidMap — from verified DB: {oid_m1, oid_m2, oid_m3, oid_m4, oid_toner_black, ...}
   * @param {Object} opts
   */
  constructor(oidMap, opts = {}) {
    this.oidMap = oidMap || {};
    this.timeout = opts.timeout || 5000;
    this.retries = opts.retries || 0;
    this.community = opts.community || 'public';
  }

  /**
   * Read counters + toner via direct GET. Same pattern as AMCS GetSNMP0-8.
   * @param {string} ip
   * @returns {Object} {total_pages, bw_counter, color_counter, toner_levels, m1m4}
   */
  async read(ip) {
    const m1 = this.oidMap.oid_m1;
    const m2 = this.oidMap.oid_m2;
    const m3 = this.oidMap.oid_m3;
    const m4 = this.oidMap.oid_m4;

    // M1-M4 counters
    const counterOids = [m1, m2, m3, m4].filter(Boolean);
    let mValues = [];
    if (counterOids.length > 0) {
      mValues = await this._snmpGet(ip, counterOids);
    }

    // Toner
    const tonerOids = ['oid_toner_black','oid_toner_cyan','oid_toner_magenta','oid_toner_yellow']
      .map(k => this.oidMap[k]).filter(Boolean);
    let tValues = [];
    if (tonerOids.length > 0) {
      tValues = await this._snmpGet(ip, tonerOids);
    }

    // Build result — same format as AMCS M1-M4
    const m1m4 = {};
    const amcsLabels = this.oidMap.amcs_labels || ['M1','M2','M3','M4'];
    const amcsCounters = [];

    counterOids.forEach((oid, i) => {
      const val = (mValues[i] !== null && mValues[i] !== undefined) ? parseInt(mValues[i]) : null;
      const label = amcsLabels[i] || `M${i+1}`;
      m1m4[label] = val;
      if (val !== null && !isNaN(val) && val > 0) {
        amcsCounters.push({ label, value: val, oid });
      }
    });

    // M1 is main total (AMCS convention for most vendors)
    const m1Val = amcsCounters.length > 0 ? amcsCounters[0].value : 0;

    // Toner levels
    const tonerLevels = {};
    const tonerColors = ['BLACK', 'CYAN', 'MAGENTA', 'YELLOW'];
    tonerOids.forEach((oid, i) => {
      const val = (tValues[i] !== null && tValues[i] !== undefined) ? parseInt(tValues[i]) : null;
      if (val !== null && !isNaN(val) && val >= 0) {
        tonerLevels[tonerColors[i]] = Math.max(0, Math.min(100, val));
      }
    });

    return {
      total_pages: m1Val,
      bw_counter: m1Val,
      color_counter: 0,
      m1m4,
      amcs_counters: amcsCounters,
      toner_levels: tonerLevels,
      counter_source: 'amcs_verified',
      vendor_counters_estimated: false,
    };
  }

  /**
   * SnmpGet for one or more OIDs, fallback v2c → v1.
   */
  async _snmpGet(ip, oids) {
    if (!oids.length) return [];
    // Try v2c first
    try {
      return await this._doGet(ip, oids, snmp.Version2c);
    } catch (e) {
      // Fallback to v1
      try { return await this._doGet(ip, oids, snmp.Version1); }
      catch { return oids.map(() => null); }
    }
  }

  _doGet(ip, oids, version) {
    return new Promise((resolve, reject) => {
      const session = snmp.createSession(ip, this.community, {
        timeout: this.timeout, retries: this.retries, version,
      });
      const oidArray = oids.map(o => o.split('.').map(Number));
      session.get(oidArray, (error, varbinds) => {
        session.close();
        if (error) return reject(error);
        if (!varbinds) return reject(new Error('No response'));
        const values = varbinds.map(vb => {
          if (snmp.isVarbindError && snmp.isVarbindError(vb)) return null;
          return vb.value !== undefined ? vb.value : null;
        });
        resolve(values);
      });
    });
  }
}

module.exports = OidVerifiedReader;
