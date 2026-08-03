/**
 * MibWalkerService.js — Background MIB Walk Engine
 * =================================================
 * Walks printer MIB subtrees via Node.js net-snmp GETBULK.
 * Runs only when CPU idle (>5m after last poll).
 * One printer per cycle, max 1 walk per 10 minutes.
 *
 * Replaces: snmpy-bridge.js (Python), oid-profiles.js (hardcoded)
 * 
 * @version 1.0.0
 */

const snmp = require('net-snmp');
const LocalDatabase = require('./LocalDatabase');

const WALK_INTERVAL_MS = 10 * 60 * 1000;   // 10 min between walks
const IDLE_DELAY_MS   = 5 * 60 * 1000;     // 5 min idle before first walk
const WALK_TIMEOUT_MS = 15 * 1000;          // 15s per subtree
const MAX_CANDIDATE   = 99999999;

class MibWalkerService {
  constructor(dataDir) {
    this.db = new LocalDatabase(dataDir);
    this.queue = [];
    this.running = false;
    this._scheduledTimer = null;
    this._lastWalkAt = 0;
  }

  /**
   * Add a printer to the walk queue. Skips if model already verified.
   */
  enqueue(dev) {
    if (!dev || !dev.ip) return;
    const model = dev.model || '';
    if (model && this.db.isVerified(model)) {
      console.log(`[MIB Walk] ${dev.ip} (${model}) already verified, skipping`);
      return;
    }
    const exists = this.queue.some(q => q.ip === dev.ip);
    if (exists) return;
    this.queue.push({
      id: dev.id || dev.ip,
      ip: dev.ip,
      model: model || dev.ip,
      vendor: dev.vendor || 'Unknown',
      status: 'pending',
      addedAt: Date.now(),
    });
    console.log(`[MIB Walk] ${dev.ip} enqueued (${this.queue.length} pending)`);
    this._schedule();
  }

  /** Enqueue all tracked devices */
  enqueueAll(devices) {
    (devices || []).forEach(d => this.enqueue(d));
  }

  /**
   * Schedule walk when idle. Uses timeout (not interval) — auto-reschedules.
   */
  _schedule() {
    if (this.running || this._scheduledTimer || this.queue.length === 0) return;
    const elapsed = Date.now() - this._lastWalkAt;
    const delay = Math.max(IDLE_DELAY_MS, WALK_INTERVAL_MS - elapsed);
    console.log(`[MIB Walk] Next walk in ${Math.round(delay/1000)}s (${this.queue.length} queued)`);
    this._scheduledTimer = setTimeout(() => {
      this._scheduledTimer = null;
      this._processQueue();
    }, delay);
  }

  /**
   * Process ONE printer from queue.
   */
  async _processQueue() {
    if (this.running || this.queue.length === 0) return;
    this.running = true;
    const dev = this.queue.shift();

    try {
      console.log(`[MIB Walk] Snapshotting ${dev.ip} (${dev.model})...`);
      const snapshot = await this._takeSnapshot(dev.ip);
      if (!snapshot || Object.keys(snapshot.oids).length < 5) {
        console.log(`[MIB Walk] ${dev.ip}: too few OIDs (${Object.keys(snapshot.oids||{}).length}), retry later`);
        dev.status = 'failed';
        this.queue.push(dev); // retry later
      } else {
        const candidates = this._extractCandidates(snapshot.oids);
        this.db.saveSnapshot(dev.id, 'initial', { ip: dev.ip, ts: snapshot.ts, oids: snapshot.oids, candidateCount: candidates.length });
        this.db.addPending({
          device_id: dev.id, device_ip: dev.ip,
          model: dev.model, vendor: dev.vendor,
          candidates, snapshot_count: Object.keys(snapshot.oids).length,
          status: 'pending',
        });
        console.log(`[MIB Walk] ${dev.model}: ${candidates.length} candidates from ${Object.keys(snapshot.oids).length} OIDs`);
      }
    } catch (err) {
      console.error(`[MIB Walk] ${dev.ip} failed: ${err.message}`);
      dev.status = 'failed';
      this.queue.push(dev); // retry later
    }

    this.running = false;
    this._lastWalkAt = Date.now();
    // Schedule next run
    this._scheduledTimer = setTimeout(() => {
      this._scheduledTimer = null;
      this._processQueue();
    }, WALK_INTERVAL_MS);
  }

