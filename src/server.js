const http = require('http');
const fs = require('fs');
const path = require('path');
const Poller = require('./poller');
const Scanner = require('./scanner');
const ApiClient = require('./api-client');
const notifier = require('./notifier');

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const CONFIG_PATH = path.join(process.cwd(), 'config.json');
const LOG_DIR = path.join(process.cwd(), 'logs');

function loadConfig() {
  try {
    return fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) : null;
  } catch { return null; }
}

function saveConfig(c) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2));
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function log(...args) {
  const ts = new Date().toISOString();
  const msg = `[${ts}] ${args.join(' ')}`;
  console.log(msg);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, `agent-${ts.slice(0, 10)}.log`), msg + '\n');
  } catch {}
}

let daemonTimer = null;

async function startDaemon(config) {
  stopDaemon();
  try {
    const apiClient = new ApiClient(config);
    const poller = new Poller(config);
    log('Daemon started');

    async function cycle() {
      try {
        const machines = await apiClient.getMachines();
        const pollable = machines.filter(m => m.ip_address);
        let ok = 0, er = 0;
        
        for (const machine of pollable) {
          const alive = await poller.ping(machine.ip_address);
          await apiClient.submitStatus(machine.id, alive).catch(() => {});
          
          try {
            const result = await poller.pollMachine(machine);
            const delta = (result.delta_bw || 0) + (result.delta_color || 0);
            if (delta > 0) {
              await apiClient.submitReading(machine.id, result);
            }
            if (result.toner_levels) {
              for (const [color, level] of Object.entries(result.toner_levels)) {
                if (level !== null && level <= 25) {
                  notifier.alertLowToner(machine.merk, machine.model, machine.ip_address, color, level);
                }
              }
            }
            ok++;
          } catch {
            er++;
          }
        }
        
        log(`Cycle: ${ok} ok, ${er} failed`);
        await apiClient.submitLogs({ ok, er, ts: new Date().toISOString() }).catch(() => {});
      } catch (err) {
        log('Cycle err: ' + err.message);
      }
    }

    await cycle(); // run immediately
    daemonTimer = setInterval(cycle, (config.polling_interval_hours || 6) * 3600000);
    return true;
  } catch (err) {
    log('Daemon start fail: ' + err.message);
    return false;
  }
}

function stopDaemon() {
  if (daemonTimer) {
    clearInterval(daemonTimer);
    daemonTimer = null;
    log('Daemon stopped');
  }
}

function startServer(onStart) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://' + req.headers.host);
    const p = url.pathname;

    if (p === '/api/ping') return json(res, { ok: true });
    
    if (p === '/api/login' && req.method === 'POST') {
      let b = '';
      req.on('data', c => b += c);
      req.on('end', async () => {
        try {
          const creds = JSON.parse(b);
          // using node-fetch for API calls
          const fetch = require('node-fetch');
          const bk = await fetch('https://printpulse-api.printpulse-api.workers.dev/api/agent/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: creds.email, password: creds.password })
          });
          const d = await bk.json();
          if (d.config) {
            saveConfig(d.config);
            await startDaemon(d.config);
            json(res, { ok: true, config: d.config, user: d.user });
          } else {
            json(res, { error: d.error || 'Login failed' }, 401);
          }
        } catch (e) {
          json(res, { error: e.message }, 500);
        }
      });
      return;
    }

    if (p === '/api/config' && req.method === 'GET') return json(res, loadConfig() || {});
    if (p === '/api/config' && req.method === 'POST') {
      let b = '';
      req.on('data', c => b += c);
      req.on('end', () => {
        try {
          saveConfig(JSON.parse(b));
          json(res, { ok: true });
        } catch (e) {
          json(res, { error: e.message }, 400);
        }
      });
      return;
    }

    if (p === '/api/config/status') {
      const c = loadConfig();
      if (!c) return json(res, { configured: false });
      try {
        const m = await (new ApiClient(c)).getMachines();
        return json(res, { configured: true, tenant: c.tenant_id, machines: m.length });
      } catch (e) {
        return json(res, { configured: true, error: e.message });
      }
    }

    if (p === '/api/daemon/start') {
      const c = loadConfig();
      return json(res, c ? { ok: await startDaemon(c) } : { error: 'Not configured' }, c ? 200 : 400);
    }
    
    if (p === '/api/daemon/stop') {
      stopDaemon();
      return json(res, { ok: true });
    }
    
    if (p === '/api/daemon/status') {
      const c = loadConfig();
      return json(res, { running: daemonTimer !== null, configured: !!(c && c.api_url && c.api_key) });
    }

    if (p === '/api/discovery') {
      const c = loadConfig();
      if (!c) return json(res, { error: 'Not configured' }, 400);
      try {
        const scanner = new Scanner(c);
        const r = await scanner.scan();
        await (new ApiClient(c)).submitDiscovery(r);
        return json(res, { ok: true, devices: r.devices.length, printers: r.devices.filter(d => d.snmp_result).length });
      } catch (e) {
        return json(res, { error: e.message }, 500);
      }
    }

    if (p === '/api/machines') {
      const c = loadConfig();
      if (!c) return json(res, { error: 'Not configured' }, 400);
      try {
        return json(res, await (new ApiClient(c)).getMachines());
      } catch (e) {
        return json(res, { error: e.message }, 500);
      }
    }

    if (p === '/api/logs') {
      try {
        const lf = path.join(LOG_DIR, `agent-${new Date().toISOString().slice(0, 10)}.log`);
        return json(res, { logs: fs.existsSync(lf) ? fs.readFileSync(lf, 'utf8') : '' });
      } catch {
        return json(res, { logs: '' });
      }
    }

    // Quit is now handled natively via Electron IPC or we can just send an IPC message if needed.
    // For now, if the frontend calls /api/quit, we exit process.
    if (p === '/api/quit') {
      stopDaemon();
      json(res, { ok: true });
      process.exit(0);
      return;
    }

    // Serve static files from renderer/
    let reqPath = p === '/' ? '/index.html' : p;
    // Fallback logic for routing: if setup.html is requested and not configured
    const R = path.join(__dirname, '..', 'renderer');
    let fullPath = path.join(R, reqPath);
    
    // Auto-redirect to setup.html if not configured, or index.html if configured
    if (p === '/' || p === '/login' || p === '/setup.html' || p === '/index.html') {
      const isConfigured = !!(loadConfig()?.api_url && loadConfig()?.api_key);
      if (!isConfigured) fullPath = path.join(R, 'setup.html');
      else if (p === '/login' || p === '/setup.html') fullPath = path.join(R, 'index.html');
    }

    if (!fs.existsSync(fullPath)) {
      json(res, { error: 'Not found' }, 404);
      return;
    }

    try {
      const ext = path.extname(fullPath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
      fs.createReadStream(fullPath).pipe(res);
    } catch {
      json(res, { error: 'Server error' }, 500);
    }
  });

  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    log(`Local server listening on port ${port}`);
    
    // Auto-start daemon if configured
    const c = loadConfig();
    if (c && c.api_url && c.api_key) {
      startDaemon(c);
    }
    
    if (onStart) onStart(port, server);
  });
}

module.exports = { startServer, loadConfig, stopDaemon };
