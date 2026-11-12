mod api;
mod client;
mod crypto;

use client::Client;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
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

/* ---------------- 人工补充的额外歌曲 ---------------- */

fn extras_dir(app: &tauri::AppHandle, kind: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("extras")
        .join(kind);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn load_extras(app: &tauri::AppHandle, kind: &str, id: i64) -> Vec<Value> {
    let dir = match extras_dir(app, kind) { Ok(d) => d, Err(_) => return Vec::new() };
    fs::read_to_string(dir.join(format!("{}.json", id)))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v["items"].as_array().cloned())
        .unwrap_or_default()
}

fn save_extras(app: &tauri::AppHandle, kind: &str, id: i64, items: &[Value]) -> Result<(), String> {
    let dir = extras_dir(app, kind)?;
    let payload = serde_json::json!({ "items": items });
    fs::write(dir.join(format!("{}.json", id)), payload.to_string()).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_extras(app: tauri::AppHandle, kind: String, id: i64) -> Value {
    serde_json::json!({ "items": load_extras(&app, &kind, id) })
}

#[tauri::command]
fn add_extra(
    app: tauri::AppHandle,
    kind: String,
    id: i64,
    name: String,
    ar: String,
    al: String,
    company: String,
) -> Result<Value, String> {
    let name = name.trim().to_string();
    if name.is_empty() { return Err("歌名不能为空".into()); }
    let mut items = load_extras(&app, &kind, id);
    items.push(serde_json::json!({
        "id": 0,
        "name": name,
        "ar": ar.trim(),
        "al": al.trim(),
        "company": company.trim(),
        "alId": 0,
        "dur": 0,
        "ncr": false,
        "fee": 0,
        "pop": 0,
        "alia": "",
        "mv": 0,
        "manual": true,
    }));
    save_extras(&app, &kind, id, &items)?;
    Ok(serde_json::json!({ "ok": true, "items": items }))
}

#[tauri::command]
fn remove_extra(app: tauri::AppHandle, kind: String, id: i64, index: usize) -> Result<Value, String> {
    let mut items = load_extras(&app, &kind, id);
    if index >= items.len() { return Err("没有这一条".into()); }
    items.remove(index);
    save_extras(&app, &kind, id, &items)?;
    Ok(serde_json::json!({ "ok": true, "items": items }))
}

/// 下架 / 无版权 / 仅其他版本可播
/// 专辑接口不返回 privilege，也就没有无版权信息，按调用方要求可以跳过这一条
fn blocked_row(r: &Value, include_no_copyright: bool) -> bool {
    r["missing"].as_bool().unwrap_or(false)
        || r["st"].as_i64() == Some(-200)
        || (include_no_copyright && r["pl"].as_i64() == Some(0))
        || r["ncr"].as_bool().unwrap_or(false)
}

/// 合并曲目：按「歌名 + 歌手」去重，人工补充的排在后面
fn merge_rows(base: &[Value], extra: &[Value]) -> Vec<Value> {
    let key = |r: &Value| {
        format!(
            "{}|||{}",
            r["name"].as_str().unwrap_or("").to_lowercase(),
            r["ar"].as_str().unwrap_or("").to_lowercase()
        )
    };
    let mut out: Vec<Value> = base.to_vec();
    let mut seen: std::collections::HashSet<String> = base.iter().map(key).collect();
    for r in extra {
        if seen.insert(key(r)) { out.push(r.clone()); }
    }
    out
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

/// 曲目状态的显示文本：优先看 privilege（st/pl），老数据回退到 ncr
fn song_state(r: &Value) -> &'static str {
    if r["manual"].as_bool().unwrap_or(false) { return "人工补充"; }
    if r["missing"].as_bool().unwrap_or(false) { return "已下架（详情不可获取）"; }
    match r["st"].as_i64() {
        Some(-200) => "已下架",
        Some(_) if r["pl"].as_i64() == Some(0) => "无版权",
        Some(_) => if r["ncr"].as_bool().unwrap_or(false) { "仅其他版本可播" } else { "正常" },
        None => if r["ncr"].as_bool().unwrap_or(false) { "仅其他版本可播" } else { "正常" },
    }
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
            let nm = r["name"].as_str().unwrap_or("");
            let nm = if nm.is_empty() && r["missing"].as_bool().unwrap_or(false) { "（已下架·名称不可获取）" } else { nm };
            let fee = r["fee"].as_i64().unwrap_or(0);
            let perm = match fee { 0 => "免费", 1 => "VIP", 4 => "付费专辑", 8 => "低音质", _ => "其他" };
            out.push_str(&format!(
                "{},{},{},{},{},{},{},{},{},{},{},{},{},{}\n",
                i + 1,
                e(&serde_json::json!(nm)),
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
                song_state(r)
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
            let state = song_state(r);
            let mark = if state == "正常" { String::new() } else { format!("  〔{}〕", state) };
            let nm = r["name"].as_str().unwrap_or("");
            let nm = if nm.is_empty() && r["missing"].as_bool().unwrap_or(false) { "（已下架·名称不可获取）" } else { nm };
            out.push_str(&format!("{}. {} - {} - {} - {}  〔{}〕{}\n",
                i + 1,
                nm,
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
        let p = out.join(&file);
        if let Some(parent) = p.parent() { let _ = fs::create_dir_all(parent); }
        if fs::write(&p, content.as_bytes()).is_ok() { saved.push(p.to_string_lossy().to_string()); }
    }
    let base = read_export_dir(&app);
    let dir = Path::new(&base);
    if dir_writable(dir).is_ok() {
        let p = dir.join(&file);
        if fs::write(&p, content.as_bytes()).is_ok() { saved.push(p.to_string_lossy().to_string()); }
    }
    if saved.is_empty() { return Err("写入文件失败".into()); }
    Ok(serde_json::json!({ "ok": true, "paths": saved }))
}

/// 从 stage 现场算专项：不再依赖内存累加，重启 App 或走后台上任务都能看到
fn special_from_stage(app: &tauri::AppHandle) -> (Vec<Value>, Value) {
    let mut seen: std::collections::HashSet<i64> = std::collections::HashSet::new();
    let mut items: Vec<Value> = Vec::new();
    let (mut down, mut other, mut special, mut non_latin) = (0i64, 0i64, 0i64, 0i64);
    for kind in ["pl", "plfav", "al"] {
        let dir = match stage_dir(app, kind) { Ok(d) => d, Err(_) => continue };
        for (_, d) in read_stage(&dir) {
            if let Some(rows) = d["rows"].as_array() {
                let (st, its) = api::classify_items(rows);
                down += st["down"].as_i64().unwrap_or(0);
                other += st["otherVersion"].as_i64().unwrap_or(0);
                special += st["special"].as_i64().unwrap_or(0);
                non_latin += st["nonLatin"].as_i64().unwrap_or(0);
                for it in its {
                    if let Some(id) = it["id"].as_i64() {
                        if seen.insert(id) { items.push(it); }
                    }
                }
            }
        }
    }
    (items, serde_json::json!({
        "down": down, "otherVersion": other, "special": special, "nonLatin": non_latin
    }))
}

#[tauri::command]
async fn special_items(app: tauri::AppHandle) -> Result<Value, String> {
    let (items, stats) = special_from_stage(&app);
    Ok(serde_json::json!({ "total": items.len(), "items": items, "stats": stats }))
}

#[tauri::command]
async fn export_special(app: tauri::AppHandle) -> Result<Value, String> {
    let (acc, _) = special_from_stage(&app);
    if acc.is_empty() { return Err("还没有专项数据，先同步歌单".into()); }
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
    let (paths, _) = write_both(&app, "专项清单.csv", &out);
    if paths.is_empty() { return Err("写入失败".into()); }
    Ok(serde_json::json!({ "ok": true, "paths": paths }))
}

/* ---------------- 导出位置 ---------------- */

fn default_export_dir() -> String {
    "/storage/emulated/0/Download/网易云导出".to_string()
}

fn settings_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("settings.json"))
}

pub fn read_export_dir(app: &tauri::AppHandle) -> String {
    settings_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v["exportDir"].as_str().map(|s| s.to_string()))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(default_export_dir)
}

fn save_export_dir(app: &tauri::AppHandle, dir: &str) -> Result<(), String> {
    let p = settings_path(app).ok_or_else(|| "取不到应用目录".to_string())?;
    if let Some(parent) = p.parent() { let _ = fs::create_dir_all(parent); }
    let v = serde_json::json!({ "exportDir": dir });
    fs::write(&p, v.to_string()).map_err(|e| e.to_string())
}

/// 试写一个临时文件，判断目录到底能不能写
fn dir_writable(dir: &Path) -> Result<(), String> {
    if let Err(e) = fs::create_dir_all(dir) {
        return Err(format!("创建目录失败：{}", e));
    }
    let probe = dir.join(".eta_write_test");
    match fs::write(&probe, b"ok") {
        Ok(_) => { let _ = fs::remove_file(&probe); Ok(()) }
        Err(e) => Err(format!("无法写入：{}（多半是没给「所有文件访问权限」）", e)),
    }
}

#[tauri::command]
fn get_export_dir(app: tauri::AppHandle) -> Value {
    let dir = read_export_dir(&app);
    let writable = dir_writable(Path::new(&dir)).is_ok();
    serde_json::json!({ "dir": dir, "writable": writable, "default": default_export_dir() })
}

#[tauri::command]
fn set_export_dir(app: tauri::AppHandle, dir: String) -> Result<Value, String> {
    let d = dir.trim().trim_end_matches('/').to_string();
    if d.is_empty() { return Err("目录不能为空".into()); }
    if !d.starts_with('/') {
        return Err("请填绝对路径，例如 /storage/emulated/0/Download/网易云导出".into());
    }
    match dir_writable(Path::new(&d)) {
        Ok(()) => {
            save_export_dir(&app, &d)?;
            Ok(serde_json::json!({ "ok": true, "dir": d, "writable": true }))
        }
        Err(e) => Ok(serde_json::json!({ "ok": false, "dir": d, "writable": false, "message": e })),
    }
}

/* ---------------- 系统目录选择（SAF） ---------------- */

fn hexval(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hexval(b[i + 1]), hexval(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// content://com.android.externalstorage.documents/tree/primary%3ADownload%2Fx
/// → /storage/emulated/0/Download/x
fn tree_uri_to_path(uri: &str) -> Option<String> {
    let decoded = percent_decode(uri);
    let rest = decoded.split("/tree/").nth(1)?;
    let (volume, path) = rest.split_once(':')?;
    let base = match volume {
        "primary" => "/storage/emulated/0",
        _ => return None,
    };
    let p = path.trim_matches('/');
    if p.is_empty() { Some(base.to_string()) } else { Some(format!("{}/{}", base, p)) }
}

#[cfg(target_os = "android")]
mod android_fs {
    use jni::objects::{GlobalRef, JClass, JObject, JString, JValue};
    use jni::JavaVM;
    use std::sync::OnceLock;

    // ndk_context 给的是 Application 的 local ref（不是 Activity），跨线程用会崩，先升成全局引用
    static APP_CONTEXT: OnceLock<GlobalRef> = OnceLock::new();

    fn with_env<T>(
        f: impl FnOnce(&mut jni::JNIEnv, &JObject) -> Result<T, String>,
    ) -> Result<T, String> {
        let ctx = ndk_context::android_context();
        let vm = unsafe { JavaVM::from_raw(ctx.vm() as *mut jni::sys::JavaVM) }
            .map_err(|e| format!("取 JavaVM 失败: {}", e))?;
        let mut env = vm.attach_current_thread().map_err(|e| format!("attach 失败: {}", e))?;
        if APP_CONTEXT.get().is_none() {
            let local = unsafe { JObject::from_raw(ctx.context() as jni::sys::jobject) };
            let global = env
                .new_global_ref(&local)
                .map_err(|e| format!("转全局引用失败: {}", e))?;
            let _ = APP_CONTEXT.set(global);
        }
        let act = APP_CONTEXT.get().ok_or_else(|| "取不到 Context".to_string())?;
        let out = f(&mut env, act.as_obj());
        // 有异常就把类型和消息带回去，别只留一句 "Java exception was thrown"
        if let Ok(true) = env.exception_check() {
            let thrown = env.exception_occurred().ok();
            let _ = env.exception_clear();
            let desc = thrown.and_then(|t| {
                let v = env
                    .call_method(&t, "toString", "()Ljava/lang/String;", &[])
                    .ok()?;
                let o = v.l().ok()?;
                let js = JString::from(o);
                let s = env.get_string(&js).ok()?;
                Some(s.to_string_lossy().to_string())
            });
            return Err(format!("Java 异常：{}", desc.unwrap_or_else(|| "未知".into())));
        }
        out
    }

    /// 取 MainActivity 实例：ndk_context 只给 Application，要自己从静态字段拿
    fn activity<'a>(env: &mut jni::JNIEnv<'a>) -> Result<JObject<'a>, String> {
        // FindClass 在这些线程上只会查 bootstrap classloader，拿不到应用类，
        // 必须用 Application 的 ClassLoader 走 Class.forName
        let ctx = APP_CONTEXT.get().ok_or_else(|| "取不到 Context".to_string())?;
        let loader = env
            .call_method(ctx.as_obj(), "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
            .map_err(|e| format!("取 ClassLoader 失败: {}", e))?
            .l()
            .map_err(|e| e.to_string())?;
        let name = env
            .new_string("app.xvsvt.netease.export.MainActivity")
            .map_err(|e| e.to_string())?;
        let name_obj = JObject::from(name);
        let cls = env
            .call_static_method(
                "java/lang/Class",
                "forName",
                "(Ljava/lang/String;ZLjava/lang/ClassLoader;)Ljava/lang/Class;",
                &[
                    JValue::Object(&name_obj),
                    JValue::Bool(0),
                    JValue::Object(&loader),
                ],
            )
            .map_err(|e| format!("找不到 MainActivity: {}", e))?
            .l()
            .map_err(|e| e.to_string())?;
        let cls = JClass::from(cls);
        let inst = env
            .get_static_field(
                &cls,
                "etaInstance",
                "Lapp/xvsvt/netease/export/MainActivity;",
            )
            .map_err(|e| format!("读 etaInstance 失败: {}", e))?
            .l()
            .map_err(|e| e.to_string())?;
        if inst.is_null() {
            return Err("MainActivity 还没准备好，回到 App 再试一次".into());
        }
        Ok(inst)
    }

    /// 打开「所有文件访问权限」的系统设置页
    pub fn request_storage() -> Result<(), String> {
        with_env(|env, _ctx| {
            let act = activity(env)?;
            env.call_method(&act, "etaRequestStorage", "()V", &[])
                .map_err(|e| e.to_string())?;
            Ok(())
        })
    }

    /// 拉起系统的「选择文件夹」界面（具体 Intent 组装在 MainActivity 里做）
    pub fn pick_dir() -> Result<(), String> {
        with_env(|env, _ctx| {
            let act = activity(env)?;
            env.call_method(&act, "etaPickFolder", "()V", &[])
                .map_err(|e| e.to_string())?;
            Ok(())
        })
    }

    /// 读取 MainActivity 在 onActivityResult 里存下的 tree uri
    pub fn read_picked() -> Result<Option<String>, String> {
        with_env(|env, act| {
            let name = env.new_string("eta").map_err(|e| e.to_string())?;
            let name_obj = JObject::from(name);
            let prefs = env
                .call_method(
                    act,
                    "getSharedPreferences",
                    "(Ljava/lang/String;I)Landroid/content/SharedPreferences;",
                    &[JValue::Object(&name_obj), JValue::Int(0)],
                )
                .map_err(|e| e.to_string())?
                .l()
                .map_err(|e| e.to_string())?;
            let key = env.new_string("picked_dir").map_err(|e| e.to_string())?;
            let key_obj = JObject::from(key);
            let null = JObject::null();
            let value = env
                .call_method(
                    &prefs,
                    "getString",
                    "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
                    &[JValue::Object(&key_obj), JValue::Object(&null)],
                )
                .map_err(|e| e.to_string())?
                .l()
                .map_err(|e| e.to_string())?;
            if value.is_null() {
                return Ok(None);
            }
            let js = JString::from(value);
            let text: String = env
                .get_string(&js)
                .map_err(|e| e.to_string())?
                .into();
            Ok(Some(text))
        })
    }
}

#[tauri::command]
async fn pick_export_dir(app: tauri::AppHandle) -> Result<Value, String> {
    #[cfg(target_os = "android")]
    {
        // 必须在主线程启动 Activity，否则连同 local ref 一起崩
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(android_fs::pick_dir());
        })
        .map_err(|e| format!("切主线程失败: {}", e))?;
        let res = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| format!("启动选择器超时: {}", e))?;
        res?;
        Ok(serde_json::json!({ "ok": true }))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("只有 Android 支持系统目录选择".into())
    }
}

