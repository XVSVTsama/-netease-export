const { app, BrowserWindow, shell, dialog } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');

const PORT = 8788;
let child = null;

function waitServer(timeout = 20000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/status', timeout: 1200 }, res => {
        res.destroy();
        resolve(true);
      });
      req.on('error', () => {
        if (Date.now() - t0 > timeout) reject(new Error('本地服务启动超时'));
        else setTimeout(tick, 400);
      });
      req.on('timeout', () => { req.destroy(); });
    };
    tick();
  });
}

function startServer() {
  child = spawn(process.execPath, [path.join(__dirname, 'web', 'server.mjs')], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'ignore',
  });
  child.on('exit', code => {
    if (code && !app.isQuiting) {
      dialog.showErrorBox('本地服务已退出', `退出码 ${code}\n请查看终端输出或重新启动。`);
    }
  });
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1120,
    height: 860,
    minWidth: 860,
    minHeight: 640,
    title: '网易云导出',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  await waitServer();
  win.loadURL(`http://127.0.0.1:${PORT}`);
}

app.whenReady().then(() => {
  startServer();
  createWindow().catch(e => {
    dialog.showErrorBox('启动失败', e.message);
    app.quit();
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', () => {
  app.isQuiting = true;
  if (child) { try { child.kill(); } catch {} }
});

app.on('window-all-closed', () => {
  if (child) { try { child.kill(); } catch {} }
  app.quit();
});
