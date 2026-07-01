#!/usr/bin/env node

/**
 * PrintPulse Agent — Cross-Platform Service Installer
 * Run with: node install-service.js
 * 
 * Handles:
 * - Windows: Scheduled Task + WinSW wrapper
 * - Linux: systemd service
 * - macOS: launchd plist
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const AGENT_ROOT = __dirname;
const SRC_INDEX = path.join(AGENT_ROOT, 'src', 'index.js');
const CONFIG_PATH = path.join(AGENT_ROOT, 'config.json');
const LOG_DIR = path.join(AGENT_ROOT, 'logs');
const BIN_PATH = process.execPath;  // node executable

const PLATFORM = os.platform();

function checkPrereqs() {
  console.log('🔍 Checking prerequisites...\n');

  // Node.js
  const nodeVer = process.version;
  console.log(`  Node.js: ${nodeVer} ${nodeVer >= 'v18' ? '✅' : '❌ (need >=18)'}`);

  // Config
  console.log(`  config.json: ${fs.existsSync(CONFIG_PATH) ? '✅' : '❌'}`);

  // Source files
  const srcFiles = ['index.js', 'poller.js', 'scanner.js', 'api-client.js', 'notifier.js', 'cli.js'];
  let allSrc = true;
  for (const f of srcFiles) {
    if (!fs.existsSync(path.join(AGENT_ROOT, 'src', f))) {
      console.log(`  src/${f}: ❌ MISSING`);
      allSrc = false;
    }
  }
  if (allSrc) console.log(`  Source files: ✅`);

  // Dependencies
  const nmExists = fs.existsSync(path.join(AGENT_ROOT, 'node_modules'));
  console.log(`  node_modules: ${nmExists ? '✅' : '❌ (run npm install)'}`);

  if (!nmExists) {
    console.log('\n📦 Installing dependencies...');
    execSync('npm install', { cwd: AGENT_ROOT, stdio: 'inherit' });
    console.log('✅ Dependencies installed\n');
  }

  console.log('');
  return fs.existsSync(CONFIG_PATH) && allSrc;
}

function installWindows() {
  console.log('📦 Installing as Windows service...\n');

  // Method: Use schtasks to create a scheduled task
  // Runs at user logon, runs every N hours
  // This works without WinSW

  const taskName = 'PrintPulseAgent';
  const nodePath = BIN_PATH;
  const scriptPath = SRC_INDEX;
  const workDir = AGENT_ROOT;

  try {
    // Delete existing task if any
    try { execSync(`schtasks /delete /tn "${taskName}" /f`, { stdio: 'pipe' }); } catch {}

    // Create task that starts at boot and runs every 6 hours
    const cmd = `schtasks /create /tn "${taskName}" /tr "${nodePath} \\"${scriptPath}\\" daemon" /sc onstart /ru "%USERNAME%" /rl highest /f`;
    execSync(cmd, { stdio: 'inherit' });

    // Also create a trigger for hourly polling (every 6 hours)
    const cmd2 = `schtasks /create /tn "${taskName}_Poll" /tr "${nodePath} \\"${scriptPath}\\" poll" /sc hourly /mo 6 /st 00:00 /ru "%USERNAME%" /f`;
    execSync(cmd2, { stdio: 'inherit' });

    console.log(`\n✅ Service installed!`);
    console.log(`   Task: ${taskName} (runs on startup)`);
    console.log(`   Task: ${taskName}_Poll (runs every 6 hours)`);
    console.log(`\n   To start now: schtasks /run /tn "${taskName}"`);
    console.log(`   To stop: schtasks /end /tn "${taskName}"`);
    console.log(`   To remove: schtasks /delete /tn "${taskName}" /f`);
  } catch (err) {
    console.error(`❌ Installation failed:`, err.message);
    console.error(`   Try running as Administrator.`);
  }
}

function installLinux() {
  console.log('📦 Installing as systemd service...\n');

  const user = os.userInfo().username;
  const unitContent = `[Unit]
Description=PrintPulse Agent
Documentation=https://printpulse.app
After=network.target

[Service]
Type=simple
User=${user}
Group=${user}
WorkingDirectory=${AGENT_ROOT}
ExecStart=${BIN_PATH} ${SRC_INDEX} daemon
Restart=always
RestartSec=30
Environment=NODE_ENV=production

# Security hardening
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
`;

  const unitPath = '/etc/systemd/system/printpulse-agent.service';

  // Try to write and enable
  try {
    // Write as root via tee
    const proc = execSync(`sudo tee ${unitPath} > /dev/null`, {
      input: unitContent,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    execSync('sudo systemctl daemon-reload', { stdio: 'inherit' });
    execSync('sudo systemctl enable printpulse-agent', { stdio: 'inherit' });
    execSync('sudo systemctl start printpulse-agent', { stdio: 'inherit' });
    console.log('✅ Service installed and started!\n');
    execSync('systemctl status printpulse-agent --no-pager', { stdio: 'inherit' });
  } catch (err) {
    console.log('⚠️  Could not install as root. Manual steps:\n');
    console.log('   Create the service file:');
    console.log(`   sudo tee ${unitPath} << 'EOF'`);
    console.log(unitContent.trim());
    console.log('EOF\n');
    console.log('   Then:');
    console.log('   sudo systemctl daemon-reload');
    console.log('   sudo systemctl enable printpulse-agent');
    console.log('   sudo systemctl start printpulse-agent');
  }
}

function installMacOS() {
  console.log('📦 Installing as launchd agent...\n');

  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.printpulse.agent</string>

  <key>ProgramArguments</key>
  <array>
    <string>${BIN_PATH}</string>
    <string>${SRC_INDEX}</string>
    <string>daemon</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${AGENT_ROOT}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/stdout.log</string>

  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/stderr.log</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>`;

  const plistDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const plistPath = path.join(plistDir, 'com.printpulse.agent.plist');

  // Ensure log dir
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

  try {
    // Ensure LaunchAgents dir exists
    if (!fs.existsSync(plistDir)) fs.mkdirSync(plistDir, { recursive: true });

    fs.writeFileSync(plistPath, plistContent, { mode: 0o644 });
    console.log(`   Created: ${plistPath}\n`);

    // Load into launchd
    execSync(`launchctl load ${plistPath}`, { stdio: 'inherit' });
    console.log('✅ Service installed and started!\n');

    // Show status
    execSync(`launchctl list | grep printpulse`, { stdio: 'inherit' });
  } catch (err) {
    console.log('⚠️  Auto-install failed. Manual steps:\n');
    console.log(`   Create ${plistPath} with content above, then:`);
    console.log(`   launchctl load ${plistPath}`);
  }
}

// ─── MAIN ────────────────────────────────────────────────
console.log('');
console.log('╔══════════════════════════════════════════╗');
console.log('║   PrintPulse Agent Installer             ║');
console.log('╚══════════════════════════════════════════╝\n');

const ok = checkPrereqs();

if (PLATFORM === 'win32') {
  installWindows();
} else if (PLATFORM === 'linux') {
  installLinux();
} else if (PLATFORM === 'darwin') {
  installMacOS();
} else {
  console.error(`❌ Unsupported platform: ${PLATFORM}`);
  process.exit(1);
}

console.log(`\n✅ Installation complete! Platform: ${PLATFORM}`);
