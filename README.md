# 网易云导出 · NetEase Exporter

把网易云音乐里**自己创建的歌单**、**收藏歌单**、**收藏专辑**、**听歌排行**、**爱心歌曲**导出成可读文档，并提供**桌面应用**与 **Android App** 两种形态。

只做导出与整理，不提供播放、不代理音频、不绕过任何付费或版权限制。

---

## 两种形态

| 形态 | 后端 | 外壳 | 产物 |
| --- | --- | --- | --- |
| 桌面版 | Node.js（`web/` + `*.mjs`） | Electron（`main.js`） | Windows 绿色版文件夹 |
| Android | Rust（`src-tauri/`） | Tauri 2 + WebView（`ui/`） | APK |

两套后端**功能对齐**，导出的文件结构、CSV 字段一致：

```
exports/
├── 歌单/          每个歌单一个 csv 或 md
├── 收藏专辑/      单张专辑曲目
├── 表格/          收藏歌单、收藏专辑、听歌排行
└── 专项/          下架、其他版本、特殊字符、非拉丁清单
```

## 功能

- **登录**：扫码 / 手机号+密码 / 手机号+验证码 / 邮箱+密码 / Cookie 粘贴，登录态持久化
- **歌单**：自建歌单（含私密）逐首导出，含艺人、专辑、厂牌、时长、失效状态
- **专辑**：收藏专辑可展开曲目（`/weapi/album/{id}`，注意不是 `v1`）
- **排行**：听歌排行（全部时间 / 最近一周）
- **专项**：已下架、仅其他版本可播、特殊字符命名、非拉丁文字，可查看明细与导出清单
- **字符保真**：零宽符、方向隔离符、组合附加符号（Zalgo）原样保留，五种显示模式切换
- **隐私模式**：一键隐藏昵称与歌单名，方便截图
- **打包**：导出目录递归打包成 zip

## 构建

### Windows 桌面版

```bash
npm install --no-audit --no-fund
npm run dist:win        # 产物：dist/win-unpacked/
```

绿色版，整个文件夹拷走即用，数据在同目录（`out2/`、`导出/`、`cookie.txt`）。

### Android APK

```bash
npm install
npx tauri android init --ci
npx tauri android build --apk --target aarch64
```

需要 JDK 17 + Android SDK + NDK 26 + Rust 的 `aarch64-linux-android` target。

CI 已配好：`.github/workflows/build-android.yml` 会自动装 NDK、签名（debug keystore）并上传 APK。

### 本地跑面板（不开壳）

```bash
npm run panel           # http://127.0.0.1:8788
```

## 目录

```
main.js                Electron 主进程（PC）
web/                   面板服务端与前端（PC）
src-tauri/             Rust 后端（Android）
ui/                    Tauri 前端（Android）
*.mjs                  Node 侧抓取、整理、核验脚本（PC）
.github/workflows/     build-win.yml、build-android.yml
```

## 关键接口记录

| 用途 | 接口 | 备注 |
| --- | --- | --- |
| 扫码 unikey | `eapi /login/qrcode/unikey` | weapi 生成的码会被新版 App 拒绝 |
| 歌单详情 | `eapi /v6/playlist/detail` | 拿 trackIds 全量 |
| 歌曲详情 | `weapi /v3/song/detail` | 批量 400–1000 首 |
| 专辑曲目 | `weapi /album/{id}` | **不要用 `/v1/album/`，songs 恒空** |
| 收藏专辑 | `weapi /album/sublist` | 25/页 |
| 听歌排行 | `weapi /v1/play/record` | type=0 全部、1 一周 |

## 已知限制

- 网易云接口无 CORS，浏览器无法直接调用，必须本地进程
- 厂牌约 23% 的专辑网易自己未填写，导出标「未标注厂牌」
- Spotify、YouTube Music 无匿名搜索接口（Node 版的全网对比只给跳转链接）
- 彻底下架的歌接口不再返回，无法取回

## 数据与隐私

- cookie 只写本地，仅用于访问你自己的账号
- 仓库不含任何账号数据，`.gitignore` 已排除 `cookie.txt`、`accounts.json`、`out2/`
- 音乐版权归权利人所有，本工具仅用于个人数据备份

## 许可证

[MIT](LICENSE)
