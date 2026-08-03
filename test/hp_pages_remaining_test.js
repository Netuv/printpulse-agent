// Test for HP pages-remaining parser in PollerService.parseConsumableHTML
const fs = require('fs');
const src = fs.readFileSync('src/services/PollerService.js', 'utf8');
// Extract parseConsumableHTML with balanced braces
const start = src.indexOf('parseConsumableHTML(html) {');
if (start === -1) { console.log('NOT FOUND'); process.exit(1); }
let depth = 0, end = -1;
for (let i = start; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const fnBody = src.substring(start, end).replace(/^parseConsumableHTML\(html\) \{/, '').replace(/\}\s*$/, '');
const fn = new Function('html', 'return (function(html){' + fnBody + '})(html)');

const html = `<h2>Cartridge Level Gauge</h2><h4>Installed Cartridges</h4><table><tr><th>Color</th><th>Cartridge Status</th><th>Cartridge Number</th><th>Type</th><th>End-of-Warranty Date (Y-M-D)</th><th>First Installation Date (Y-M-D)</th><th>Cartridge Zone</th><th>USE</th><th>HP</th><th>Approximate Pages Remaining *</th></tr><tr><td>Cyan</td><td>Non-HP Ink Cartridge Installed</td><td>-- 95UXL Cyan Cartridge (L0S63A)</td><td>--</td><td>--</td><td>2026-07-09</td><td>1</td><td>0</td><td>0</td><td>>32700</td></tr><tr><td>Magenta</td><td>Non-HP Ink Cartridge Installed</td><td>-- 95UXL Magenta Cartridge (L0S66A)</td><td>--</td><td>--</td><td>2025-12-10</td><td>1</td><td>0</td><td>0</td><td>Low</td></tr><tr><td>Yellow</td><td>Non-HP Ink Cartridge Installed</td><td>-- 95UXL Yellow Cartridge (L0S69A)</td><td>--</td><td>--</td><td>2025-08-13</td><td>1</td><td>0</td><td>0</td><td>20800</td></tr><tr><td>Black</td><td>Non-HP Ink Cartridge Installed</td><td>-- 95UXL Black Cartridge (L0S72A)</td><td>--</td><td>--</td><td>2025-09-17</td><td>1</td><td>0</td><td>0</td><td>>32700</td></tr></table>`;

const res = fn(html);
console.log('RESULT:', JSON.stringify(res, null, 2));

// Assertions
const assert = require('assert');
if (res && res.toner && res.toner.length === 4) {
  const map = {};
  res.toner.forEach(t => map[t.warna] = t.level);
  console.log('Levels:', JSON.stringify(map));
  assert.ok(map.CYAN > 50, 'Cyan should be high (>32700 pages)');
  assert.ok(map.MAGENTA <= 10, 'Magenta should be low (Low status)');
  assert.ok(map.YELLOW >= 30 && map.YELLOW <= 70, 'Yellow should be ~52% (20800/40000)');
  assert.ok(map.BLACK > 50, 'Black should be high');
  console.log('PASS');
} else {
  console.log('FAIL: toner not parsed');
  process.exit(1);
}

