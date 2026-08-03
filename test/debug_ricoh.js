// Direct test of readPrinterComprehensive for Ricoh IMC 2010 (10.10.30.244)
// Mocks electron app.getPath so config.js loads in plain node
process.env.PP_DEBUG = '1';
const path = require('path');
const electronPath = require.resolve('electron');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: { getPath: () => path.join(__dirname, '.test-user-data') },
      ipcMain: { handle(){} },
      BrowserWindow: class {},
      net: { fetch: global.fetch },
      ipcRenderer: { invoke: async () => ({}) },
    };
  }
  return originalLoad.apply(this, arguments);
};

const P = require('../src/services/PollerService');
const p = new P();
const timer = setTimeout(() => { console.error('TIMEOUT 60s'); process.exit(2); }, 60000);
(async () => {
  console.log('START readPrinterPhased only...');
  try {
    const dev = { ip: '10.10.30.244', merk: 'ricoh', model: 'IM C2010', id: 80 };
    const res = await p.readPrinterPhased(dev);
    clearTimeout(timer);
    console.log('=== PHASED RESULT ===');
    console.log('bw:', res.bw_counter, 'color:', res.color_counter, 'total:', res.total_pages);
    console.log('toner:', JSON.stringify(res.toner.map(t => ({w:t.warna, l:t.level, e:t.estimated, f:t.estimated_from}))));
  } catch (e) {
    clearTimeout(timer);
    console.error('PHASED ERR:', e.message);
  }
  process.exit(0);
})();
