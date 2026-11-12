mod api;
mod client;
mod crypto;

use client::Client;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{Manager, State};

/// 后台任务：同步 → 整理 → 核验，脱离 WebView 运行，切后台/锁屏也不会中断
pub struct Job {
    running: AtomicBool,
    stop: AtomicBool,
    phase: Mutex<String>,
    kind: Mutex<String>,
    step: Mutex<String>,
    total: AtomicUsize,
    done: AtomicUsize,
    phase_total: AtomicUsize,
    phase_done: AtomicUsize,
    ok: AtomicUsize,
    fail: AtomicUsize,
    songs: AtomicI64,
    started: Mutex<Option<Instant>>,
    logs: Mutex<Vec<(String, String, String)>>,
    log_path: Mutex<String>,
}

impl Job {
    fn new() -> Self {
        Self {
            running: AtomicBool::new(false),
            stop: AtomicBool::new(false),
            phase: Mutex::new(String::new()),
            kind: Mutex::new(String::new()),
            step: Mutex::new(String::new()),
            total: AtomicUsize::new(0),
            done: AtomicUsize::new(0),
            phase_total: AtomicUsize::new(0),
            phase_done: AtomicUsize::new(0),
            ok: AtomicUsize::new(0),
            fail: AtomicUsize::new(0),
            songs: AtomicI64::new(0),
            started: Mutex::new(None),
            logs: Mutex::new(Vec::new()),
            log_path: Mutex::new(String::new()),
        }
    }

    fn reset(&self, total: usize, log_path: String, kind: &str) {
        *self.kind.lock().unwrap() = kind.to_string();
        self.stop.store(false, Ordering::SeqCst);
        self.total.store(total, Ordering::SeqCst);
        self.done.store(0, Ordering::SeqCst);
        self.phase_total.store(0, Ordering::SeqCst);
        self.phase_done.store(0, Ordering::SeqCst);
        self.ok.store(0, Ordering::SeqCst);
        self.fail.store(0, Ordering::SeqCst);
        self.songs.store(0, Ordering::SeqCst);
        *self.phase.lock().unwrap() = "sync".to_string();
        *self.step.lock().unwrap() = String::new();
        *self.started.lock().unwrap() = Some(Instant::now());
        self.logs.lock().unwrap().clear();
        *self.log_path.lock().unwrap() = log_path;
    }

    fn set_phase(&self, p: &str) {
        *self.phase.lock().unwrap() = p.to_string();
    }

    fn log(&self, kind: &str, text: impl Into<String>) {
        let text = text.into();
        let path = self.log_path.lock().unwrap().clone();
        if !path.is_empty() {
            use std::io::Write;
            if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&path) {
                let _ = writeln!(f, "{} [{}] {}", now_full(), kind, text);
            }
        }
        let hms = chrono::Local::now().format("%H:%M:%S").to_string();
        let mut logs = self.logs.lock().unwrap();
        logs.push((kind.to_string(), hms, text));
        if logs.len() > 600 { logs.remove(0); }
    }
}

pub struct AppState {
    client: Arc<Client>,
    last_qr: Mutex<String>,
    special: Mutex<Vec<Value>>,
    special_ids: Mutex<std::collections::HashSet<i64>>,
    job: Arc<Job>,
}

fn cookie_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("cookie.txt"))
}

fn save_cookie(app: &tauri::AppHandle, cookie: &str) {
    if let Some(p) = cookie_path(app) {
        if let Some(dir) = p.parent() { let _ = fs::create_dir_all(dir); }
        let _ = fs::write(p, cookie);
    }
}

fn sanitize(name: &str) -> String {
    let s: String = name.chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let t = s.trim().to_string();
    if t.is_empty() { "未命名".to_string() } else { t.chars().take(50).collect() }
}

/// 允许 "子目录/文件名"，逐段清洗
fn sanitize_path(name: &str) -> String {
    name.split('/').filter(|s| !s.is_empty()).map(sanitize).collect::<Vec<_>>().join("/")
}

fn fmt_dur(ms: i64) -> String {
    if ms <= 0 { return "--:--".into(); }
    let total = (ms + 500) / 1000;
    format!("{}:{:02}", total / 60, total % 60)
}

/// 厂牌列的显示文本：区分「有厂牌 / 网易未标注 / 查询失败 / 还没查」
fn company_text(r: &Value) -> &str {
    let c = r["company"].as_str().unwrap_or("");
    if !c.is_empty() { return c; }
    match r["cstate"].as_str() {
        Some("none") => "未标注厂牌",
        Some("fail") => "查询失败",
        _ => "未查询",
    }
}

/// 把查询结果写回行：记录 cstate，区分「网易没标注」和「请求失败」
/// 返回是否有改动
fn apply_companies(
    rows: &mut Vec<Value>,
    found: &std::collections::HashMap<i64, String>,
    failed: &std::collections::HashSet<i64>,
) -> bool {
    let mut changed = false;
    for r in rows.iter_mut() {
        let aid = match r["alId"].as_i64() {
            Some(a) if a > 0 => a,
            _ => continue,
        };
        let cur = r["company"].as_str().unwrap_or("");
        if let Some(cmp) = found.get(&aid) {
            if !cmp.is_empty() {
                if cur.is_empty() {
                    r["company"] = serde_json::json!(cmp);
                    r["cstate"] = serde_json::json!("have");
                    changed = true;
                }
            } else if cur.is_empty() && r["cstate"].as_str() != Some("none") {
                r["cstate"] = serde_json::json!("none");
                changed = true;
            }
        } else if failed.contains(&aid) && cur.is_empty() && r["cstate"].as_str() != Some("fail") {
            r["cstate"] = serde_json::json!("fail");
            changed = true;
        }
    }
    changed
}

