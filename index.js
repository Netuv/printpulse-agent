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

// Ensure we're running from agent root
process.chdir(__dirname);

// Route to the right handler
const cmd = process.argv[2] || 'help';

// If it's a daemon/service/discover/poll command, use src/index.js
if (['daemon', 'start', 'install', 'uninstall', 'status', 'discover', 'poll'].includes(cmd)) {
  require(path.join(__dirname, 'src', 'index.js'));
} else if (['setup', 'test', '--help', '-h', 'help'].includes(cmd)) {
  // Use src/cli.js for CLI commands
  require(path.join(__dirname, 'src', 'cli.js'));
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
