#!/usr/bin/env node

/**
 * PrintPulse Agent Daemon
 * Background service that runs continuously, polling printers on schedule.
 * Auto-installs as OS-native service (systemd/launchd/Windows Service).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const Poller = require('./poller');
const Scanner = require('./scanner');
const ApiClient = require('./api-client');
const notifier = require('./notifier');

const CONFIG_PATH = path.join(__dirname, '..', 'config.json');
const CACHE_PATH = path.join(__dirname, '..', 'poll-cache.json');
const LOG_DIR = path.join(__dirname, '..', 'logs');
const PID_PATH = path.join(__dirname, '..', 'agent.pid');
const LOCK_PATH = path.join(__dirname, '..', 'agent.lock');

function log(...args) {
  const ts = new Date().toISOString();
  const msg = `[${ts}] ${args.join(' ')}`;
  console.log(msg);

  // Also write to log file
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const logFile = path.join(LOG_DIR, `agent-${new Date().toISOString().slice(0, 10)}.log`);
    fs.appendFileSync(logFile, msg + '\n');
  } catch {}
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    log('❌ config.json not found. Run `node index.js setup` first.');
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!config.api_url || !config.api_key) {
    log('❌ config.json incomplete. Required: api_url, api_key');
    process.exit(1);
  }
  return config;
}

async function runDiscovery(config, apiClient) {
  log('🔍 Starting network discovery...');
  const scanner = new Scanner(config);
  try {
    const result = await scanner.scan();
    const printerCount = result.devices.filter(d => d.snmp_result).length;
    log(`✅ Discovery: ${result.devices.length} devices, ${printerCount} printers`);
    await apiClient.submitDiscovery(result);
    log('📤 Results submitted to API');
    return result;
  } catch (err) {
    log('❌ Discovery failed:', err.message);
    return null;
  }
}

async function runPollCycle(config, apiClient, poller) {
  log('📊 Starting poll cycle...');
  try {
    const machines = await apiClient.getMachines();
    const pollable = machines.filter(m => m.ip_address);
    log(`   ${machines.length} machines, ${pollable.length} pollable`);

    let success = 0, errors = 0;
    for (const machine of pollable) {
      try {
        const result = await poller.pollMachine(machine);
        const delta = (result.delta_bw || 0) + (result.delta_color || 0);
        if (delta > 0) {
          await apiClient.submitReading(machine.id, result);
          log(`  ✓ ${machine.merk} ${machine.model} (${machine.ip_address}): +${result.delta_bw}B +${result.delta_color}C`);
        }
        // Update toner levels
        if (result.toner_levels) {
          for (const [color, level] of Object.entries(result.toner_levels)) {
            if (level !== null && level <= 25) {
              notifier.alertLowToner(machine.merk, machine.model, machine.ip_address, color, level);
            }
          }
        }
        success++;
      } catch (err) {
        log(`  ✗ ${machine.merk} ${machine.model} (${machine.ip_address}): ${err.message}`);
        errors++;
      }
    }
    log(`📊 Cycle done: ${success} ok, ${errors} failed`);
  } catch (err) {
    log('❌ Poll cycle failed:', err.message);
  }
}

// ─── Daemon Mode ──────────────────────────────────────────
async function runDaemon(config) {
  log('🚀 PrintPulse Agent daemon starting...');
  notifier.send('PrintPulse Agent', 'Agent daemon started');

  const apiClient = new ApiClient(config);
  const poller = new Poller(config);
  const intervalMs = (config.polling_interval_hours || 6) * 3600000;

  // Run discovery if first time
  const cache = loadCache();
  if (!cache.lastDiscovery) {
    log('🔍 No previous discovery found, running initial scan...');
    await runDiscovery(config, apiClient);
    saveCache({ ...cache, lastDiscovery: new Date().toISOString() });
  }

  // Run initial poll immediately
  await runPollCycle(config, apiClient, poller);

  // Schedule recurring polls
  log(`⏰ Polling every ${config.polling_interval_hours || 6} hours (${Math.round(intervalMs/3600000)}h)`);
  const interval = setInterval(async () => {
    try {
      await runPollCycle(config, apiClient, poller);
      // Rediscover once per day
      const cache = loadCache();
      const lastDisc = cache.lastDiscovery ? new Date(cache.lastDiscovery) : new Date(0);
      if (Date.now() - lastDisc.getTime() > 86400000) {
        await runDiscovery(config, apiClient);
        saveCache({ ...cache, lastDiscovery: new Date().toISOString() });
      }
    } catch (err) {
      log('❌ Cycle error:', err.message);
    }
  }, intervalMs);

  // Graceful shutdown
  const shutdown = () => {
    log('🛑 Shutting down...');
    clearInterval(interval);
    try { fs.unlinkSync(LOCK_PATH); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', (err) => log('💥 Uncaught:', err.message));

  // Keep running
  log('✅ Daemon running. Press Ctrl+C to stop.');
}

// ─── Cache helpers ────────────────────────────────────────
function loadCache() {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    }
  } catch {}
  return {};
}

function saveCache(cache) {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch {}
}

// ─── Service Management ───────────────────────────────────
const service = {
  install() {
    const platform = os.platform();
    log(`📦 Installing PrintPulse Agent as ${platform} service...`);

    if (platform === 'win32') {
      const winsw = path.join(__dirname, '..', 'winsw.xml');
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<service>
  <id>PrintPulseAgent</id>
  <name>PrintPulse Agent</name>
  <description>SNMP polling agent for PrintPulse print fleet management</description>
  <executable>${process.execPath}</executable>
  <arguments>${path.join(__dirname, 'index.js')} daemon</arguments>
  <log mode="roll"></log>
  <onfailure action="restart" delay="10 sec"/>
  <delayedAutoStart>true</delayedAutoStart>
</service>`;
      fs.writeFileSync(winsw, xml);
      log('   Windows: Download WinSW.exe and run:');
      log('   winsw install winsw.xml');
      log('   winsw start winsw.xml');
    } else if (platform === 'linux') {
      const unit = `[Unit]
Description=PrintPulse Agent
After=network.target

[Service]
Type=simple
User=${os.userInfo().username}
WorkingDirectory=${path.join(__dirname, '..')}
ExecStart=${process.execPath} ${path.join(__dirname, 'index.js')} daemon
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
`;
      const unitPath = '/etc/systemd/system/printpulse-agent.service';
      log(`   Create: ${unitPath}`);
      log(`   Content:\n${unit}`);
      log('   Run: sudo systemctl daemon-reload');
      log('   Run: sudo systemctl enable printpulse-agent');
      log('   Run: sudo systemctl start printpulse-agent');
      // If root, write directly
      try {
        fs.writeFileSync(unitPath, unit);
        require('child_process').execSync('systemctl daemon-reload && systemctl enable printpulse-agent && systemctl start printpulse-agent');
        log('✅ Service installed and started!');
      } catch {
        log('⚠️  Need sudo. Run the commands above manually.');
      }
    } else if (platform === 'darwin') {
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.printpulse.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${path.join(__dirname, 'index.js')}</string>
    <string>daemon</string>
  </array>
  <key>WorkingDirectory</key><string>${path.join(__dirname, '..')}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_DIR}/stdout.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/stderr.log</string>
</dict>
</plist>`;
      const plistPath = path.join(os.homedir(), 'Library/LaunchAgents/com.printpulse.agent.plist');
      try {
        if (!fs.existsSync(path.dirname(plistPath))) fs.mkdirSync(path.dirname(plistPath), { recursive: true });
        fs.writeFileSync(plistPath, plist);
        require('child_process').execSync(`launchctl load ${plistPath}`);
        log('✅ Service installed and started!');
      } catch {
        log(`⚠️  Create: ${plistPath}`);
        log('   Run: launchctl load ~/Library/LaunchAgents/com.printpulse.agent.plist');
      }
    }
  },

  uninstall() {
    const platform = os.platform();
    log(`🗑️  Removing PrintPulse Agent ${platform} service...`);
    if (platform === 'linux') {
      try {
        require('child_process').execSync('systemctl stop printpulse-agent && systemctl disable printpulse-agent');
        log('✅ Service stopped and disabled');
      } catch { log('⚠️  Could not remove service (try sudo)'); }
    } else if (platform === 'darwin') {
      try {
        require('child_process').execSync('launchctl unload ~/Library/LaunchAgents/com.printpulse.agent.plist');
        log('✅ Service unloaded');
      } catch { log('⚠️  Could not unload service'); }
    } else if (platform === 'win32') {
      log('   Run: winsw stop winsw.xml && winsw uninstall winsw.xml');
    }
    // Clean up
    try { fs.unlinkSync(LOCK_PATH); } catch {}
    try { fs.unlinkSync(PID_PATH); } catch {}
  },

  status() {
    const running = false;
    try {
      if (fs.existsSync(PID_PATH)) {
        const pid = parseInt(fs.readFileSync(PID_PATH, 'utf8'));
        try { process.kill(pid, 0); running = true; } catch {}
      }
    } catch {}

    log(`Platform: ${os.platform()}`);
    log(`Hostname: ${os.hostname()}`);
    log(`PID: ${running ? fs.readFileSync(PID_PATH, 'utf8').trim() : 'not running'}`);
    log(`Config: ${fs.existsSync(CONFIG_PATH) ? '✅' : '❌'}`);
    log(`Cache: ${fs.existsSync(CACHE_PATH) ? '✅' : 'empty'}`);
    log(`Logs: ${fs.existsSync(LOG_DIR) ? fs.readdirSync(LOG_DIR).length + ' files' : 'none'}`);
  }
};

// ─── Main entry ───────────────────────────────────────────
async function main() {
  const cmd = process.argv[2];

  switch (cmd) {
    case 'daemon':
    case 'start':
      const config = loadConfig();
      // Single instance check
      if (fs.existsSync(LOCK_PATH)) {
        log('❌ Agent already running (lock file exists)');
        log('   Delete agent.lock if stuck');
        process.exit(1);
      }
      fs.writeFileSync(LOCK_PATH, String(process.pid));
      // Write PID
      fs.writeFileSync(PID_PATH, String(process.pid));
      await runDaemon(config);
      break;

    case 'install':
      service.install();
      break;

    case 'uninstall':
      service.uninstall();
      break;

    case 'status':
      service.status();
      break;

    case 'discover':
      const discConfig = loadConfig();
      const discApi = new ApiClient(discConfig);
      await runDiscovery(discConfig, discApi);
      break;

    case 'poll':
      const pollConfig = loadConfig();
      const pollApi = new ApiClient(pollConfig);
      const poll = new Poller(pollConfig);
      await runPollCycle(pollConfig, pollApi, poll);
      break;

    default:
      console.log(`
PrintPulse Agent v1.0.0 — Daemon Mode

Commands:
  daemon | start   Start background daemon (continuous polling)
  install           Install as OS service (auto-start on boot)
  uninstall         Remove OS service
  status            Show daemon status
  discover          Run one-time network scan
  poll              Run one-time poll cycle
      `);
  }
}

main().catch(err => {
  log('💥 Fatal:', err.message);
  process.exit(1);
});