  /**
   * Take SNMP snapshot via GETBULK on 3 key subtrees.
   * Pure Node.js — zero Python dependency.
   */
  async _takeSnapshot(ip) {
    const subtrees = ['1.3.6.1.2.1.1', '1.3.6.1.2.1.43', '1.3.6.1.4.1'];
    const snapshot = { ip, ts: Date.now(), oids: {} };

    for (const subtree of subtrees) {
      try {
        const results = await this._bulkWalk(ip, subtree);
        for (const r of results) {
          if (r.oid) snapshot.oids[r.oid] = { value: r.value, type: r.type };
        }
      } catch (e) {
        // subtree failed — skip, continue next
      }
    }
    return snapshot;
  }

  /**
   * GETBULK walk a subtree. Returns [{oid, value, type}].
   */
  _bulkWalk(ip, subtree) {
    return new Promise((resolve, reject) => {
      const session = snmp.createSession(ip, 'public', {
        timeout: 5000, retries: 0, version: snmp.Version2c,
      });
      const entries = [];
      const maxRepetitions = 10;

      const callback = (error, varbinds) => {
        if (error) { session.close(); return reject(error); }
        if (!varbinds || varbinds.length === 0) { session.close(); return resolve(entries); }
        let done = false;
        for (const vb of varbinds) {
          if (snmp.isVarbindError && snmp.isVarbindError(vb)) continue;
          const oid = (Array.isArray(vb.oid) ? vb.oid.join('.') : String(vb.oid));
          if (!oid.startsWith(subtree)) { done = true; break; }
          entries.push({ oid, value: vb.value, type: vb.type });
        }
        if (done) { session.close(); resolve(entries); }
        else { session.getNext(varbinds, callback); }
      };

      const startOid = subtree.split('.').map(Number);
      session.getNext([{ oid: startOid, maxRepetitions }], callback);

      // Timeout safety
      setTimeout(() => {
        try { session.close(); } catch {}
        reject(new Error(`GETBULK ${subtree} timed out`));
      }, WALK_TIMEOUT_MS);
    });
  }

  /**
   * Extract counter candidates from raw snapshot.
   * Rules: numeric, 1..MAX_CANDIDATE, not TimeTicks, not String.
   */
  _extractCandidates(oids) {
    const candidates = [];
    for (const [oid, v] of Object.entries(oids)) {
      // Must be number
      if (typeof v.value !== 'number') continue;
      // Skip zero, negative, huge
      if (v.value < 1 || v.value > MAX_CANDIDATE) continue;
      // Skip timeticks
      if (v.type === 8) continue;
      // Skip string types
      if (v.type === 4) continue;
      // Skip MAC/IP-like OIDs (too many variations)
      if (oid.includes('.1.3.6.1.2.1.2.2.1') || oid.includes('.1.3.6.1.2.1.4.20.1')) continue;
      // Counter or Integer or Gauge
      candidates.push({ oid, value: v.value, type: v.type });
    }
    // Sort by value descending — most likely real counters first
    candidates.sort((a, b) => b.value - a.value);
    return candidates;
  }

  /**
   * After 24h, take snapshot B and diff to confirm real counters by delta.
   */
  async verifySnapshot(devIp, deviceId) {
    const snapA = this.db.getSnapshot(deviceId, 'initial');
    if (!snapA) return [];
    const snapB = await this._takeSnapshot(devIp);
    this.db.saveSnapshot(deviceId, 'verify', snapB);

    const changes = [];
    for (const [oid, vA] of Object.entries(snapA.oids)) {
      const vB = snapB.oids[oid];
      if (vB && typeof vA.value === 'number' && typeof vB.value === 'number') {
        const delta = vB.value - vA.value;
        if (delta > 0 && delta < 10000) {
          changes.push({ oid, delta, before: vA.value, after: vB.value });
        }
      }
    }
    return changes.sort((a, b) => b.delta - a.delta);
  }

  /** Walk queue size */
  getQueueLength() { return this.queue.length; }
}

module.exports = MibWalkerService;
