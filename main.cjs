/**
 * 桌面壳（Electron 主进程）
 * 便携优先：程序所在目录即数据目录，拷走整个文件夹即可换机使用；
 * 目录只读（如放进 Program Files）时自动退回系统用户数据目录。
 */
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');

const PREFERRED_PORT = 8788;
const CODE = __dirname;
const pkg = (() => { try { return require(path.join(CODE, 'package.json')); } catch { return { version: '' }; } })();

let child = null;
let workDir = CODE;
let port = PREFERRED_PORT;
let quitting = false;

/** 便携化：返回可写的数据目录 */
function pickWorkDir() {
  if (!app.isPackaged) return CODE; // 源码运行时就在项目目录
  const base = path.dirname(app.getPath('exe'));
  try {
    const probe = path.join(base, '.eta-write-test');
    fs.writeFileSync(probe, '1');
    fs.unlinkSync(probe);
    return base;
  } catch {
    return app.getPath('userData');
  }
}

/** 依次尝试首选端口与随机空闲端口 */
function pickPort() {
  const listen = p => new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(0));
    s.once('listening', () => { s.close(() => resolve(p)); });
    s.listen(p, '127.0.0.1');
  });
  return listen(PREFERRED_PORT).then(p => {
    if (p) return p;
    return new Promise(resolve => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => {
        const got = s.address().port;
        s.close(() => resolve(got));
      });
    });
  });
}

function waitServer(timeout = 25000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/status', timeout: 1500 }, res => {
        res.destroy();
        resolve(true);
      });
      req.on('error', () => {
        if (Date.now() - t0 > timeout) reject(new Error(`本地服务启动超时（端口 ${port}）`));
        else setTimeout(tick, 400);
      });
      req.on('timeout', () => req.destroy());
    };
    tick();
  });
}

function startServer() {
  child = spawn(process.execPath, [path.join(CODE, 'web', 'server.mjs')], {
    cwd: workDir,
    env: {
      ...process.env,
      PORT: String(port),
      NC_ROOT: workDir,
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: 'ignore',
  });
  child.on('exit', code => {
    if (code && !quitting) {
      dialog.showErrorBox('本地服务已退出', `退出码 ${code}\n工作目录：${workDir}`);
    }
  });
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1120,
    height: 860,
    minWidth: 860,
    minHeight: 640,
    title: `网易云导出 ${pkg.version || ''}`.trim(),
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  await waitServer();
  win.loadURL(`http://127.0.0.1:${port}`);
  return win;
}

function buildMenu() {
  const tpl = [
    {
      label: '文件',
      submenu: [
        { label: '打开导出目录', click: () => shell.openPath(path.join(workDir, '导出')) },
        { label: '打开数据目录', click: () => shell.openPath(workDir) },
        { type: 'separator' },
        { label: '版本信息', click: () => dialog.showMessageBox({
          type: 'info',
          message: `网易云导出 ${pkg.version || ''}`,
          detail: `数据目录：${workDir}\n面板端口：${port}\n\n便携版：整个文件夹拷走即可换机使用。`,
        }) },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(async () => {
    workDir = pickWorkDir();
    try { process.chdir(workDir); } catch {}
    // 首次运行生成账号配置骨架
    const accFile = path.join(workDir, 'accounts.json');
    if (!fs.existsSync(accFile)) {
      try { fs.copyFileSync(path.join(CODE, 'accounts.example.json'), accFile); } catch {}
    }
    port = await pickPort();
    startServer();
    buildMenu();
    try {
      await createWindow();
    } catch (e) {
      dialog.showErrorBox('启动失败', `${e.message}\n工作目录：${workDir}`);
      app.quit();
    }
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

app.on('before-quit', () => {
  quitting = true;
  if (child) { try { child.kill(); } catch {} }
});

app.on('window-all-closed', () => {
  quitting = true;
  if (child) { try { child.kill(); } catch {} }
  app.quit();
});
