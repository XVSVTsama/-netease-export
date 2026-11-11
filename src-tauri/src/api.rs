use crate::client::Client;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use futures::future::join_all;
use qrcode::QrCode;
use serde_json::{json, Value};
use std::collections::HashMap;

fn md5_hex(s: &str) -> String {
    format!("{:x}", md5::compute(s))
}

/* ---------------- 登录 ---------------- */

pub async fn qr_new(c: &Client) -> Result<Value, String> {
    let r = c.eapi("/login/qrcode/unikey", json!({ "type": 1 })).await?;
    if r["code"].as_i64() != Some(200) {
        return Err(format!("生成二维码失败: {}", r));
    }
    let key = r["unikey"].as_str().unwrap_or_default().to_string();
    let url = format!("https://music.163.com/login?codekey={}", key);
    let code = QrCode::new(url.as_bytes()).map_err(|e| e.to_string())?;
    let svg = code
        .render::<qrcode::render::svg::Color>()
        .quiet_zone(true)
        .min_dimensions(320, 320)
        .build();
    Ok(json!({ "key": key, "img": format!("data:image/svg+xml;base64,{}", B64.encode(svg.as_bytes())) }))
}

pub async fn qr_poll(c: &Client, key: &str) -> Result<Value, String> {
    let r = c.eapi("/login/qrcode/client/login", json!({ "key": key, "type": 1 })).await?;
    let code = r["code"].as_i64().unwrap_or(0);
    let mut nickname = String::new();
    if code == 803 {
        let acc = c.weapi("/weapi/w/nuser/account/get", json!({})).await?;
        nickname = acc["profile"]["nickname"].as_str().unwrap_or("").to_string();
    }
    Ok(json!({ "code": code, "message": r["message"].as_str().unwrap_or(""), "nickname": nickname, "logged": c.has_login() }))
}

pub async fn account(c: &Client) -> Result<Value, String> {
    let r = c.weapi("/weapi/w/nuser/account/get", json!({})).await?;
    Ok(json!({
        "logged": c.has_login() && r["account"].is_object(),
        "nickname": r["profile"]["nickname"].as_str().unwrap_or(""),
        "uid": r["account"]["id"].as_i64().unwrap_or(0),
        "cookie": c.cookie_header(),
    }))
}

pub async fn login_cookie(c: &Client, cookie: &str) -> Result<Value, String> {
    let raw = cookie.trim();
    if raw.is_empty() {
        return Err("Cookie 为空".into());
    }
    let normalized = if raw.contains('=') { raw.to_string() } else { format!("MUSIC_U={}", raw) };
    c.set_cookie(&normalized);
    let a = account(c).await?;
    if a["logged"].as_bool() == Some(true) {
        Ok(json!({ "ok": true, "nickname": a["nickname"], "uid": a["uid"] }))
    } else {
        Err("Cookie 无效或已过期".into())
    }
}

pub async fn login_phone_password(c: &Client, phone: &str, password: &str) -> Result<Value, String> {
    let r = c.weapi("/weapi/login/cellphone", json!({
        "phone": phone.trim(), "password": md5_hex(password), "countrycode": "86", "rememberLogin": true
    })).await?;
    ok_or_login_err(r)
}

pub async fn sms_sent(c: &Client, phone: &str) -> Result<Value, String> {
    let r = c.weapi("/weapi/sms/captcha/sent", json!({ "cellphone": phone.trim(), "ctcode": "86" })).await?;
    let code = r["code"].as_i64().unwrap_or(-1);
    Ok(json!({ "ok": code == 200, "code": code, "message": if code == 200 { "验证码已发送".to_string() } else { r["message"].as_str().unwrap_or("发送失败").to_string() } }))
}

pub async fn login_phone_captcha(c: &Client, phone: &str, captcha: &str) -> Result<Value, String> {
    let r = c.weapi("/weapi/login/cellphone", json!({
        "phone": phone.trim(), "captcha": captcha.trim(), "countrycode": "86", "rememberLogin": true
    })).await?;
    ok_or_login_err(r)
}

pub async fn login_email(c: &Client, email: &str, password: &str) -> Result<Value, String> {
    let r = c.weapi("/weapi/login", json!({
        "username": email.trim(), "password": md5_hex(password), "rememberLogin": true
    })).await?;
    ok_or_login_err(r)
}

fn ok_or_login_err(r: Value) -> Result<Value, String> {
    let code = r["code"].as_i64().unwrap_or(-1);
    if code == 200 {
        Ok(json!({ "ok": true, "code": code, "nickname": r["profile"]["nickname"], "uid": r["account"]["id"] }))
    } else {
        let msg = match code {
            501 => "账号不存在", 502 => "密码错误", 8810 => "需要验证码校验", 400 => "参数错误",
            _ => r["message"].as_str().unwrap_or("登录失败"),
        };
        Err(format!("{}（code {}）", msg, code))
    }
}

/* ---------------- 歌单 ---------------- */

