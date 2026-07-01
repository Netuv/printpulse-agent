#!/usr/bin/env node

const { Command } = require('commander');
const fs = require('fs');
const path = require('path');
const Scanner = require('./scanner');
const Poller = require('./poller');
const ApiClient = require('./api-client');

// Load configuration
function loadConfig() {
  const configPath = path.join(__dirname, 'config.json');
  
  if (!fs.existsSync(configPath)) {
    console.error('❌ config.json not found!');
    console.error('Please copy config.json.example to config.json and configure it.');
    process.exit(1);
  }

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    
    // Validate required fields
    if (!config.api_url || !config.api_key) {
      console.error('❌ config.json is incomplete!');
      console.error('Required fields: api_url, api_key');
      process.exit(1);
    }

    return config;
  } catch (error) {
    console.error('❌ Failed to load config.json:', error.message);
    process.exit(1);
  }
}

// Network Discovery Command
async function runDiscovery(config) {
  console.log('🔍 PrintPulse Agent - Network Discovery\n');
  console.log('Starting network scan...');
  console.log('This may take 30-60 seconds depending on network size.\n');

  const scanner = new Scanner(config);
  const apiClient = new ApiClient(config);

  try {
    // Perform network scan
    const scanResult = await scanner.scan();

    console.log(`\n✅ Scan complete!`);
    console.log(`   Found: ${scanResult.devices.length} devices`);
    console.log(`   Printers detected: ${scanResult.devices.filter(d => d.snmp_result).length}`);

    // Submit to API
    console.log('\n📤 Submitting results to PrintPulse API...');
    const response = await apiClient.submitDiscovery(scanResult);

    console.log('✅ Results submitted successfully!');
    console.log(`   Scan ID: ${response.scan_id}`);
    console.log(`   View in web: ${config.api_url.replace('/api', '')}/discovery.html`);

    return response;
  } catch (error) {
    console.error('\n❌ Discovery failed:', error.message);
    console.error('Details:', error.stack);
    process.exit(1);
  }
}

// SNMP Polling Command
async function runPolling(config) {
  console.log('📊 PrintPulse Agent - SNMP Polling\n');

  const poller = new Poller(config);
  const apiClient = new ApiClient(config);

  try {
    // Fetch registered machines from API
    console.log('📥 Fetching registered machines from API...');
    const machines = await apiClient.getMachines();

    if (!machines || machines.length === 0) {
      console.log('⚠️  No machines registered yet.');
      console.log('   Please add machines via web interface first, or run discovery.');
      return;
    }

    console.log(`   Found: ${machines.length} registered machines`);

    // Filter machines with IP addresses
    const pollableMachines = machines.filter(m => m.ip_address);
    
    if (pollableMachines.length === 0) {
      console.log('⚠️  No machines have IP addresses configured.');
      console.log('   Please add IP addresses to machines via web interface.');
      return;
    }

    console.log(`   Pollable: ${pollableMachines.length} machines\n`);

    // Poll each machine
    let successCount = 0;
    let errorCount = 0;

    for (const machine of pollableMachines) {
      console.log(`Polling: ${machine.merk} ${machine.model} (${machine.ip_address})...`);

      try {
        const result = await poller.pollMachine(machine);

        if (result && result.delta_bw + result.delta_color > 0) {
          console.log(`  ✓ Delta: BW +${result.delta_bw}, Color +${result.delta_color}`);
          console.log(`  ✓ Toner: ${JSON.stringify(result.toner_levels || {})}`);
          
          // Submit reading to API (if in auto mode)
          if (config.auto_submit !== false) {
            await apiClient.submitReading(machine.id, result);
            console.log('  ✓ Submitted to API');
          }
          
          successCount++;
        } else {
          console.log('  ℹ No change since last poll');
          successCount++;
        }
      } catch (error) {
        console.error(`  ✗ Error: ${error.message}`);
        errorCount++;
      }

      console.log('');
    }

    console.log(`\n📊 Polling Summary:`);
    console.log(`   Success: ${successCount}`);
    console.log(`   Errors: ${errorCount}`);
    console.log(`   Total: ${pollableMachines.length}`);

  } catch (error) {
    console.error('\n❌ Polling failed:', error.message);
    console.error('Details:', error.stack);
    process.exit(1);
  }
}

// Main CLI Program
const program = new Command();

program
  .name('printpulse-agent')
  .description('PrintPulse SNMP Agent - Network discovery and printer polling')
  .version('1.0.0');

program
  .command('discover')
  .description('Scan network for printers and submit to API')
  .action(async () => {
    const config = loadConfig();
    await runDiscovery(config);
  });

program
  .command('poll')
  .description('Poll registered printers via SNMP')
  .action(async () => {
    const config = loadConfig();
    await runPolling(config);
  });

program
  .command('test')
  .description('Test configuration and API connection')
  .action(async () => {
    const config = loadConfig();
    console.log('🧪 Testing configuration...\n');
    
    console.log('Config loaded:');
    console.log(`  API URL: ${config.api_url}`);
    console.log(`  Tenant ID: ${config.tenant_id || 'not set'}`);
    console.log(`  Polling interval: ${config.polling_interval_hours || 6} hours`);
    console.log(`  SNMP timeout: ${config.snmp?.timeout_ms || 5000}ms\n`);

    console.log('Testing API connection...');
    const apiClient = new ApiClient(config);
    
    try {
      const machines = await apiClient.getMachines();
      console.log(`✅ API connection OK`);
      console.log(`   Registered machines: ${machines?.length || 0}`);
    } catch (error) {
      console.error(`❌ API connection failed: ${error.message}`);
    }
  });

program
  .command('setup')
  .description('Interactive setup wizard — no manual config needed')
  .action(async () => {
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const ask = (q) => new Promise(r => readline.question(q, r));

    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║   PrintPulse Agent — Setup Wizard        ║');
    console.log('╚══════════════════════════════════════════╝\n');
    console.log('Enter your PrintPulse credentials.\n');

    const apiUrl = await ask('  API URL (https://your-worker.workers.dev): ') || 'https://printpulse.workers.dev';
    const apiKey = await ask('  API Key (from PrintPulse → Setup Agent page): ');
    const tenantId = await ask('  Tenant ID (press Enter for default "1"): ') || '1';

    readline.close();

    if (!apiKey) {
      console.error('\n❌ API Key wajib diisi!');
      console.error('   Buka web PrintPulse → SNMP → Setup Agent, klik "Generate Config"\n');
      process.exit(1);
    }

    const config = {
      api_url: apiUrl.replace(/\/+$/, ''),
      api_key: apiKey,
      tenant_id: parseInt(tenantId),
      polling_interval_hours: 6,
      auto_submit: true,
      snmp: {
        timeout_ms: 5000,
        retry: 2,
        default_community: 'public',
        default_version: 'v2c',
        default_port: 161,
      },
      discovery: {
        enabled: true,
        subnet_auto_detect: true,
        scan_on_startup: true,
      },
      log_level: 'info',
    };

    fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(config, null, 2));

    console.log('\n✅ config.json created successfully!\n');
    console.log('   API URL:', config.api_url);
    console.log(`   Tenant ID: ${config.tenant_id}\n`);
    console.log('   Next steps:');
    console.log('   1. Run: node index.js discover   — scan network for printers');
    console.log('   2. Run: node index.js poll       — start SNMP polling');
    console.log('   3. Or run: node index.js --help  — see all commands\n');
  });

// Show help if no command provided
if (process.argv.length <= 2) {
  program.help();
}

program.parse(process.argv);
