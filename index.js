#!/usr/bin/env node

/**
 * PrintPulse Agent v1.0.0
 * Print fleet management SNMP agent — CLI & daemon modes
 *
 * Usage:
 *   node index.js setup          Interactive setup wizard
 *   node index.js install        Install as OS-native service (auto-start)
 *   node index.js start          Start daemon / background service
 *   node index.js status         Check daemon status
 *   node index.js uninstall      Remove OS service
 *   node index.js discover       One-time network scan
 *   node index.js poll           One-time SNMP polling
 *   node index.js daemon         Run continuous daemon (foreground)
 */

const path = require('path');
const fs = require('fs');

// Ensure we're running from agent root (skip if bundled in pkg)
try {
  process.chdir(__dirname);
} catch (err) {
  // Ignore chdir errors in pkg-bundled executables
}

// Auto-detect first run - if no config exists, run setup wizard automatically
const configPath = path.join(__dirname, 'config.json');
let cmd = process.argv[2] || 'help';

if (!fs.existsSync(configPath) && !['setup', 'help', '--help', '-h'].includes(cmd)) {
  console.log('\n⚠️  Configuration not found. Running setup wizard...\n');
  cmd = 'setup';
}

// If it's a daemon/service/discover/poll command, use src/index.js
if (['daemon', 'start', 'install', 'uninstall', 'status', 'discover', 'poll'].includes(cmd)) {
  require('./src/index.js');
} else if (['setup', 'test', '--help', '-h', 'help'].includes(cmd)) {
  // Use src/cli.js for CLI commands
  require('./src/cli.js');
} else {
  console.log(`\n  PrintPulse Agent v1.0.0\n`);
  console.log('  Commands:');
  console.log('    setup          Interactive setup wizard');
  console.log('    install        Install as OS service (auto-start on boot)');
  console.log('    start          Start daemon (background polling)');
  console.log('    status         Show daemon status');
  console.log('    uninstall      Remove OS service');
  console.log('    discover       One-time network scan');
  console.log('    poll           One-time SNMP polling');
  console.log('    test           Test API connection\n');
}