pub async fn playlists(c: &Client, uid: i64) -> Result<Value, String> {
    let mut out = Vec::new();
    let mut offset = 0;
    loop {
        let r = c.weapi("/weapi/user/playlist", json!({ "uid": uid, "limit": 100, "offset": offset, "includeVideo": true })).await?;
        let arr = r["playlist"].as_array().cloned().unwrap_or_default();
        if arr.is_empty() { break; }
        for p in &arr {
            out.push(json!({
                "id": p["id"].as_i64().unwrap_or(0),
                "name": p["name"].as_str().unwrap_or(""),
                "count": p["trackCount"].as_i64().unwrap_or(0),
                "privacy": p["privacy"].as_i64().unwrap_or(0),
                "creator": p["creator"]["nickname"].as_str().unwrap_or(""),
                "mine": p["userId"].as_i64() == Some(uid),
            }));
        }
        if arr.len() < 100 { break; }
        offset += 100;
    }
    Ok(json!({ "total": out.len(), "items": out }))
}

fn song_of_album(s: &Value) -> (String, String, String, i64, i64, i64) {
    let name = s["name"].as_str().unwrap_or("").to_string();
    let ar = s["ar"].as_array().or_else(|| s["artists"].as_array())
        .map(|a| a.iter().filter_map(|x| x["name"].as_str()).collect::<Vec<_>>().join(" / "))
        .unwrap_or_default();
    let al = s["al"].as_object().or_else(|| s["album"].as_object()).cloned().unwrap_or_default();
    let al_name = al.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let al_id = al.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
    let dur = s["dt"].as_i64().or_else(|| s["duration"].as_i64()).unwrap_or(0);
    let ncr = s["noCopyrightRcmd"]["typeDesc"].as_str().unwrap_or("").to_string();
    (name, ar, al_name, al_id, dur, if ncr.is_empty() { 0 } else { 1 })
}

/// 歌单详情：曲目 + 专辑信息（含厂牌）
pub async fn playlist_detail(c: &Client, id: i64) -> Result<Value, String> {
    let r = c.eapi("/v6/playlist/detail", json!({ "id": id.to_string(), "n": 100000, "s": 8, "t": 0 })).await?;
    if r["code"].as_i64() != Some(200) {
        return Err(format!("拉取歌单失败: {}", r["message"].as_str().unwrap_or("未知")));
    }
    let pl = &r["playlist"];
    let mut songs: Vec<Value> = pl["tracks"].as_array().cloned().unwrap_or_default();
    let ids: Vec<i64> = pl["trackIds"].as_array()
        .map(|a| a.iter().filter_map(|x| x["id"].as_i64()).collect())
        .unwrap_or_default();

    if ids.len() > songs.len() {
        let mut got: HashMap<i64, Value> = songs.iter().filter_map(|s| s["id"].as_i64().map(|i| (i, s.clone()))).collect();
        for chunk in ids.chunks(400) {
            let cjson: Vec<Value> = chunk.iter().map(|x| json!({ "id": x })).collect();
            if let Ok(sr) = c.weapi("/weapi/v3/song/detail", json!({ "c": serde_json::to_string(&cjson).unwrap_or_default() })).await {
                if let Some(arr) = sr["songs"].as_array() {
                    for s in arr { if let Some(i) = s["id"].as_i64() { got.insert(i, s.clone()); } }
                }
            }
        }
        songs = ids.iter().filter_map(|i| got.get(i).cloned()).collect();
    }

    let mut rows = Vec::new();
    let mut album_ids: Vec<i64> = Vec::new();
    for s in &songs {
        let (name, ar, al, al_id, dur, ncr) = song_of_album(s);
        if al_id > 0 && !album_ids.contains(&al_id) { album_ids.push(al_id); }
        rows.push(json!({
            "id": s["id"].as_i64().unwrap_or(0),
            "name": name, "ar": ar, "al": al, "alId": al_id, "dur": dur,
            "ncr": ncr == 1, "company": "",
        }));
    }

    // 厂牌：按专辑去重后查询（并发 6）
    let mut companies: HashMap<i64, String> = HashMap::new();
    for chunk in album_ids.chunks(6) {
        let futs = chunk.iter().map(|aid| {
            let c = c;
            let aid = *aid;
            async move {
                let v = c.weapi(&format!("/weapi/v1/album/{}", aid), json!({})).await.ok();
                let company = v.as_ref()
                    .and_then(|x| x["album"]["company"].as_str())
                    .unwrap_or("").to_string();
                (aid, company)
            }
        });
        for (aid, company) in join_all(futs).await {
            companies.insert(aid, company);
        }
    }
    for row in rows.iter_mut() {
        if let Some(aid) = row["alId"].as_i64() {
            if let Some(cmp) = companies.get(&aid) {
                row["company"] = json!(cmp);
            }
        }
    }

    Ok(json!({
        "id": id,
        "name": pl["name"].as_str().unwrap_or(""),
        "count": rows.len(),
        "rows": rows,
    }))
}
