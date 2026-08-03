/**
 * PrintPulse Agent — Notifier Module
 * Cross-platform system notifications for alerts
 */

const os = require('os');
const { execSync } = require('child_process');

let notifier = null;
try {
  notifier = require('node-notifier');
} catch {
  // Fallback: no desktop notifications available
}

function send(title, message) {
  if (notifier) {
    try {
      notifier.notify({ title, message, icon: __dirname + '/../assets/icon.png' });
    } catch {}
  }
  console.log(`[NOTIFY] ${title}: ${message}`);
}

function alertLowToner(merk, model, ip, color, level) {
  send(
    `⚠️ Toner Low: ${merk} ${model}`,
    `${color}: ${level}% — IP: ${ip}`
  );
}

function alertMaintenanceDue(merk, model, ip, desc) {
  send(
    `🔧 Maintenance: ${merk} ${model}`,
    `${desc} — IP: ${ip}`
  );
}

function alertConnectionLost(merk, model, ip) {
  send(
    `🔴 Connection Lost: ${merk} ${model}`,
    `Cannot reach ${ip}. Check network connectivity.`
  );
}

function alertError(message) {
  send('❌ PrintPulse Agent Error', message);
}

module.exports = { send, alertLowToner, alertMaintenanceDue, alertConnectionLost, alertError };
