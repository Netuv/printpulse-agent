const config = require('../config');
const api = require('../api');
const snmp = require('net-snmp');
const SnmpyBridge = require('../snmpy-bridge');
const OID_PROFILES = require('../oid-profiles');

function normalizeTonerWarna(raw) {
  if (!raw) return 'UNKNOWN';
  // Check for [K] [C] [M] [Y] notation common in vendor supplies descriptions
  const bracketMatch = raw.match(/\[([KCMY])\]/);
  if (bracketMatch) {
    const map = { K:'BLACK', C:'CYAN', M:'MAGENTA', Y:'YELLOW' };
    return map[bracketMatch[1]] || 'UNKNOWN';
  }
  // Strip everything after ; [ ( (serial numbers, chip IDs)
  let s = raw.replace(/[;\[(].*$/, '').trim();
  // Look for known color words
  const colorWords = s.split(/[\s,]+/);
  for (const word of colorWords) {
    const upper = word.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (['BLACK','K','BK'].includes(upper)) return 'BLACK';
    if (['CYAN','C'].includes(upper)) return 'CYAN';
    if (['MAGENTA','M'].includes(upper)) return 'MAGENTA';
    if (['YELLOW','Y'].includes(upper)) return 'YELLOW';
  }
  return colorWords[0].toUpperCase();
}

// Use lazy load to avoid circular dependency loop on init
let ipcController = null;

class PollerService {
  constructor() {
    this.intervalId = null;
    this.isRunning = false;
    this._polling = false; // ← fix #1: concurrency guard
    this.offlineQueue = [];
    this.snmpy = SnmpyBridge.getShared();
    this.timeout = (config.get && config.get('snmp_timeout_ms')) || 5000;
    // Reuse OEM yield table from snmpy-bridge (shared estimator)
    this._yieldProfiles = SnmpyBridge.TONER_YIELDS || {};
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    const ms = config.get('poll_interval_ms') || 60000;
    
    if (!ipcController) {
      ipcController = require('../controllers/ipcController');
    }

    setTimeout(() => this.pollOnce(), 1500);
    
    this.intervalId = setInterval(() => this.pollOnce(), ms);
    
    console.log(`[Poller v4] Started. Interval: ${ms}ms (snmpy enabled)`);
  }

  stop() {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    this.isRunning = false;
  }

  async pollOnce() {
    // Fix #1: skip if previous poll still running (with safety timeout)
    if (this._polling) {
      // Safety: if poll stuck for > 5 minutes, force reset
      if (this._pollingStart && (Date.now() - this._pollingStart > 300000)) {
        console.log('[Poller] Previous poll stuck (>5min), force resetting');
        this._polling = false;
      } else {
        console.log('[Poller] Previous poll still running, skipping');
        return;
      }
    }
    this._polling = true;
    this._pollingStart = Date.now();
    
    try {
      await this._doPoll();
    } catch (err) {
      console.error('[Poller] Unhandled error in poll cycle:', err);
    } finally {
      this._polling = false;
    }
  }

  async _doPoll() {
    let devices = config.get('tracked_devices') || [];
    if (!devices.length || !config.get('token')) return;

    if (!ipcController) ipcController = require('../controllers/ipcController');
    ipcController.emitToUI('poller-status', { status: 'syncing' });

    const syncPayload = { devices: [] };

    // Parallel poll all devices — with per-device timeout so one slow device
    // can never block the whole sync cycle. Web scraping gets more time than
    // SNMP: a web UI with Layer2 crawl can take 60-90s, while SNMP offline
    // detection is fast. A device is ONLINE if EITHER succeeds.
    const WEB_TIMEOUT = 90000;   // web scrape incl. Layer2
    const SNMP_TIMEOUT = 25000;  // snmpy chain + node fallback
    const pollResults = await Promise.allSettled(devices.map(async (dev) => {
      try {
        const data = await Promise.race([
          this.readPrinterComprehensive(dev),
          new Promise((_, rej) => setTimeout(() => rej(new Error('DEVICE_TIMEOUT')), WEB_TIMEOUT)),
        ]);
        
        // ── Baseline management ──
        // initial_bw/initial_color = meter saat agent pertama diinstall (untuk hitung delta/pemakaian)
        // Jika sumber data berubah (SNMP → Web Scraper) dan nilainya jauh berbeda,
        // jangan biarkan delta jadi negatif gila. Re-baseline otomatis.
        const src = data.data_source || 'snmp';
        if (dev.initial_bw === undefined) {
          dev.initial_bw = data.bw_counter || 0;
          dev.initial_color = data.color_counter || 0;
          dev.baseline_source = src;
          console.log(`[Poller] ${dev.ip} initial baseline: BW=${dev.initial_bw} Color=${dev.initial_color} (${src})`);
        } else {
          const prevSrc = dev.baseline_source || 'snmp';
          const curBw = data.bw_counter || 0;
          const curColor = data.color_counter || 0;
          const deltaBw = curBw - (dev.initial_bw || 0);
          const deltaCol = curColor - (dev.initial_color || 0);
          const sourceChanged = prevSrc !== src;

          // Self-heal: if initial was zeroed by a transient failure, restore from
          // the first valid counter returned (counter > 0). No delta guard needed —
          // the initial was wrong (zeroed by bad poll), any real counter is better.
          if (dev.initial_bw === 0 && curBw > 100) {
            console.log(`[Poller] ${dev.ip} self-heal initial from 0 → ${curBw}/${curColor}`);
            dev.initial_bw = curBw;
            dev.initial_color = curColor;
            dev.baseline_source = src;
          } else if (curBw > 0 && curColor >= 0) {
            // Re-baseline only when BOTH counters are non-zero (real data, not transient 0)
            // and delta is deeply negative (stale/wrong-scale baseline).
            const drifted = deltaBw < -1000 || deltaCol < -1000;
            if (drifted) {
              console.log(`[Poller] ${dev.ip} re-baseline (${sourceChanged ? 'source ' + prevSrc + '→' + src : 'drift'} delta was ${deltaBw}/${deltaCol})`);
              dev.initial_bw = curBw;
              dev.initial_color = curColor;
              dev.baseline_source = src;
            }
          }
          dev.baseline_source = src;
        }

        dev._pendingData = data;
        dev._pendingSync = new Date().toISOString();

        if (data.merk) dev.merk = data.merk;
        if (data.model) dev.model = data.model;
        if (data.serial_number) dev.serial_number = data.serial_number;
        if (data.hostname) dev.hostname = data.hostname;
        if (data.location) dev.location = data.location;

        // Record new alerts as machine activity (fire-and-forget, deduped)
        this._recordAlertActivities(dev, data).catch(() => {});

        return {
          id: dev.id,
          ip: dev.ip,
          status: 'ONLINE',
          initial_bw: dev.initial_bw,
          initial_color: dev.initial_color,
          ...data
        };
      } catch (err) {
        console.log(`[Poller] ${dev.ip} OFFLINE: ${err.message}`);
        if (!String(err.message).includes('DEVICE_TIMEOUT')) {
          console.log(`   └─ stack: ${(err.stack || '').split('\n').slice(0, 3).join(' | ')}`);
        }
        // Grace period: if we have last good data (from a previous successful poll),
        // keep the device ONLINE with stale data instead of flapping OFFLINE.
        // Slow web devices (many Layer2 links) may exceed a poll timeout occasionally;
        // a single missed poll must not mark a working printer offline.
        const last = dev.last_data;
        if (last && (last.bw_counter > 0 || last.color_counter > 0 || (last.toner && last.toner.length > 0))) {
          console.log(`   └─ grace: keep ONLINE with last data (${last.bw_counter || 0}/${last.color_counter || 0})`);
          return {
            id: dev.id,
            ip: dev.ip,
            status: 'ONLINE',
            initial_bw: dev.initial_bw,
            initial_color: dev.initial_color,
            ...last,
          };
        }
        dev.status = 'OFFLINE';
        return { id: dev.id, ip: dev.ip, status: 'OFFLINE' };
      }
    }));

    for (const r of pollResults) {
      if (r.status === 'fulfilled') syncPayload.devices.push(r.value);
    }

    // DEBUG: log toner payload being sent to worker
    if (process.env.PP_DEBUG) {
      syncPayload.devices.forEach(d => {
        if (d.toner && d.toner.length) {
          console.log(`[Poller] SYNC toner ${d.ip}:`, d.toner.map(t => `${t.warna}=${t.level}${t.estimated ? '(est)' : ''}`).join(', '));
        }
      });
    }

    config.set('tracked_devices', devices);

    if (this.offlineQueue.length > 0) {
      syncPayload.devices = [...syncPayload.devices, ...this.offlineQueue];
    }

    // Always commit fresh poll data to last_data for UI (before API sync)
    var commitDevices = config.get('tracked_devices') || [];
    for (var ci = 0; ci < commitDevices.length; ci++) {
      var cd = commitDevices[ci];
      if (cd._pendingData) {
        cd.last_data = cd._pendingData;
        cd.last_sync = cd._pendingSync || new Date().toISOString();
        delete cd._pendingData;
        delete cd._pendingSync;
      }
    }
    config.set('tracked_devices', commitDevices);
    devices = commitDevices;

    // Update agent dashboard IMMEDIATELY with fresh poll data —
    // don't wait for API sync (which may be slow/failed/queued).
    // Sync still runs below and emits again on success.
    if (devices.length > 0) {
      ipcController.emitToUI('poller-data-updated', devices);
    }

    if (syncPayload.devices.length > 0) {
      try {
        const res = await api.syncPolledData(syncPayload);
        this.offlineQueue = [];
        
        if (res && Array.isArray(res.valid_device_ids)) {
          const currentDevices = config.get('tracked_devices') || [];
          const validSet = new Set(res.valid_device_ids.map(id => Number(id)));
          const updatedDevices = currentDevices.filter(d => validSet.has(Number(d.id)));
          
          if (updatedDevices.length !== currentDevices.length) {
            // Backend auto re-registers missing devices and returns old_id→new_id mapping
            var idMapping = res.id_mapping || {};
            var updatedDevicesNew = config.get('tracked_devices') || [];
            
            // Update local IDs using mapping so agent continues tracking with correct IDs
            for (var di = 0; di < updatedDevicesNew.length; di++) {
              var dd = updatedDevicesNew[di];
              var mapId = idMapping[Number(dd.id)];
              if (mapId) {
                dd.id = String(mapId);
              }
            }
            // Re-filter with new valid set
            var newValidSet = new Set(res.valid_device_ids.map(function(id) { return Number(id); }));
            var filtered = updatedDevicesNew.filter(function(d) { return newValidSet.has(Number(d.id)); });
            if (filtered.length !== updatedDevicesNew.length) {
              console.log('[Poller] Cleaned ' + (updatedDevicesNew.length - filtered.length) + ' orphaned devices.');
              config.set('tracked_devices', filtered);
            }
            devices = config.get('tracked_devices') || [];
          }
        }
        
        ipcController.emitToUI('poller-status', { status: 'success', time: new Date().toLocaleTimeString() });
        ipcController.emitToUI('poller-data-updated', devices);
      } catch (err) {
        console.warn('[Poller] API Sync Failed. Queue size: ' + this.offlineQueue.length);
        // Only queue latest, discard stale to prevent unbounded growth
        this.offlineQueue = syncPayload.devices;
        // Clean up pending data — don't show stale data in UI when offline
        var cleanup = config.get('tracked_devices') || [];
        for (var ci2 = 0; ci2 < cleanup.length; ci2++) {
          delete cleanup[ci2]._pendingData;
          delete cleanup[ci2]._pendingSync;
        }
        config.set('tracked_devices', cleanup);
        ipcController.emitToUI('poller-status', { status: 'offline_queued', time: new Date().toLocaleTimeString() });
      }
    }
  }

  /**
   * Read printer data — SNMP + Web Scraper PARALLEL
   * Both run concurrently. Web data overrides SNMP if it matches.
   * Data source indicator: 'web_scraper' | 'snmp' | 'mixed'
   */
  async readPrinterComprehensive(dev) {
    const ip = dev.ip;
    const snmpyOk = await this.snmpy.isAvailable();

    // ── Run SNMP probe and Web scraper in PARALLEL ──
    const snmpPromise = (async () => {
      if (snmpyOk) {
        // Strategy 1: Phased streaming probe
        try {
          return await this.readPrinterPhased(dev);
        } catch (e) {
          console.log(`[Poller] Phased probe failed for ${ip}: ${e.message}`);
        }
        // Strategy 2: deep probe
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const result = await this.snmpy.deepProbePrinter(ip, 'public', 4);
            if (result && result.vendor) return this.formatSnmpyResult(result);
          } catch (e) {
            if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
          }
        }
        // Strategy 3: standard probe
        try {
          const result = await this.snmpy.probePrinter(ip, 'public', 3);
          if (result) return this.formatSnmpyResult(result);
        } catch (e) {}
      }
      // Strategy 4: Node.js fallback
      return await this.readPrinterSNMP(dev);
    })();
    // Cap SNMP at 25s — a hung SNMP chain must never block a device whose web
    // UI works (HP 82/85 got marked OFFLINE because slow web + hung SNMP both
    // exceeded the old 45s race; web data was discarded).
    const snmpRaced = Promise.race([
      snmpPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('SNMP_TIMEOUT')), 25000)),
    ]).catch(() => null);

    // Web scraper: try all pages — anonymous first, then with creds
    const webPromise = (async () => {
      const web = await this.scrapeAllWebUI(ip, dev);
      return web; // { status, toner, trays, usage, detail }
    })();

    const [snmpResult, webResult] = await Promise.allSettled([snmpRaced, webPromise]);
    const snmpData = snmpResult.status === 'fulfilled' ? snmpResult.value : null;
    const webData = webResult.status === 'fulfilled' ? webResult.value : null;

    // ── Merge: web wins if data matches or is valid ──
    let result = snmpData || { ip, total_pages: 0, bw_counter: 0, color_counter: 0, toner: [], paper_trays: [] };

    if (webData && webData.status === 'ok') {
      // Web scraping succeeded (anonymous or with creds)
      if (webData.toner && webData.toner.length > 0) {
        // Web toner priority, BUT Layer-2-sourced toner is unreliable (may
        // mis-parse a page as toner, e.g. Ricoh WIM artifact 75/25/50/75).
        // Layer-2 toner only wins if it matches SNMP or SNMP has no toner.
        const snmpToner = snmpData && snmpData.toner ? snmpData.toner : [];
        const webTonerMap = {};
        webData.toner.forEach(t => { webTonerMap[t.warna] = t.level; });
        const snmpTonerMap = {};
        snmpToner.forEach(t => { if (t.warna) snmpTonerMap[t.warna] = t.level; });
        const match = Object.keys(webTonerMap).every(c => 
          snmpTonerMap[c] !== undefined && Math.abs(snmpTonerMap[c] - webTonerMap[c]) <= 15
        );
        const fromLayer2 = webData.toner_from_layer2 === true;
        const webWins = !fromLayer2 || match || snmpToner.length === 0;
        if (webWins) {
          result.toner = webData.toner;
          result.toner_match_snmp = match;
          result._dataSource = 'web_scraper';
          console.log(`   ✅ Web scraper toner WINS (${match ? 'MATCH SNMP' : 'web-realtime'}): ${webData.toner.map(t => t.warna + '=' + t.level + '%').join(', ')}`);
        } else {
          console.log(`   ⚠️ Web toner SKIPPED (Layer2 artifact, tidak match SNMP) — pertahankan SNMP: ${webData.toner.map(t => t.warna + '=' + t.level).join(', ')} vs SNMP ${snmpToner.map(t => t.warna + '=' + t.level).join(', ')}`);
        }
      }
      if (webData.trays && webData.trays.length > 0) {
        result.paper_trays = webData.trays;
        result._dataSource = result._dataSource || 'web_scraper';
      }
      if (webData.usage && Object.keys(webData.usage).length > 0) {
        result.usage_counters = webData.usage;
        result.usage_detail = webData.usage_detail || null;
        // Map usage counters → bw/color/total for ANY vendor (not just Xerox)
        const mapped = this.mapUsageCounters(webData.usage);
        if (mapped.total !== undefined) {
          result.total_pages = mapped.total;
          result.bw_counter = mapped.bw;
          result.color_counter = mapped.color;
          result._dataSource = 'web_scraper';
          result.vendor_counters_estimated = false;
        }
        console.log(`   ✅ Web usage: Total=${mapped.total} BW=${mapped.bw} Color=${mapped.color}`);
      }

      // Device info from web (serial, location, hostname, uptime, model)
      if (webData.deviceInfo && Object.keys(webData.deviceInfo).length > 0) {
        const di = webData.deviceInfo;
        if (di.serial_number) result.serial_number = di.serial_number;
        if (di.serial) result.serial_number = di.serial;
        if (di.location) result.location = di.location;
        if (di.hostname) result.hostname = di.hostname;
        if (di.model) result.model = di.model;
        if (di.merk || di.vendor) result.merk = di.merk || di.vendor;
        if (di.uptime) result.uptime = di.uptime;
        result._dataSource = result._dataSource || 'web_scraper';
      }

      // Alerts/status from web
      if (webData.alerts && webData.alerts.length > 0) {
        result.alerts = result.alerts || {};
        result.alerts.web = webData.alerts;
        result.alerts.critical = webData.alerts.filter(a => a.severity === 'critical' || a.severity >= 8).length;
        result.alerts.warnings = webData.alerts.filter(a => a.severity === 'warning' || (a.severity >= 4 && a.severity < 8)).length;
      }
      // Job log from web (Layer 2 full crawl)
      if (webData.jobs && webData.jobs.length > 0) {
        result.jobs = webData.jobs;
        result._dataSource = result._dataSource || 'web_scraper';
      }
      if (webData.statusText) {
        result.web_status = webData.statusText;
      }
    } else if (webData && webData.status === 'need_auth') {
      // Needs login — set flag, SNMP data stays
      result._needWebAuth = true;
      result._webAuthDetail = webData.detail;
      result._dataSource = 'snmp';
      console.log(`   ⚠️ ${webData.detail} (${ip})`);
    } else if (webData && webData.status === 'error') {
      // Web scraper failed (no web UI / timeout) — SNMP only
      result._dataSource = 'snmp';
      result._webError = webData.detail;
      console.log(`   ℹ️ Web scraper: ${webData.detail} (${ip})`);
    } else {
      result._dataSource = 'snmp';
    }

    // SNMP counter override (AMCS M1-M4) — only as fallback when web scraper FAILED
    // Web scraper data is ALWAYS prioritized (real-time from printer web UI)
    if (result._dataSource !== 'web_scraper') {
      result = await this.overrideVendorToner(ip, result, dev.merk || dev.vendor || (result.merk || ''));
    } else {
      // Web won — keep web counters, only fill gaps from SNMP toner
      console.log(`   ✅ Web scraper data prioritized for ${ip} (SKIP SNMP override)`);
    }

    // Add data source metadata for UI — distinguish toner source vs usage source.
    // A device can have web-scraped usage counters but SNMP toner (web UI needs login).
    result.data_source = result._dataSource || 'snmp';
    result.scraped_realtime = (result._dataSource === 'web_scraper');
    // toner_source: where the displayed toner levels came from.
    // Web is the priority — if web returned toner, toner came from web.
    const webTonerUsed = !!(webData && webData.status === 'ok' && webData.toner && webData.toner.length > 0);
    result.toner_source = webTonerUsed ? 'web' : 'snmp';
    if (!webTonerUsed && (result.toner || []).some(t => t.estimated)) {
      result.toner_source = 'snmp_estimated';
    }

    return result;
  }

  /**
   * Record new/changed machine alerts as device_activity (MONITORING).
   * Dedupe: dev._alertCache keeps {text: severity} of previously recorded alerts.
   * New alert (text not in cache) or severity increase → POST to /api/mesin/:id/activity.
   * When an alert clears (was in cache, gone now) → record a "clear" activity.
   */
  async _recordAlertActivities(dev, data) {
    if (!dev || !dev.id || !data || !data.alerts) return;
    const alerts = data.alerts;
    // Merge SNMP list + web alerts array (web scraper stores under alerts.web)
    let list = Array.isArray(alerts.list) ? alerts.list.slice() : [];
    if (Array.isArray(alerts.web)) list = list.concat(alerts.web);
    if (!Array.isArray(alerts) && list.length === 0) list = Array.isArray(alerts) ? alerts : [];
    if (!list.length && !dev._alertCache) return;

    // Normalize cache: {textKey: severity}
    const prevCache = dev._alertCache || {};
    const newCache = {};
    const newAlerts = [];
    const clearedAlerts = [];

    list.forEach(a => {
      const text = (a.text || a.message || a.detail || '').trim();
      if (!text) return;
      const sev = typeof a.severity === 'number' ? a.severity : (a.severity === 'critical' ? 10 : a.severity === 'warning' ? 6 : a.severity === 'info' ? 2 : 0);
      const key = text.toLowerCase().slice(0, 120);
      newCache[key] = sev;
      const prev = prevCache[key];
      if (prev === undefined) {
        newAlerts.push({ text, severity: sev });
      } else if (sev > prev) {
        newAlerts.push({ text: text + ' (severity ↑)', severity: sev });
      }
    });

    // Cleared alerts: in prev but not in new
    for (const key of Object.keys(prevCache)) {
      if (newCache[key] === undefined) {
        // Find original text — store it alongside cache for readability
        const orig = (dev._alertTextCache && dev._alertTextCache[key]) || key;
        clearedAlerts.push({ text: orig, severity: prevCache[key] });
      }
    }

    // Store caches
    dev._alertCache = newCache;
    const textCache = {};
    list.forEach(a => {
      const text = (a.text || a.message || a.detail || '').trim();
      if (!text) return;
      textCache[text.toLowerCase().slice(0, 120)] = text;
    });
    dev._alertTextCache = textCache;

    // Don't record anything on very first poll (baseline) — avoids spam for pre-existing alerts
    if (!dev._alertSeeded) {
      dev._alertSeeded = true;
      return;
    }

    const now = new Date().toISOString();
    const teknisi = null;
    const payloads = [];

    newAlerts.forEach(a => {
      payloads.push({
        activity_type: 'MONITORING',
        status: 'PROSES',
        deskripsi: `⚠️ Alert: ${a.text} (severity ${a.severity})`,
        teknisi,
        tgl_aktivitas: now,
      });
    });
    clearedAlerts.forEach(a => {
      payloads.push({
        activity_type: 'MONITORING',
        status: 'SELESAI',
        deskripsi: `✅ Alert clear: ${a.text}`,
        teknisi,
        tgl_aktivitas: now,
      });
    });

    // Post all — fire and forget (system endpoint bypasses PIC view-only gate)
    for (const p of payloads) {
      try {
        await api.logDeviceActivity({ ...p, mesin_id: dev.id });
        console.log(`   [Alert→Activity] ${dev.ip}: ${p.deskripsi}`);
      } catch (err) {
        // Rate-limit: back off silently; next poll retries
        console.warn(`   [Alert→Activity] Gagal catat untuk ${dev.ip}: ${err.message || err}`);
      }
    }
  }

  /**
   * Phased streaming probe — NDJSON progressive data via streamProbe()
   * Emits IPC event per phase for real-time UI updates
   */
  async readPrinterPhased(dev) {
    const ip = dev.ip;
    const phases = {};
    
    if (!ipcController) ipcController = require('../controllers/ipcController');
    
    for await (const phase of this.snmpy.streamProbe(ip, 'public', 8)) {
      phases[phase.phase] = phase;
      
      if (phase.phase === 'identity') {
        if (phase.is_printer === false) throw new Error(`${ip} not a printer`);
        if (phase.error) throw new Error(`${ip}: ${phase.error}`);
      }
      
      if (ipcController && phase.phase !== 'complete') {
        ipcController.emitToUI('poller-phase', {
          deviceId: dev.id, ip, phase: phase.phase, data: phase,
        });
      }
    }
    
    if (!phases.identity) throw new Error(`${ip} unreachable (no identity phase)`);
    return this.buildPhasedPayload(phases, ip);
  }

  /**
   * Build poller payload from accumulated phased probe data
   */
  buildPhasedPayload(phases, ip) {
    const idPhase = phases.identity || {};
    let cntPhase = phases.counters || {};
    const supPhase = phases.supplies || { toners: [], waste: [] };
    const detPhase = phases.detail || { trays: [], alerts: [], jobs: [] };
    
    // Estimate 70/30 BW/Color when single marker + color toner present
    let bwVal = cntPhase.bw || 0;
    let colorVal = cntPhase.color || 0;
    if (bwVal > 0 && colorVal === 0 && (cntPhase.markers === 1)) {
      const hasColorToner = (supPhase.toners || []).some(t => {
        const d = (t.desc || '').toLowerCase();
        return d.includes('cyan') || d.includes('magenta') || d.includes('yellow');
      });
      if (hasColorToner) {
        const total = bwVal + colorVal;
        bwVal = Math.round(total * 0.7);
        colorVal = total - bwVal;
      }
    }
    
    // Build toner list — pass source info for estimation logic downstream
    // Guard: ignore pct outside 0-100 (HP inkjet pages-remaining like 3603/32700)
    const rawToner = (supPhase.toners || []).map(t => {
      const raw = t.pct;
      const validPct = (raw !== null && raw !== undefined && raw >= 0 && raw <= 100) ? raw : -2;
      return {
        warna: normalizeTonerWarna(t.desc || ''),
        level: validPct,
        level_sekarang: validPct,
        updated_at: new Date().toISOString(),
        estimated: (t.source === 'synthetic'),
        estimated_from: t.source === 'synthetic' ? 'Auto-created (no supply table)' : null,
      };
    });
    // Reorder to [BLACK, CYAN, MAGENTA, YELLOW] — printers may return in different order
    const COLOR_ORDER = ['BLACK','CYAN','MAGENTA','YELLOW'];
    const toner = COLOR_ORDER.map(c => rawToner.find(t => t.warna === c) || 
      rawToner.find(t => t.warna.includes(c)) || null).filter(Boolean);
    if (process.env.PP_DEBUG) {
      console.log(`[Poller] phased raw toner (${idPhase.vendor || '?'}):`, toner.map(t => `${t.warna}=${t.level} src=${(t.estimated_from||'')}`).join(' | '));
    }
    // For synthetic toners: mark all as estimated so JS estimation engine fills real %
    // For prtMediumTable: real data but may need page-count refinement
    // estimateTonerLevels in snmpy-bridge will replace estimated ones

    // ── Estimate non-original/unknown chips (-2) from page counts ──
    // Non-original chips return level -2 (no digital %). Estimate from
    // page counts ÷ yield, so worker/frontend gets a REAL number instead
    // of a stale 0/100. Matches the UI-side estimator.
    const hasUnknown = toner.some(t => t.level === -2);
    const totalPages = bwVal + colorVal;
    if (hasUnknown && (bwVal > 0 || colorVal > 0 || totalPages > 0)) {
      const vendor = (idPhase.vendor || '').toLowerCase();
      const model = (idPhase.model || '').toLowerCase();
      const yields = this._yieldProfiles || {};
      let profile = yields[vendor] || { black: 8000, color: 5000 };
      for (const [key, val] of Object.entries(yields)) {
        if (key.startsWith(vendor + ':') && model.includes(key.split(':')[1])) { profile = val; break; }
      }
      const colorCount = toner.filter(t => !['BLACK','K','BK','NEGRO'].includes((t.warna||'').toUpperCase())).length || 1;
      const perColor = colorCount > 0 ? Math.round(colorVal / colorCount) : colorVal;
      toner.forEach(t => {
        if (t.level !== -2) return;
        const isBlack = ['BLACK','K','BK','NEGRO'].includes((t.warna||'').toUpperCase());
        let estPct = null, note = '';
        if (isBlack && bwVal > 0 && profile.black > 0) {
          estPct = Math.max(0, Math.min(100, Math.round(100 - (bwVal / profile.black) * 100)));
          note = `Est. BW pages (${bwVal}/${profile.black})`;
        } else if (!isBlack && perColor > 0 && profile.color > 0) {
          estPct = Math.max(0, Math.min(100, Math.round(100 - (perColor / profile.color) * 100)));
          note = `Est. color ÷${colorCount} (${perColor}/${profile.color})`;
        } else if (totalPages > 0) {
          // Fallback: total pages split across toners
          const perToner = Math.round(totalPages / Math.max(toner.length, 1));
          const cap = (profile.black || 8000);
          estPct = Math.max(0, Math.min(100, Math.round(100 - (perToner / cap) * 100)));
          note = `Est. total ÷${toner.length} (${perToner}/${cap})`;
        }
        if (estPct !== null) {
          t.level = estPct;
          t.level_sekarang = estPct;
          t.estimated = true;
          t.estimated_from = note;
        }
      });
    }
    
    const waste = (supPhase.waste || []).map(w => ({
      description: w.desc || '',
      percentage: w.pct,
      status: w.pct !== null ? (w.pct > 85 ? 'Full' : 'OK') : 'Unknown',
      source: w.source || null,
    }));
    
    const trays = (detPhase.trays || []).map(t => ({
      index: t.idx,
      name: t.name || t.media || 'Unknown',
      media_name: t.media_name || null,
      sheets: t.sheets,
      max_capacity: t.max || null,
      dims: t.dims || null,
      size: t.size || null,
      weight: t.weight || null,
      color: t.color || null,
    }));
    
    const alertsList = detPhase.alerts || [];
    const critical = alertsList.filter(a => a.severity >= 8).length;
    const warnings = alertsList.filter(a => a.severity >= 4 && a.severity < 8).length;
    
    let uptimeStr = '';
    if (idPhase.uptime_ticks) uptimeStr = this.snmpy.formatUptime(idPhase.uptime_ticks);
    
    return {
      bw_counter: bwVal,
      color_counter: colorVal,
      total_pages: bwVal + colorVal,
      toner,
      waste_toner: waste,
      paper_trays: trays,
      alerts: { critical, warnings, list: alertsList },
      uptime: uptimeStr,
      serial: idPhase.serial || '',
      serial_number: idPhase.serial || '',
      hostname: idPhase.hostname || ip,
      location: idPhase.location || '',
      merk: idPhase.vendor || null,
      model: idPhase.model || null,
      ip_address: idPhase.ip || ip,
      scan_time: new Date().toISOString(),
      counter_source: 'snmpy_phased',
      vendor_counters_estimated: false,
    };
  }

  /**
   * Format snmpy result → poller format
   * Handles unified (toner_levels) and deep (supplies.toners) output
   */
  formatSnmpyResult(result) {
    let bw = result.total_bw || 0;
    let color = result.total_color || 0;
    // Single-total printers (e.g. Epson WF-C5790) report only a lifetime total
    // with no BW/color split (counter_source 'total_only'). Split 70/30 so the
    // monthly baseline stays consistent with buildPhasedPayload's split — otherwise
    // one poll stores the split and the next stores the raw total, corrupting the
    // monthly delta (bw jumps +30%, color goes negative).
    if (bw > 0 && color === 0 && result.counter_source === 'total_only') {
      const total = bw;
      bw = Math.round(total * 0.7);
      color = total - bw;
    }
    
    // Toner: from unified (toner_levels) or deep (supplies.toners)
    // Guard: ignore pct outside 0-100 (HP inkjet pages-remaining like 3603/32700)
    const tonerItems = result.toner_levels || (result.supplies && result.supplies.toners) || [];
    const isSynthetic = result.supplies && result.supplies.synthetic;
    const rawToner = tonerItems.map(t => {
      const raw = t.percentage;
      const validPct = (raw !== null && raw !== undefined && raw >= 0 && raw <= 100) ? raw : -2;
      return {
        warna: normalizeTonerWarna(t.color || t.description || ''),
        level: validPct,
        level_sekarang: validPct,
        updated_at: new Date().toISOString(),
        estimated: t.estimated || isSynthetic || (t.source === 'synthetic') || false,
        estimated_from: t.estimated_from || (t.source === 'synthetic' ? 'Auto-created (no supply table)' : null),
      };
    });
    // Reorder to [BLACK, CYAN, MAGENTA, YELLOW]
    const COLOR_ORDER = ['BLACK','CYAN','MAGENTA','YELLOW'];
    const toner = COLOR_ORDER.map(c => rawToner.find(t => t.warna === c) || 
      rawToner.find(t => t.warna.includes(c)) || null).filter(Boolean);
    // Waste: ensure source passthrough
    const wasteItems = result.waste_toner || (result.supplies && result.supplies.waste) || [];
    const wasteMapped = wasteItems.map(w => ({
      description: w.description || w.desc || 'Waste',
      percentage: w.pct !== undefined ? w.pct : w.percentage,
      status: (w.pct !== null && w.pct !== undefined) ? (w.pct > 85 ? 'Full' : 'OK') : 'Unknown',
      source: w.source || null,
    }));
    
    // Toner estimation from page counts (matches snmpy-bridge estimateTonerLevels)
    const estBw = result.total_bw || 0;
    const estColor = result.total_color || 0;
    const estTotal = result.total_pages || (estBw + estColor);
    
    // Build complete payload with ALL fields
    const payload = {
      bw_counter: bw,
      color_counter: color,
      total_pages: result.total_pages || (bw + color),
      toner,
      waste_toner: wasteMapped,
      paper_trays: result.paper_trays || (result.details?.paper_trays) || [],
      alerts: { critical: result.critical_alerts || 0, warnings: result.warnings || 0, list: (result.alerts || []).slice(0, 20) },
      uptime: result.uptime || '',
      serial: result.serial || result.serial_number || '',
      serial_number: result.serial || result.serial_number || '',
      hostname: result.hostname || '',
      location: result.location || '',
      merk: result.merk || result.vendor || result.details?.device_info?.vendor || null,
      model: result.model || null,
      ip_address: result.ip || result.ip_address || null,
      scan_time: result.scan_time || new Date().toISOString(),
      // Estimation metadata (for transparency)
      counter_source: result.counter_source || 'snmpy',
      vendor_counters_estimated: result.vendor_counters_estimated || false,
      raw_oids_summary: result.raw_oids_summary || null,
    };

    // Include raw_oids walk_stats when available (deep probe)
    if (result.raw_oids) {
      payload.raw_oids_summary = Object.keys(result.raw_oids).reduce(function(a, k) {
        a[k] = Object.keys(result.raw_oids[k] || {}).length;
        return a;
      }, {});
    }

    return payload;
  }

  // ===================================================================
  // VENDOR TONER OVERRIDE — direct GET from enterprise OIDs
  // More accurate than standard MIB supplies walk for most vendors
  // ===================================================================

  /**
   * Override toner levels AND counters in poll result with direct GET from AMCS enterprise OIDs
   * Mirrors AMCS GetSNMP1-9 pattern: M1-M4 direct GET, toner direct GET
   */
  async overrideVendorToner(ip, pollResult, vendorHint) {
    if (!pollResult) return pollResult;
    const v = (vendorHint || pollResult.merk || '').toLowerCase();
    if (!v) return pollResult;

    // Find matching OID profile for this vendor
    const profile = this._matchOidProfile(v, pollResult.model || '');
    if (!profile) return pollResult;

    // ── M1-M4 counter override (AMCS-style direct GET for totals) ──
    const mOids = ['oid_m1','oid_m2','oid_m3','oid_m4'].map(k => profile[k]).filter(Boolean);
    if (mOids.length > 0) {
      try {
        const mResults = await this.snmpGetWithFallback(ip, mOids);
        const mVal = mResults.map(r => (r && r.value !== null) ? parseInt(r.value) : null);
        const validM = mVal.filter(v => v !== null && !isNaN(v) && v > 0);
        if (validM.length >= 1) {
          const mTotal = validM.reduce((a, b) => a + b, 0);
          const labels = profile.amcs_labels || ['M1','M2','M3','M4'];
          // Log what we got
          console.log(`   AMCS M1-M4 override: ${mVal.map((v, i) => `${labels[i]||'M'+(i+1)}=${v}`).join(', ')} (total=${mTotal})`);
          // M1 = main total counter. ONLY override total_pages as a sanity check.
          // DO NOT touch bw_counter/color_counter — those come from probe/web scraper
          // which has correct BW/Color split. Overwriting them with M1 as BW
          // kills color split for color MFPs (Ricoh, Xerox color, Canon color).
          const m1 = mVal[0] || 0;
          // Only set total if existing total is 0 or wildly different (sanity)
          const existingTotal = pollResult.total_pages || 0;
          if (existingTotal === 0 || Math.abs(existingTotal - m1) > (existingTotal * 0.5)) {
            console.log(`   AMCS M1-M4: total sanity check ${existingTotal}→${m1}`);
          }
          // Preserve BW/Color split: adjust proportionally if totals differ significantly
          // but never zero out color
          const keepSplit = (pollResult.bw_counter || 0) + (pollResult.color_counter || 0);
          if (keepSplit > 0 && m1 > 0) {
            // Normalize existing split to M1 total, preserving ratio
            const ratio = m1 / keepSplit;
            pollResult.bw_counter = Math.round((pollResult.bw_counter || 0) * ratio);
            pollResult.color_counter = Math.round((pollResult.color_counter || 0) * ratio);
            pollResult.total_pages = m1;
            console.log(`   AMCS M1-M4: normalized split BW=${pollResult.bw_counter} Color=${pollResult.color_counter} (total=${m1})`);
          } else {
            // No split data — use M1 as total, keep color 0
            pollResult.total_pages = m1;
            pollResult.bw_counter = m1;
            pollResult.color_counter = pollResult.color_counter || 0;
          }
          pollResult.counter_source = pollResult.counter_source || 'amcs_m1m4_direct';
          pollResult.vendor_counters_estimated = false;
          // Attach M1-M4 raw for downstream use
          pollResult.m1m4_raw = mVal;
          pollResult.m1m4_labels = labels;

          // ── Map M1-M4 to per-function usage_detail (Xerox etc.) ──
          // Labels convention: M1:Total, M2:Copy, M3:Print, M4:Fax (Xerox).
          // Provide print/copy/fax breakdown when M1-M4 available.
          if (!pollResult.usage_detail && mVal.length >= 4) {
            const mk = (s) => { const v = mVal[s]; return (v !== null && !isNaN(v) && v > 0) ? v : 0; };
            const m2 = mk(1), m3 = mk(2), m4 = mk(3); // copy, print, fax (Xerox order)
            const fnTotal = m2 + m3 + m4;
            // Color split unknown from M1-M4 alone — allocate proportionally to
            // existing color counter if available, else all black.
            const colorTotal = pollResult.color_counter || 0;
            const bwTotal = pollResult.bw_counter || 0;
            const grand = bwTotal + colorTotal;
            const colorShare = (fnTotal > 0 && grand > 0) ? colorTotal / grand : 0;
            const f = (v) => ({
              bw: Math.round(v * (1 - colorShare)),
              color: Math.round(v * colorShare),
            });
            pollResult.usage_detail = {
              print: f(m3), copy: f(m2), fax: f(m4),
              source: 'amcs_m1m4',
            };
            console.log(`   AMCS M1-M4 → usage_detail: print=${m3} copy=${m2} fax=${m4} (src=amcs_m1m4)`);
          }
        }
      } catch (e) {
        console.log(`   AMCS M1-M4 override failed for ${ip}: ${e.message}`);
      }
    }

    // ── Toner override from enterprise OIDs ──
    if (!pollResult.toner) return pollResult;
    if (!profile.oid_toner_black && !profile.oid_toner_cyan && !profile.oid_toner_magenta && !profile.oid_toner_yellow) {
      return pollResult;
    }

    try {
      const tonerOids = [
        profile.oid_toner_black, profile.oid_toner_cyan,
        profile.oid_toner_magenta, profile.oid_toner_yellow,
      ].filter(Boolean);

      if (tonerOids.length === 0) return pollResult;

      const results = await this.snmpGetWithFallback(ip, tonerOids);
      const colors = ['BLACK', 'CYAN', 'MAGENTA', 'YELLOW'];
      let overridden = false;

      tonerOids.forEach((oid, idx) => {
        const vb = results.find(r => r.oid === oid);
        if (vb && vb.value !== null && parseInt(vb.value) >= 0) {
          const val = parseInt(vb.value);
          // HP inkjet/PageWide OIDs return "approximate pages remaining"
          // (e.g. 3603, 20800, 32700) — NOT a percentage. Only accept 0-100.
          if (val > 100) return;
          // Match by POSITION (index), not by warna string — normalizeTonerWarna unreliable
          const target = pollResult.toner[idx];
          if (target) {
            // Non-original chips (estimated) already have a page-count estimate.
            // OID may return a misleading 100/full value — do NOT clobber the estimate.
            if (target.estimated === true || target.estimated === 1) return;
            target.warna = colors[idx];        // Fix the color name
            target.level = val;
            target.level_sekarang = val;
            target.estimated = false;
            target.estimated_from = null;
            overridden = true;
          }
        }
      });

      if (overridden) console.log(`   Vendor toner override applied for ${v} (${ip})`);
    } catch (e) {
      // Silently fallback
    }

    return pollResult;
  }

  /**
   * Match OID profile by vendor
   */
  _matchOidProfile(vendor, model) {
    if (!vendor) return OID_PROFILES.find(p => p.merk === 'Unknown');
    const vendorLower = vendor.toLowerCase();
    const modelUpper = (model || '').toUpperCase();
    const profiles = OID_PROFILES.filter(p => p.merk.toLowerCase() === vendorLower);
    if (profiles.length === 0) {
      const alt = { konicaminolta:'Konica Minolta', fujixerox:'Fuji Xerox' }[vendorLower];
      if (alt) {
        const altProfiles = OID_PROFILES.filter(p => p.merk.toLowerCase() === alt.toLowerCase());
        if (altProfiles.length) {
          return altProfiles.find(p => p.pattern === '*') || altProfiles[0];
        }
      }
      return OID_PROFILES.find(p => p.merk === 'Unknown');
    }
    // Best match: specific pattern then generic
    const specific = profiles.find(p => p.pattern !== '*' && modelUpper.includes(p.pattern.toUpperCase()));
    return specific || profiles.find(p => p.pattern === '*');
  }

  // ===================================================================
  // WEB UI SCRAPING — Universal, all vendors
  // Reference: AMCS cConsumable.cs — scrapes stsply.htm with credentials
  // Strategy: try anonymous first → if 401/403 → need credentials → fallback SNMP
  // ===================================================================

  /**
   * Universal web scraping — tries anonymous first, then with credentials
   * Returns: { status: 'ok'|'need_auth'|'error', toner:[], detail:'' }
   */
  async scrapeWebUI(ip, dev) {
    const ssl = (dev && dev.web_ssl) || false;
    const protocol = ssl ? 'https' : 'http';
    const username = (dev && dev.web_username) || '';
    const password = (dev && dev.web_password) || '';

    // Step 1: Try anonymous first
    const anonResult = await this._httpFetch(protocol, ip, 'stsply.htm', null);
    if (anonResult.status === 'ok') return anonResult;

    // Step 2: If we have credentials, try with Basic Auth
    if (username) {
      const authStr = Buffer.from(username + ':' + password).toString('base64');
      const authResult = await this._httpFetch(protocol, ip, 'stsply.htm', authStr);
      if (authResult.status === 'ok') return authResult;
      // Auth failed too — return error with detail
      return { status: 'error', toner: [], detail: `Login gagal (${anonResult.detail || authResult.detail})` };
    }

    // Step 3: No credentials, anonymous failed with 401/403
    return { status: 'need_auth', toner: [], detail: anonResult.detail || 'Perlu login' };
  }

  /**
   * UNIFIED web scraper — all vendors, all pages, parallel-friendly
   * Vendor-specific EWS paths from research (munin, pysyncthru, WhatWeb, AMCS decompile)
   * Returns: { status, toner, trays, usage, detail }
   */
  async scrapeAllWebUI(ip, dev) {
    const ssl = (dev && dev.web_ssl) || false;
    let protocol = ssl ? 'https' : 'http';
    const username = (dev && dev.web_username) || '';
    const password = (dev && dev.web_password) || '';
    const authHeader = username ? Buffer.from(username + ':' + password).toString('base64') : null;
    const vend = ((dev && dev.merk) || '').toLowerCase();
    console.log(`   [scrapeAllWebUI] ${ip} vend='${vend}' user='${username ? 'yes' : 'no'}'`);

    // ── Vendor-specific EWS paths (researched) ──
    const PAGES = {
      toner: [
        // Xerox
        'stsply.htm', 'sttnr.htm', 'stdrm.htm', 'status/Supplies.html',
        // HP
        '/hp/device/DeviceStatus/Index', '/hp/device/InternalPages/Index?id=SuppliesStatus',
        '/hp/device/Consumables/Index', '/hp/device/SuppliesStatus/Index',
        '/SSI/supply_status_info.htm',
        // Canon
        '/html/consumables.html', '/html/consumables.html?lang=en',
        // Ricoh
        '/web/guest/en/websys/status/consumables.cgi',
        // Brother
        '/general/consumables.html',
        // Toshiba
        ':8080/TopAccess/Supplies/Status/List.htm', '/cgi-bin/consumables.cgi',
        // Samsung
        '/sws/app/information/home/home.json', '/Information/supplies_status.htm',
        // Konica Minolta / Kyocera
        '/wcd/top.xml', '/wcd/supplies.xml',
        // Sharp / Lexmark
        '/gateway.htm', '/cgi-bin/pts_w.cgi', '/status/index.htm', '/cgi-bin/dynamic/status.htm',
      ],
      tray: [
        'sttray.htm', 'trays.htm', 'input.htm', 'media.htm', 'paper.htm',
        '/hp/device/Trays/Index', '/hp/device/PaperHandling/Index',
        '/general/tray.html', '/wcd/trayinfo.xml', ':8080/TopAccess/Trays/Status/List.htm',
        '/cgi-bin/tray.cgi', '/sws/app/information/trays/trays.json',
      ],
      usage: [
        // Ricoh WIM (verified working — counter split by color)
        '/web/guest/en/websys/status/getUnificationCounter.cgi',
        'prcnt.htm', 'usage.htm', 'counters.htm', 'billing.htm', 'meter.htm',
        'pagecount.htm', 'usagecounters.htm', 'timecnt.htm',
        '/hp/device/InternalPages/Index?id=UsagePage',
        '/hp/device/Usage/Index', '/hp/device/UsageReport/Index', '/hp/device/PageUsage/Index',
        '/general/usage.html', '/wcd/counter.xml', '/cgi-bin/counter.cgi',
        ':8080/TopAccess/Counter/TotalCount/List.htm',
        '/sws/app/information/counters/counters.json',
      ],
      status: [
        'stgen.htm', '/hp/device/DeviceStatus/Index', '/general/status.html',
        '/wcd/status.xml', '/wcd/deviceinfo.xml', '/wcd/top.xml',
        '/sws/app/information/home/home.json', '/cgi-bin/status.cgi',
      ],
      alert: [
        '/general/alerts.html', '/wcd/alertinfo.xml', '/hp/device/InternalPages/Index?id=Alerts',
        '/sws/app/information/home/home.json',
      ],
    };

    // Per-vendor priority: test likely vendor pages FIRST for speed
    const vendorFirst = {
      xerox: ['stsply.htm', 'sttray.htm', 'prcnt.htm', 'stgen.htm'],
      hp: ['/hp/device/DeviceStatus/Index', '/hp/device/InternalPages/Index?id=SuppliesStatus', '/SSI/supply_status_info.htm'],
      canon: ['/html/consumables.html'],
      ricoh: ['/web/guest/en/websys/status/getUnificationCounter.cgi', '/web/guest/en/websys/status/consumables.cgi', '/web/guest/en/websys/status/configuration.cgi'],
      brother: ['/general/consumables.html', '/general/status.html'],
      toshiba: [':8080/TopAccess/Counter/TotalCount/List.htm'],
      samsung: ['/sws/app/information/home/home.json'],
      konicaminolta: ['/wcd/top.xml'],
      kyocera: ['/wcd/top.xml'],
      sharp: ['/gateway.htm'],
    };

    const result = { status: 'need_auth', toner: [], trays: [], usage: {}, detail: '' };
    let gotAny = false;

    // Build ordered page list: vendor-specific first, then generic
    const orderedPages = (category) => {
      const vp = vendorFirst[vend] || [];
      const catPages = PAGES[category] || [];
      const ordered = [];
      for (const p of vp) {
        if (!ordered.includes(p) && catPages.some(cp => cp === p || cp.endsWith(p) || p.endsWith(cp))) ordered.push(p);
      }
      for (const p of catPages) {
        if (!ordered.includes(p)) ordered.push(p);
      }
      return ordered;
    };

    const tryPages = async (pages, fetchFn) => {
      // Fetch all candidate pages of this category IN PARALLEL — first success wins.
      // Sequential probing made slow web UIs exceed the poll timeout (HP 82/85 got
      // marked OFFLINE despite working web). Promise.any resolves on first success;
      // all-fail falls back to null.
      const attempts = [];
      for (const proto of ['http', 'https']) {
        for (const page of pages) {
          let port = null;
          let path = page;
          if (page.startsWith(':8080')) { port = 8080; path = page.slice(5); }
          attempts.push((async () => {
            const r = await this._httpFetchRaw(proto, ip, path, authHeader, 0, port);
            if (r.status !== 'ok') throw new Error('not-ok');
            const data = fetchFn(r.html, page);
            if (data && (Array.isArray(data) ? data.length > 0 : Object.keys(data).length > 0)) return data;
            throw new Error('empty');
          })());
        }
      }
      // Promise.any — first fulfilled wins; all rejected → null
      if (attempts.length === 0) return null;
      try {
        return await Promise.any(attempts);
      } catch {
        return null;
      }
    };

    // Toner pages — try vendor-first ordering
    const tonerHtml = await tryPages(orderedPages('toner'), (h, page) => {
      // Samsung JSON
      if (page.includes('.json') || h.trim().startsWith('{')) {
        return this.parseSamsungJson(h);
      }
      return this.parseConsumableHTML(h);
    });
    if (tonerHtml && tonerHtml.toner && tonerHtml.toner.length > 0) {
      result.toner = tonerHtml.toner;
      result.status = 'ok';
      gotAny = true;
    }

    // Tray pages
    const trayHtml = await tryPages(orderedPages('tray'), (h, page) => {
      if (page.includes('.json') || h.trim().startsWith('{')) return this.parseSamsungTrays(h);
      return this.parseTrayHTML(h);
    });
    if (trayHtml && trayHtml.length > 0) {
      result.trays = trayHtml.map(t => ({
        index: t.name ? t.name.replace(/\D/g, '') || t.name : t.index || '',
        name: t.name || ('Tray ' + (t.index || '')),
        media_name: t.media_name || `${t.paperSize || ''} ${t.paperType || ''}`.trim(),
        sheets: t.percentage !== null ? Math.round(t.percentage) : (t.sheets || null),
        percentage: t.percentage,
        status: t.status,
      }));
      gotAny = true;
    }

    // Usage counter pages
    let usageDetail = null;
    const usageHtml = await tryPages(orderedPages('usage'), (h, page) => {
      if (page.includes('.json') || h.trim().startsWith('{')) return this.parseSamsungCounters(h);
      // Ricoh WIM counter page — HTML table with Full Color / Black & White rows
      if (page.includes('getUnificationCounter') || h.includes('Full Color') || h.includes('Black &amp; White')) {
        const r = this.parseRicohCounters(h);
        if (r.usage && Object.keys(r.usage).length) {
          usageDetail = r.detail;
          return r.usage;
        }
        return {};
      }
      // HP EWS UsagePage — Equivalent Impressions (weighted billing units)
      if (h.includes('EquivalentImpressions')) {
        const r = this.parseHPUsageCounters(h);
        if (r.usage && Object.keys(r.usage).length) {
          usageDetail = r.detail;
          return r.usage;
        }
        return {};
      }
      return this.parseUsageCountersHTML(h);
    });
    if (usageHtml && Object.keys(usageHtml).length > 0) {
      result.usage = usageHtml;
      result.usage_detail = usageDetail;
      gotAny = true;
    }

    // Universal per-function detail — ALL vendors get usage_detail, so monthly
    // breakdown (print/copy/fax/scan BW+Color) works for every machine.
    // Priority: vendor parser detail (Ricoh/HP) > counter-derived (Samsung/
    // Xerox print+copy+scan) > aggregate-to-print (everything else).
    if (!result.usage_detail) {
      const u = result.usage || {};
      const pick = (keys) => {
        for (const k of keys) {
          for (const [label, val] of Object.entries(u)) {
            if (label.toLowerCase().includes(k)) return Number(val) || 0;
          }
        }
        return 0;
      };
      const tPrint = pick(['total printed', 'total print', 'print impressions', 'total impressions']);
      const tCopy = pick(['total copied', 'total copy', 'copy impressions']);
      const tScan = pick(['total scanned', 'scan images', 'scanned images', 'total scan']);
      const tFax = pick(['total fax']);
      // Aggregate counters are the source of truth for total BW/color.
      // Inside scrapeAllWebUI result.bw_counter isn't set yet — read from usage
      // counters directly (Black/Color Printed Impressions), fallback result fields.
      const aggBw = pick(['black printed', 'black impressions', 'black copy', 'black'])
        || (result.bw_counter || result.total_bw || 0);
      const aggColor = pick(['color printed', 'color impressions', 'color copy', 'color'])
        || (result.color_counter || result.total_color || 0);
      const aggTotal = aggBw + aggColor;
      // Only distribute across functions when their sum is CONSISTENT with the
      // aggregate (within 10%). Some vendors (Xerox) label the total machine
      // counter "Total Printed Impressions" — using it as "print" double-counts
      // (print+copy > real total). In that case, attribute everything to print.
      const fnTotal = tPrint + tCopy + tFax;
      const consistent = aggTotal > 0 && fnTotal > 0 && fnTotal <= aggTotal * 1.1 && fnTotal >= aggTotal * 0.9;
      if (consistent) {
        // Distribute aggregate BW/color across functions proportionally
        const bwShare = aggBw / aggTotal;
        const fnSplit = (fn) => {
          const tot = Math.round(fn);
          return { bw: Math.round(tot * bwShare), color: tot - Math.round(tot * bwShare) };
        };
        result.usage_detail = {
          print: fnSplit(tPrint),
          copy: fnSplit(tCopy),
          fax: fnSplit(tFax),
          scan: { count: tScan },
          source: 'usage_fallback',
        };
        console.log(`   ✅ usage_detail fallback (distributed, ${result.ip || ''}): print=${fnSplit(tPrint).bw}/${fnSplit(tPrint).color} copy=${fnSplit(tCopy).bw}/${fnSplit(tCopy).color} src=usage_fallback`);
      } else if (aggTotal > 0) {
        // Not consistent → all usage is print (aggregate BW/color). Honest, no
        // double-count, and monthly print delta = aggregate delta.
        result.usage_detail = {
          print: { bw: aggBw, color: aggColor },
          copy: { bw: 0, color: 0 },
          fax: { bw: 0, color: 0 },
          scan: { count: tScan },
          source: 'usage_fallback',
        };
        console.log(`   ✅ usage_detail fallback (all-to-print, ${result.ip || ''}): print=${aggBw}/${aggColor} src=usage_fallback`);
      }
    }

    // Status pages
    const statusHtml = await tryPages(orderedPages('status'), (h) => {
      // Reuse consumable parser for device status (HP)
      const t = this.parseConsumableHTML(h);
      if (t && t.toner.length > 0) { result.toner = t.toner; gotAny = true; }
      return t;
    });

    // Device info pages — extract serial, location, uptime, status
    const devPages = ['stgen.htm', '/hp/device/DeviceStatus/Index', '/general/status.html',
      '/wcd/deviceinfo.xml', '/sws/app/information/home/home.json', '/properties/aboutPrinter.html',
      '/cgi-bin/status.cgi', '/general/information.html'];
    const devHtml = await tryPages(devPages, (h, page) => {
      if (page.includes('.json') || h.trim().startsWith('{')) return this.parseSamsungDeviceInfo(h);
      return this.parseDeviceInfoHTML(h);
    });
    if (devHtml && Object.keys(devHtml).length > 0) {
      result.deviceInfo = devHtml;
      gotAny = true;
    }

    // Alert pages — extract active alerts
    const alertPages = ['/general/alerts.html', '/wcd/alertinfo.xml', '/hp/device/InternalPages/Index?id=Alerts',
      '/sws/app/information/home/home.json'];
    const alertHtml = await tryPages(alertPages, (h, page) => {
      if (page.includes('.json') || h.trim().startsWith('{')) return this.parseSamsungAlerts(h);
      return this.parseAlertsHTML(h);
    });
    if (alertHtml && alertHtml.length > 0) {
      result.alerts = alertHtml;
      gotAny = true;
    }

    // ── LAYER 2: Auto-discovery — crawl pages, fill gaps ──
    // Full crawl (up to 40 pages) is EXPENSIVE — only every 6h per device.
    // When gaps exist, probe the few known vendor paths quickly instead of
    // crawling everything (a full crawl per poll made offline/no-UI devices
    // block the cycle and hit "Previous poll still running").
    const now = Date.now();
    const lastL2 = (dev && dev._layer2At) || 0;
    const hasGap = !result.toner || result.toner.length === 0 ||
      !result.trays || result.trays.length === 0 ||
      !result.usage || Object.keys(result.usage).length === 0;
    const dueFull = (now - lastL2) > 6 * 3600 * 1000;
    if (dueFull) {
      if (dev) dev._layer2At = now;
      const discovered = await this.discoverWebPaths(ip, dev, authHeader);
      if (discovered) {
        // Fill gaps only — prefer richer data, never replace real known-path data
        if (!result.toner || result.toner.length === 0) {
          if (discovered.toner && discovered.toner.length > 0) {
            result.toner = discovered.toner;
            result.toner_from_layer2 = true;
            gotAny = true;
          }
        }
        if (!result.trays || result.trays.length === 0) {
          if (discovered.trays && discovered.trays.length > 0) { result.trays = discovered.trays; gotAny = true; }
        }
        if (!result.usage || Object.keys(result.usage).length === 0) {
          if (discovered.usage && Object.keys(discovered.usage).length > 0) {
            result.usage = discovered.usage;
            if (discovered.usage_detail) result.usage_detail = discovered.usage_detail;
            gotAny = true;
          }
        }
        if (!result.deviceInfo || Object.keys(result.deviceInfo).length === 0) {
          if (discovered.deviceInfo && Object.keys(discovered.deviceInfo).length > 0) { result.deviceInfo = discovered.deviceInfo; gotAny = true; }
        }
        if (discovered.alerts && discovered.alerts.length > 0) {
          result.alerts = (result.alerts || []).concat(discovered.alerts);
          gotAny = true;
        }
        if (discovered.jobs && discovered.jobs.length > 0) {
          result.jobs = discovered.jobs;
          gotAny = true;
        }
        if (gotAny) console.log(`   🔍 Layer2 full auto-discovery enriched data for ${ip}`);
      }
    } else if (hasGap) {
      // Quick gap-fill: probe known vendor paths IN PARALLEL (fast, one round-trip
      // batch) instead of sequential — sequential took too long for slow web UIs.
      const quickPaths = ['stsply.htm', 'prcnt.htm', 'sttray.htm', 'stgen.htm',
        '/hp/device/DeviceStatus/Index', '/SSI/supply_status_info.htm',
        '/web/guest/en/websys/status/getUnificationCounter.cgi', '/general/status.html',
        '/wcd/top.xml', '/sws/app/information/home/home.json'];
      const need = () => !(result.toner.length > 0 && result.trays.length > 0 && Object.keys(result.usage).length > 0);
      if (need()) {
        const fetches = [];
        for (const proto of ['http', 'https']) {
          for (const qp of quickPaths) {
            fetches.push(this._httpFetchRaw(proto, ip, qp, authHeader));
          }
        }
        const responses = await Promise.allSettled(fetches);
        for (const rsp of responses) {
          const r = rsp.status === 'fulfilled' ? rsp.value : null;
          if (!r || r.status !== 'ok' || !need()) continue;
          const h = r.html;
          const t = this.parseConsumableHTML(h);
          if (t && t.toner.length > 0 && result.toner.length === 0) { result.toner = t.toner; result.toner_from_layer2 = true; gotAny = true; }
          const trays = this.parseTrayHTML(h);
          if (trays && trays.length > 0 && result.trays.length === 0) {
            result.trays = trays.map(t => ({ index: t.index || '', name: t.name || '', media_name: t.media_name || '', sheets: t.sheets !== null ? Math.round(t.sheets) : (t.percentage ?? null), percentage: t.percentage, status: t.status }));
            gotAny = true;
          }
          if (h.includes('Full Color') || h.includes('Black &amp; White')) {
            const ru = this.parseRicohCounters(h);
            if (ru.usage && Object.keys(ru.usage).length && Object.keys(result.usage).length === 0) {
              result.usage = ru.usage; result.usage_detail = ru.detail; gotAny = true;
            }
          }
        }
      }
      if (gotAny) console.log(`   🔍 Layer2 quick gap-fill enriched data for ${ip}`);
    }

    if (gotAny) {
      result.status = 'ok';
      result.detail = 'web scraper';
      return result;
    }

    // Nothing found — check if it's an auth issue or no web UI
    const probe = await this._httpFetchRaw(protocol, ip, (vendorFirst[vend] || ['stsply.htm'])[0], null);
    if (probe.status === 'need_auth') {
      result.status = 'need_auth';
      result.detail = 'Perlu login web UI';
      if (authHeader) {
        result.status = 'error';
        result.detail = 'Login gagal — cek username/password';
      }
    } else {
      result.status = 'error';
      result.detail = 'Web UI tidak tersedia untuk mesin ini';
    }
    return result;
  }

  /**
   * Map usage counter labels → bw/color/total for ANY vendor
   * Handles Xerox, Samsung, Toshiba, HP, generic labels
   */
  mapUsageCounters(usage) {
    const find = (keys) => {
      for (const k of keys) {
        for (const [label, val] of Object.entries(usage)) {
          if (label.toLowerCase().includes(k)) return val;
        }
      }
      return undefined;
    };
    // Total: look for "total" + "print/copy/impression"
    const total = find(['total printed', 'total impressions', 'total copy', 'total']);
    // BW: black printed / black impressions / black copy
    const bw = find(['black printed', 'black impressions', 'black copy', 'black']);
    // Color: color printed / color impressions / color copy
    const color = find(['color printed', 'color impressions', 'color copy', 'color']);
    return {
      total: total !== undefined ? total : ((bw || 0) + (color || 0)),
      bw: bw || 0,
      color: color || 0,
    };
  }

  /**
   * Parse device info from generic HTML (serial, location, model, uptime)
   */
  parseDeviceInfoHTML(html) {
    if (!html) return {};
    const info = {};
    // Xerox stgen.htm: spcs=['ApeosPort-V C3376',[...],'','Lt.3 Swadaya',...]
    const spcs = html.match(/var\s+spcs\s*=\s*\[([^\]]*)\]/);
    if (spcs) {
      const parts = spcs[1].split(',').map(s => s.trim().replace(/^'|'$/g, '').replace(/\[.*\]/g, ''));
      if (parts[0] && parts[0].length > 1 && !parts[0].includes('[')) info.model = parts[0];
      // Location usually a non-IP string
      const nonIp = parts.find(p => p.length > 3 && !p.includes('.') && !p.includes('fe80') && !p.includes('[') && !p.includes('Machine'));
      if (nonIp) info.location = nonIp;
    }
    // HP: <title>HP ...</title>, MachineStatus span
    const mStatus = html.match(/id="MachineStatus"[^>]*>([^<]+)</);
    if (mStatus) info.statusText = mStatus[1].trim();
    // Generic serial patterns
    const serial = html.match(/serial[_ -]*(number|no)?[\"']?\s*[:=]\s*[\"']?([A-Z0-9]{6,})/i);
    if (serial) info.serial_number = serial[2];
    // HP serial: SN:XXXX
    const hpSerial = html.match(/[Ss][Nn]:\s*([A-Z0-9]{6,})/);
    if (hpSerial && !info.serial_number) info.serial_number = hpSerial[1];
    // Uptime
    const uptime = html.match(/uptime[^<]*?(\d+)[^<]*?(days?|hours?|mins?)/i);
    if (uptime) info.uptime = uptime[0].replace(/<[^>]+>/g, '').trim();
    return info;
  }

  /**
   * Parse Samsung device info from home.json
   */
  parseSamsungDeviceInfo(html) {
    try {
      const json = JSON.parse(html);
      const data = json.DATA || json.data || [];
      const find = (k) => {
        const item = data.find(d => (d.KEY || d.key) === k);
        return item ? (item.VALUE ?? item.value) : undefined;
      };
      const info = {};
      const m = find('ModelName') || find('Model');
      if (m) info.model = m;
      const s = find('SerialNumber') || find('SerialNo');
      if (s) info.serial_number = s;
      const l = find('Location') || find('ContactLocation');
      if (l) info.location = l;
      return info;
    } catch (e) { return {}; }
  }

  /**
   * Parse alerts from generic HTML
   */
  parseAlertsHTML(html) {
    if (!html) return [];
    const alerts = [];
    // Xerox stgen: artinfo=[['icon', severity, code, text, skill],...]
    const art = html.match(/var\s+artinfo\s*=\s*\[(.*)\];/s);
    if (art) {
      const items = art[1].match(/\[([^\]]*)\]/g) || [];
      items.forEach(item => {
        const parts = item.replace(/\[|\]/g, '').split(',').map(s => s.trim().replace(/^'|'$/g, ''));
        if (parts.length >= 3 && parts[1] !== '0') {
          const text = parts[3] || '';
          // Skip noise: field labels, generic nav labels, empty texts
          const noise = /^(description|management|field service|status code|system|device|menu|home)$/i.test(text) ||
            text.length === 0 || text.length > 200;
          if (!noise) {
            alerts.push({ severity: parseInt(parts[1]) || 1, code: parts[2], text });
          }
        }
      });
    }
    // HP alerts: <span class="status status-...">text</span>
    const hpAlerts = html.match(/class="status[^"]*"[^>]*>\s*([^<]+)</g);
    if (hpAlerts && alerts.length === 0) {
      hpAlerts.forEach(a => {
        const text = a.replace(/<[^>]+>/g, '').trim();
        if (text && text.length > 2 && !text.includes('Full') && !text.includes('Ready')) {
          alerts.push({ severity: 2, text });
        }
      });
    }
    return alerts;
  }

  /**
   * Parse Samsung alerts from home.json
   */
  parseSamsungAlerts(html) {
    try {
      const json = JSON.parse(html);
      const data = json.DATA || json.data || [];
      const alerts = [];
      data.forEach(d => {
        const key = (d.KEY || d.key || '').toString();
        const val = (d.VALUE ?? d.value) || '';
        if (key.toLowerCase().includes('alert') || key.toLowerCase().includes('error') || key.toLowerCase().includes('jam')) {
          if (val && val !== 'None' && val !== 'none' && val !== '0') {
            alerts.push({ severity: 2, text: key + ': ' + val });
          }
        }
      });
      return alerts;
    } catch (e) { return []; }
  }

  /**
   * Parse job log HTML (HP EWS JobLog, generic tables)
   * Returns [{ name, user, pages, status }]
   */
  parseJobLogHTML(html) {
    if (!html) return [];
    const jobs = [];
    // HP: table rows with job name / user / pages
    // Look for JobLog tables — rows like <td>Report.pdf</td><td>user</td><td>12</td>
    const table = html.match(/<(?:table|tbody)[^>]*>([\s\S]*?)<\/(?:table|tbody)>/i);
    if (!table) return [];
    const rows = table[1].match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
    rows.forEach((row, ri) => {
      if (ri === 0) return; // skip header
      const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
        .map(c => c.replace(/<[^>]+>/g, '').trim());
      if (cells.length >= 2) {
        const name = cells[0];
        if (!name || /^(job|status|name|user)/i.test(name) || name.length > 120) return;
        // pages = cell containing a number, user = cell with @ or letters
        const numCell = cells.find(c => /^\d{1,6}$/.test(c));
        const pages = numCell ? parseInt(numCell) : (cells.length >= 3 ? parseInt(cells[2]) || 0 : 0);
        const user = cells.length >= 3 ? cells[1] : '';
        // Avoid duplicates / non-jobs
        if (name.length > 2 && !name.includes('Copyright')) {
          jobs.push({ name, user: user || '', pages: pages || 0, status: cells[cells.length - 1] || '' });
        }
      }
    });
    return jobs.slice(0, 15);
  }

  /**
   * LAYER 2 FULL: Auto-discovery web paths — crawl ALL internal pages
   * 1. Crawl http(s)://IP root page
   * 2. Extract ALL internal links (htm/cgi/xml/json)
   * 3. Fetch EVERY candidate page (deduped, depth-guarded) — no 15-link limit
   * 4. Parse with all parsers; collect the BEST (most complete) data per field
   * 5. Recurse 1 level for richer pages (nav menus point to detail pages)
   * Goal: leave no data behind — toner, trays, usage, jobs, alerts, device info.
   */
  async discoverWebPaths(ip, dev, authHeader) {
    const found = { toner: [], trays: [], usage: {}, usage_detail: null, deviceInfo: {}, alerts: [], jobs: [] };
    const ssl = (dev && dev.web_ssl) || false;
    const MAX_PAGES = 40;           // hard cap to avoid flooding (was 15)
    const visited = new Set();      // page paths already fetched

    const fetchAndParse = async (proto, path) => {
      if (visited.has(path) || visited.size >= MAX_PAGES) return;
      visited.add(path);
      const page = await this._httpFetchRaw(proto, ip, path, authHeader);
      if (page.status !== 'ok') return;
      const h = page.html;
      if (!h || h.length < 100) return;
      this.tryParsePage(h, path, found, proto, ip, authHeader, fetchAndParse);
    };

    const fetchBatch = async (proto, paths) => {
      const CONCURRENCY = 6;
      for (let i = 0; i < paths.length; i += CONCURRENCY) {
        await Promise.all(paths.slice(i, i + CONCURRENCY).map(p => fetchAndParse(proto, p)));
        if (visited.size >= MAX_PAGES) break;
      }
    };

    for (const proto of ['http', 'https']) {
      // Step 1: fetch root
      const root = await this._httpFetchRaw(proto, ip, '', authHeader);
      if (root.status !== 'ok' || root.html.length < 50) continue;
      const looksHtml = /<html|<head|<body|<title/i.test(root.html);
      if (!looksHtml) {
        // Binary/compressed root — probe known paths directly (parallel)
        console.log(`   🔍 Layer2: ${proto} root binary — probing known paths for ${ip}`);
        const known = ['/hp/device/DeviceStatus/Index', '/SSI/supply_status_info.htm', 'stsply.htm',
          '/web/guest/en/websys/status/getUnificationCounter.cgi', '/general/status.html', '/wcd/top.xml',
          '/sws/app/information/home/home.json'];
        await fetchBatch(proto, known);
        break;
      }

      // Step 2: extract ALL links
      const links = this.extractInternalLinks(root.html, ip);
      console.log(`   🔍 Layer2: ${proto} root → ${links.length} candidate link(s) for ${ip}`);

      // Step 3: fetch + parse EVERY candidate in parallel batches
      const toCrawl = links.length > 0 ? links : ['stsply.htm', 'prcnt.htm', 'sttray.htm', 'stgen.htm',
        '/hp/device/DeviceStatus/Index', '/SSI/supply_status_info.htm', '/general/status.html',
        '/web/guest/en/websys/status/getUnificationCounter.cgi', '/wcd/top.xml',
        '/sws/app/information/home/home.json'];
      await fetchBatch(proto, toCrawl);
    }

    // Dedupe/order: pick most-complete toner set if multiple pages gave toner
    if (found.toner.length > 0) {
      // Prefer 4-color complete sets over partial
      const full = found.toner.filter(t => t.warna);
      if (full.length >= 4) found.toner = full.slice(0, 4);
      console.log(`   🔍 Layer2 final toner (${ip}): ${found.toner.map(x => x.warna + '=' + x.level).join(', ')}`);
    }

    return found;
  }

  /**
   * Parse a page with all parsers and collect into found.
   * Prefers the MOST COMPLETE data per field (does not overwrite a fuller set).
   * Also recurses 1 level: pages found in nav menus often point to detail pages.
   */
  async tryParsePage(h, link, found, proto, ip, authHeader, fetchAndParse) {
    // Toner detection — prefer complete sets (>=3 colors) over partial
    const t = this.parseConsumableHTML(h);
    if (t && t.toner.length > 0) {
      const plausible = t.toner.every(x => x.level >= 0 && x.level <= 100);
      if (plausible && t.toner.length > found.toner.length) {
        found.toner = t.toner;
        console.log(`   🔍 Layer2 toner @ ${link}: ${t.toner.map(x => x.warna + '=' + x.level + '%').join(', ')}`);
      }
    }

    // Tray detection — prefer more trays
    const tray = this.parseTrayHTML(h);
    if (tray && tray.length > 0) {
      const plausible = tray.every(x => x.percentage === null || (x.percentage >= 0 && x.percentage <= 100));
      if (plausible && tray.length >= found.trays.length) {
        found.trays = tray;
        console.log(`   🔍 Layer2 trays @ ${link}: ${tray.length} tray(s)`);
      }
    }

    // Usage detection — prefer more counters
    if (Object.keys(found.usage).length === 0) {
      const u = this.parseUsageCountersHTML(h);
      if (Object.keys(u).length > 0) {
        found.usage = u;
        console.log(`   🔍 Layer2 usage @ ${link}: ${Object.keys(u).length} counter(s)`);
      }
      // Ricoh-style
      if (Object.keys(found.usage).length === 0 && (h.includes('Full Color') || h.includes('Black &amp; White'))) {
        const r = this.parseRicohCounters(h);
        if (r.usage && Object.keys(r.usage).length > 0) {
          found.usage = r.usage;
          found.usage_detail = r.detail;
          console.log(`   🔍 Layer2 Ricoh usage @ ${link}`);
        }
      }
      // HP EquivalentImpressions
      if (Object.keys(found.usage).length === 0 && h.includes('EquivalentImpressions')) {
        const r = this.parseHPUsageCounters(h);
        if (r.usage && Object.keys(r.usage).length > 0) {
          found.usage = r.usage;
          found.usage_detail = r.detail;
          console.log(`   🔍 Layer2 HP usage @ ${link}`);
        }
      }
    }

    // Device info
    if (Object.keys(found.deviceInfo).length === 0) {
      const d = this.parseDeviceInfoHTML(h);
      if (d && (d.serial_number || d.model || d.location)) {
        found.deviceInfo = d;
        console.log(`   🔍 Layer2 deviceInfo @ ${link}`);
      }
    }

    // Alerts — merge (dedupe by text)
    const a = this.parseAlertsHTML(h);
    if (a && a.length > 0) {
      const have = new Set(found.alerts.map(x => x.text));
      const fresh = a.filter(x => !have.has(x.text));
      if (fresh.length > 0) {
        found.alerts = found.alerts.concat(fresh).slice(0, 20);
        console.log(`   🔍 Layer2 alerts @ ${link}: +${fresh.length} alert(s)`);
      }
    }

    // Job log (HP /hp/device/InternalPages/Index?id=JobLog etc.)
    if (found.jobs.length === 0) {
      const j = this.parseJobLogHTML(h);
      if (j && j.length > 0) {
        found.jobs = j;
        console.log(`   🔍 Layer2 jobs @ ${link}: ${j.length} job(s)`);
      }
    }

    // Recurse 1 level: fetch links from this page (nav → detail pages)
    if (fetchAndParse) {
      const subLinks = this.extractInternalLinks(h, ip);
      for (const sl of subLinks) await fetchAndParse(proto, sl);
    }
  }

  /**
   * Extract internal links from root HTML
   * Filters: same-host paths, page extensions (.htm/.cgi/.xml/.json), ignore images/css/js
   */
  extractInternalLinks(html, ip) {
    const links = [];
    const seen = new Set();
    // href="..." and action="..." and src of scripts (not images)
    const re = /(?:href|action|src)="([^"]*)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      let url = m[1].trim();
      if (!url || url.startsWith('#') || url.startsWith('javascript') || url.startsWith('mailto')) continue;
      // Absolute URL — same host?
      if (url.startsWith('http')) {
        try {
          const u = new URL(url);
          if (u.hostname !== ip) continue;
          url = u.pathname + (u.search || '');
        } catch { continue; }
      }
      // Relative — strip query params for dedupe but keep for cgi
      const ext = url.split('?')[0].toLowerCase();
      // Accept pages WITH extension OR HP-style /hp/device/ paths (no ext)
      const isHpPath = ext.includes('/hp/') || ext.includes('/ssi/');
      if (!isHpPath && !/\.(htm|html|cgi|xml|json)$/.test(ext)) continue;
      // Skip obvious static resources
      if (/\.(js|css|png|jpg|gif|ico|svg)$/i.test(ext)) continue;
      // Normalize: strip leading ./
      url = url.replace(/^\.\//, '');
      if (url.startsWith('/')) url = url.slice(1);
      // Dedupe
      const key = url.split('?')[0];
      if (!seen.has(key) && url.length < 100) {
        seen.add(key);
        links.push(url);
      }
    }
    return links;
  }

  /**
   * Parse Samsung SyncThru JSON (home.json)
   * Format: { "DATA": [ { "KEY": "BlackTonerPer", "VALUE": 70 }, ... ] }
   */
  parseSamsungJson(html) {
    try {
      const json = JSON.parse(html);
      const toners = [];
      const data = json.DATA || json.data || [];
      const find = (key) => {
        const item = data.find(d => (d.KEY || d.key) === key);
        return item ? (item.VALUE ?? item.value) : undefined;
      };
      const map = { blackTonerPer: 'BLACK', cyanTonerPer: 'CYAN', magentaTonerPer: 'MAGENTA', yellowTonerPer: 'YELLOW' };
      for (const [key, color] of Object.entries(map)) {
        const v = parseInt(find(key));
        if (!isNaN(v)) toners.push({ warna: color, level: v, level_sekarang: v, source: 'web_ui' });
      }
      return { toner: toners };
    } catch (e) { return null; }
  }

  /**
   * Parse Samsung counters JSON
   * Keys like GXI_BILLING_PRINT_TOTAL_IMP_CNT
   */
  parseSamsungCounters(html) {
    try {
      const json = JSON.parse(html);
      const data = json.DATA || json.data || [];
      const find = (key) => {
        const item = data.find(d => (d.KEY || d.key) === key);
        return item ? parseInt(item.VALUE ?? item.value) : undefined;
      };
      const usage = {};
      const map = {
        'GXI_BILLING_PRINT_TOTAL_IMP_CNT': 'Total Printed Impressions',
        'GXI_BILLING_COPY_TOTAL_IMP_CNT': 'Total Copied Impressions',
        'GXI_BILLING_SCAN_TOTAL_IMG_CNT': 'Total Scanned Images',
      };
      for (const [key, label] of Object.entries(map)) {
        const v = find(key);
        if (v !== undefined) usage[label] = v;
      }
      return usage;
    } catch (e) { return {}; }
  }

  /**
   * Parse Samsung tray JSON
   */
  parseSamsungTrays(html) {
    try {
      const json = JSON.parse(html);
      const data = json.DATA || json.data || [];
      const trays = [];
      for (let i = 1; i <= 8; i++) {
        const key = `tray${i}Status`;
        const item = data.find(d => (d.KEY || d.key) === key);
        if (item) {
          const v = (item.VALUE ?? item.value) || '';
          trays.push({
            name: 'Tray ' + i,
            status: v,
            percentage: null,
          });
        }
      }
      return trays;
    } catch (e) { return []; }
  }

  /**
   * Low-level HTTP fetch with status detection + redirect following
   */
  _httpFetch(protocol, ip, path, authHeader, _depth) {
    _depth = _depth || 0;
    if (_depth > 5) return Promise.resolve({ status: 'error', toner: [], detail: 'Too many redirects' });
    
    return new Promise((resolve) => {
      const http = require(protocol === 'https' ? 'https' : 'http');
      const headers = {};
      if (authHeader) headers['Authorization'] = 'Basic ' + authHeader;

      const timeout = setTimeout(() => {
        resolve({ status: 'error', toner: [], detail: 'Timeout' });
      }, 4000);

      http.get(`${protocol}://${ip}/${path}`, { timeout: 3500, headers, rejectUnauthorized: false }, (res) => {
        // Follow redirects (301, 302, 307, 308)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          clearTimeout(timeout);
          let loc = res.headers.location;
          if (loc.startsWith('/')) loc = `${protocol}://${ip}${loc}`;
          const match = loc.match(/^(https?):\/\/([^/]+)(\/.*)/);
          if (match) {
            resolve(this._httpFetch(match[1], ip, match[3].replace(/^\//, ''), authHeader, _depth + 1));
          } else {
            resolve({ status: 'error', toner: [], detail: `Redirect ke ${loc} tidak valid` });
          }
          return;
        }
        
        let html = '';
        res.on('data', (c) => { html += c; });
        res.on('end', () => {
          clearTimeout(timeout);
          if (res.statusCode === 401 || res.statusCode === 403) {
            resolve({ status: 'need_auth', toner: [], detail: `HTTP ${res.statusCode} — butuh login` });
            return;
          }
          if (res.statusCode !== 200) {
            resolve({ status: 'error', toner: [], detail: `HTTP ${res.statusCode}` });
            return;
          }
          try {
            const parsed = this.parseConsumableHTML(html);
            if (parsed && parsed.toner.length > 0) {
              resolve({ status: 'ok', toner: parsed.toner, drum: parsed.drum, detail: '' });
            } else {
              resolve({ status: 'error', toner: [], detail: 'Halaman ditemukan tapi data konsumabel tidak ada' });
            }
          } catch (e) {
            resolve({ status: 'error', toner: [], detail: 'Parse error: ' + e.message });
          }
        });
      }).on('error', (e) => {
        clearTimeout(timeout);
        resolve({ status: 'error', toner: [], detail: `Koneksi gagal: ${e.message}` });
      });
    });
  }

  /**
   * Parse consumable HTML — AMCS cConsumable.cs pattern
   * Tries multiple page formats (stsply.htm, sttnr.htm, stdrm.htm, etc.)
   */
  parseConsumableHTML(html) {
    if (!html || html.length < 50) return null;

    const result = { toner: [], drum: [] };

    // Pattern 1: Xerox JS concat format
    // info=info.concat([['Toner Cartridge(s)',[['Black Toner [K]',0,75],...],3]]);
    // After 'Black Toner [K]' → ,statusCode,percentage]
    const jsColorSearch = [
      { label: 'BLACK', search: "'Black Toner [K]'" },
      { label: 'CYAN', search: "'Cyan Toner [C]'" },
      { label: 'MAGENTA', search: "'Magenta Toner [M]'" },
      { label: 'YELLOW', search: "'Yellow Toner [Y]'" },
    ];

    for (const p of jsColorSearch) {
      if (result.toner.find(t => t.warna === p.label)) continue;
      const idx = html.indexOf(p.search);
      if (idx === -1) continue;
      // Extract after the name: ',statusCode,percentage]  or  ',[statusCode,percentage]]
      const after = html.substring(idx + p.search.length);
      const nums = after.match(/,(\d+),(\d+)/);
      if (nums) {
        const pct = parseInt(nums[2]);
        const statusCode = parseInt(nums[1]);
        if (!isNaN(pct) && pct >= 0 && pct <= 100) {
          result.toner.push({ warna: p.label, level: pct, level_sekarang: pct, source: 'web_ui', status_code: statusCode });
        }
      }
    }

    // Pattern 2: Generic — var info=['Black', statusCode, percentage]
    if (result.toner.length === 0) {
      const genericSearch = [
        { label: 'BLACK', search: "'Black'" },
        { label: 'CYAN', search: "'Cyan'" },
        { label: 'MAGENTA', search: "'Magenta'" },
        { label: 'YELLOW', search: "'Yellow'" },
      ];
      for (const p of genericSearch) {
        if (result.toner.find(t => t.warna === p.label)) continue;
        const idx = html.indexOf(p.search);
        if (idx === -1) continue;
        const after = html.substring(idx + p.search.length);
        const nums = after.match(/,(\d+),(\d+)/);
        if (nums) {
          const pct = parseInt(nums[2]);
          if (!isNaN(pct) && pct >= 0 && pct <= 100) {
            result.toner.push({ warna: p.label, level: pct, level_sekarang: pct, source: 'web_ui' });
          }
        }
      }
    }

    // Pattern 3: HTML table format
    const htmlPatterns = [
      { label: 'BLACK', regex: /Black\s+Toner\s*\[K\][^<]*?(\d+)%/i },
      { label: 'CYAN', regex: /Cyan\s+Toner\s*\[C\][^<]*?(\d+)%/i },
      { label: 'MAGENTA', regex: /Magenta\s+Toner\s*\[M\][^<]*?(\d+)%/i },
      { label: 'YELLOW', regex: /Yellow\s+Toner\s*\[Y\][^<]*?(\d+)%/i },
    ];

    for (const p of htmlPatterns) {
      if (result.toner.find(t => t.warna === p.label)) continue;
      const m = html.match(p.regex);
      if (m) {
        result.toner.push({ warna: p.label, level: parseInt(m[1]), level_sekarang: parseInt(m[1]), source: 'web_ui' });
      }
    }

    // Pattern 4: HP Device Status HTML
    // <h2 id="SupplyName0" title="Black Cartridge">Black Cartridge</h2>
    // <span id="SupplyPLR0" class="plr">70%*</span>
    // <span id="SupplyPartNumber0" ...>Order 55A (CE255A)</span>
    if (result.toner.length === 0) {
      const hpSupplyRegex = /id="SupplyName(\d+)"[^>]*title="([^"]+)"[^>]*>[\s\S]*?id="SupplyPLR\1"[^>]*>(\d+)%/g;
      let hpMatch;
      while ((hpMatch = hpSupplyRegex.exec(html)) !== null) {
        const name = hpMatch[2];
        const pct = parseInt(hpMatch[3]);
        const upper = name.toUpperCase();
        // Detect color from name
        let warna = null;
        if (upper.includes('BLACK') || upper.includes('MONO')) warna = 'BLACK';
        else if (upper.includes('CYAN')) warna = 'CYAN';
        else if (upper.includes('MAGENTA')) warna = 'MAGENTA';
        else if (upper.includes('YELLOW')) warna = 'YELLOW';
        // Only map toner cartridges (skip drum/feeder/fuser/waste)
        if (warna && !upper.includes('DRUM') && !upper.includes('FEEDER') && !upper.includes('FUSER') && !upper.includes('WASTE')) {
          result.toner.push({ warna, level: pct, level_sekarang: pct, source: 'web_ui' });
        }
      }
    }

    // Pattern 5: HP inkjet/PageWide — "Approximate Pages Remaining" table
    // Installed Cartridges: Cyan / Magenta / Yellow / Black with
    // Approximate Pages Remaining: >32700 / Low / 20800 / >32700
    // Convert pages-remaining to an estimated % (no exact max known → map
    // "Low"/small values low, large values high). If page count known from
    // a max cartridge, normalize to it; otherwise use yield heuristics.
    if (result.toner.length === 0) {
      // Detect the "Installed Cartridges" table with Approximate Pages Remaining
      const tableStart = html.indexOf('Installed Cartridges');
      const remIdx = html.indexOf('Approximate Pages Remaining');
      if (tableStart > -1 && remIdx > -1) {
        // Order in the table row: Cyan, Magenta, Yellow, Black (from user sample)
        const hpColorOrder = ['CYAN', 'MAGENTA', 'YELLOW', 'BLACK'];
        const cellRe = /<td[^>]*>([^<]*)<\/td>/gi;
        // Find the table containing "Installed Cartridges" → capture cells after it
        const seg = html.substring(tableStart, tableStart + 12000);
        const rows = [];
        let cm;
        while ((cm = cellRe.exec(seg)) !== null) {
          const v = cm[1].trim();
          if (v) rows.push(v);
        }
        // Rows should contain the 4 colors then 4 statuses then 4 cartridge numbers,
        // and eventually the pages-remaining values. Look for known cartridge tokens.
        const isHpCart = (s) => /^(--\s*)?\d*\s*[0-9A-Za-z-]*\s*(cartridge|ink cartridge|95uxl|970xl|971xl|972xl|973xl)/i.test(s);
        // Locate the 4 cartridge rows — cartridge numbers start with "-- " (sample) or
        // contain "Cartridge" but NOT the "Non-HP Ink Cartridge Installed" status cell.
        const cartIdx = [];
        for (let i = 0; i < rows.length; i++) {
          if (/cartridge/i.test(rows[i]) && !/installed/i.test(rows[i]) && rows[i].length < 60) cartIdx.push(i);
        }
        if (cartIdx.length >= 4) {
          // Colors are 2 cells before each cartridge number: [Color, Status, Number]
          const colorCells = [];
          for (let i = cartIdx[0] - 2; i < cartIdx[0] && i >= 0; i++) {
            const c = (rows[i] || '').trim();
            if (/^(cyan|magenta|yellow|black)$/i.test(c)) colorCells.push(c);
          }
          // Fallback: default order
          const colors = colorCells.length === 4 ? colorCells : hpColorOrder;
          // Find pages-remaining values — numeric tokens like "20800" or ">32700" or "Low"
          // after the cartridge rows (skip statuses/numbers/types/dates)
          const pageVals = rows.filter(v => /^(>?\d{3,}|low|unknown)$/i.test(v) && v.length < 20);
          // Take the last 4 (pages remaining come last in the table)
          const last4 = pageVals.slice(-4);
          if (last4.length === 4) {
            const MAX_PAGES = 40000; // typical high-capacity ink cartridge upper bound
            colors.forEach((c, i) => {
              const raw = last4[i];
              let pct = 50; // default unknown → mid estimate
              if (/low/i.test(raw)) pct = 5;
              else if (/unknown/i.test(raw)) pct = 50;
              else {
                const n = parseInt(String(raw).replace(/\D/g, ''));
                if (!isNaN(n)) pct = Math.max(1, Math.min(100, Math.round((n / MAX_PAGES) * 100)));
              }
              result.toner.push({
                warna: c.toUpperCase(),
                level: pct,
                level_sekarang: pct,
                source: 'web_ui',
                estimated: true,
                estimated_from: 'pages_remaining: ' + raw,
              });
            });
          }
        }
      }
    }

    // Parse drum status
    const drumSearches = ["'Drum Cartridge (Black)'", "'Drum Cartridge (Cyan)'", "'Drum Cartridge (Magenta)'", "'Drum Cartridge (Yellow)'"];
    const drumColors = ['BLACK', 'CYAN', 'MAGENTA', 'YELLOW'];
    for (let i = 0; i < drumSearches.length; i++) {
      const idx = html.indexOf(drumSearches[i]);
      if (idx === -1) continue;
      const after = html.substring(idx + drumSearches[i].length);
      const bracketStart = after.indexOf('[');
      if (bracketStart === -1) continue;
      const bracketEnd = after.indexOf(']', bracketStart + 1);
      if (bracketEnd === -1) continue;
      const statusCode = parseInt(after.substring(bracketStart + 1, bracketEnd).trim());
      if (!isNaN(statusCode)) result.drum.push({ color: drumColors[i], status_code: statusCode });
    }

    return result.toner.length > 0 ? result : null;
  }

  // ===================================================================
  // PAPER TRAY SCRAPING — Xerox sttray.htm
  // Format: infoIn=[['Tray 1',0,25,'A4','White','Bond (80-105 gsm)',1,1],...]
  // ===================================================================

  /**
   * Scrape paper tray data from sttray.htm
   */
  async scrapeTrayWebUI(ip, dev) {
    const ssl = (dev && dev.web_ssl) || false;
    const protocol = ssl ? 'https' : 'http';
    const username = (dev && dev.web_username) || '';
    const password = (dev && dev.web_password) || '';

    // Try with auth (trays usually need auth)
    let authHeader = null;
    if (username) {
      authHeader = Buffer.from(username + ':' + password).toString('base64');
    }

    const result = await this._httpFetchRaw(protocol, ip, 'sttray.htm', authHeader);
    if (result.status !== 'ok') return [];

    try {
      return this.parseTrayHTML(result.html);
    } catch (e) {
      return [];
    }
  }

  /**
   * Raw HTTP fetch — returns status + html
   * Supports HTTPS with self-signed certs (printers use them)
   */
  _httpFetchRaw(protocol, ip, path, authHeader, _depth, port) {
    _depth = _depth || 0;
    if (_depth > 5) return Promise.resolve({ status: 'error', html: '' });
    
    return new Promise((resolve) => {
      const http = require(protocol === 'https' ? 'https' : 'http');
      const zlib = require('zlib');
      const headers = {};
      if (authHeader) headers['Authorization'] = 'Basic ' + authHeader;
      headers['Accept-Encoding'] = 'identity'; // avoid gzip binary responses
      // Handle leading / in path
      const cleanPath = path.startsWith('/') ? path.slice(1) : path;

      const timeout = setTimeout(() => {
        resolve({ status: 'error', html: '' });
      }, 4000);

      const opts = { timeout: 3500, headers };
      // Accept self-signed certs for HTTPS (printers use them)
      if (protocol === 'https') {
        opts.rejectUnauthorized = false;
      }
      // Custom port (e.g. Toshiba 8080)
      const hostPort = port ? `${ip}:${port}` : ip;

      http.get(`${protocol}://${hostPort}/${cleanPath}`, opts, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          clearTimeout(timeout);
          let loc = res.headers.location;
          if (loc.startsWith('/')) loc = `${protocol}://${hostPort}${loc}`;
          const match = loc.match(/^(https?):\/\/([^/]+)(\/.*)/);
          if (match) {
            resolve(this._httpFetchRaw(match[1], ip, match[3].replace(/^\//, ''), authHeader, _depth + 1, port));
          } else {
            resolve({ status: 'error', html: '' });
          }
          return;
        }

        // Decompress if gzip/deflate
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          clearTimeout(timeout);
          if (res.statusCode === 200) {
            let body = Buffer.concat(chunks);
            try {
              if (enc.includes('gzip')) body = zlib.gunzipSync(body);
              else if (enc.includes('deflate')) body = zlib.inflateSync(body);
            } catch (e) { /* keep raw */ }
            const html = body.toString('utf8');
            resolve({ status: 'ok', html, statusCode: 200 });
          } else if (res.statusCode === 401 || res.statusCode === 403) {
            resolve({ status: 'need_auth', html: '', statusCode: res.statusCode });
          } else {
            resolve({ status: 'error', html: '', statusCode: res.statusCode });
          }
        });
      }).on('error', () => { clearTimeout(timeout); resolve({ status: 'error', html: '' }); });
    });
  }

  /**
   * Parse sttray.htm — extracts infoIn array
   * Format: ['Tray 1', statusCode, %Full, 'A4', 'White', 'Bond (80-105 gsm)', priority, x]
   */
  parseTrayHTML(html) {
    if (!html) return [];
    const trays = [];
    // Match infoIn=[...]
    const m = html.match(/infoIn\s*=\s*\[((?:\[.*?\],?\s*)+)\]/);
    if (!m) return [];
    // Extract individual tray arrays
    const trayRegex = /\['([^']*)',(\d+),([^,]*),'([^']*)','([^']*)','([^']*)',/g;
    let match;
    while ((match = trayRegex.exec(m[1])) !== null) {
      const pct = parseInt(match[3]);
      trays.push({
        name: match[1],
        statusCode: parseInt(match[2]),
        percentage: isNaN(pct) ? null : pct,
        paperSize: match[4],
        paperColor: match[5],
        paperType: match[6],
        status: parseInt(match[2]) === 0 ? 'Ready' : parseInt(match[2]) === 1 ? 'Empty' : 'Unknown',
      });
    }
    return trays;
  }

  // ===================================================================
  // USAGE COUNTER SCRAPING — billing data from prcnt.htm
  // Format: var info=['Total Printed Impressions',19203,'Color Printed
  //   Impressions',13405,'Black Printed Impressions',5798,...]
  // ===================================================================

  /**
   * Scrape usage counters (billing data) from prcnt.htm
   */
  async scrapeUsageCounters(ip, dev) {
    const ssl = (dev && dev.web_ssl) || false;
    const protocol = ssl ? 'https' : 'http';
    const username = (dev && dev.web_username) || '';
    const password = (dev && dev.web_password) || '';

    if (!username) return null;

    const authHeader = Buffer.from(username + ':' + password).toString('base64');
    const result = await this._httpFetchRaw(protocol, ip, 'prcnt.htm', authHeader);
    if (result.status !== 'ok') return null;

    try {
      return this.parseUsageCountersHTML(result.html);
    } catch (e) {
      return null;
    }
  }

  /**
   * Parse prcnt.htm — name/value pairs in info array
   */
  parseUsageCountersHTML(html) {
    if (!html) return {};
    const m = html.match(/var\s+info\s*=\s*\[([^\]]+)\]/);
    if (!m) return {};

    const pairs = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
    const usage = {};
    for (let i = 0; i < pairs.length - 1; i += 2) {
      const name = pairs[i];
      const value = parseInt(pairs[i + 1]);
      if (name && !isNaN(value)) {
        usage[name] = value;
      }
    }
    return usage;
  }

  /**
   * Parse HP EWS UsagePage (InternalPages/Index?id=UsagePage)
   * Equivalent Impressions (Letter/A4) — weighted billing units:
   *   UsagePage.EquivalentImpressionsTable.Print.Total / .Copy.Total / .Fax.Total
   * Color models also expose a Color Counts section (TotalColor / B/W rows).
   * Mono models have no color section → all impressions are black.
   */
  parseHPUsageCounters(html) {
    if (!html || !html.includes('EquivalentImpressions')) return {};
    const grab = (key) => {
      const re = new RegExp('UsagePage\\.EquivalentImpressionsTable\\.' + key + '\\.Total[^>]*>([\\d,.]+)<');
      const m = html.match(re);
      return m ? parseFloat(m[1].replace(/,/g, '')) : 0;
    };
    const print = grab('Print');
    const copy = grab('Copy');
    const fax = grab('Fax');
    if (!print && !copy && !fax) return { usage: {}, detail: null };
    const total = Math.round(print + copy + fax);
    if (!total) return { usage: {}, detail: null };

    const usage = {};
    usage['Total Printed Impressions'] = total;
    usage['Total Impressions'] = total;
    usage['Print'] = Math.round(print);
    usage['Copy'] = Math.round(copy);
    usage['Fax'] = Math.round(fax);

    // Color split (color models only): any td id with Color + Total
    let colorSum = 0;
    const colorRe = /id="[^"]*(?:Color|colour)[^"]*Total[^"]*"[^>]*>([\d,.]+)</gi;
    let cm;
    while ((cm = colorRe.exec(html)) !== null) colorSum += parseFloat(cm[1].replace(/,/g, '')) || 0;
    colorSum = Math.round(colorSum);
    if (colorSum > 0 && colorSum <= total) {
      usage['Color Printed Impressions'] = colorSum;
      usage['Black Printed Impressions'] = total - colorSum;
    } else {
      // Mono printer — everything counts as black
      usage['Black Printed Impressions'] = total;
    }

    // Per-function breakdown: HP gives Print/Copy/Fax totals directly.
    // Color split per function is not exposed → allocate proportionally
    // when colorSum known; mono → all black.
    const col = colorSum > 0 ? colorSum : 0;
    const detail = {
      print: { bw: Math.round(print) - Math.round(col * print / total), color: Math.round(col * print / total) },
      copy: { bw: Math.round(copy) - Math.round(col * copy / total), color: Math.round(col * copy / total) },
      fax: { bw: Math.round(fax) - Math.round(col * fax / total), color: Math.round(col * fax / total) },
      source: 'hp_usagepage',
    };
    // Scan counts (info only, not billing)
    const scanRe = /UsagePage\.ScanCountsDestinationTable\.GrandTotal\.Value[^>]*>([\d,.]+)</;
    const scanM = html.match(scanRe);
    if (scanM) detail.scan = { count: Math.round(parseFloat(scanM[1].replace(/,/g, ''))) };

    return { usage, detail };
  }

  /**
   * Parse Ricoh WIM getUnificationCounter.cgi
   * Sections: Total Counter / Copier / Printer / Fax — each a table with
   * rows "Full Color : <Total>" / "Black & White : <Total>" etc.
   * Returns { usage, detail } where detail is per-function breakdown:
   *   detail = { print:{bw,color}, copy:{bw,color}, fax:{bw,color}, source:'ricoh_wim' }
   * Color = Full Color + Single Color + Two-color (all non-BW output).
   */
  parseRicohCounters(html) {
    if (!html) return { usage: {}, detail: null };
    const usage = {};

    // Section boundaries: ">Total Counter<", ">Copier<", ">Printer<", ">Fax<"
    const sections = {};
    const secRe = />((?:Total Counter|Copier|Printer|Fax))<\/div>/g;
    let sm;
    while ((sm = secRe.exec(html)) !== null) sections[sm[1]] = sm.index;
    // "Total" summary row appears after Fax section (outside any div header)
    const totalIdx = html.indexOf('>Total<');
    const sectionNames = ['Total Counter', 'Copier', 'Printer', 'Fax'];
    const boundaries = sectionNames.map(n => sections[n] ?? -1).filter(i => i >= 0);
    const summaryStart = totalIdx > 0 ? totalIdx : Math.max(...boundaries, 0);

    const sliceFor = (name) => {
      const start = sections[name];
      if (start === undefined) return '';
      const nexts = boundaries.filter(i => i > start);
      const end = nexts.length ? Math.min(...nexts) : summaryStart;
      return html.slice(start, end);
    };

    // Extract rows within a slice: align="left">LABEL</td> ... colspan="1">VALUE</td>
    const extract = (slice, label) => {
      let total = 0;
      const re = new RegExp('align="left">' + label + '</td>[\\s\\S]*?colspan="1">(\\d+)</td>', 'g');
      let m;
      while ((m = re.exec(slice)) !== null) total += parseInt(m[1]) || 0;
      return total;
    };
    const sectionTotals = (slice) => ({
      fc: extract(slice, 'Full Color'),
      bw: extract(slice, 'Black &amp; White'),
      sc: extract(slice, 'Single Color'),
      tc: extract(slice, 'Two-color'),
    });

    const total = sectionTotals(sliceFor('Total Counter'));
    const copier = sectionTotals(sliceFor('Copier'));
    const printer = sectionTotals(sliceFor('Printer'));
    const fax = sectionTotals(sliceFor('Fax'));

    const sumOf = (s) => s.fc + s.bw + s.sc + s.tc;
    const allTotals = sumOf(total) || sumOf(copier) + sumOf(printer) + sumOf(fax);

    if (allTotals) {
      usage['Total Printed Impressions'] = allTotals;
      usage['Color Printed Impressions'] = (total.fc || copier.fc + printer.fc + fax.fc) + (total.sc || copier.sc + printer.sc + fax.sc) + (total.tc || copier.tc + printer.tc + fax.tc);
      usage['Black Printed Impressions'] = total.bw || copier.bw + printer.bw + fax.bw;
      usage['Full Color'] = total.fc || copier.fc + printer.fc + fax.fc;
      usage['Black & White'] = total.bw || copier.bw + printer.bw + fax.bw;
      usage['Single Color'] = total.sc || copier.sc + printer.sc + fax.sc;
      usage['Two-color'] = total.tc || copier.tc + printer.tc + fax.tc;
    }

    // Per-function breakdown (only when sections exist)
    const col = (s) => s.fc + s.sc + s.tc;
    const detail = (sumOf(copier) || sumOf(printer) || sumOf(fax))
      ? {
          print: { bw: printer.bw, color: col(printer) },
          copy: { bw: copier.bw, color: col(copier) },
          fax: { bw: fax.bw, color: col(fax) },
          source: 'ricoh_wim',
        }
      : null;

    return { usage, detail };
  }

  async snmpGetWithFallback(ip, oids, customCreds = null) {
    // Try snmpy (Python) first — only if available
    if (await this.snmpy.isAvailable()) {
      try {
        const res = await this.snmpy.getOids(ip, 'public', Array.isArray(oids) ? oids : [oids], Math.floor(this.timeout/1000));
        const oidArray = Array.isArray(oids) ? oids : [oids];
        return oidArray.map(oid => ({ oid, value: res[oid] }));
      } catch (e) {
        console.log(`[Poller] snmpy GET failed for ${ip}, falling back to node net-snmp: ${e.message}`);
      }
    }

    // Node.js fallback (v2c -> v1 -> v3)
    try {
      return await this.doSnmpGet(ip, oids, snmp.Version2c, 'public');
    } catch (e) {
      console.log(`[Poller] v2c failed for ${ip}, trying v1...`);
    }
    try {
      return await this.doSnmpGet(ip, oids, snmp.Version1, 'public');
    } catch (e) {}
    if (customCreds && customCreds.version === 3) {
      try {
        return await this.doSnmpV3Get(ip, oids, customCreds);
      } catch (e) {}
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
            const oidStr = vb && vb.oid ? (Array.isArray(vb.oid) ? vb.oid.join('.') : String(vb.oid)) : null;
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
            const oidStr = vb && vb.oid ? (Array.isArray(vb.oid) ? vb.oid.join('.') : String(vb.oid)) : null;
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
   * Safe OID string from varbind (handles both array and string)
   */
  oidStr(vb) {
    if (!vb || !vb.oid) return '';
    if (Array.isArray(vb.oid)) return vb.oid.join('.');
    return String(vb.oid);
  }

  /**
   * Legacy Node.js printer read (fallback when snmpy unavailable)
   */
  async readPrinterSNMP(dev) {
    const ip = dev.ip;
    const vendor = (dev.merk || '').toLowerCase();

    const parseCounter = (vb) => {
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

    let bw = 0, color = 0, total = 0;
    let isOnline = false;
    let lastError = null;

    if (vendor.includes('ricoh')) {
       // AMCS GetSNMP7 M1-M4: .367.3.2.1.2.19.1-4.0
       const ricohOids = [
          '1.3.6.1.4.1.367.3.2.1.2.19.1.0',
          '1.3.6.1.4.1.367.3.2.1.2.19.2.0',
          '1.3.6.1.4.1.367.3.2.1.2.19.3.0',
          '1.3.6.1.4.1.367.3.2.1.2.19.4.0',
       ];
       try {
          const varbinds = await this.snmpGetWithFallback(ip, ricohOids, dev.snmpConfig);
          isOnline = true;
          if (varbinds && varbinds.length >= 1) {
            const vals = varbinds.map(v => parseCounter(v));
            // M1 = Total Copy (all functions combined). BW/Color split:
            // M1 is total, try to get color from standard MIB if available
            total = vals[0] || 0;
            bw = total;
            color = 0;
            // Try standard MIB color split (prtMarkerLifeCount index 2 = color)
            try {
              const split = await this.snmpGetWithFallback(ip, ['1.3.6.1.2.1.43.10.2.1.4.1.1', '1.3.6.1.2.1.43.10.2.1.4.1.2'], dev.snmpConfig);
              if (split && split.length >= 2) {
                const c2 = parseCounter(split[1]);
                if (c2 > 0 && c2 < total) {
                  color = c2;
                  bw = total - c2;
                }
              }
            } catch (e) {}
          }
       } catch(e) {
          lastError = e;
       }
    } else {
      let bwOid = '1.3.6.1.2.1.43.10.2.1.4.1.1';
      let colorOid = '1.3.6.1.2.1.43.10.2.1.4.1.2';
      if (vendor.includes('hp')) {
        bwOid = '1.3.6.1.4.1.11.2.3.9.4.2.1.4.1.2.6.0';
        colorOid = '1.3.6.1.4.1.11.2.3.9.4.2.1.4.1.2.7.0';
      }
      // Try to get counters — for Xerox/Fuji use AMCS M1-M4 (GetSNMP1)
      let xeroxTry = false;
      if (vendor.includes('fuji') || vendor.includes('xerox')) {
        xeroxTry = true;
      }
      const oidSets = xeroxTry ? [
        // AMCS GetSNMP1 M1-M4: .253.8.53.13.2.1.6.101.20.1-4
        ['1.3.6.1.4.1.253.8.53.13.2.1.6.101.20.1', '1.3.6.1.4.1.253.8.53.13.2.1.6.101.20.2',
         '1.3.6.1.4.1.253.8.53.13.2.1.6.101.20.3', '1.3.6.1.4.1.253.8.53.13.2.1.6.101.20.4'],
        // Fallback: standard RFC
        [bwOid, colorOid],
      ] : [[bwOid, colorOid]];
      
      for (const oidSet of oidSets) {
        try {
          const varbinds = await this.snmpGetWithFallback(ip, oidSet, dev.snmpConfig);
          isOnline = true;
          if (varbinds && varbinds.length >= 1) {
            // M1-M4 path: M1 = main total
            const vals = varbinds.map(v => parseCounter(v));
            const validVals = vals.filter(v => v > 0);
            if (validVals.length >= 1) {
              if (oidSet.length === 4) {
                // M1-M4: M1 is total. Try color split from standard MIB (index 2)
                total = vals[0];
                bw = total;
                color = 0;
                try {
                  const split = await this.snmpGetWithFallback(ip, [bwOid, colorOid], dev.snmpConfig);
                  if (split && split.length >= 2) {
                    const c2 = parseCounter(split[1]);
                    if (c2 > 0 && c2 < total) {
                      color = c2;
                      bw = total - c2;
                    }
                  }
                } catch (e) {}
              } else {
                bw = vals[0]; color = vals[1] || 0; total = bw + (vals[1] || 0);
              }
              break;
            }
          }
        } catch(e) {
          lastError = e;
        }
      }
    }

    if (!isOnline) {
      throw lastError || new Error(`Device ${ip} is unreachable (SNMP Timeout)`);
    }

    if (bw === 0 && color === 0 && total > 0) {
      bw = total; 
    }

    // Toner via simple counter OIDs (no subtree — avoids vb.oid bug)
    const toner = [];
    try {
      const tonerOids = [
        '1.3.6.1.2.1.43.11.1.1.9.1.1',
        '1.3.6.1.2.1.43.11.1.1.9.1.2',
        '1.3.6.1.2.1.43.11.1.1.9.1.3',
        '1.3.6.1.2.1.43.11.1.1.9.1.4',
      ];
      const varbinds = await this.snmpGetWithFallback(ip, tonerOids, dev.snmpConfig);
      
      const colors = ['BLACK', 'CYAN', 'MAGENTA', 'YELLOW'];
      if (varbinds) {
        for (let i = 0; i < 4; i++) {
          const vb = varbinds[i];
          let val = null;
          if (!vb) continue;
          if (typeof vb === 'object') {
            if (snmp.isVarbindError && snmp.isVarbindError(vb)) continue;
            val = vb.value !== undefined ? vb.value : null;
          } else {
            val = vb;
          }
          const n = parseInt(val);
          if (!isNaN(n) && n >= 0 && n <= 100) toner.push({ warna: colors[i], level: n });
        }
      }
    } catch (err) {
      console.log(`[Poller] Toner GET failed for ${ip}: ${err.message}`);
    }

    // If no real toner data but counters exist, create synthetic estimation toners
    if ((!toner || toner.length === 0) && (bw > 0 || color > 0)) {
      const hasColor = color > 0;
      const colors = hasColor ? ['BLACK', 'CYAN', 'MAGENTA', 'YELLOW'] : ['BLACK'];
      colors.forEach((warna, i) => {
        toner.push({
          warna,
          level: -2,
          level_sekarang: -2,
          updated_at: new Date().toISOString(),
          estimated: true,
          estimated_from: 'Synthetic (supply table unreachable)',
        });
      });
    }

    return {
      bw_counter: bw,
      color_counter: color,
      toner,
      merk: dev.merk || null,
      model: dev.model || null,
      serial: dev.serial_number || '',
      location: dev.location || '',
      ip_address: dev.ip,
      scan_time: new Date().toISOString(),
    };
  }
}

module.exports = PollerService;
