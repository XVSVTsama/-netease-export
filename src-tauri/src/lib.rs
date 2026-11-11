mod api;
mod client;
mod crypto;

use client::Client;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};

pub struct AppState {
    client: Arc<Client>,
    last_qr: Mutex<String>,
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

fn fmt_dur(ms: i64) -> String {
    if ms <= 0 { return "--:--".into(); }
    let total = (ms + 500) / 1000;
    format!("{}:{:02}", total / 60, total % 60)
}

fn to_csv(d: &Value) -> String {
    let mut out = String::from("\u{feff}序号,歌名,制作人/团体,专辑,发行公司/厂牌,时长,时长秒,歌曲ID,专辑ID,流行度,MV_ID,别名,权限,状态\n");
    if let Some(rows) = d["rows"].as_array() {
        for (i, r) in rows.iter().enumerate() {
            let e = |v: &Value| format!("\"{}\"", v.as_str().unwrap_or("").replace('"', "\"\""));
            let company = r["company"].as_str().unwrap_or("");
            let fee = r["fee"].as_i64().unwrap_or(0);
            let perm = match fee { 0 => "免费", 1 => "VIP", 4 => "付费专辑", 8 => "低音质", _ => "其他" };
            out.push_str(&format!(
                "{},{},{},{},{},{},{},{},{},{},{},{},{},{}\n",
                i + 1,
                e(&r["name"]),
                e(&r["ar"]),
                e(&r["al"]),
                if company.is_empty() { "\"未标注厂牌\"".to_string() } else { e(&r["company"]) },
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
        chrono_like_now());
    if let Some(rows) = d["rows"].as_array() {
        for (i, r) in rows.iter().enumerate() {
            let company = r["company"].as_str().unwrap_or("");
            let mark = if r["ncr"].as_bool().unwrap_or(false) { "  〔仅其他版本可播〕" } else { "" };
            out.push_str(&format!("{}. {} - {} - {} - {}  〔{}〕{}\n",
                i + 1,
                r["name"].as_str().unwrap_or(""),
                r["ar"].as_str().unwrap_or("未知"),
                r["al"].as_str().unwrap_or("未知"),
                if company.is_empty() { "未标注厂牌" } else { company },
                fmt_dur(r["dur"].as_i64().unwrap_or(0)),
                mark));
        }
    }
    out
}

fn chrono_like_now() -> String {
    // 不引入 chrono：用系统时间戳拼近似（本地时区偏移未处理，仅作标记）
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format!("epoch {}", secs)
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
    api::playlist_detail(&state.client, id).await
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

/// 导出歌单：format = csv | md，返回保存路径列表
#[tauri::command]
async fn export_playlist(app: tauri::AppHandle, state: State<'_, AppState>, id: i64, format: String) -> Result<Value, String> {
    let d = api::playlist_detail(&state.client, id).await?;
    let content = if format == "md" { to_md(&d) } else { to_csv(&d) };
    let name = sanitize(d["name"].as_str().unwrap_or("playlist"));
    let ext = if format == "md" { "md" } else { "csv" };
    let file = format!("{}.{}", name, ext);

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
                Ok(())
            }
        })
        .manage(AppState { client, last_qr: Mutex::new(String::new()) })
        .invoke_handler(tauri::generate_handler![
            qr_new, qr_poll, account, playlists, playlist_detail,
            login_cookie, login_phone_password, sms_sent, login_phone_captcha,
            login_email, logout, export_playlist, collected_albums, play_record, save_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
