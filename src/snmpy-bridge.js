/**
 * snmpy-bridge.js — Bridge between Node.js agent and snmpy Python scanner
 * =====================================================================
 * Calls snmpy_scanner.py via child_process for fast SNMP operations
 * snmpy uses GETBULK which is 10-50x faster than node's net-snmp
 * 
 * Usage:
 *   const SnmpyBridge = require('./snmpy-bridge');
 *   const bridge = new SnmpyBridge();
 *   const result = await bridge.probePrinter('10.10.30.244', 'public');
 *   const walkData = await bridge.walkOid('10.10.30.244', 'public', '1.3.6.1.2.1.43.11.1.1');
 */

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

class SnmpyBridge {
  constructor() {
    this.scriptPath = path.join(__dirname, '..', 'snmpy_scanner.py');
    this.useShell = process.platform === 'win32';
    // Resolve python SYNCHRONOUSLY — no async, no race conditions
    const fs = require('fs');
    const localVenv = path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe');
    if (fs.existsSync(localVenv)) {
      this.pythonCmd = localVenv;
      console.log(`[snmpy] Using .venv Python: ${localVenv}`);
    } else {
      this.pythonCmd = null;
      this._pyCandidates = ['python3', 'python'];
      if (process.platform === 'win32') this._pyCandidates.unshift('py');
      console.log(`[snmpy] .venv not found at ${localVenv}, will try system python on first exec()`);
    }
    this._resolvePromise = null;
    this._resolved = false;
  }

  /**
   * Singleton: reuse shared state across instances
   */
  static _shared = null;
  static getShared() {
    if (!SnmpyBridge._shared) SnmpyBridge._shared = new SnmpyBridge();
    return SnmpyBridge._shared;
  }

  /**
   * Lazy singleton factory — replaces module.exports
   */
  static getInstance() {
    if (!SnmpyBridge._shared) SnmpyBridge._shared = new SnmpyBridge();
    return SnmpyBridge._shared;
  }

  /**
   * Resolve system Python on first exec() (lazy, only if .venv not found)
   */
  async _resolveSystemPython() {
    const { spawnSync, execSync } = require('child_process');

    // On Windows: skip Microsoft Store alias, find real Python
    if (process.platform === 'win32') {
      // Where to find real python (excluding store alias)
      try {
        const out = execSync('where python', { encoding: 'utf8', timeout: 5000 });
        const paths = out.split('\n').map(s => s.trim()).filter(Boolean);
        for (const p of paths) {
          // Skip Microsoft Store alias or hermes agent
          if (p.includes('Microsoft') || p.includes('hermes')) continue;
          const r = spawnSync(p, ['-c', 'import snmpy; print(1)'], { timeout: 5000, encoding: 'utf8' });
          if (r.status === 0) { console.log(`[snmpy] Found Python: ${p}`); return p; }
        }
      } catch (e2) {}
    }

    for (const cmd of this._pyCandidates) {
      const r = spawnSync(cmd, ['-c', 'import snmpy; print(1)'], { timeout: 5000, encoding: 'utf8', shell: true });
      if (r.status === 0) {
        console.log(`[snmpy] Found Python: ${cmd}`);
        return cmd;
      }
    }
    return null;
  }

  /**
   * Check if snmpy is available — fast .venv check, lazy system resolve
   */
  async isAvailable() {
    if (this.pythonCmd) return true;
    if (!this._resolved) {
      this._resolved = true;
      if (!this._resolvePromise) {
        this._resolvePromise = this._resolveSystemPython().then(py => { this.pythonCmd = py; });
      }
      await this._resolvePromise;
    }
    return !!this.pythonCmd;
  }

  /**
   * Execute snmpy scanner with args, return parsed JSON
   */
  async exec(args) {
    if (!this.pythonCmd) {
      if (!this._resolvePromise) {
        this._resolvePromise = this._resolveSystemPython().then(py => { this.pythonCmd = py; });
      }
      await this._resolvePromise;
    }
    if (!this.pythonCmd) {
      throw new Error('snmpy: Python not found. Install Python or use fallback scanner.');
    }
    
    const fullArgs = [this.scriptPath, ...args];
    return await this.spawnWithTimeout(this.pythonCmd, fullArgs, 60000);
  }

