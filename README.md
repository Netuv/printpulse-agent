# PrintPulse Agent

**Local SNMP polling and network discovery agent for PrintPulse Print Fleet Management System**

## Overview

The PrintPulse Agent runs on your local network to:
- **Discover printers** - Automatic network scan to detect MFPs/printers
- **Poll SNMP data** - Read counters, toner levels, status from printers
- **Submit to API** - Send collected data to PrintPulse cloud backend
- **Run continuously** - Background service or scheduled task

## Requirements

- **Node.js 18+** (download from https://nodejs.org)
- **Network access** to printers (same LAN/subnet)
- **SNMP enabled** on printers (usually enabled by default)
- **PrintPulse account** with API credentials

## Installation

```bash
# 1. Navigate to agent directory
cd agent

# 2. Install dependencies
npm install

# 3. Edit config.json with your settings
# - api_url: Your Cloudflare Worker URL
# - api_key: JWT token from PrintPulse web app
# - tenant_id: Your tenant ID
```

## Configuration

Edit `config.json`:

```json
{
  "api_url": "https://your-worker.workers.dev",
  "api_key": "your-jwt-token",
  "tenant_id": 1,
  "polling_interval_hours": 6,
  "snmp": {
    "timeout_ms": 5000,
    "retry": 2,
    "default_community": "public",
    "default_version": "v2c"
  }
}
```

**Get your JWT token:**
1. Login to PrintPulse web app
2. Open browser DevTools (F12)
3. Go to Application → Storage → Session Storage
4. Copy value of `pp_token`

## Usage

### One-Time Network Discovery

Scan your network for printers:

```bash
npm run discover
```

This will:
- Detect your subnet automatically
- Ping sweep to find active devices
- SNMP probe to identify printers
- Submit results to PrintPulse API
- Display scan ID for viewing in web app

### SNMP Polling (One-Time)

Poll registered printers once:

```bash
npm run poll
```

This will:
- Fetch registered machines from API
- Poll each machine via SNMP
- Read counters, toner, status
- Calculate delta from last poll
- Submit readings to API

### Continuous Background Service

For production use, run agent as a service:

**Windows (Task Scheduler):**
```powershell
# Create scheduled task that runs every 6 hours
schtasks /create /tn "PrintPulse Agent" /tr "node C:\path\to\agent\index.js poll" /sc hourly /mo 6 /st 00:00
```

**Linux (systemd):**
```bash
# Create /etc/systemd/system/printpulse-agent.service
sudo nano /etc/systemd/system/printpulse-agent.service

# Add:
[Unit]
Description=PrintPulse SNMP Agent
After=network.target

[Service]
Type=simple
User=printpulse
WorkingDirectory=/path/to/agent
ExecStart=/usr/bin/node index.js poll
Restart=always
RestartSec=21600

[Install]
WantedBy=multi-user.target

# Enable and start
sudo systemctl enable printpulse-agent
sudo systemctl start printpulse-agent
```

**Linux (cron):**
```bash
# Edit crontab
crontab -e

# Add (runs every 6 hours)
0 */6 * * * cd /path/to/agent && node index.js poll >> /var/log/printpulse-agent.log 2>&1
```

## Commands

```bash
node index.js discover    # Network discovery scan
node index.js poll        # Poll registered printers
node index.js --help      # Show help
```

## Troubleshooting

**"SNMP timeout" errors:**
- Check printer IP is correct
- Verify SNMP is enabled on printer
- Check SNMP community string (default: "public")
- Ensure no firewall blocking UDP port 161

**"API request failed":**
- Verify `api_url` is correct
- Check `api_key` is valid (not expired)
- Ensure internet connectivity
- Check Cloudflare Worker is deployed

**"No devices found" during discovery:**
- Verify you're on same network as printers
- Check subnet detection is correct
- Some networks block ICMP (ping)
- Try manual IP range in scanner.js

**"Permission denied" errors:**
- Run as administrator (Windows) or sudo (Linux)
- Required for network scanning operations

## How It Works

### Discovery Flow
```
1. Detect local IP and subnet
2. Ping sweep 192.168.x.0/24 (254 IPs)
3. For active IPs, check ports 161 (SNMP), 9100 (JetDirect)
4. SNMP GET sysDescr, sysObjectID → detect vendor
5. Read counter OIDs, toner levels
6. Submit results to /api/discovery/submit
7. View in web: Discovery page → latest scan
```

### Polling Flow
```
1. GET /api/mesin → fetch registered machines
2. For each machine with IP address:
   - SNMP GET counter OIDs
   - Calculate delta from last poll
   - If delta > 0, submit reading
3. POST /api/pemakaian (if manual mode)
   OR store in agent and submit batch
4. Update local cache with new counter values
```

## Security Notes

- Agent only **reads** from printers (no writes)
- API key required for all submissions
- Data sent over HTTPS
- Config file contains credentials - keep secure
- Run agent with minimal privileges

## Support

For issues, check:
1. Agent logs (console output)
2. PrintPulse API logs (wrangler tail)
3. Printer SNMP settings
4. Network connectivity

## License

MIT
