// Test parseHPUsageCounters against real HP HTML
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/src/services/PollerService.js', 'utf8');
// Extract the method by eval'ing class prototype
const cls = src.slice(src.indexOf('class PollerService'), src.indexOf('module.exports') >= 0 ? src.indexOf('module.exports') : undefined);
const m = src.match(/class PollerService \{[\s\S]*?\n\}/);
if (!m) { console.log('class not found'); process.exit(1); }
const PollerService = new Function(m[0] + '\nreturn PollerService;')();
const p = PollerService.prototype;
const html = fs.readFileSync(__dirname + '/hp_usagepage.html', 'utf8');
const usage = p.parseHPUsageCounters(html);
console.log(JSON.stringify(usage, null, 2));
// Verify expected
const expect = { 'Total Printed Impressions': 210302, 'Black Printed Impressions': 210302 };
const ok = usage['Total Printed Impressions'] === 210302 && usage['Black Printed Impressions'] === 210302;
console.log(ok ? 'PASS: Total 210,302 BW 210,302' : 'FAIL: ' + JSON.stringify(usage));
process.exit(ok ? 0 : 1);