  /**
   * Spawn process with timeout, return parsed JSON
   */
  spawnWithTimeout(cmd, args, timeoutMs) {
    return new Promise((resolve, reject) => {
      const opts = {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        timeout: timeoutMs,
      };
      // Only use shell for short command names (aliases like 'py', 'python')
      // Full paths (.venv, where.exe results) go directly — space-safe with args array
      const isShortName = !cmd.includes('\\') && !cmd.includes('/');
      if (this.useShell && isShortName) opts.shell = true;
      const proc = spawn(cmd, args, opts);
      
      let stdout = '';
      let stderr = '';
      
      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        // On Windows SIGTERM doesn't kill — try taskkill
        if (process.platform === 'win32') {
          try { require('child_process').execSync(`taskkill /F /PID ${proc.pid}`, { timeout: 2000 }); } catch(e) {}
        }
        reject(new Error(`snmpy timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      
      proc.on('close', (code) => {
        clearTimeout(timer);
        
        if (code !== 0 && !stdout) {
          reject(new Error(`snmpy exited code ${code}: ${stderr.trim()}`));
          return;
        }
        
        // Extract JSON from stdout — handle Python warnings/messages before JSON
        let jsonStr = stdout;
        const firstBrace = stdout.indexOf('{');
        const firstBracket = stdout.indexOf('[');
        const jsonStart = (firstBrace >= 0 && firstBracket >= 0) ? Math.min(firstBrace, firstBracket) :
                          (firstBrace >= 0) ? firstBrace : firstBracket;
        if (jsonStart > 0) jsonStr = stdout.substring(jsonStart);
        
        try {
          const parsed = JSON.parse(jsonStr);
          resolve(parsed);
        } catch (e) {
          if (stderr) console.warn(`[snmpy] stderr: ${stderr.substring(0, 500)}`);
          reject(new Error(`snmpy JSON parse error: ${jsonStr.substring(0, 200)}`));
        }
      });
    });
  }

  /**
   * Full printer probe using snmpy
   */
  async probePrinter(ip, community = 'public', timeout = 3) {
    const args = [ip, `--community`, community, `--timeout`, String(timeout), `--probe`];
    const result = await this.exec(args);
    
    if (result && result.error) {
      if (result.printer === false) {
        return null; // Not a printer
      }
      throw new Error(result.error);
    }
    
    // Map to unified format
    return this.mapToUnified(ip, result);
  }

  /**
   * Map snmpy output to unified scanner format
   */
  mapToUnified(ip, data) {
    if (!data) return null;
    
    // Build toner list
    let tonerList = (data.supplies && data.supplies.toners || []).map(t => ({
      color: this.normalizeTonerWarna(t.description),
      percentage: t.percentage,
      status: t.percentage !== null ? (t.percentage < 10 ? 'Critical' : t.percentage < 30 ? 'Low' : 'OK') : 'Unknown',
      estimated: false,
    }));
    
    // Estimate unknown toners from page count ÷ yield
    tonerList = this.estimateTonerLevels(tonerList, data);
    
    return {
      ip: data.ip || ip,
      hostname: data.hostname || ip,
      vendor: data.vendor || 'unknown',
      model: data.model || '',
      serial: data.serial || '',
      location: (data.device && data.device.sysLocation) || '',
      uptime: data.device && data.device.sysUptime ? this.formatUptime(data.device.sysUptime) : '',
      total_pages: data.total_pages || 0,
      total_bw: data.total_bw || 0,
      total_color: data.total_color || 0,
      toner_levels: tonerList,
      waste_toner: (data.supplies && data.supplies.waste || []).map(w => ({
        description: w.description,
        percentage: w.percentage,
        status: w.percentage !== null ? (w.percentage > 85 ? 'Full' : 'OK') : 'Unknown',
      })),
      paper_trays: (data.trays || []).map(t => ({
        index: t.index,
        media: t.media || 'Unknown',
        sheets: t.sheets,
      })),
      critical_alerts: (data.alerts || []).filter(a => a.severity >= 8).length,
      warnings: (data.alerts || []).filter(a => a.severity >= 4 && a.severity < 8).length,
      active_jobs: (data.jobs || []).length,
      details: {
        device_info: {
          sys_descr: data.device && data.device.sysDescr,
          sys_object_id: data.device && data.device.sysObjectID,
          hostname: data.device && data.device.sysName,
          model: data.model,
          serial: data.serial,
          location: data.device && data.device.sysLocation,
          uptime_human: this.formatUptime(data.device && data.device.sysUptime),
          vendor: data.vendor,
        },
        counters: data.counters || [],
        supplies: data.supplies || {},
        paper_trays: data.trays || [],
        alerts: data.alerts || [],
        jobs: data.jobs || [],
      },
      scan_time: new Date().toISOString(),
      counter_source: data.counter_source || 'standard',
      vendor_counters_estimated: data.vendor_counters_estimated || false,
    };
  }

  /**
   * Estimate toner levels when printer doesn't report digital level
   * Uses total_bw page count for black, total_color for CMY ÷ typical yield
   * Marks estimated=true, stores raw estimate in estimated_from/note
   */
  estimateTonerLevels(tonerList, data) {
    const totalBW = data.total_bw || 0;
    const totalColor = data.total_color || 0;
    const totalPages = data.total_pages || 0;
    const vendor = (data.vendor || '').toLowerCase();
    const model = (data.model || '').toLowerCase();
    
    // OEM cartridge yields (pages @5% ISO/IEC 19798) — researched from official datasheets
    // Non-original/refill toners usually match OEM page yield ±10%
    const yields = {
      'ricoh': { black: 12000, color: 6000 },
      'ricoh:im c2010': { black: 12000, color: 6000 },       // Ricoh D0BK2200/D0BK2300
      'ricoh:im c3010': { black: 15000, color: 8000 },       // Ricoh D0BK2400/D0BK2500
      'ricoh:im c3510': { black: 20000, color: 10000 },
      'ricoh:im c4510': { black: 20000, color: 10000 },       // Ricoh D0BK2000/D0BK2100
      'ricoh:im c5510': { black: 30000, color: 15000 },
      'ricoh:im c6010': { black: 30000, color: 15000 },
      'ricoh:sp 325sfnw': { black: 12000, color: 0 },        // Mono laser
      'ricoh:sp 8400dn': { black: 25000, color: 0 },
      'ricoh:sp c252sf': { black: 4000, color: 3000 },
      'hp': { black: 6000, color: 4000 },
      'hp:laserjet': { black: 7000, color: 5000 },
      'hp:pagewide': { black: 10000, color: 8000 },          // HP 973X high-capacity
      'hp:pagewide pro 552': { black: 10000, color: 8000 },  // HP 970XL/971XL/972XL/973XL
      'hp:pagewide pro 452': { black: 6000, color: 6000 },
      'hp:officejet': { black: 6000, color: 4000 },
      'hp:officejet pro 87': { black: 6000, color: 4000 },
      'hp:laserjet m404': { black: 8000, color: 0 },
      'hp:laserjet m454': { black: 2600, color: 2600 },      // HP 416A series
      'hp:laserjet m507': { black: 8000, color: 5000 },
      'hp:laserjet mfp m527': { black: 8000, color: 5000 },
      'hp:laserjet enterpris': { black: 12000, color: 8000 },
      'canon': { black: 8000, color: 5000 },
      'canon:imagerunner': { black: 12000, color: 7000 },
      'canon:imagerunner 2200': { black: 16000, color: 9000 },
      'canon:imagerunner 2500': { black: 20000, color: 10000 },
      'canon:lbp': { black: 5000, color: 4000 },
      'epson': { black: 5000, color: 4000 },
      'epson:workforce': { black: 6000, color: 5000 },
      'epson:ecotank': { black: 8000, color: 6000 },         // Bottle yield
      'brother': { black: 5000, color: 3000 },
      'brother:hl-l23': { black: 12000, color: 0 },
      'brother:mfc-l37': { black: 12000, color: 0 },
      'brother:hl-l32': { black: 6000, color: 0 },
      'kyocera': { black: 10000, color: 6000 },
      'kyocera:taskalfa 180': { black: 14000, color: 7000 },
      'kyocera:taskalfa 220': { black: 14000, color: 7000 },
      'kyocera:taskalfa 255': { black: 14000, color: 7000 },
      'kyocera:ecosys': { black: 10000, color: 5000 },
      'konicaminolta': { black: 12000, color: 7000 },
      'konicaminolta:bizhub 215': { black: 12000, color: 0 },
      'konicaminolta:bizhub 235': { black: 12000, color: 0 },
      'konicaminolta:bizhub c220': { black: 12000, color: 7000 },
      'konicaminolta:bizhub c280': { black: 18000, color: 12000 },
      'konicaminolta:bizhub c360': { black: 18000, color: 12000 },
      'konicaminolta:bizhub c450': { black: 23000, color: 15000 },
      'konicaminolta:bizhub c550': { black: 23000, color: 15000 },
      'sharp': { black: 10000, color: 6000 },
      'sharp:mx-2640': { black: 10000, color: 6000 },
      'sharp:mx-3140': { black: 10000, color: 6000 },
      'sharp:mx-4140': { black: 20000, color: 10000 },
      'xerox': { black: 10000, color: 6000 },
      'xerox:apeosport': { black: 26000, color: 15000 },     // ApeosPort-V C3376 actual
      'xerox:apeosport-v c3376': { black: 26000, color: 15000 },
      'xerox:apeosport-v c4476': { black: 26000, color: 15000 },
      'xerox:workcentre': { black: 12000, color: 8000 },
      'xerox:workcentre 78': { black: 16000, color: 10000 },
      'xerox:workcentre 58': { black: 16000, color: 10000 },
      'xerox:altalink': { black: 20000, color: 12000 },
      'xerox:versalink': { black: 12000, color: 7000 },
      'xerox:phaser': { black: 6000, color: 5000 },
      'toshiba': { black: 10000, color: 6000 },
      'toshiba:e-studio 2308': { black: 10000, color: 6000 },
      'toshiba:e-studio 2808': { black: 15000, color: 8000 },
      'samsung': { black: 5000, color: 3000 },
      'samsung:sl-m28': { black: 12000, color: 0 },
      'oki': { black: 8000, color: 5000 },
    };
    
    // Find best matching yield profile
    let profile = yields[vendor]; // vendor default
    for (const [key, val] of Object.entries(yields)) {
      if (key.startsWith(vendor + ':') && model.includes(key.split(':')[1])) {
        profile = val;
        break;
      }
    }
    if (!profile) profile = { black: 8000, color: 5000 }; // fallback generic
    
    // Count color toners to divide total_color fairly
    const colorTonerCount = tonerList.filter(t => {
      const cn = (t.color || '').toLowerCase();
      return !(cn.includes('black') || cn.includes('k') || cn.includes('negro'));
    }).length;
    const colorPerToner = colorTonerCount > 0 ? Math.round(totalColor / colorTonerCount) : totalColor;
    
    return tonerList.map(t => {
      if (t.percentage !== null) return t; // real data, no estimation needed
      
      const colorName = (t.color || '').toLowerCase();
      const isBlack = colorName.includes('black') || colorName.includes('k') || colorName.includes('negro');
      
      let estPct = null;
      let note = '';
      
      if (isBlack && totalBW > 0 && profile.black > 0) {
        estPct = Math.max(0, Math.min(100, Math.round(100 - (totalBW / profile.black) * 100)));
        note = `Est. from BW pages (${totalBW}/${profile.black})`;
      } else if (!isBlack && colorPerToner > 0 && profile.color > 0) {
        estPct = Math.max(0, Math.min(100, Math.round(100 - (colorPerToner / profile.color) * 100)));
        note = `Est. from color pages ÷${colorTonerCount} (${colorPerToner}/${profile.color})`;
      } else if (totalPages > 0) {
        // Fallback: use total pages split evenly across 4 toners
        const perToner = Math.round(totalPages / 4);
        estPct = Math.max(0, Math.min(100, Math.round(100 - (perToner / (profile.black || 8000)) * 100)));
        note = `Est. from total pages ÷ 4 (${totalPages}/4)`;
      }
      
      if (estPct !== null) {
        return {
          ...t,
          percentage: estPct,
          status: estPct < 10 ? 'Critical' : estPct < 30 ? 'Low' : 'OK',
          estimated: true,
          estimated_from: note,
        };
      }
      return t; // no estimation possible, keep Unknown
    });
  }

  formatUptime(ticks) {
    if (!ticks && ticks !== 0) return '';
    try {
      const seconds = Math.floor(Number(ticks) / 100);
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor((seconds % 86400) / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = seconds % 60;
      return `${days}d ${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } catch {
      return String(ticks);
    }
  }

  normalizeTonerWarna(raw) {
    if (!raw) return 'UNKNOWN';
    // Strip everything after ; [ ( (serial numbers)
    let s = raw.replace(/[;\[(].*$/, '').trim();
    // Extract just the base color name (first word that is a known color)
    const colorWords = s.split(/[\s,]+/);
    for (const word of colorWords) {
      const upper = word.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (['BLACK','K','BK'].includes(upper)) return 'BLACK';
      if (['CYAN','C'].includes(upper)) return 'CYAN';
      if (['MAGENTA','M'].includes(upper)) return 'MAGENTA';
      if (['YELLOW','Y'].includes(upper)) return 'YELLOW';
    }
    // Fallback: return first word uppercased
    return colorWords[0].toUpperCase();
  }

  /**
   * Walk OID subtree using snmpy
   */
  async walkOid(ip, community, baseOid, timeout = 10) {
    const args = [ip, `--community`, community, `--walk`, baseOid, `--timeout`, String(timeout)];
    return await this.exec(args);
  }

  /**
   * GET one or more OIDs using snmpy
   * Returns an object mapping oid -> value (parsed)
   */
  async getOids(ip, community, oids = [], timeout = 5) {
    if (!Array.isArray(oids)) oids = [oids];
    if (oids.length === 0) return {};
    const args = [ip, `--community`, community, `--timeout`, String(timeout), `--get`, ...oids];
    const result = await this.exec(args);
    // result should be a JSON map of oid->value
    return result || {};
  }

  /**
   * Phased NDJSON printer probe — streams phases progressively
   * Each line is {"phase":"identity|counters|supplies|detail|complete", ...}
   * Returns an async generator yielding each phase object
   */
  async *streamProbe(ip, community = 'public', timeout = 10) {
    const args = [ip, `--community`, community, `--timeout`, String(timeout), `--probe-phased`];
    
    // Lazy resolve system python if .venv wasn't found
    if (!this.pythonCmd && !this._resolving) {
      this._resolving = true;
      this.pythonCmd = await this._resolveSystemPython();
    }
    if (!this.pythonCmd) {
      throw new Error('snmpy: Python not found. Install Python or use fallback scanner.');
    }
    
    const fullArgs = [this.scriptPath, ...args];
    const proc = spawn(this.pythonCmd, fullArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    
    let buffer = '';
    let settled = false;
    
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill('SIGTERM');
        if (process.platform === 'win32') {
          try { require('child_process').execSync(`taskkill /F /PID ${proc.pid}`, { timeout: 2000 }); } catch(e) {}
        }
      }
    }, (timeout + 5) * 1000);  // Phased probe may take longer
    
    try {
      for await (const chunk of proc.stdout) {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';  // Keep incomplete line
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const phase = JSON.parse(line);
            settled = phase.phase === 'complete';
            yield phase;
          } catch (e) {
            console.warn(`[snmpy] streamProbe parse error: ${line.substring(0, 100)}`);
          }
        }
      }
      // Process remaining buffer
      if (buffer.trim()) {
        try {
          yield JSON.parse(buffer);
        } catch (e) {}
      }
    } finally {
      clearTimeout(timer);
      if (!settled) {
        proc.kill();
        if (process.platform === 'win32') {
          try { require('child_process').execSync(`taskkill /F /PID ${proc.pid}`, { timeout: 2000 }); } catch(e) {}
        }
      }
    }
  }

  /**
   * Deep comprehensive printer probe — walks ALL reachable OIDs
   * Returns exhaustive data including raw_oids for pricing
   */
  async deepProbePrinter(ip, community = 'public', timeout = 10) {
    const args = [ip, `--community`, community, `--timeout`, String(timeout), `--probe`];
    const result = await this.exec(args);
    
    if (result && result.error) {
      if (result.printer === false) return null;
      throw new Error(result.error);
    }
    
    // Map to unified format + attach raw_oids for deep analysis
    const unified = this.mapToUnified(ip, result);
    if (unified) {
      unified.raw_oids = result.raw_oids || {};
      unified.walk_stats = result.walk_stats || {};
      // Also expose nested supplies/trays/alerts for compatibility
      unified.supplies = result.supplies || {};
      unified.trays = result.trays || [];
      unified.alerts = result.alerts || [];
      unified.jobs = result.jobs || [];
      unified.counters_raw = result.counters || [];
      // Ensure merk/model from deep probe
      unified.merk = result.vendor || unified.vendor;
      unified.model = result.model || unified.model;
      unified.ip_address = result.ip || ip;
    }
    return unified;
  }

}

module.exports = SnmpyBridge;
