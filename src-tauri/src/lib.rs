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
    special: Mutex<Vec<Value>>,
    special_ids: Mutex<std::collections::HashSet<i64>>,
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
    let d = api::playlist_detail(&state.client, id).await?;
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

/// 同步：把一个歌单 / 收藏歌单 / 收藏专辑的详情抓到暂存区，不生成文档
#[tauri::command]
async fn stage_one(app: tauri::AppHandle, state: State<'_, AppState>, kind: String, id: i64) -> Result<Value, String> {
    if kind_sub(&kind).is_none() { return Err("未知类型".into()); }
    let d = if kind == "al" {
        api::album_detail(&state.client, id).await?
    } else {
        api::playlist_detail(&state.client, id).await?
    };
    let dir = stage_dir(&app, &kind)?;
    fs::write(dir.join(format!("{}.json", id)), d.to_string()).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "ok": true,
        "name": d["name"].clone(),
        "count": d["count"].as_i64().unwrap_or(0),
        "stats": d["stats"].clone()
    }))
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

/// 整理：暂存区 → CSV + MD 文档
#[tauri::command]
async fn tidy(app: tauri::AppHandle, kind: String) -> Result<Value, String> {
    let sub = kind_sub(&kind).ok_or_else(|| "未知类型".to_string())?;
    let dir = stage_dir(&app, &kind)?;
    let mut files = 0usize;
    let mut items = 0usize;
    let mut songs = 0i64;
    let mut failed = 0usize;
    for (_, d) in read_stage(&dir) {
        let name = sanitize(d["name"].as_str().unwrap_or("未命名"));
        let (csv_paths, _) = write_both(&app, &format!("{}/{}.csv", sub, name), &to_csv(&d));
        let (md_paths, _) = write_both(&app, &format!("{}/{}.md", sub, name), &to_md(&d));
        if csv_paths.is_empty() || md_paths.is_empty() { failed += 1; continue; }
        files += 2;
        items += 1;
        songs += d["count"].as_i64().unwrap_or(0);
    }
    Ok(serde_json::json!({
        "ok": true, "items": items, "files": files, "songs": songs, "failed": failed, "sub": sub
    }))
}

/// 核验：比对暂存区与已生成的文档
#[tauri::command]
async fn check_exports(app: tauri::AppHandle, kind: String) -> Result<Value, String> {
    let sub = kind_sub(&kind).ok_or_else(|| "未知类型".to_string())?;
    let dir = stage_dir(&app, &kind)?;
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
        .manage(AppState { client, last_qr: Mutex::new(String::new()), special: Mutex::new(Vec::new()), special_ids: Mutex::new(std::collections::HashSet::new()) })
        .invoke_handler(tauri::generate_handler![
            qr_new, qr_poll, account, playlists, playlist_detail,
            login_cookie, login_phone_password, sms_sent, login_phone_captcha,
            login_email, logout, export_playlist, collected_albums, play_record, save_text,
            special_items, export_special, zip_exports, album_detail, export_album,
            stage_one, stage_stats, tidy, check_exports
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
