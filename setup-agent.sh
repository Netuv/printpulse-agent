#!/usr/bin/env bash
set -euo pipefail

echo "PrintPulse Agent — Setup (Linux/macOS)"

echo "[1/3] Checking Python..."
PYTHON_CMD=""
if command -v python3 >/dev/null 2>&1; then
  PYTHON_CMD=python3
elif command -v python >/dev/null 2>&1; then
  PYTHON_CMD=python
fi

if [ -z "$PYTHON_CMD" ]; then
  echo "Python 3 is not installed on this system."
  echo "Please install Python 3 (use your package manager or download from https://www.python.org)."
  echo "On Debian/Ubuntu: sudo apt update && sudo apt install -y python3 python3-pip"
  echo "On CentOS/RHEL: sudo yum install -y python3 python3-pip"
  echo "On macOS with Homebrew: brew install python"
  exit 1
fi

echo "Found $($PYTHON_CMD --version 2>&1)"

echo "[2/3] Ensuring pip is available..."
if ! $PYTHON_CMD -m pip --version >/dev/null 2>&1; then
  echo "pip not found. Attempting to bootstrap pip..."
  $PYTHON_CMD -m ensurepip --upgrade || true
fi

echo "[3/3] Installing snmpy (fast SNMP library)..."
# Use --user to avoid requiring sudo by default
$PYTHON_CMD -m pip install --user --upgrade git+https://github.com/snmpware/snmpy.git

if [ $? -ne 0 ]; then
  echo "WARNING: snmpy installation failed. Agent will fall back to Node.js SNMP library."
  echo "Run the following to retry as needed:"
  echo "  $PYTHON_CMD -m pip install --upgrade git+https://github.com/snmpware/snmpy.git"
  exit 1
fi

echo "snmpy installed successfully."

echo "Setup complete. You can test with:"
echo "  $PYTHON_CMD snmpy_scanner.py <IP> --probe"

exit 0
