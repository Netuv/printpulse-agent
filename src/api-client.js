const fetch = require('node-fetch');

class ApiClient {
  constructor(config) {
    this.baseURL = config.api_url;
    this.apiKey = config.api_key;
    this.tenantId = config.tenant_id;
  }

  /**
   * Make authenticated API request
   */
  async request(method, path, body = null) {
    const url = `${this.baseURL}${path}`;
    
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
    };

    if (body && method !== 'GET') {
      options.body = JSON.stringify(body);
    }

    try {
      const response = await fetch(url, options);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || `API request failed: ${response.status}`);
      }

      return data;
    } catch (error) {
      throw new Error(`API request to ${path} failed: ${error.message}`);
    }
  }

  /**
   * Get registered machines from API
   */
  async getMachines() {
    const result = await this.request('GET', '/api/mesin');
    return result.mesin || [];
  }

  /**
   * Submit discovery scan results
   */
  async submitDiscovery(scanResult) {
    const payload = {
      scan_id: scanResult.scan_id,
      agent_version: scanResult.agent_version || '1.0.0',
      network_info: scanResult.network,
      total_devices: scanResult.total_devices || 0,
      devices: scanResult.devices || [],
      raw_result: scanResult,
    };

    const result = await this.request('POST', '/api/discovery/submit', payload);
    return result;
  }

  /**
   * Submit meter reading (poll result)
   */
  async submitReading(mesinId, pollResult) {
    const payload = {
      mesin_id: mesinId,
      transaction_at: pollResult.polled_at || new Date().toISOString(),
      paper_size: 'MIXED', // Can't detect per-size from SNMP
      print_type: 'MIXED',
      bw_total: pollResult.delta_bw || 0,
      color_total: pollResult.delta_color || 0,
      source: 'SNMP_AUTO',
      snmp_raw: {
        current_bw: pollResult.current_bw,
        current_color: pollResult.current_color,
        toner_levels: pollResult.toner_levels,
        device_status: pollResult.device_status,
      },
    };

    // Note: This submits to pemakaian endpoint
    // In production, you might want a dedicated SNMP endpoint
    const result = await this.request('POST', '/api/pemakaian', payload);
    return result;
  }

  /**
   * Update toner levels
   */
  async updateTonerLevels(mesinId, tonerLevels) {
    // Get toner records for this machine
    const tonerResult = await this.request('GET', `/api/toner?mesin_id=${mesinId}`);
    const toners = tonerResult.toner || [];

    // Update each toner color
    const updates = [];
    for (const [warna, level] of Object.entries(tonerLevels)) {
      if (level === null) continue;

      const tonerRecord = toners.find(t => t.warna === warna);
      if (tonerRecord) {
        updates.push(
          this.request('PUT', `/api/toner/${tonerRecord.id}/level`, { level })
        );
      }
    }

    await Promise.allSettled(updates);
  }

  /**
   * Submit device online/offline status
   */
  async submitStatus(mesinId, online) {
    return this.request('PUT', `/api/mesin/${mesinId}/status`, { online });
  }

  /**
   * Submit silent log data
   */
  async submitLogs(logData) {
    return this.request('POST', '/api/agent/logs', logData).catch(() => {});
  }

  /**
   * Track machines (apply configuration for discovery results)
   */
  async trackMachines(machineIds) {
    return this.request('POST', '/api/mesin/track', { machine_ids: machineIds });
  }
}

module.exports = ApiClient;
