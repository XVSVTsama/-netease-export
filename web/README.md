# 面板（Web 形态）源码与搭建说明

面板是一个**独立可运行的本地 HTTP 服务**：Node 提供接口 + 静态前端，Electron / Tauri 只是把它套进窗口。所以它可以单独跑，也可以放到自己的服务器、NAS、路由器、Termux 里。

不放公网、不加登录鉴权——它直接用你本机的 cookie 访问你的网易云账号。

## 目录

```
web/
├── server.mjs          服务端（约 700 行，无框架，只用 node:http）
└── public/             前端静态文件
    ├── index.html      首页：概览、任务按钮、实时日志、统计
    ├── browse.html     歌单浏览与曲目
    ├── albums.html     收藏专辑 / 我创建的专辑
    ├── login.html      扫码、手机号、短信、邮箱、Cookie 登录
    ├── settings.html   账号、导出目录、代理设置
    ├── docs.html       使用说明与字段说明
    ├── app.js          前端逻辑（约 900 行，无框架）
    ├── style.css       设计令牌与组件样式（颜色、圆角、按钮、卡片），两端共用
    └── desk.css        仅 ≥900px 生效的桌面布局（左侧导航、概览双栏、列表两列）
```

脚本侧的抓取与整理逻辑在仓库根目录的 `*.mjs`（`export*.mjs`、`sync.mjs`、`fav.mjs`、`cpl.mjs`、`merge.mjs`、`check.mjs`、`stage.mjs`、`build.mjs`），面板通过 `runner.mjs` 串起任务链。

## 运行环境

| 项 | 要求 |
| --- | --- |
| Node.js | 20 及以上 |
| 必需依赖 | `qrcode`（二维码）、`undici`（代理支持） |
| 可选依赖 | `@fontsource/*`（非拉丁文字显示用的字体，缺了自动退回系统字体） |

```bash
# 完整开发环境
npm install --no-audit --no-fund

# 只要面板能跑（省掉 electron / tauri 等开发依赖）
npm install --omit=dev --no-audit --no-fund
```

## 启动

```bash
node web/server.mjs        # 直接启动
npm run panel             # 同上，等价写法
```

启动后终端输出 `web panel on 127.0.0.1:8788`，浏览器打开 <http://127.0.0.1:8788>。

手机同设备访问、Termux 内运行都用 `127.0.0.1`；需要局域网内其它设备访问时设 `HOST=0.0.0.0`（例如 `HOST=0.0.0.0 PORT=8788 node web/server.mjs`），再放行防火墙端口。**无鉴权，不要在不可信网络里开 `0.0.0.0`。**

### 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `PORT` | `8789`（Electron 外壳传 `8788`） | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `NC_ROOT` | 当前工作目录 | 数据根目录（`out2/`、`cookie.txt`、`accounts.json` 所在） |
| `NC_DEST` | `NC_ROOT/导出` | 默认发布目录 |
| `NC_STAGE` | 空 | `1` 时整理脚本写 `out2/staging` 暂存区 |

`desk.css` 不定义任何颜色或外观，只重排结构；窄屏下完全不生效，所以同一份前端在手机浏览器与桌面上各用各的布局。

注意：数据目录与代码目录是分开的。`web/server.mjs` 里的 `CODE` 指向代码所在目录（静态资源、字体、脚本都按它解析），`ROOT` 指向数据目录，因此可以在任意位置 `cd` 到数据目录再 `node <代码目录>/web/server.mjs`。

## 数据目录

```
<NC_ROOT>/
├── accounts.json     账号注册表（首次运行自动生成）
├── cookie.txt        当前登录凭据
├── proxy.json        可选，网络出口设置
├── out/              抓取中间产物（playlists.json）
├── out2/             正式数据：playlists_full.json、albums_cache.json、covers.json、
│                     ranking.json、collected_*.json、history/，以及生成的文档
└── 导出/             发布目录 + 导出.zip
```

`accounts.json` 结构：

```json
{
  "current": "default",
  "accounts": [
    { "id": "default", "nick": "我的账号", "uid": "", "root": ".", "dest": "./导出" }
  ]
}
```

多账号时每个账号 `root` 指向自己的数据目录（面板登录新账号会自动在 `accounts/<uid>` 下建目录），`dest` 是各自发布目录。

## 页面路由

| 路径 | 页面 |
| --- | --- |
| `/` | 概览：账号、任务按钮、实时日志、统计、zip 下载 |
| `/browse` | 歌单列表与曲目 |
| `/albums` | 收藏专辑、我创建的专辑 |
| `/login` | 登录（扫码 / 手机密码 / 短信 / 邮箱 / Cookie） |
| `/settings` | 账号切换、导出目录、代理 |
| `/docs` | 文档与字段说明 |

## 接口

读接口都是 `GET`，返回 JSON。

