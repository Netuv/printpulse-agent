// Test dedupe logic of _recordAlertActivities
const assert = require('assert');

// Simulate the dedupe logic inline (mirrors PollerService._recordAlertActivities)
function simulate(firstPoll, secondPoll) {
  const dev = { id: 1, ip: '10.0.0.1' };
  const records = [];
  const fakeApi = {
    async createMesinActivity(id, p) { records.push(p); }
  };

  // Extract the method body logic — inline reimplementation for test
  const record = async (data) => {
    if (!data || !data.alerts) return;
    const alerts = data.alerts;
    let list = Array.isArray(alerts.list) ? alerts.list.slice() : [];
    if (Array.isArray(alerts.web)) list = list.concat(alerts.web);
    if (!Array.isArray(alerts) && list.length === 0) list = Array.isArray(alerts) ? alerts : [];
    if (!list.length && !dev._alertCache) return;

    const prevCache = dev._alertCache || {};
    const newCache = {};
    const newAlerts = [];
    const clearedAlerts = [];

    list.forEach(a => {
      const text = (a.text || a.message || a.detail || '').trim();
      if (!text) return;
      const sev = typeof a.severity === 'number' ? a.severity : (a.severity === 'critical' ? 10 : a.severity === 'warning' ? 6 : a.severity === 'info' ? 2 : 0);
      const key = text.toLowerCase().slice(0, 120);
      newCache[key] = sev;
      const prev = prevCache[key];
      if (prev === undefined) {
        newAlerts.push({ text, severity: sev });
      } else if (sev > prev) {
        newAlerts.push({ text: text + ' (severity ↑)', severity: sev });
      }
    });

    for (const key of Object.keys(prevCache)) {
      if (newCache[key] === undefined) {
        const orig = (dev._alertTextCache && dev._alertTextCache[key]) || key;
        clearedAlerts.push({ text: orig, severity: prevCache[key] });
      }
    }

    dev._alertCache = newCache;
    const textCache = {};
    list.forEach(a => {
      const text = (a.text || a.message || a.detail || '').trim();
      if (!text) return;
      textCache[text.toLowerCase().slice(0, 120)] = text;
    });
    dev._alertTextCache = textCache;

    if (!dev._alertSeeded) { dev._alertSeeded = true; return; }

    const now = new Date().toISOString();
    const payloads = [];
    newAlerts.forEach(a => payloads.push({ activity_type: 'MONITORING', status: 'PROSES', deskripsi: `⚠️ Alert: ${a.text} (severity ${a.severity})`, tgl_aktivitas: now }));
    clearedAlerts.forEach(a => payloads.push({ activity_type: 'MONITORING', status: 'SELESAI', deskripsi: `✅ Alert clear: ${a.text}`, tgl_aktivitas: now }));
    for (const p of payloads) await fakeApi.createMesinActivity(dev.id, p);
  };

  return { record, records };
}

(async () => {
  // Test 1: first poll seeds cache (no records), second poll same alerts (no records)
  const t1 = simulate();
  const alerts1 = { list: [{ text: 'Toner low', severity: 6 }, { text: 'Door open', severity: 8 }] };
  await t1.record({ alerts: alerts1 });  // seed
  await t1.record({ alerts: alerts1 });  // same → no records
  assert.strictEqual(t1.records.length, 0, 'Test1: no records on identical alerts');

  // Test 2: new alert appears → recorded
  const t2 = simulate();
  await t2.record({ alerts: { list: [{ text: 'Toner low', severity: 6 }] } }); // seed
  await t2.record({ alerts: { list: [{ text: 'Toner low', severity: 6 }, { text: 'Paper jam', severity: 9 }] } });
  assert.strictEqual(t2.records.length, 1, 'Test2: 1 record for new alert');
  assert.ok(t2.records[0].deskripsi.includes('Paper jam'), 'Test2: records Paper jam');

  // Test 3: alert clears → recorded as clear
  const t3 = simulate();
  await t3.record({ alerts: { list: [{ text: 'Paper jam', severity: 9 }] } }); // seed
  await t3.record({ alerts: { list: [] } }); // cleared
  assert.strictEqual(t3.records.length, 1, 'Test3: 1 record for clear');
  assert.ok(t3.records[0].deskripsi.includes('clear'), 'Test3: records clear');

  // Test 4: web alerts array merged
  const t4 = simulate();
  await t4.record({ alerts: { list: [{ text: 'A', severity: 4 }], web: [] } }); // seed
  await t4.record({ alerts: { list: [], web: [{ text: 'Web alert', severity: 10 }] } });
  // 'A' cleared + Web alert new = 2 records
  assert.strictEqual(t4.records.length, 2, 'Test4: A cleared + web alert = 2 records');
  assert.ok(t4.records.some(r => r.deskripsi.includes('Web alert')), 'Test4: records web alert');
  assert.ok(t4.records.some(r => r.deskripsi.includes('clear')), 'Test4: records A clear');

  console.log('ALL PASS');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
