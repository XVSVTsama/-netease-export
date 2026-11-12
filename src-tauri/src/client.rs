use crate::crypto;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 相邻请求的最小间隔：网易风控对连续请求很敏感，太快会整批失败
const MIN_GAP: Duration = Duration::from_millis(160);
const RETRIES: usize = 2;

const UA_WEB: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const UA_APP: &str = "NeteaseMusic/8.9.70.240407164325(8009070);Dalvik/2.1.0 (Linux; U; Android 13; PJZ110 Build/TP1A.220905.001)";
const API: &str = "https://music.163.com";

pub struct Client {
    http: reqwest::Client,
    cookies: Mutex<HashMap<String, String>>,
    gate: Mutex<Instant>,
}

impl Client {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(20))
                .build()
                .expect("http client"),
            cookies: Mutex::new(HashMap::new()),
            gate: Mutex::new(Instant::now()),
        }
    }

    /// 全局限速：所有请求排队，保证相邻两次之间至少 MIN_GAP
    async fn wait_gate(&self) {
        let sleep_for = {
            let mut g = self.gate.lock().unwrap();
            let now = Instant::now();
            let slot = if *g + MIN_GAP > now { *g + MIN_GAP } else { now };
            *g = slot;
            slot.saturating_duration_since(now)
        };
        if !sleep_for.is_zero() {
            tokio::time::sleep(sleep_for).await;
        }
    }

    pub fn cookie_header(&self) -> String {
        let jar = self.cookies.lock().unwrap();
        jar.iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect::<Vec<_>>()
            .join("; ")
    }

    pub fn set_cookie(&self, raw: &str) {
        let mut jar = self.cookies.lock().unwrap();
        for part in raw.split(';') {
            let part = part.trim();
            if let Some((k, v)) = part.split_once('=') {
                if !k.is_empty() {
                    jar.insert(k.to_string(), v.to_string());
                }
            }
        }
    }

    pub fn clear_cookies(&self) {
        self.cookies.lock().unwrap().clear();
    }

    pub fn has_login(&self) -> bool {
        self.cookies.lock().unwrap().contains_key("MUSIC_U")
    }

    fn store_set_cookie(&self, resp: &reqwest::Response) {
        for v in resp.headers().get_all(reqwest::header::SET_COOKIE) {
            if let Ok(s) = v.to_str() {
                self.set_cookie(s);
            }
        }
    }

    pub async fn weapi(&self, path: &str, body: Value) -> Result<Value, String> {
        let form = crypto::weapi_body(&body);
        let ck = self.cookie_header();
        let mut last_err = String::from("请求失败");
        for attempt in 0..=RETRIES {
            self.wait_gate().await;
            let mut req = self
                .http
                .post(format!("{}{}", API, path))
                .header(reqwest::header::USER_AGENT, UA_WEB)
                .header(reqwest::header::REFERER, "https://music.163.com/")
                .form(&form);
            if !ck.is_empty() {
                req = req.header(reqwest::header::COOKIE, ck.clone());
            }
            match req.send().await {
                Ok(resp) => {
                    self.store_set_cookie(&resp);
                    let status = resp.status();
                    match resp.json::<Value>().await {
                        Ok(v) => {
                            let code = v["code"].as_i64().unwrap_or(200);
                            if code == 200 {
                                return Ok(v);
                            }
                            last_err = format!("接口返回 {} {}", code, v["message"].as_str().unwrap_or(""));
                        }
                        Err(e) => last_err = format!("HTTP {} 解析失败 {}", status.as_u16(), e),
                    }
                }
                Err(e) => last_err = e.to_string(),
            }
            if attempt < RETRIES {
                tokio::time::sleep(Duration::from_millis(700 * (attempt as u64 + 1))).await;
            }
        }
        Err(last_err)
    }

    pub async fn eapi(&self, short: &str, body: Value) -> Result<Value, String> {
        let mut obj = body.clone();
        obj["header"] = serde_json::json!({
            "os": "android", "appver": "8.9.70", "osver": "13",
            "deviceId": "com.netease.cloudmusic",
            "buildver": "1793900000", "resolution": "1440x3200", "mobilename": "PJZ110"
        });
        let params = crypto::eapi_params(&format!("/api{}", short), &obj);
        let ck = self.cookie_header();
        let cookie = if ck.is_empty() {
            "os=android; appver=8.9.70; osver=13".to_string()
        } else {
            format!("{}; os=android; appver=8.9.70; osver=13", ck)
        };
        let mut last_err = String::from("请求失败");
        for attempt in 0..=RETRIES {
            self.wait_gate().await;
            let send = self
                .http
                .post(format!("{}/eapi{}", API, short))
                .header(reqwest::header::USER_AGENT, UA_APP)
                .header(reqwest::header::COOKIE, cookie.clone())
                .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                .body(format!("params={}", params))
                .send()
                .await;
            match send {
                Ok(resp) => {
                    self.store_set_cookie(&resp);
                    let status = resp.status();
                    match resp.json::<Value>().await {
                        Ok(v) => return Ok(v),
                        Err(e) => last_err = format!("HTTP {} 解析失败 {}", status.as_u16(), e),
                    }
                }
                Err(e) => last_err = e.to_string(),
            }
            if attempt < RETRIES {
                tokio::time::sleep(Duration::from_millis(700 * (attempt as u64 + 1))).await;
            }
        }
        Err(last_err)
    }
}
