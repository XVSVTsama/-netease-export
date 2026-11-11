# 网易云导出 · NetEase Exporter

把**自己创建的歌单**、**收藏歌单**、**收藏专辑**、**听歌排行**、**爱心歌曲**导出成可读文档，同时提供 **Windows 便携版** 与 **Android App** 两种形态。

只做导出与整理：不提供播放、不代理音频、不绕过任何付费或版权限制。

当前版本：**1.4.0**（Android 界面与 PC 面板统一，共用同一份样式）

---

## 两种形态

| 形态 | 后端 | 外壳 | 产物 | 数据落在 |
| --- | --- | --- | --- | --- |
| Windows 便携版 | Node（`web/` + `*.mjs`） | Electron（`main.cjs`） | 免安装文件夹 | exe 同级目录 |
| Android | Rust（`src-tauri/`） | Tauri 2 + WebView（`ui/`，样式取自 `web/public/style.css`） | 单个 APK | 应用私有目录 |

两端功能对齐，导出的目录结构、CSV 字段一致：

```
导出/
├── 00_自建歌单索引.md
├── 01_数据处理说明.md
├── 02_歌单可见性清单.md
├── 03_整理报告.md
├── 歌单/          每个歌单一个 md 或 csv
├── 收藏/          00_收藏歌单索引、01_收藏专辑、02_我创建的专辑
├── 排行与收藏/    10_听歌排行_全部时间、10_听歌排行_最近一周、12_爱心歌曲
├── 专项/          30_特殊字符歌曲、40_删除与下架与其他版本、50_非拉丁文字歌曲
├── 表格/          all_songs.csv、albums.csv、collected_playlists.csv
└── 导出.zip
```

## 功能

- **登录**：扫码 / 手机号+密码 / 手机号+验证码 / 邮箱+密码 / Cookie 粘贴，登录态持久化；多账号可切换
- **歌单**：自建歌单（含私密、置顶）逐首导出，含艺人、专辑、厂牌、时长、失效状态
- **专辑**：收藏专辑可展开曲目（`weapi /album/{id}`）；「我创建的专辑」单独成档
- **排行**：听歌排行（全部时间 / 最近一周）、爱心歌曲
- **专项**：已删除、已下架、仅其他版本可播、特殊字符命名、非拉丁文字，可查看明细并导出清单
- **字符保真**：零宽符、方向隔离符、组合附加符号（Zalgo）原样保留，五种显示模式切换
- **隐私模式**：一键隐藏昵称与歌单名，方便截图
- **任务链**：同步（抓数据）、整理（重建文档）、核验（一致性检查）可分步执行，也有「同步+整理+核验」一键跑
- **原子发布**：整理结果先写临时目录，核验通过才替换旧版；失败保留上一版
- **打包**：导出目录递归打包成 zip（纯 Node 实现，不依赖系统 zip）

## 使用

### Windows 便携版

1. 解压发布包到任意可写目录（U 盘、桌面、同步盘都可以），双击 `网易云导出.exe`
2. 登录 → 同步 → 整理 → 菜单「文件 → 打开导出目录」
3. 浏览器面板同样是 `http://127.0.0.1:8788`（端口被占用时自动换空闲端口，实际端口见菜单「文件 → 版本信息」）

程序不写注册表、不碰 `%APPDATA%`，`accounts.json`、`cookie.txt`、`out2/`、`导出/` 全部在 exe 同级目录，整个文件夹拷走即可换机使用。放进 Program Files 等只读位置时，数据自动改存用户数据目录。

### 更新（重点）

**Windows 便携版**——数据与程序分离，更新只替换程序：

