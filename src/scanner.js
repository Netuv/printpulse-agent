/**
 * scanner.js — Comprehensive Printer SNMP Scanner
 * =================================================
 * Based on RFC 3805 (Printer MIB v2) & vendor private MIBs
 * Extends ComprehensiveScanner with backward-compatible API
 * 
 * ✅ Device info | Page counters | Toner levels | Waste toner
 * ✅ Paper trays | Alerts | Active jobs | Vendor-specific
 * ✅ Canon | Brother | Ricoh | HP | Epson | Kyocera | etc.
 */

const ComprehensiveScanner = require('./scanner-comprehensive');

class Scanner extends ComprehensiveScanner {
  constructor(config) {
    super(config);
  }

  /**
   * Legacy backward-compatible probe method (per MIB Walk Plan)
   * Simplified: returns basic info, toner/trays empty until OIDs verified
   */
  async probeDevice(host) {
    const result = await this.probeDeviceComprehensive(host);
    if (!result) return null;

    return {
      ip: result.ip,
      hostname: result.hostname,
      merk_detected: result.vendor,
      model_detected: result.model,
      sn: result.serial,
      location: result.location,
      uptime: result.uptime,
      status: result.status || result.host_status,
      total_pages: result.total_pages,
      total_bw: result.total_bw,
      total_color: result.total_color,
      toner_levels: result.toner_levels || [],
      waste_toner: result.waste_toner || [],
      paper_trays: result.paper_trays || [],
      critical_alerts: result.critical_alerts || 0,
      warnings: result.warnings || 0,
      active_jobs: result.active_jobs || 0,
      details: result.device_info || result.details || {},
    };
  }
}

module.exports = Scanner;
