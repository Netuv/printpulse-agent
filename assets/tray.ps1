# PrintPulse Agent Tray
param($Port, $AgentPid)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$url = "http://127.0.0.1:$Port"

# Load icon from temp file created by main.js
$icoPath = "$env:TEMP\pp-tray-$AgentPid.ico"
$icon = $null
if (Test-Path $icoPath) { try { $icon = [Drawing.Icon]::new($icoPath) } catch { $icon = $null } }

$tray = New-Object Windows.Forms.NotifyIcon
$tray.Text = "PrintPulse Agent"
$tray.Visible = $true
if ($icon) { $tray.Icon = $icon }
else { $tray.Icon = [Drawing.SystemIcons]::Application }

$menu = New-Object Windows.Forms.ContextMenuStrip
$null = $menu.Items.Add((New-Object Windows.Forms.ToolStripMenuItem("Open Dashboard", $null, { Start-Process $url })))
$null = $menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
$auto = New-Object Windows.Forms.ToolStripMenuItem("AutoStart")
$startup = "$env:USERPROFILE\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\PrintPulseAgent.url"
$auto.Checked = (Test-Path $startup)
$auto.Add_Click({
  if ($this.Checked) { Remove-Item $startup -Force -ErrorAction SilentlyContinue; $this.Checked = $false }
  else {
    try { $exe = (Get-CimInstance Win32_Process -Filter "ProcessId = $AgentPid" -ErrorAction Stop).ExecutablePath; Set-Content $startup "[InternetShortcut]`nURL=file:///$($exe.Replace('\','/'))`nIconIndex=0" -Force; $this.Checked = $true } catch {}
  }
})
$null = $menu.Items.Add($auto)
$null = $menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
$null = $menu.Items.Add((New-Object Windows.Forms.ToolStripMenuItem("Quit", $null, {
  $tray.Visible = $false; $tray.Dispose()
  try { Invoke-WebRequest "$url/api/quit" -Method POST -UseBasicParsing } catch {}
  Stop-Process $AgentPid -Force
})))
$tray.ContextMenuStrip = $menu

$tray.Add_Click({ if ($_.Button -eq [Windows.Forms.MouseButtons]::Left) { Start-Process $url } })

while ($true) {
  Start-Sleep 5
  try { Invoke-WebRequest "$url/api/ping" -UseBasicParsing -TimeoutSec 3 | Out-Null }
  catch { $tray.Visible = $false; $tray.Dispose(); break }
}
