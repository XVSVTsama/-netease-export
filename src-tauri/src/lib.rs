mod api;
mod client;
mod crypto;

use client::Client;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tauri::State;

pub struct AppState {
    client: Arc<Client>,
    last_qr: Mutex<String>,
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
async fn qr_poll(state: State<'_, AppState>) -> Result<Value, String> {
    let key = state.last_qr.lock().unwrap().clone();
    if key.is_empty() {
        return Err("没有待轮询的二维码".into());
    }
    api::qr_poll(&state.client, &key).await
}

#[tauri::command]
async fn account(state: State<'_, AppState>) -> Result<Value, String> {
    api::account(&state.client).await
}

#[tauri::command]
async fn playlists(state: State<'_, AppState>, uid: i64) -> Result<Value, String> {
    api::playlists(&state.client, uid).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            client: Arc::new(Client::new()),
            last_qr: Mutex::new(String::new()),
        })
        .invoke_handler(tauri::generate_handler![qr_new, qr_poll, account, playlists])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
