/**
 * LocalDatabase.js — JSON-file OID store
 * =======================================
 * Drop-in for the MIB Walk Plan's "SQLite lokal" concept.
 * No native modules needed (JSON is always available).
 *
 * Stores:
 *   verified-oids.json   — {model → {oid_m1, oid_m2, ..., confirmed_at}}
 *   mib-snapshots/       — {device_id}_{snapshot_id}.json
 *   pending-verify.json  — [{device_id, model, vendor, candidates, status}]
 *
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');

class LocalDatabase {
  constructor(dataDir) {
    this.dataDir = dataDir || path.join(process.cwd(), 'data');
    this.verifiedPath = path.join(this.dataDir, 'verified-oids.json');
    this.pendingPath = path.join(this.dataDir, 'pending-verify.json');
    this.snapshotDir = path.join(this.dataDir, 'mib-snapshots');
    this._ensureDirs();
    this._cache = { verified: null, pending: null };
  }

  _ensureDirs() {
    [this.dataDir, this.snapshotDir].forEach(d => {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    });
  }

  _readJson(p) {
    try {
      if (!fs.existsSync(p)) return {};
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch { return {}; }
  }

  _writeJson(p, data) {
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
  }

  // ── Verified OIDs ──

  getVerified() {
    if (!this._cache.verified) this._cache.verified = this._readJson(this.verifiedPath);
    return this._cache.verified;
  }

  getVerifiedForModel(model) {
    if (!model) return null;
    return this.getVerified()[model] || null;
  }

  isVerified(model) {
    return !!this.getVerifiedForModel(model);
  }

  saveVerified(model, oidMap) {
    const db = this.getVerified();
    db[model] = { ...oidMap, confirmed_at: Date.now() };
    this._writeJson(this.verifiedPath, db);
    this._cache.verified = db;
  }

  syncFromWorker(oidDb) {
    // oidDb = [{model, oid_m1, oid_m2, ...}] from Worker API
    const db = {};
    for (const entry of oidDb) {
      if (entry && entry.model) db[entry.model] = { ...entry, confirmed_at: Date.now() };
    }
    this._writeJson(this.verifiedPath, db);
    this._cache.verified = db;
  }

  getAllVerifiedModels() {
    return Object.keys(this.getVerified());
  }

  // ── Snapshots ──

  saveSnapshot(deviceId, snapshotId, data) {
    const fp = path.join(this.snapshotDir, `${deviceId}_${snapshotId}.json`);
    fs.writeFileSync(fp, JSON.stringify(data), 'utf-8');
  }

  getSnapshot(deviceId, snapshotId) {
    const fp = path.join(this.snapshotDir, `${deviceId}_${snapshotId}.json`);
    try { return JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { return null; }
  }

  listSnapshots(deviceId) {
    const prefix = `${deviceId}_`;
    try {
      return fs.readdirSync(this.snapshotDir)
        .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
        .map(f => f.replace('.json', '').replace(prefix, ''));
    } catch { return []; }
  }

  cleanOldSnapshots(maxAgeDays = 30) {
    const cutoff = Date.now() - maxAgeDays * 86400000;
    try {
      for (const f of fs.readdirSync(this.snapshotDir)) {
        const fp = path.join(this.snapshotDir, f);
        const stat = fs.statSync(fp);
        if (stat.mtimeMs < cutoff) fs.unlinkSync(fp);
      }
    } catch {}
  }

  // ── Pending Verification ──

  getPending() {
    if (!this._cache.pending) {
      const raw = this._readJson(this.pendingPath);
      this._cache.pending = Array.isArray(raw) ? raw : [];
    }
    return this._cache.pending;
  }

  addPending(entry) {
    const list = this.getPending();
    // Dedupe by device_id
    const idx = list.findIndex(p => p.device_id === entry.device_id);
    if (idx >= 0) list[idx] = { ...list[idx], ...entry, updated_at: Date.now() };
    else list.push({ ...entry, added_at: Date.now(), updated_at: Date.now(), status: 'pending' });
    this._writeJson(this.pendingPath, list);
    this._cache.pending = list;
  }

  markPendingSubmitted(deviceId) {
    const list = this.getPending();
    const e = list.find(p => p.device_id === deviceId);
    if (e) { e.status = 'submitted'; e.submitted_at = Date.now(); }
    this._writeJson(this.pendingPath, list);
  }

  markPendingVerified(deviceId) {
    const list = this.getPending();
    const idx = list.findIndex(p => p.device_id === deviceId);
    if (idx >= 0) list.splice(idx, 1);
    this._writeJson(this.pendingPath, list);
    this._cache.pending = list;
  }

  getPendingCount() {
    return this.getPending().filter(p => p.status === 'pending').length;
  }

  getPendingForUpload() {
    return this.getPending().filter(p => p.status === 'pending');
  }
}

module.exports = LocalDatabase;