| 步骤 | 操作 |
| --- | --- |
| 1 | 下载新版 `netease-export-windows.zip`，解压到临时目录 |
| 2 | 覆盖旧文件夹中的程序文件：`网易云导出.exe`、`resources\`、`locales\`、`*.dll`、`*.pak`、`icudtl.dat`、`使用说明.txt` |
| 3 | **不要**覆盖：`accounts.json`、`cookie.txt`、`out2\`、`导出\`、`导出.zip` |
| 4 | 启动后看菜单「文件 → 版本信息」确认版本号 |

更保险的做法：新版解压到新文件夹，把旧文件夹里的 `accounts.json`、`cookie.txt`、`out2\` 复制过去，启动后点一次「整理」重建 `导出\`。回滚同理，旧版覆盖回去数据不受影响。

**Android**——APK 覆盖安装：

| 场景 | 操作 |
| --- | --- |
| 1.3.1 及以后 | 直接安装新版 APK，系统升级覆盖，歌单数据与登录态保留 |
| 1.3.0 及更早 | 这些版本每次构建用随机调试证书，签名不一致无法覆盖；先卸载旧版再装新版，数据需重新同步 |

`versionCode` 随版本号递增（1.3.1 → 10301），签名证书固定为仓库内 `signing/` 的密钥，从 1.3.1 起都能直接覆盖升级。

### 面板（Web 形态）单独运行

面板不是外壳的附属功能，它是独立的本地服务，可以单独跑在自己的电脑、NAS、路由器或 Termux 里：

```bash
git clone https://github.com/XVSVTsama/-netease-export.git
cd -- -netease-export
npm install --omit=dev --no-audit --no-fund   # 只装面板必需依赖
node web/server.mjs                           # 默认 http://127.0.0.1:8788
```

源码位置：`web/server.mjs`（服务端，无框架）、`web/public/`（前端，无框架）。接口清单、数据目录结构、环境变量、systemd 与反向代理写法、常见问题都在 **[web/README.md](web/README.md)**。

默认只监听 `127.0.0.1`；需要局域网内其它设备访问时设 `HOST=0.0.0.0`（无鉴权，别放公网）。

### 桌面外壳 / 源码运行

```bash
npm start          # Electron 窗口（内部起同一个面板服务）
```

Termux 用 `sh install-termux.sh`，Linux / macOS 用 `sh start.sh`，Windows 用 `start.bat`。

## 更新与发布流程（维护者）

1. 改代码，改 `package.json` 与 `src-tauri/tauri.conf.json` 的版本号
2. 本地核验：`node build.mjs`（生成文档 → 打包 → 核验 → 发布）
3. 推 `main` 或打 tag 触发 CI：
   - `build-windows.yml`：`npm run dist:win` 出 `dist/win-unpacked/`，作为 `netease-export-windows` artifact 上传
   - `build-android.yml`：写 `versionCode` → `tauri android build --apk --target aarch64` → 用 `signing/` 密钥签名 → 上传 `netease-export-<版本>-arm64.apk`
4. 下载 artifact 分发；PC 端整包解压即用，Android 端直接覆盖安装

## 构建

### Windows 便携版

```bash
npm install --no-audit --no-fund
npm run dist:win       # 产物：dist/win-unpacked/（免安装目录）
```

`asar` 关闭，`resources/app/` 是真实文件，脚本可被同目录运行时直接执行，Windows 上不需要 sh/python。

### Android APK

```bash
npm install
npx tauri android init --ci
npx tauri android build --apk --target aarch64
```

需要 JDK 17 + Android SDK + NDK 26 + Rust `aarch64-linux-android`。CI 已配好全流程与签名。

界面样式与 PC 面板共用一份：`ui/style.css` 是 `web/public/style.css` 的生成副本，构建前由 `beforeBuildCommand`（`npm run sync:ui`）自动覆盖，不要手改 `ui/style.css`；改样式只改 `web/public/style.css`。`npm run test:ui` 用假 DOM 跑一遍 `ui/index.html` 的脚本，确认没有解析错误、所有按钮都绑定了事件。

## 目录

```
main.cjs               Electron 主进程（窗口、便携目录、端口选择、启动面板服务）
web/server.mjs         面板服务端（接口 + 静态资源 + 任务调度）
web/public/            面板前端
web/README.md          面板部署与接口文档
build.mjs              发布：重建文档 → 打包 zip → 核验 → 原子替换（纯 Node）
runner.mjs             任务链执行器（直接用当前运行时跑脚本，不经 sh）
*.mjs                  抓取与整理脚本（export/sync/fav/cpl/cal/merge/check/enrich/stage/covers）
src-tauri/             Rust 后端（Android）
ui/                    Tauri 前端（Android）：index.html + extra.css + 生成的 style.css
scripts/               sync-ui.mjs（样式同步）、ui-check.mjs（假 DOM 界面自检）
signing/               Android 固定签名密钥（key.pk8 + cert.pem）
.github/workflows/     build-win.yml、build-android.yml
```

数据流：`*.mjs` 抓取 → `out2/`（原始 JSON 与历史）→ `merge.mjs` 生成文档 → `check.mjs` 核验 → `build.mjs` 发布到 `导出/` 并打 zip。多账号时数据根为 `accounts/<uid>/`，代码目录只读共用。

## 运行时环境变量

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `NC_ROOT` | 数据根目录 | 当前工作目录 |
| `NC_DEST` | 发布目录 | `NC_ROOT/导出` |
| `NC_ZIP` | 核验的压缩包路径 | `NC_DEST.zip` |
| `NC_STAGE` | `1` 表示写暂存区 `out2/staging` | 关 |
| `PORT` | 面板端口 | 8788（独立运行时 8789） |
| `HOST` | 面板监听地址 | `127.0.0.1` |

## 关键接口记录

| 用途 | 接口 | 备注 |
| --- | --- | --- |
| 扫码 unikey | `eapi /login/qrcode/unikey` | weapi 生成的码会被新版 App 拒绝（8821） |
| 歌单详情 | `eapi /v6/playlist/detail` | 拿 trackIds 全量 |
| 歌曲详情 | `weapi /v3/song/detail` | 批量 400–1000 首 |
| 专辑曲目 | `weapi /album/{id}` | **不要用 `/v1/album/`，songs 恒空** |
| 收藏专辑 | `weapi /album/sublist` | 25/页 |
| 听歌排行 | `weapi /v1/play/record` | type=0 全部、1 一周 |

## 已知限制

- 网易云接口无 CORS，浏览器不能直接调用，必须本地进程
- 厂牌约 23% 的专辑网易自己没填，导出标「未标注厂牌」
- 彻底下架的歌接口不再返回，无法取回
- Spotify、YouTube Music 无匿名搜索接口，全网对比只给跳转链接
- Android 端抓取逻辑在 Rust 侧独立实现，字段与 Node 侧对齐，但新增字段需两端同步

## 数据与隐私

- cookie 只写本地，仅用于访问你自己的账号
- 仓库不含任何账号数据，`.gitignore` 已排除 `cookie.txt`、`accounts.json`、`out2/`、`导出/`
- `signing/` 只是本应用的固定自签名密钥，用于 APK 覆盖升级，不含任何用户信息
- 音乐版权归权利人所有，本工具仅用于个人数据备份

## 许可证

[MIT](LICENSE)
