# PrintPulse Agent - 1-Click Setup (PowerShell)
$ErrorActionPreference = 'Continue'
$AgentDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "============================================" -ForegroundColor Cyan
Write-Host " PrintPulse Agent - 1-Click Setup" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan

# 1. Check/Install Python
Write-Host "[1/3] Checking Python..." -ForegroundColor Yellow
$py = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $py) { $py = (Get-Command python3 -ErrorAction SilentlyContinue).Source }
if (-not $py) {
    Write-Host "  Python not found. Installing via winget..." -ForegroundColor Yellow
    winget install --id Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    $py = (Get-Command python -ErrorAction SilentlyContinue).Source
    if (-not $py) {
        $candidates = Get-ChildItem "$env:LOCALAPPDATA\Programs\Python\Python*\python.exe" 2>$null
        if ($candidates) { $py = $candidates[-1].FullName }
    }
    if ($py) { Write-Host "  Python installed: $py" -ForegroundColor Green }
    else { Write-Host "  Please install Python manually" -ForegroundColor Yellow }
} else {
    $v = & $py --version 2>&1
    Write-Host "  $v" -ForegroundColor Green
}

# 2. Install snmpy
Write-Host "[2/3] Installing snmpy..." -ForegroundColor Yellow
$pip = $null
if ($py -and (& $py -m pip --version 2>&1) -and $LASTEXITCODE -eq 0) { $pip = "$py -m pip" }
elseif ((Get-Command pip -ErrorAction SilentlyContinue).Source) { $pip = 'pip' }
elseif ((Get-Command pip3 -ErrorAction SilentlyContinue).Source) { $pip = 'pip3' }

if ($pip) {
    Invoke-Expression "$pip install git+https://github.com/snmpware/snmpy.git 2>&1" | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Host "  snmpy installed" -ForegroundColor Green }
    else { Write-Host "  snmpy install had warnings" -ForegroundColor Yellow }
} else {
    Write-Host "  pip not found. Run: python -m pip install git+https://github.com/snmpware/snmpy.git" -ForegroundColor Yellow
}

# 3. NPM deps
Write-Host "[3/3] Checking Node.js deps..." -ForegroundColor Yellow
if (-not (Test-Path "$AgentDir\node_modules\.package-lock.json")) {
    Write-Host "  Installing npm packages..." -ForegroundColor Yellow
    Push-Location $AgentDir
    npm install 2>&1 | Out-Null
    Pop-Location
    Write-Host "  npm install done" -ForegroundColor Green
} else {
    Write-Host "  node_modules OK" -ForegroundColor Green
}

Write-Host "============================================" -ForegroundColor Cyan
Write-Host " Setup complete!" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "Run agent: cd $AgentDir ; npx electron ." -ForegroundColor White
