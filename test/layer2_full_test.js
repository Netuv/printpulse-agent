// Test Layer 2 FULL auto-discovery on a real printer (Xerox ApeosPort-V C3376)
process.env.PP_DEBUG = '1';
const path = require('path');
const Module = require('module');
const orig = Module._load;
Module._load = function(r, p, m) {
  if (r === 'electron') {
    return { app: { getPath: () => path.join(__dirname, '.test') }, ipcMain: { handle(){} }, BrowserWindow: class {}, net: { fetch: global.fetch }, ipcRenderer: { invoke: async () => ({}) } };
  }
  return orig.apply(this, arguments);
};
const P = require('../src/services/PollerService');
const p = new P();
const t = setTimeout(() => { console.error('TIMEOUT 120s'); process.exit(2); }, 120000);
(async () => {
  try {
    const dev = { ip: '10.10.30.252', merk: 'xerox', model: 'ApeosPort-V C3376', id: 79, web_username: '', web_password: '' };
    const found = await p.discoverWebPaths('10.10.30.252', dev, null);
    clearTimeout(t);
    console.log('=== LAYER 2 FULL RESULT ===');
    console.log('toner:', JSON.stringify(found.toner));
    console.log('trays:', found.trays.length, 'tray(s)');
    console.log('usage keys:', Object.keys(found.usage).length);
    console.log('usage_detail:', JSON.stringify(found.usage_detail));
    console.log('alerts:', found.alerts.length, 'alert(s)');
    console.log('jobs:', found.jobs.length, 'job(s)');
    console.log('deviceInfo:', JSON.stringify(found.deviceInfo));
    process.exit(0);
  } catch (e) {
    clearTimeout(t);
    console.error('ERR:', e.message, e.stack);
    process.exit(1);
  }
})();
