const { app, BrowserWindow, Tray, Menu } = require('electron');
const path = require('path');
const config = require('./config');
const ipcController = require('./controllers/ipcController');
const PollerService = require('./services/PollerService');

let tray = null;
let mainWindow = null;
let poller = null;

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

app.on('second-instance', () => {
  showWindow();
});

app.whenReady().then(() => {
  createTray();
  
  // Start Poller
  poller = new PollerService();
  poller.start();

  // Register all IPC events
  ipcController.register(poller);

  // If not logged in, show UI immediately
  if (!config.get('token')) {
    createWindow();
  } else {
    // If logged in, create it but keep it hidden so it loads in background
    createWindow(false); 
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      showWindow();
    }
  });
});

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  try { tray = new Tray(iconPath); } 
  catch { tray = new Tray(path.join(__dirname, '..', 'icon-fallback.png')); }
  
  const loginItemSettings = app.getLoginItemSettings();
  
  const contextMenu = Menu.buildFromTemplate([
    { label: 'PrintPulse Agent v3', enabled: false },
    { type: 'separator' },
    { label: 'Buka Dashboard', click: () => showWindow() },
    {
      label: 'Auto Startup',
      type: 'checkbox',
      checked: loginItemSettings.openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({
          openAtLogin: item.checked,
          path: app.getPath('exe')
        });
      }
    },
    { type: 'separator' },
    { 
      label: 'Keluar', 
      click: () => {
        if (poller) poller.stop();
        app.isQuitting = true;
        app.quit();
      } 
    }
  ]);

  tray.setToolTip('PrintPulse Agent v3 - Running');
  tray.setContextMenu(contextMenu);
  
  // Windows fix: explicitly bind double-click and click
  tray.on('double-click', () => showWindow());
  tray.on('click', () => showWindow());
}

function createWindow(show = true) {
  if (mainWindow) {
    if (show) showWindow();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 750,
    title: 'PrintPulse Agent',
    show: show,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    autoHideMenuBar: true
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  
  // Attach mainWindow to ipcController for event emitting
  ipcController.setWindow(mainWindow);
}

function showWindow() {
  if (!mainWindow) {
    createWindow(true);
    return;
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.focus();
}

app.on('window-all-closed', (event) => {
  event.preventDefault();
});
app.on('before-quit', () => {
  app.isQuitting = true;
});