use crate::crypto;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;

const UA_WEB: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const UA_APP: &str = "NeteaseMusic/8.9.70.240407164325(8009070);Dalvik/2.1.0 (Linux; U; Android 13; PJZ110 Build/TP1A.220905.001)";
const API: &str = "https://music.163.com";

pub struct Client {
    http: reqwest::Client,
    cookies: Mutex<HashMap<String, String>>,
}

impl Client {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(20))
                .build()
                .expect("http client"),
            cookies: Mutex::new(HashMap::new()),
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
        let mut req = self
            .http
            .post(format!("{}{}", API, path))
            .header(reqwest::header::USER_AGENT, UA_WEB)
            .header(reqwest::header::REFERER, "https://music.163.com/")
            .form(&form);
        if !ck.is_empty() {
            req = req.header(reqwest::header::COOKIE, ck);
        }
        let resp = req.send().await.map_err(|e| e.to_string())?;
        self.store_set_cookie(&resp);
        resp.json::<Value>().await.map_err(|e| e.to_string())
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
        let resp = self
            .http
            .post(format!("{}/eapi{}", API, short))
            .header(reqwest::header::USER_AGENT, UA_APP)
            .header(reqwest::header::COOKIE, cookie)
            .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(format!("params={}", params))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        self.store_set_cookie(&resp);
        resp.json::<Value>().await.map_err(|e| e.to_string())
    }
}