| 接口 | 作用 |
| --- | --- |
| `/api/status` | 版本、数据根、账号列表、当前任务、统计、历史 |
| `/api/playlists` | 自建歌单列表 |
| `/api/playlist/<id>` | 单个歌单曲目 |
| `/api/collected-playlists` | 收藏歌单 |
| `/api/collected-albums`、`/api/albums` | 收藏专辑 |
| `/api/album/<id>` | 专辑曲目 |
| `/api/created-albums` | 我创建的专辑 |
| `/api/special` | 专项统计 |
| `/api/find-batch?tab=down\|otherVersion\|other\|deleted` | 批量跨平台查找 |
| `/api/find?n=歌名&a=艺人&probe=1` | 单曲跨平台查找 |
| `/api/platforms` | 各平台连通性实测 |
| `/api/dirs?path=` | 目录浏览（选导出目录用） |
| `/api/log/download` | 下载当前任务日志 |
| `/zip` | 下载 `导出.zip` |
| `/fonts.css`、`/fonts/<包>/<文件>` | 非拉丁字体 |
| `/img?kind=pl\|al&id=` | 歌单 / 专辑封面 |

写接口是 `POST`：

| 接口 | 作用 |
| --- | --- |
| `/run/<mode>?acc=<id>` | 启动任务链，`mode` 见下表 |
| `/api/switch?acc=<id>` | 切换当前账号 |
| `/api/settings` | 修改账号发布目录、设当前账号 |
| `/api/proxy`、`/api/proxy/test` | 设置 / 测试网络出口 |
| `/api/login` | 取扫码二维码、轮询状态（`new=1` 刷新） |

任务链 `mode`（由 `runner.mjs` 执行，输出带 `::STEP::` 等标记，面板据此画进度）：

| mode | 含义 |
| --- | --- |
| `sync` | 抓云端数据到暂存区（初始化、同步、封面、版权、排行） |
| `tidy` | 用本地数据重建文档（暂存区存在时只写暂存区） |
| `check` | 核验一致性；暂存区存在时核验后自动提交并发布 |
| `full` | 同步 + 整理 + 核验 + 发布，一条龙 |
| `favSync` / `favTidy` / `favCheck` | 收藏专辑同步 / 整理 / 核验 |
| `cplSync` / `cplTidy` / `cplCheck` | 收藏歌单同步 / 整理 / 核验 |
| `calSync` / `calTidy` / `calCheck` | 我创建的专辑同步 / 整理 / 核验 |

## 放到服务器 / NAS / Termux

```bash
# 1. 取代码
git clone https://github.com/XVSVTsama/-netease-export.git
cd -- -netease-export

# 2. 装依赖（只要面板）
npm install --omit=dev --no-audit --no-fund

# 3. 首次运行生成 accounts.json，然后登录
npm run panel

# 4. 常驻（任选其一）
nohup node web/server.mjs > panel.log 2>&1 &
pm2 start web/server.mjs --name netease-panel
```

Termux 用 `sh install-termux.sh`；Linux / macOS 用 `sh start.sh`；Windows 双击 `start.bat`（三者都是装依赖 + 起面板）。

需要开机自启时用 systemd：

```ini
[Unit]
Description=netease-export panel
After=network.target

[Service]
WorkingDirectory=/opt/netease-export
Environment=PORT=8788
Environment=NC_ROOT=/opt/netease-export
ExecStart=/usr/bin/node web/server.mjs
Restart=always

[Install]
WantedBy=multi-user.target
```

反向代理（nginx）直接把 `/` 转给 `127.0.0.1:8788` 即可，没有 WebSocket、没有 SSE，普通 HTTP 代理就行；务必加 Basic Auth 或只在内网开放。

## 与两种外壳的关系

| 形态 | 启动方式 | 数据目录 |
| --- | --- | --- |
| Windows 便携版 | `main.cjs` 选端口 → 用 Electron 的 Node 起 `web/server.mjs` → 窗口加载 `127.0.0.1:<端口>` | exe 同级目录 |
| Android | Rust 侧自己实现同一套接口（`src-tauri/src/api.rs`），不走本面板 | 应用私有目录 |

也就是说：**面板才是 PC 端的主体**，Electron 外壳只负责选端口、定数据目录、开窗口；想换浏览器、换设备访问，直接跑 `node web/server.mjs` 就行。

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 端口被占用 | Electron 外壳会自动换空闲端口（菜单「文件 → 版本信息」可看实际端口）；单独跑面板时改 `PORT` |
| 页面能开、按钮没反应 | 前端脚本解析失败或接口报错，打开浏览器控制台看第一条报错；`node --check web/public/app.js` 可先验语法 |
| 字体 404、非拉丁文字显示成方块 | 没装 `@fontsource/*`，界面自动退回系统字体，不影响导出 |
| 扫码报 8821 / 环境异常 | 扫码被风控，改用 Cookie 登录（`/login` → Cookie 页） |
| Cookie 失效 | 重新登录一次；`cookie.txt` 只存本地 |
| 任务卡住 | 面板有单任务锁，先等当前任务结束或重启面板；日志可下载 |