#[tauri::command]
async fn open_storage_settings(app: tauri::AppHandle) -> Result<Value, String> {
    #[cfg(target_os = "android")]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = tx.send(android_fs::request_storage());
        })
        .map_err(|e| format!("切主线程失败: {}", e))?;
        let res = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| format!("打开设置超时: {}", e))?;
        res?;
        Ok(serde_json::json!({ "ok": true }))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("只有 Android 需要在系统里授权".into())
    }
}

#[tauri::command]
async fn take_picked_dir(app: tauri::AppHandle) -> Result<Value, String> {
    #[cfg(target_os = "android")]
    {
        let handle = app.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        handle
            .run_on_main_thread(move || {
                let _ = tx.send(android_fs::read_picked());
            })
            .map_err(|e| format!("切主线程失败: {}", e))?;
        let picked = rx
            .recv_timeout(std::time::Duration::from_secs(10))
            .map_err(|e| format!("读取超时: {}", e))?;
        let uri = picked?.ok_or_else(|| "还没选目录".to_string())?;
        let path = tree_uri_to_path(&uri)
            .ok_or_else(|| "只支持内部存储（primary）上的目录".to_string())?;
        match dir_writable(Path::new(&path)) {
            Ok(()) => {
                save_export_dir(&app, &path)?;
                Ok(serde_json::json!({ "ok": true, "dir": path, "uri": uri }))
            }
            Err(e) => Ok(serde_json::json!({ "ok": false, "dir": path, "message": e })),
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("只有 Android 支持系统目录选择".into())
    }
}

#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
fn check_export_dir(dir: String) -> Value {
    let d = dir.trim().trim_end_matches('/').to_string();
    match dir_writable(Path::new(&d)) {
        Ok(()) => serde_json::json!({ "ok": true, "writable": true }),
        Err(e) => serde_json::json!({ "ok": false, "writable": false, "message": e }),
    }
}

fn write_both(app: &tauri::AppHandle, name: &str, content: &str) -> (Vec<String>, ()) {
    let file = sanitize_path(name);
    let mut saved: Vec<String> = Vec::new();
    if let Ok(dir) = app.path().app_data_dir() {
        let out = dir.join("exports");
        let p = out.join(&file);
        if let Some(parent) = p.parent() { let _ = fs::create_dir_all(parent); }
        if fs::write(&p, content.as_bytes()).is_ok() { saved.push(p.to_string_lossy().to_string()); }
    }
    let base = read_export_dir(app);
    let dir = Path::new(&base);
    if dir_writable(dir).is_ok() {
        let p = dir.join(&file);
        if let Some(parent) = p.parent() { let _ = fs::create_dir_all(parent); }
        if fs::write(&p, content.as_bytes()).is_ok() { saved.push(p.to_string_lossy().to_string()); }
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
    for base in [read_export_dir(&app), default_export_dir()] {
        let d = std::path::Path::new(&base);
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
    let mut other = 0i64;
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
            other += st.get("otherVersion").and_then(|v| v.as_i64()).unwrap_or(0);
            special += st.get("special").and_then(|v| v.as_i64()).unwrap_or(0);
            non_latin += st.get("nonLatin").and_then(|v| v.as_i64()).unwrap_or(0);
        }
    }
    Ok(serde_json::json!({
        "ok": true, "lists": lists, "total": total, "unique": ids.len() as i64,
        "down": down, "otherVersion": other, "special": special, "nonLatin": non_latin,
        "sub": kind_sub(&kind).unwrap_or("")
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
    let mut public_files = 0usize;
    let mut extras_total = 0i64;

    for (_, d) in read_stage(&dir) {
        let name = sanitize(d["name"].as_str().unwrap_or("未命名"));
        let raw_name = d["name"].as_str().unwrap_or("未命名");
        let id = d["id"].as_i64().unwrap_or(0);
        let rows: Vec<Value> = d["rows"].as_array().cloned().unwrap_or_default();
        let extras = load_extras(app, kind, id);
        extras_total += extras.len() as i64;

        let judge_nc = kind == "pl";
        let blocked: Vec<Value> =
            rows.iter().filter(|r| blocked_row(*r, judge_nc)).cloned().collect();
        let full = merge_rows(&rows, &extras);

        let sets: [(&str, &str, Vec<Value>); 4] = [
            ("", "完整歌单", full.clone()),
            ("-网易云", "网易云现状", rows.clone()),
            ("-受限", "受限曲目", blocked.clone()),
            ("-补充", "人工补充", extras.clone()),
        ];
        let mut wrote = 0usize;
        for (tag, label, list) in sets {
            let payload = serde_json::json!({
                "name": format!("{}（{}）", raw_name, label),
                "id": id,
                "count": list.len(),
                "rows": list,
            });
            let (c, _) = write_both(app, &format!("{}/{}{}.csv", sub, name, tag), &to_csv(&payload));
            let (m, _) = write_both(app, &format!("{}/{}{}.md", sub, name, tag), &to_md(&payload));
            if c.is_empty() || m.is_empty() { continue; }
            public_files += c.iter().filter(|p| !p.contains("/exports/")).count();
            public_files += m.iter().filter(|p| !p.contains("/exports/")).count();
            wrote += 2;
        }
        if wrote == 0 { failed += 1; continue; }
        files += wrote;
        items += 1;
        songs += rows.len() as i64;
        index_rows.push(format!(
            "| {} | {} | {} | {}{} |",
            name, rows.len(), blocked.len(), extras.len(),
            if extras.is_empty() { "" } else { "（含人工补充）" }
        ));
        if kind == "pl" {
            for r in &full {
                if let Some(rid) = r["id"].as_i64() {
                    if rid > 0 && seen.insert(rid) { all_rows.push(r.clone()); }
                }
            }
        }
    }

    if !index_rows.is_empty() {
        let idx = format!(
            "# {}\n\n- 项数：{}\n- 曲目合计：{} 首（人工补充 {} 首）\n- 生成时间：{}\n\n每个歌单四套文件：`名字.csv/md` 是完整歌单，`名字-网易云` 是当前状态，`名字-受限` 是下架/无版权/仅其他版本，`名字-补充` 是人工添加。\n\n| 名称 | 曲目 | 受限 | 人工补充 | 文件 |\n| --- | --- | --- | --- | --- |\n{}\n",
            sub, items, songs, extras_total, now_human(), index_rows.join("\n")
        );
        let (p, _) = write_both(app, &format!("{}/00_索引.md", sub), &idx);
        public_files += p.iter().filter(|x| !x.contains("/exports/")).count();
        if !p.is_empty() { files += 1; }
    }

    let mut unique = 0i64;
    if kind == "pl" && !all_rows.is_empty() {
        unique = all_rows.len() as i64;
        let d = serde_json::json!({ "name": "全部曲目", "id": 0, "count": unique, "rows": all_rows });
        let (p, _) = write_both(app, "表格/all_songs.csv", &to_csv(&d));
        public_files += p.iter().filter(|x| !x.contains("/exports/")).count();
        if !p.is_empty() { files += 1; }
    }

    Ok(serde_json::json!({
        "ok": true, "items": items, "files": files, "songs": songs, "unique": unique,
        "extras": extras_total, "failed": failed, "publicFiles": public_files, "sub": sub
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
                if rows < count { issues.push(format!("完整歌单只有 {} 行，少于曲目 {}", rows, count)); }
                if !t.contains("发行公司/厂牌") { issues.push("CSV 缺厂牌列".to_string()); }
            }
            Err(_) => issues.push("缺少完整歌单 CSV".to_string()),
        }
        for tag in ["", "-网易云", "-受限", "-补充"] {
            if fs::read_to_string(out.join(format!("{}{}.csv", name, tag))).is_err() {
                issues.push(format!("缺少 {}{}.csv", name, tag));
            }
            if fs::read_to_string(out.join(format!("{}{}.md", name, tag))).is_err() {
                issues.push(format!("缺少 {}{}.md", name, tag));
            }
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
                if v["publicFiles"].as_u64().unwrap_or(0) == 0 {
                    job.log("warn", "文件只写进了应用私有目录：到系统设置给本应用「所有文件访问权限」后，才会出现在 Download/网易云导出");
                }
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
            job_start, job_status, job_stop, copy_log,
            get_export_dir, set_export_dir, check_export_dir, app_version, open_storage_settings,
            list_extras, add_extra, remove_extra,
            pick_export_dir, take_picked_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
