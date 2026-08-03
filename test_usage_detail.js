// Test Ricoh + HP parsers (new {usage, detail} shape)
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/src/services/PollerService.js', 'utf8');
const m = src.match(/class PollerService \{[\s\S]*?\n\}/);
const PollerService = new Function(m[0] + '\nreturn PollerService;')();
const p = PollerService.prototype;

const ricohHtml = fs.readFileSync(__dirname + '/test/fixtures/ricoh_counter.html', 'utf8');
const ricoh = p.parseRicohCounters(ricohHtml);
console.log('=== RICOH ===');
console.log('usage:', JSON.stringify(ricoh.usage, null, 1));
console.log('detail:', JSON.stringify(ricoh.detail, null, 1));

const hpHtml = fs.readFileSync(__dirname + '/test/fixtures/hp_usagepage.html', 'utf8');
const hp = p.parseHPUsageCounters(hpHtml);
console.log('\n=== HP ===');
console.log('usage:', JSON.stringify(hp.usage, null, 1));
console.log('detail:', JSON.stringify(hp.detail, null, 1));

// Assertions — total should be >= baseline (printer actively used)
const rOK = ricoh.usage['Total Printed Impressions'] >= 52344
  && ricoh.usage['Color Printed Impressions'] + ricoh.usage['Black Printed Impressions'] === ricoh.usage['Total Printed Impressions']
  && ricoh.detail && ricoh.detail.print.bw > 10000
  && ricoh.detail.copy.color > 1000
  && ricoh.detail.source === 'ricoh_wim';
const hOK = hp.usage['Total Printed Impressions'] === 210302
  && hp.detail && hp.detail.print.bw + hp.detail.print.color === 107538
  && hp.detail.scan && hp.detail.scan.count === 73261
  && hp.detail.source === 'hp_usagepage';
console.log('\nRICOH ' + (rOK ? 'PASS' : 'FAIL'));
console.log('HP ' + (hOK ? 'PASS' : 'FAIL'));
process.exit(rOK && hOK ? 0 : 1);