/// 把当前查到的厂牌写回 stage 文件，返回被改动的文件数
/// 每批调用一次就能做增量保存，中断也不会丢掉已经查过的专辑
fn persist_companies(
    files: &mut [(PathBuf, Value)],
    found: &std::collections::HashMap<i64, String>,
    failed: &std::collections::HashSet<i64>,
) -> usize {
    let mut updated = 0usize;
    for (p, d) in files.iter_mut() {
        let changed = match d["rows"].as_array_mut() {
            Some(rows) => apply_companies(rows, found, failed),
            None => false,
        };
        if changed {
            updated += 1;
            let _ = fs::write(&*p, d.to_string());
        }
    }
    updated
}

/// 整理前把厂牌缓存写回 stage：纯本地，一个请求都不发
fn apply_cached_companies(app: &tauri::AppHandle, kind: &str) -> usize {
    let dir = match stage_dir(app, kind) { Ok(d) => d, Err(_) => return 0 };
    let mut files = read_stage(&dir);
    let found: HashMap<i64, String> = api::companies_snapshot()
        .into_iter()
        .filter(|(_, v)| !v.is_empty())
        .collect();
    if found.is_empty() { return 0; }
    persist_companies(&mut files, &found, &std::collections::HashSet::new())
}

fn to_csv(d: &Value) -> String {
    let mut out = String::from("\u{feff}序号,歌名,制作人/团体,专辑,发行公司/厂牌,时长,时长秒,歌曲ID,专辑ID,流行度,MV_ID,别名,权限,状态\n");
    if let Some(rows) = d["rows"].as_array() {
        for (i, r) in rows.iter().enumerate() {
            let e = |v: &Value| format!("\"{}\"", v.as_str().unwrap_or("").replace('"', "\"\""));
            let fee = r["fee"].as_i64().unwrap_or(0);
            let perm = match fee { 0 => "免费", 1 => "VIP", 4 => "付费专辑", 8 => "低音质", _ => "其他" };
            out.push_str(&format!(
                "{},{},{},{},{},{},{},{},{},{},{},{},{},{}\n",
                i + 1,
                e(&r["name"]),
                e(&r["ar"]),
                e(&r["al"]),
                format!("\"{}\"", company_text(r).replace('"', "\"\"")),
                fmt_dur(r["dur"].as_i64().unwrap_or(0)),
                r["dur"].as_i64().unwrap_or(0) / 1000,
                r["id"].as_i64().unwrap_or(0),
                r["alId"].as_i64().unwrap_or(0),
                r["pop"].as_i64().unwrap_or(0),
                r["mv"].as_i64().unwrap_or(0),
                e(&r["alia"]),
                perm,
                if r["ncr"].as_bool().unwrap_or(false) { "仅其他版本可播" } else { "正常" }
            ));
        }
    }
    out
}

fn to_md(d: &Value) -> String {
    let name = d["name"].as_str().unwrap_or("歌单");
    let mut out = format!("# {}\n\n- 曲目：{} 首\n- 歌单 ID：{}\n- 导出时间：{}\n\n## 曲目\n\n",
        name, d["count"].as_i64().unwrap_or(0), d["id"].as_i64().unwrap_or(0),
        now_human());
    if let Some(rows) = d["rows"].as_array() {
        for (i, r) in rows.iter().enumerate() {
            let mark = if r["ncr"].as_bool().unwrap_or(false) { "  〔仅其他版本可播〕" } else { "" };
            out.push_str(&format!("{}. {} - {} - {} - {}  〔{}〕{}\n",
                i + 1,
                r["name"].as_str().unwrap_or(""),
                r["ar"].as_str().unwrap_or("未知"),
                r["al"].as_str().unwrap_or("未知"),
                company_text(r),
                fmt_dur(r["dur"].as_i64().unwrap_or(0)),
                mark));
        }
    }
    out
}

fn now_human() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M").to_string()
}

fn now_full() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

/* ---------------- 最近一次同步 / 整理的时间 ---------------- */

fn state_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("state.json"))
}

