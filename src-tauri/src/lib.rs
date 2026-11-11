mod api;
mod client;
mod crypto;

use client::Client;
use serde_json::Value;
use std::fs;
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};

pub struct AppState {
    client: Arc<Client>,
    last_qr: Mutex<String>,
}

fn cookie_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("cookie.txt"))
}

fn save_cookie(app: &tauri::AppHandle, cookie: &str) {
    if let Some(p) = cookie_path(app) {
        if let Some(dir) = p.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(p, cookie);
    }
}

#[tauri::command]
async fn qr_new(state: State<'_, AppState>) -> Result<Value, String> {
    let r = api::qr_new(&state.client).await?;
    if let Some(k) = r["key"].as_str() {
        *state.last_qr.lock().unwrap() = k.to_string();
    }
    Ok(r)
}

#[tauri::command]
async fn qr_poll(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let key = state.last_qr.lock().unwrap().clone();
    if key.is_empty() {
        return Err("没有待轮询的二维码".into());
    }
    let r = api::qr_poll(&state.client, &key).await?;
    if r["code"].as_i64() == Some(803) {
        save_cookie(&app, &state.client.cookie_header());
    }
    Ok(r)
}

#[tauri::command]
async fn account(state: State<'_, AppState>) -> Result<Value, String> {
    api::account(&state.client).await
}

#[tauri::command]
async fn playlists(state: State<'_, AppState>, uid: i64) -> Result<Value, String> {
    api::playlists(&state.client, uid).await
}

#[tauri::command]
async fn login_cookie(app: tauri::AppHandle, state: State<'_, AppState>, cookie: String) -> Result<Value, String> {
    let r = api::login_cookie(&state.client, &cookie).await?;
    save_cookie(&app, &state.client.cookie_header());
    Ok(r)
}

#[tauri::command]
async fn login_phone_password(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    phone: String,
    password: String,
) -> Result<Value, String> {
    let r = api::login_phone_password(&state.client, &phone, &password).await?;
    save_cookie(&app, &state.client.cookie_header());
    Ok(r)
}

#[tauri::command]
async fn sms_sent(state: State<'_, AppState>, phone: String) -> Result<Value, String> {
    api::sms_sent(&state.client, &phone).await
}

#[tauri::command]
async fn login_phone_captcha(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    phone: String,
    captcha: String,
) -> Result<Value, String> {
    let r = api::login_phone_captcha(&state.client, &phone, &captcha).await?;
    save_cookie(&app, &state.client.cookie_header());
    Ok(r)
}

#[tauri::command]
async fn login_email(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    email: String,
    password: String,
) -> Result<Value, String> {
    let r = api::login_email(&state.client, &email, &password).await?;
    save_cookie(&app, &state.client.cookie_header());
    Ok(r)
}

#[tauri::command]
async fn logout(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    state.client.clear_cookies();
    if let Some(p) = cookie_path(&app) {
        let _ = fs::remove_file(p);
    }
    Ok(serde_json::json!({ "ok": true }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let client = Arc::new(Client::new());
    tauri::Builder::default()
        .setup({
            let client = client.clone();
            move |app| {
                if let Some(p) = cookie_path(&app.handle().clone()) {
                    if let Ok(saved) = fs::read_to_string(p) {
                        if !saved.trim().is_empty() {
                            client.set_cookie(&saved);
                        }
                    }
                }
                Ok(())
            }
        })
        .manage(AppState {
            client,
            last_qr: Mutex::new(String::new()),
        })
        .invoke_handler(tauri::generate_handler![
            qr_new, qr_poll, account, playlists,
            login_cookie, login_phone_password, sms_sent, login_phone_captcha,
            login_email, logout
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
