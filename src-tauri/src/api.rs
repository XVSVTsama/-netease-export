use crate::client::Client;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use qrcode::QrCode;
use serde_json::{json, Value};

fn md5_hex(s: &str) -> String {
    format!("{:x}", md5::compute(s))
}

/// 生成扫码 unikey，并返回二维码（SVG data URL）
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
    Ok(json!({
        "key": key,
        "img": format!("data:image/svg+xml;base64,{}", B64.encode(svg.as_bytes())),
    }))
}

/// 轮询扫码状态：801 待扫 / 802 已扫 / 803 成功 / 800 过期
pub async fn qr_poll(c: &Client, key: &str) -> Result<Value, String> {
    let r = c
        .eapi("/login/qrcode/client/login", json!({ "key": key, "type": 1 }))
        .await?;
    let code = r["code"].as_i64().unwrap_or(0);
    let mut nickname = String::new();
    if code == 803 {
        let acc = c.weapi("/weapi/w/nuser/account/get", json!({})).await?;
        nickname = acc["profile"]["nickname"].as_str().unwrap_or("").to_string();
    }
    Ok(json!({
        "code": code,
        "message": r["message"].as_str().unwrap_or(""),
        "nickname": nickname,
        "logged": c.has_login(),
    }))
}

/// 已登录账号信息
pub async fn account(c: &Client) -> Result<Value, String> {
    let r = c.weapi("/weapi/w/nuser/account/get", json!({})).await?;
    Ok(json!({
        "logged": c.has_login() && r["account"].is_object(),
        "nickname": r["profile"]["nickname"].as_str().unwrap_or(""),
        "uid": r["account"]["id"].as_i64().unwrap_or(0),
        "cookie": c.cookie_header(),
    }))
}

/// 方式二：粘贴 Cookie（MUSIC_U 或完整 cookie 串）
pub async fn login_cookie(c: &Client, cookie: &str) -> Result<Value, String> {
    let raw = cookie.trim();
    if raw.is_empty() {
        return Err("Cookie 为空".into());
    }
    // 允许只贴 MUSIC_U 的值
    let normalized = if raw.contains('=') { raw.to_string() } else { format!("MUSIC_U={}", raw) };
    c.set_cookie(&normalized);
    let a = account(c).await?;
    if a["logged"].as_bool() == Some(true) {
        Ok(json!({ "ok": true, "nickname": a["nickname"], "uid": a["uid"] }))
    } else {
        Err("Cookie 无效或已过期".into())
    }
}

/// 方式三：手机号 + 密码
pub async fn login_phone_password(c: &Client, phone: &str, password: &str) -> Result<Value, String> {
    let r = c
        .weapi(
            "/weapi/login/cellphone",
            json!({
                "phone": phone.trim(),
                "password": md5_hex(password),
                "countrycode": "86",
                "rememberLogin": true,
            }),
        )
        .await?;
    let code = r["code"].as_i64().unwrap_or(-1);
    if code == 200 {
        Ok(json!({ "ok": true, "code": code, "nickname": r["profile"]["nickname"], "uid": r["account"]["id"] }))
    } else {
        let msg = match code {
            501 => "账号不存在",
            502 => "密码错误",
            8810 => "需要验证码校验",
            400 => "参数错误",
            _ => r["message"].as_str().unwrap_or("登录失败"),
        };
        Err(format!("{}（code {}）", msg, code))
    }
}

/// 方式四：手机号 + 短信验证码（发送）
pub async fn sms_sent(c: &Client, phone: &str) -> Result<Value, String> {
    let r = c
        .weapi(
            "/weapi/sms/captcha/sent",
            json!({ "cellphone": phone.trim(), "ctcode": "86" }),
        )
        .await?;
    let code = r["code"].as_i64().unwrap_or(-1);
    Ok(json!({
        "ok": code == 200,
        "code": code,
        "message": if code == 200 { "验证码已发送".to_string() } else { r["message"].as_str().unwrap_or("发送失败").to_string() }
    }))
}

/// 方式四：手机号 + 短信验证码（校验登录）
pub async fn login_phone_captcha(c: &Client, phone: &str, captcha: &str) -> Result<Value, String> {
    let r = c
        .weapi(
            "/weapi/login/cellphone",
            json!({
                "phone": phone.trim(),
                "captcha": captcha.trim(),
                "countrycode": "86",
                "rememberLogin": true,
            }),
        )
        .await?;
    let code = r["code"].as_i64().unwrap_or(-1);
    if code == 200 {
        Ok(json!({ "ok": true, "code": code, "nickname": r["profile"]["nickname"], "uid": r["account"]["id"] }))
    } else {
        Err(format!("{}（code {}）", r["message"].as_str().unwrap_or("登录失败"), code))
    }
}

/// 方式五：邮箱 + 密码
pub async fn login_email(c: &Client, email: &str, password: &str) -> Result<Value, String> {
    let r = c
        .weapi(
            "/weapi/login",
            json!({
                "username": email.trim(),
                "password": md5_hex(password),
                "rememberLogin": true,
            }),
        )
        .await?;
    let code = r["code"].as_i64().unwrap_or(-1);
    if code == 200 {
        Ok(json!({ "ok": true, "code": code, "nickname": r["profile"]["nickname"], "uid": r["account"]["id"] }))
    } else {
        Err(format!("{}（code {}）", r["message"].as_str().unwrap_or("登录失败"), code))
    }
}

/// 用户歌单列表（自建 + 收藏）
pub async fn playlists(c: &Client, uid: i64) -> Result<Value, String> {
    let mut out = Vec::new();
    let mut offset = 0;
    loop {
        let r = c
            .weapi(
                "/weapi/user/playlist",
                json!({ "uid": uid, "limit": 100, "offset": offset, "includeVideo": true }),
            )
            .await?;
        let arr = r["playlist"].as_array().cloned().unwrap_or_default();
        if arr.is_empty() {
            break;
        }
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
        if arr.len() < 100 {
            break;
        }
        offset += 100;
    }
    Ok(json!({ "total": out.len(), "items": out }))
}