fn read_state(app: &tauri::AppHandle) -> Value {
    state_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

fn set_state(app: &tauri::AppHandle, key: &str, value: &str) {
    let mut v = read_state(app);
    v[key] = Value::String(value.to_string());
    if let Some(p) = state_path(app) {
        if let Some(dir) = p.parent() { let _ = fs::create_dir_all(dir); }
        let _ = fs::write(p, v.to_string());
    }
}

/* ---------------- 命令 ---------------- */

#[tauri::command]
async fn qr_new(state: State<'_, AppState>) -> Result<Value, String> {
    let r = api::qr_new(&state.client).await?;
    if let Some(k) = r["key"].as_str() { *state.last_qr.lock().unwrap() = k.to_string(); }
    Ok(r)
}

#[tauri::command]
async fn qr_poll(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let key = state.last_qr.lock().unwrap().clone();
    if key.is_empty() { return Err("没有待轮询的二维码".into()); }
    let r = api::qr_poll(&state.client, &key).await?;
    if r["code"].as_i64() == Some(803) { save_cookie(&app, &state.client.cookie_header()); }
    Ok(r)
}

#[tauri::command]
async fn account(state: State<'_, AppState>) -> Result<Value, String> { api::account(&state.client).await }

#[tauri::command]
async fn playlists(state: State<'_, AppState>, uid: i64) -> Result<Value, String> { api::playlists(&state.client, uid).await }

#[tauri::command]
async fn playlist_detail(state: State<'_, AppState>, id: i64) -> Result<Value, String> {
    api::playlist_detail(&state.client, id, true).await
}

#[tauri::command]
async fn login_cookie(app: tauri::AppHandle, state: State<'_, AppState>, cookie: String) -> Result<Value, String> {
    let r = api::login_cookie(&state.client, &cookie).await?;
    save_cookie(&app, &state.client.cookie_header());
    Ok(r)
}

#[tauri::command]
async fn login_phone_password(app: tauri::AppHandle, state: State<'_, AppState>, phone: String, password: String) -> Result<Value, String> {
    let r = api::login_phone_password(&state.client, &phone, &password).await?;
    save_cookie(&app, &state.client.cookie_header());
    Ok(r)
}

#[tauri::command]
async fn sms_sent(state: State<'_, AppState>, phone: String) -> Result<Value, String> {
    api::sms_sent(&state.client, &phone).await
}

#[tauri::command]
async fn login_phone_captcha(app: tauri::AppHandle, state: State<'_, AppState>, phone: String, captcha: String) -> Result<Value, String> {
    let r = api::login_phone_captcha(&state.client, &phone, &captcha).await?;
    save_cookie(&app, &state.client.cookie_header());
    Ok(r)
}

#[tauri::command]
async fn login_email(app: tauri::AppHandle, state: State<'_, AppState>, email: String, password: String) -> Result<Value, String> {
    let r = api::login_email(&state.client, &email, &password).await?;
    save_cookie(&app, &state.client.cookie_header());
    Ok(r)
}

#[tauri::command]
async fn logout(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    state.client.clear_cookies();
    if let Some(p) = cookie_path(&app) { let _ = fs::remove_file(p); }
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
async fn album_detail(state: State<'_, AppState>, id: i64) -> Result<Value, String> {
    api::album_detail(&state.client, id).await
}

/// 导出专辑曲目
#[tauri::command]
async fn export_album(app: tauri::AppHandle, state: State<'_, AppState>, id: i64, format: String) -> Result<Value, String> {
    let d = api::album_detail(&state.client, id).await?;
    let content = if format == "md" { to_md(&d) } else { to_csv(&d) };
    let name = sanitize(d["name"].as_str().unwrap_or("album"));
    let ext = if format == "md" { "md" } else { "csv" };
    let (paths, _) = write_both(&app, &format!("收藏专辑/{}.{}", name, ext), &content);
    if paths.is_empty() { return Err("写入文件失败".into()); }
    Ok(serde_json::json!({ "ok": true, "paths": paths, "count": d["count"] }))
}

/// 导出歌单：format = csv | md，返回保存路径列表
#[tauri::command]
async fn export_playlist(app: tauri::AppHandle, state: State<'_, AppState>, id: i64, format: String) -> Result<Value, String> {
    let d = api::playlist_detail(&state.client, id, true).await?;
    let content = if format == "md" { to_md(&d) } else { to_csv(&d) };
    let name = sanitize(d["name"].as_str().unwrap_or("playlist"));
    let ext = if format == "md" { "md" } else { "csv" };
    let file = format!("歌单/{}.{}", name, ext);

    let mut saved: Vec<String> = Vec::new();

    // 1) App 私有目录（一定可写）
    if let Ok(dir) = app.path().app_data_dir() {
        let out = dir.join("exports");
        let _ = fs::create_dir_all(&out);
        let p = out.join(&file);
        if fs::write(&p, content.as_bytes()).is_ok() {
            saved.push(p.to_string_lossy().to_string());
        }
    }

    // 2) 公共下载目录（尽力而为，无权限则跳过）
    for base in ["/storage/emulated/0/Download/网易云导出", "/sdcard/Download/网易云导出"] {
        let dir = std::path::Path::new(base);
        if fs::create_dir_all(dir).is_ok() {
            let p = dir.join(&file);
            if fs::write(&p, content.as_bytes()).is_ok() {
                saved.push(p.to_string_lossy().to_string());
                break;
            }
        }
    }

    if saved.is_empty() {
        return Err("写入文件失败".into());
    }
    // 累积专项明细（按歌曲 ID 去重）
    if let Some(items) = d["items"].as_array() {
        let mut set = state.special_ids.lock().unwrap();
        let mut acc = state.special.lock().unwrap();
        for it in items {
            if let Some(id) = it["id"].as_i64() {
                if set.insert(id) { acc.push(it.clone()); }
            }
        }
    }
    Ok(serde_json::json!({ "ok": true, "paths": saved, "count": d["count"].as_i64().unwrap_or(0), "stats": d["stats"].clone() }))
}

#[tauri::command]
async fn collected_albums(state: State<'_, AppState>) -> Result<Value, String> {
    api::collected_albums(&state.client).await
}

#[tauri::command]
async fn play_record(state: State<'_, AppState>, uid: i64, week: bool) -> Result<Value, String> {
    api::play_record(&state.client, uid, week).await
}

/// 通用保存：把前端生成的文本写入文件
#[tauri::command]
async fn save_text(app: tauri::AppHandle, name: String, content: String) -> Result<Value, String> {
    let file = sanitize(&name);
    let mut saved: Vec<String> = Vec::new();
    if let Ok(dir) = app.path().app_data_dir() {
        let out = dir.join("exports");
        let _ = fs::create_dir_all(&out);
        let p = out.join(&file);
        if fs::write(&p, content.as_bytes()).is_ok() { saved.push(p.to_string_lossy().to_string()); }
    }
    for base in ["/storage/emulated/0/Download/网易云导出", "/sdcard/Download/网易云导出"] {
        let dir = std::path::Path::new(base);
        if fs::create_dir_all(dir).is_ok() {
            let p = dir.join(&file);
            if fs::write(&p, content.as_bytes()).is_ok() { saved.push(p.to_string_lossy().to_string()); break; }
        }
    }
    if saved.is_empty() { return Err("写入文件失败".into()); }
    Ok(serde_json::json!({ "ok": true, "paths": saved }))
}

#[tauri::command]
async fn special_items(state: State<'_, AppState>) -> Result<Value, String> {
    let acc = state.special.lock().unwrap();
    Ok(serde_json::json!({ "total": acc.len(), "items": acc.clone() }))
}

#[tauri::command]
async fn export_special(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let acc = state.special.lock().unwrap();
    if acc.is_empty() { return Err("还没有专项数据，先导出几个歌单".into()); }
    let mut out = String::from("\u{feff}序号,歌名,制作人/团体,专辑,发行公司/厂牌,分类,歌曲ID\n");
    let e = |v: &Value| format!("\"{}\"", v.as_str().unwrap_or("").replace('"', "\"\""));
    for (i, it) in acc.iter().enumerate() {
        let kinds = it["kinds"].as_array()
            .map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(" / "))
            .unwrap_or_default();
        out.push_str(&format!("{},{},{},{},{},{},{}\n", i + 1,
            e(&it["name"]), e(&it["ar"]), e(&it["al"]), e(&it["company"]), kinds,
            it["id"].as_i64().unwrap_or(0)));
    }
    drop(acc);
    let (paths, _) = write_both(&app, "专项清单.csv", &out);
    if paths.is_empty() { return Err("写入失败".into()); }
    Ok(serde_json::json!({ "ok": true, "paths": paths }))
}

fn write_both(app: &tauri::AppHandle, name: &str, content: &str) -> (Vec<String>, ()) {
    let file = sanitize_path(name);
    let mut saved: Vec<String> = Vec::new();
    if let Ok(dir) = app.path().app_data_dir() {
        let out = dir.join("exports");
        let _ = fs::create_dir_all(&out);
        let p = out.join(&file);
        if fs::write(&p, content.as_bytes()).is_ok() { saved.push(p.to_string_lossy().to_string()); }
    }
    for base in ["/storage/emulated/0/Download/网易云导出", "/sdcard/Download/网易云导出"] {
        let dir = std::path::Path::new(base);
        if fs::create_dir_all(dir).is_ok() {
            let p = dir.join(&file);
            if fs::write(&p, content.as_bytes()).is_ok() { saved.push(p.to_string_lossy().to_string()); break; }
        }
    }
    (saved, ())
}

/// 把已导出的文件打包成 zip
#[tauri::command]
async fn zip_exports(app: tauri::AppHandle) -> Result<Value, String> {
    use std::io::Write;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("exports");
    if !dir.exists() { return Err("还没有导出任何文件".into()); }
    fn collect(dir: &std::path::Path, base: &std::path::Path, out: &mut Vec<(std::path::PathBuf, String)>) {
        if let Ok(rd) = fs::read_dir(dir) {
            for e in rd.filter_map(|e| e.ok()) {
                let p = e.path();
                if p.is_dir() { collect(&p, base, out); continue; }
                if p.extension().map(|x| x == "zip").unwrap_or(false) { continue; }
                if let Ok(rel) = p.strip_prefix(base) {
                    out.push((p.clone(), rel.to_string_lossy().replace('\\', "/")));
                }
            }
        }
    }
    let mut entries: Vec<(std::path::PathBuf, String)> = Vec::new();
    collect(&dir, &dir, &mut entries);
    entries.sort_by(|a, b| a.1.cmp(&b.1));
    if entries.is_empty() { return Err("导出目录里没有文件".into()); }
    let zip_path = dir.join("网易云导出.zip");
    {
        let file = fs::File::create(&zip_path).map_err(|e| e.to_string())?;
        let mut zw = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (p, rel) in &entries {
            zw.start_file(rel.as_str(), opts).map_err(|e| e.to_string())?;
            let data = fs::read(p).map_err(|e| e.to_string())?;
            zw.write_all(&data).map_err(|e| e.to_string())?;
        }
        zw.finish().map_err(|e| e.to_string())?;
    }
    let size = fs::metadata(&zip_path).map(|m| m.len()).unwrap_or(0);
    // 复制到公共下载目录
    let mut public = String::new();
    for base in ["/storage/emulated/0/Download/网易云导出", "/sdcard/Download/网易云导出"] {
        let d = std::path::Path::new(base);
        if fs::create_dir_all(d).is_ok() {
            let p = d.join("网易云导出.zip");
            if fs::copy(&zip_path, &p).is_ok() { public = p.to_string_lossy().to_string(); break; }
        }
    }
    Ok(serde_json::json!({ "ok": true, "files": entries.len(), "size": size,
        "path": zip_path.to_string_lossy().to_string(), "public": public }))
}

/* ---------------- 同步 / 整理 / 核验 ---------------- */

fn kind_sub(kind: &str) -> Option<&'static str> {
    match kind {
        "pl" => Some("歌单"),
        "plfav" => Some("收藏歌单"),
        "al" => Some("收藏专辑"),
        _ => None,
    }
}

fn stage_dir(app: &tauri::AppHandle, kind: &str) -> Result<PathBuf, String> {
    let sub = kind_sub(kind).ok_or_else(|| "未知类型".to_string())?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("stage").join(sub);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn read_stage(dir: &std::path::Path) -> Vec<(PathBuf, Value)> {
    let mut out: Vec<(PathBuf, Value)> = Vec::new();
    if let Ok(rd) = fs::read_dir(dir) {
        for ent in rd.flatten() {
            let p = ent.path();
            if p.extension().and_then(|e| e.to_str()) != Some("json") { continue; }
            if let Some(v) = fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
                out.push((p, v));
            }
        }
    }
    out
}

/// 抓一个歌单 / 收藏歌单 / 收藏专辑的详情进暂存区（不生成文档）
async fn do_stage(app: &tauri::AppHandle, client: &Client, kind: &str, id: i64) -> Result<(String, i64, Value), String> {
    if kind_sub(kind).is_none() { return Err("未知类型".into()); }
    let d = if kind == "al" {
        api::album_detail(client, id).await?
    } else {
        api::playlist_detail(client, id, false).await?
    };
    let dir = stage_dir(app, kind)?;
    fs::write(dir.join(format!("{}.json", id)), d.to_string()).map_err(|e| e.to_string())?;
    Ok((
        d["name"].as_str().unwrap_or("").to_string(),
        d["count"].as_i64().unwrap_or(0),
        d["stats"].clone(),
    ))
}

#[tauri::command]
async fn stage_one(app: tauri::AppHandle, state: State<'_, AppState>, kind: String, id: i64) -> Result<Value, String> {
    let (name, count, stats) = do_stage(&app, &state.client, &kind, id).await?;
    Ok(serde_json::json!({ "ok": true, "name": name, "count": count, "stats": stats }))
}

/// 已同步到暂存区的歌单 / 专辑 ID
#[tauri::command]
fn stage_ids(app: tauri::AppHandle, kind: String) -> Result<Value, String> {
    let dir = stage_dir(&app, &kind)?;
    let ids: Vec<i64> = read_stage(&dir).iter()
        .filter_map(|(p, _)| p.file_stem().and_then(|s| s.to_str()).and_then(|s| s.parse::<i64>().ok()))
        .collect();
    Ok(serde_json::json!({ "ids": ids }))
}

/// 分批补厂牌：最多 limit 张，回写暂存文件；返回 (找到数量, 回写歌单数, 剩余)
async fn do_fill(app: &tauri::AppHandle, client: &Client, kind: &str, limit: usize) -> Result<(usize, usize, usize), String> {
    let dir = stage_dir(app, kind)?;
    let mut files = read_stage(&dir);
    let mut need: Vec<i64> = Vec::new();
    let mut seen: std::collections::HashSet<i64> = std::collections::HashSet::new();
    for (_, d) in &files {
        if let Some(rows) = d["rows"].as_array() {
            for r in rows {
                let empty = r["company"].as_str().map(|s| s.is_empty()).unwrap_or(true);
                let known_none = r["cstate"].as_str() == Some("none");
                if empty && !known_none {
                    if let Some(aid) = r["alId"].as_i64() {
                        if aid > 0 && seen.insert(aid) { need.push(aid); }
                    }
                }
            }
        }
    }
    let remaining_total = need.len();
    if need.len() > limit { need.truncate(limit); }
    let (found, failed_ids, _err) = api::fill_companies(client, &need).await;

    let updated = persist_companies(&mut files, &found, &failed_ids);

    if let Ok(dir_app) = app.path().app_data_dir() {
        let snap = api::companies_snapshot();
        let map: serde_json::Map<String, Value> = snap.into_iter()
            .map(|(k, v)| (k.to_string(), Value::String(v))).collect();
        let _ = fs::write(dir_app.join("companies.json"), Value::Object(map).to_string());
    }

    Ok((found.len(), updated, remaining_total.saturating_sub(need.len())))
}

#[tauri::command]
async fn fill_companies(app: tauri::AppHandle, state: State<'_, AppState>, kind: String, limit: usize) -> Result<Value, String> {
    let (found, updated, remaining) = do_fill(&app, &state.client, &kind, limit).await?;
    Ok(serde_json::json!({ "ok": true, "found": found, "updated": updated, "remaining": remaining }))
}

/// 同步后的汇总口径：去重曲目、下架、特殊字符、非拉丁
#[tauri::command]
async fn stage_stats(app: tauri::AppHandle, kind: String) -> Result<Value, String> {
    let dir = stage_dir(&app, &kind)?;
    let mut ids: std::collections::HashSet<i64> = std::collections::HashSet::new();
    let mut lists = 0i64;
    let mut total = 0i64;
    let mut down = 0i64;
    let mut special = 0i64;
    let mut non_latin = 0i64;
    for (_, d) in read_stage(&dir) {
        lists += 1;
        if let Some(rows) = d["rows"].as_array() {
            for r in rows {
                if let Some(id) = r["id"].as_i64() { ids.insert(id); }
                total += 1;
            }
        }
        if let Some(st) = d["stats"].as_object() {
            down += st.get("down").and_then(|v| v.as_i64()).unwrap_or(0);
            special += st.get("special").and_then(|v| v.as_i64()).unwrap_or(0);
            non_latin += st.get("nonLatin").and_then(|v| v.as_i64()).unwrap_or(0);
        }
    }
    Ok(serde_json::json!({
        "ok": true, "lists": lists, "total": total, "unique": ids.len() as i64,
        "down": down, "special": special, "nonLatin": non_latin, "sub": kind_sub(&kind).unwrap_or("")
    }))
}

/// 整理：暂存区 → CSV + MD + 索引 + 总表
async fn do_tidy(app: &tauri::AppHandle, kind: &str) -> Result<Value, String> {
    let sub = kind_sub(kind).ok_or_else(|| "未知类型".to_string())?;
    let dir = stage_dir(app, kind)?;
    let mut files = 0usize;
    let mut items = 0usize;
    let mut songs = 0i64;
    let mut failed = 0usize;
    let mut index_rows: Vec<String> = Vec::new();
    let mut all_rows: Vec<Value> = Vec::new();
    let mut seen: std::collections::HashSet<i64> = std::collections::HashSet::new();

    for (_, d) in read_stage(&dir) {
        let name = sanitize(d["name"].as_str().unwrap_or("未命名"));
        let (csv_paths, _) = write_both(app, &format!("{}/{}.csv", sub, name), &to_csv(&d));
        let (md_paths, _) = write_both(app, &format!("{}/{}.md", sub, name), &to_md(&d));
        if csv_paths.is_empty() || md_paths.is_empty() { failed += 1; continue; }
        files += 2;
        items += 1;
        let count = d["count"].as_i64().unwrap_or(0);
        songs += count;
        index_rows.push(format!("| {} | {} | `{}/{}.md` |", name, count, sub, name));
        if kind == "pl" {
            if let Some(rows) = d["rows"].as_array() {
                for r in rows {
                    let id = r["id"].as_i64().unwrap_or(0);
                    if id > 0 && seen.insert(id) { all_rows.push(r.clone()); }
                }
            }
        }
    }

    if !index_rows.is_empty() {
        let idx = format!(
            "# {}\n\n- 项数：{}\n- 曲目合计：{} 首\n- 生成时间：{}\n\n| 名称 | 曲目 | 文件 |\n| --- | --- | --- |\n{}\n",
            sub, items, songs, now_human(), index_rows.join("\n")
        );
        let (p, _) = write_both(app, &format!("{}/00_索引.md", sub), &idx);
        if !p.is_empty() { files += 1; }
    }

    let mut unique = 0i64;
    if kind == "pl" && !all_rows.is_empty() {
        unique = all_rows.len() as i64;
        let d = serde_json::json!({ "name": "全部曲目", "id": 0, "count": unique, "rows": all_rows });
        let (p, _) = write_both(app, "表格/all_songs.csv", &to_csv(&d));
        if !p.is_empty() { files += 1; }
    }

    Ok(serde_json::json!({
        "ok": true, "items": items, "files": files, "songs": songs, "unique": unique,
        "failed": failed, "sub": sub
    }))
}

#[tauri::command]
async fn tidy(app: tauri::AppHandle, kind: String) -> Result<Value, String> {
    do_tidy(&app, &kind).await
}

/// 核验：比对暂存区与已生成的文档
async fn do_check(app: &tauri::AppHandle, kind: &str) -> Result<Value, String> {
    let sub = kind_sub(kind).ok_or_else(|| "未知类型".to_string())?;
    let dir = stage_dir(app, kind)?;
    let out = app.path().app_data_dir().map_err(|e| e.to_string())?.join("exports").join(sub);
    let mut ok_count = 0usize;
    let mut bad_count = 0usize;
    let mut songs = 0i64;
    let mut items: Vec<Value> = Vec::new();
    for (p, d) in read_stage(&dir) {
        let name = sanitize(d["name"].as_str().unwrap_or("未命名"));
        let count = d["count"].as_i64().unwrap_or(0);
        songs += count;
        let mut issues: Vec<String> = Vec::new();
        let mut rows = 0i64;
        match fs::read_to_string(out.join(format!("{}.csv", name))) {
            Ok(t) => {
                rows = (t.lines().count() as i64) - 1;
                if rows != count { issues.push(format!("CSV 行数 {} ≠ 曲目 {}", rows, count)); }
                if !t.contains("发行公司/厂牌") { issues.push("CSV 缺厂牌列".to_string()); }
            }
            Err(_) => issues.push("缺少 CSV".to_string()),
        }
        if fs::read_to_string(out.join(format!("{}.md", name))).is_err() {
            issues.push("缺少 MD".to_string());
        }
        let good = issues.is_empty();
        if good { ok_count += 1; } else { bad_count += 1; }
        items.push(serde_json::json!({
            "file": p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
            "name": name, "count": count, "rows": rows, "ok": good, "issues": issues
        }));
    }
    Ok(serde_json::json!({
        "ok": true, "okCount": ok_count, "badCount": bad_count, "songs": songs, "items": items, "sub": sub
    }))
}

#[tauri::command]
async fn check_exports(app: tauri::AppHandle, kind: String) -> Result<Value, String> {
    do_check(&app, &kind).await
}

/* ---------------- 后台任务：同步 → 整理 → 核验 ---------------- */

fn now_stamp() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

/// 一次性补全暂存区的厂牌：只读写一次 stage 文件，分批查询并逐批写日志
async fn fill_all(app: &tauri::AppHandle, client: &Client, job: &Job, kind: &str) -> Result<(usize, usize), String> {
    let dir = stage_dir(app, kind)?;
    let mut files = read_stage(&dir);
    let mut need: Vec<i64> = Vec::new();
    let mut seen: std::collections::HashSet<i64> = std::collections::HashSet::new();
    for (_, d) in &files {
        if let Some(rows) = d["rows"].as_array() {
            for r in rows {
                let empty = r["company"].as_str().map(|s| s.is_empty()).unwrap_or(true);
                let known_none = r["cstate"].as_str() == Some("none");
                if empty && !known_none {
                    if let Some(aid) = r["alId"].as_i64() {
                        if aid > 0 && seen.insert(aid) { need.push(aid); }
                    }
                }
            }
        }
    }
    // 单次整理最多补 3000 张，避免第一次整理要等太久；其余的再点一次整理接着补
    const MAX_FILL: usize = 3000;
    let all_need = need.len();
    let rest = all_need.saturating_sub(MAX_FILL);
    if need.len() > MAX_FILL { need.truncate(MAX_FILL); }
    let total = need.len();
    job.phase_total.store(total, Ordering::SeqCst);
    job.phase_done.store(0, Ordering::SeqCst);
    if total == 0 { return Ok((0, 0)); }
    job.log("info", format!("需要补厂牌的专辑 {} 张，本次处理 {}", all_need, total));
    if rest > 0 { job.log("warn", format!("还有 {} 张留到下次整理继续（分批不影响文档生成）", rest)); }

    let mut found: HashMap<i64, String> = HashMap::new();
    let mut fail_total = 0usize;
    let mut fail_streak = 0usize;
    let mut last_err: Option<String> = None;

    // 预检：先取 3 张探路，全部失败说明网络或风控有问题，别把 3000 张空跑完
    let probe_n = need.len().min(3);
    let probe: Vec<i64> = need.drain(..probe_n).collect();
    let (got0, failed0, err0) = api::fill_companies(client, &probe).await;
    let mut failed_all: std::collections::HashSet<i64> = failed0.clone();
    if got0.is_empty() && !failed0.is_empty() {
        let why = err0.unwrap_or_else(|| "请求全部失败".to_string());
        job.log("err", format!("补厂牌预检失败：{}", why));
        return Err(format!("补厂牌预检失败（{}/{} 张）：{}。请保持 App 在前台并检查网络后重试",
            failed0.len(), probe_n, why));
    }
    found.extend(got0);
    job.phase_done.store(probe_n, Ordering::SeqCst);
    job.ok.store(found.len(), Ordering::SeqCst);
    job.log("info", format!("补厂牌预检通过（{} 张）", probe_n));

    const BATCH: usize = 60;
    for (i, chunk) in need.chunks(BATCH).enumerate() {
        if job.stop.load(Ordering::SeqCst) { break; }
        let (got, failed_ids, err) = api::fill_companies(client, chunk).await;
        let before = found.len();
        found.extend(got);
        let fresh = found.len() - before;
        let failed = failed_ids.len();
        fail_total += failed;
        failed_all.extend(failed_ids.iter().copied());
        if let Some(e) = err { last_err = Some(e); }
        let done = (probe_n + (i + 1) * BATCH).min(total);
        job.phase_done.store(done, Ordering::SeqCst);
        job.ok.store(found.len(), Ordering::SeqCst);
        if failed == 0 {
            job.log("info", format!("补厂牌 {}/{}（成功 {} 张）", done, total, found.len()));
        } else {
            job.log("warn", format!("补厂牌 {}/{}（成功 {} 张 · 失败 {} 张）", done, total, found.len(), failed));
        }
        if fresh == 0 && failed > 0 {
            fail_streak += 1;
        } else {
            fail_streak = 0;
        }
        // 每 10 批把结果落到 stage，中断或被杀进程都不会丢掉已查过的
        if (i + 1) % 10 == 0 {
            persist_companies(&mut files, &found, &failed_all);
        }
        if fail_streak >= 2 {
            let why = last_err.unwrap_or_else(|| "请求全部失败".to_string());
            job.log("err", format!("补厂牌中止：连续 {} 批全部失败，{}", fail_streak, why));
            return Err(format!("连续 {} 批失败（共 {} 张）：{}。请保持 App 在前台并检查网络后重试",
                fail_streak, fail_total + failed0.len(), why));
        }
    }
    if fail_total + failed0.len() > 0 {
        job.log("warn", format!("补厂牌结束：成功 {} 张，失败 {} 张", found.len(), fail_total + failed0.len()));
    }

    let updated = persist_companies(&mut files, &found, &failed_all);
    let none_cnt = found.values().filter(|v| v.is_empty()).count();
    job.log("info", format!("厂牌结果：{} 张有厂牌 · {} 张网易未标注 · {} 张查询失败",
        found.len() - none_cnt, none_cnt, fail_total + failed0.len()));

    if let Ok(dir_app) = app.path().app_data_dir() {
        let snap = api::companies_snapshot();
        let map: serde_json::Map<String, Value> = snap.into_iter()
            .map(|(k, v)| (k.to_string(), Value::String(v))).collect();
        let _ = fs::write(dir_app.join("companies.json"), Value::Object(map).to_string());
    }
    Ok((found.len(), updated))
}

async fn run_job(
    app: tauri::AppHandle,
    client: Arc<Client>,
    job: Arc<Job>,
    kind: String,
    ids: Vec<i64>,
    do_tidy_flag: bool,
    do_check_flag: bool,
    with_fill: bool,
) {
    let total = ids.len();
    let label = kind_sub(&kind).unwrap_or("歌单").to_string();
    job.log("step", format!("开始：{} · {} 项待同步", label, total));

    let mut ok = 0usize;
    let mut fail = 0usize;
    let mut songs = 0i64;
    for (i, id) in ids.iter().enumerate() {
        if job.stop.load(Ordering::SeqCst) {
            job.log("warn", "已按请求停止");
            break;
        }
        job.done.store(i + 1, Ordering::SeqCst);
        match do_stage(&app, &client, &kind, *id).await {
            Ok((name, count, _)) => {
                ok += 1;
                songs += count;
                job.ok.store(ok, Ordering::SeqCst);
                job.songs.store(songs, Ordering::SeqCst);
                *job.step.lock().unwrap() = name.clone();
                job.log("ok", format!("{} · {} 首", name, count));
            }
            Err(e) => {
                fail += 1;
                job.fail.store(fail, Ordering::SeqCst);
                job.log("err", format!("#{} · {}", id, e));
            }
        }
    }

    if do_tidy_flag && !job.stop.load(Ordering::SeqCst) {
        if with_fill {
            job.set_phase("tidy");
            job.log("step", "补厂牌（联网，较慢）");
            match fill_all(&app, &client, job.as_ref(), &kind).await {
                Ok((found, updated)) => job.log("ok", format!("补厂牌完成：{} 张，回写 {} 个", found, updated)),
                Err(e) => {
                    job.fail.fetch_add(1, Ordering::SeqCst);
                    job.log("err", format!("补厂牌失败：{}", e));
                    job.log("warn", "继续生成文档，没查到的厂牌会标成「未查询」");
                }
            }
        } else {
            let n = apply_cached_companies(&app, &kind);
            job.log("info", format!("厂牌取自本地缓存（更新 {} 个文件），要联网补请点「补厂牌」", n));
        }
        job.set_phase("tidy-doc");
        let t0 = Instant::now();
        match do_tidy(&app, &kind).await {
            Ok(v) => {
                set_state(&app, "lastTidy", &now_human());
                job.log("ok", format!(
                    "整理完成：{} 项 · {} 个文件 · {} 首（去重 {}）· 用时 {:.1}s",
                    v["items"], v["files"], v["songs"], v["unique"], t0.elapsed().as_secs_f64()));
            }
            Err(e) => job.log("err", format!("整理失败：{}", e)),
        }
    }

    if do_check_flag && !job.stop.load(Ordering::SeqCst) {
        job.set_phase("check");
        job.log("step", "核验文档");
        match do_check(&app, &kind).await {
            Ok(v) => {
                set_state(&app, "lastCheck", &now_human());
                let bad = v["badCount"].as_u64().unwrap_or(0);
                job.log(if bad == 0 { "ok" } else { "err" },
                    format!("核验：通过 {} 项 · 问题 {} 项", v["okCount"], bad));
            }
            Err(e) => job.log("err", format!("核验失败：{}", e)),
        }
    }

    set_state(&app, "lastSync", &now_human());
    job.ok.store(ok, Ordering::SeqCst);
    job.set_phase("done");
    job.running.store(false, Ordering::SeqCst);
    job.log("done", format!("完成：成功 {} · 失败 {} · {} 首", ok, fail, songs));
}

#[tauri::command]
async fn job_start(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    kind: String,
    ids: Vec<i64>,
    do_tidy: bool,
    do_check: bool,
    with_fill: bool,
) -> Result<Value, String> {
    if kind_sub(&kind).is_none() { return Err("未知类型".into()); }
    let job = state.job.clone();
    if job.running.swap(true, Ordering::SeqCst) {
        return Err("已有任务在运行".into());
    }
    let log_path = app.path().app_data_dir().ok()
        .map(|d| {
            let dir = d.join("logs");
            let _ = fs::create_dir_all(&dir);
            dir.join(format!("job-{}.log", now_stamp())).to_string_lossy().to_string()
        })
        .unwrap_or_default();
    job.reset(ids.len(), log_path.clone(), &kind);

    let task_app = app.clone();
    let task_client = state.client.clone();
    let task_job = job.clone();
    tauri::async_runtime::spawn(async move {
        run_job(task_app, task_client, task_job, kind, ids, do_tidy, do_check, with_fill).await;
    });

    Ok(serde_json::json!({ "ok": true, "log": log_path }))
}

#[tauri::command]
fn job_status(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let app_handle = app.clone();
    let job = &state.job;
    let logs = job.logs.lock().unwrap();
    let start = logs.len().saturating_sub(160);
    let slice: Vec<Value> = logs[start..].iter()
        .map(|(k, ts, t)| serde_json::json!({ "k": k, "ts": ts, "t": t }))
        .collect();
    drop(logs);
    let st = read_state(&app_handle);
    Ok(serde_json::json!({
        "running": job.running.load(Ordering::SeqCst),
        "phase": job.phase.lock().unwrap().clone(),
        "kind": job.kind.lock().unwrap().clone(),
        "step": job.step.lock().unwrap().clone(),
        "total": job.total.load(Ordering::SeqCst),
        "done": job.done.load(Ordering::SeqCst),
        "phaseTotal": job.phase_total.load(Ordering::SeqCst),
        "phaseDone": job.phase_done.load(Ordering::SeqCst),
        "ok": job.ok.load(Ordering::SeqCst),
        "fail": job.fail.load(Ordering::SeqCst),
        "songs": job.songs.load(Ordering::SeqCst),
        "elapsed": job.started.lock().unwrap().map(|t| t.elapsed().as_secs_f64()).unwrap_or(0.0),
        "logs": slice,
        "times": {
            "lastSync": st["lastSync"].as_str().unwrap_or(""),
            "lastTidy": st["lastTidy"].as_str().unwrap_or(""),
            "lastCheck": st["lastCheck"].as_str().unwrap_or("")
        },
        "logPath": job.log_path.lock().unwrap().clone()
    }))
}

#[tauri::command]
fn copy_log(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let p = state.job.log_path.lock().unwrap().clone();
    if p.is_empty() { return Err("还没有运行过任务".into()); }
    let src = std::path::Path::new(&p);
    if !src.exists() { return Err("日志文件不存在".into()); }
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("job");
    let text = fs::read_to_string(src).unwrap_or_default();
    let (paths, _) = write_both(&app, &format!("日志/{}.log", stem), &text);
    if paths.is_empty() { return Err("写入失败".into()); }
    Ok(serde_json::json!({ "ok": true, "paths": paths }))
}

#[tauri::command]
fn job_stop(state: State<'_, AppState>) -> Result<Value, String> {
    state.job.stop.store(true, Ordering::SeqCst);
    Ok(serde_json::json!({ "ok": true }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let client = Arc::new(Client::new());
    tauri::Builder::default()
        .setup({
            let client = client.clone();
            move |app| {
                let handle = app.handle().clone();
                if let Some(p) = cookie_path(&handle) {
                    if let Ok(saved) = fs::read_to_string(p) {
                        if !saved.trim().is_empty() { client.set_cookie(&saved); }
                    }
                }
                if let Ok(dir) = handle.path().app_data_dir() {
                    if let Ok(t) = fs::read_to_string(dir.join("companies.json")) {
                        if let Ok(Value::Object(m)) = serde_json::from_str::<Value>(&t) {
                            let map: std::collections::HashMap<i64, String> = m.into_iter()
                                .filter_map(|(k, v)| k.parse::<i64>().ok().map(|i| (i, v.as_str().unwrap_or("").to_string())))
                                .collect();
                            api::companies_load(map);
                        }
                    }
                }
                Ok(())
            }
        })
        .manage(AppState { client, last_qr: Mutex::new(String::new()), special: Mutex::new(Vec::new()), special_ids: Mutex::new(std::collections::HashSet::new()), job: Arc::new(Job::new()) })
        .invoke_handler(tauri::generate_handler![
            qr_new, qr_poll, account, playlists, playlist_detail,
            login_cookie, login_phone_password, sms_sent, login_phone_captcha,
            login_email, logout, export_playlist, collected_albums, play_record, save_text,
            special_items, export_special, zip_exports, album_detail, export_album,
            stage_one, stage_stats, stage_ids, fill_companies, tidy, check_exports,
            job_start, job_status, job_stop, copy_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
