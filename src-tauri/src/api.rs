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
                "cover": p["coverImgUrl"].as_str().unwrap_or(""),
            }));
        }
        if arr.len() < 100 { break; }
        offset += 100;
    }
    Ok(json!({ "total": out.len(), "items": out }))
}

fn song_cover(s: &Value) -> String {
    s["al"]["picUrl"].as_str()
        .or_else(|| s["album"]["picUrl"].as_str())
        .unwrap_or("")
        .to_string()
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

/// 厂牌缓存：专辑 ID → 发行公司，进程内共享，跨歌单复用
fn company_cache() -> &'static std::sync::Mutex<HashMap<i64, String>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<HashMap<i64, String>>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

pub fn companies_snapshot() -> HashMap<i64, String> {
    company_cache().lock().unwrap().clone()
}

pub fn companies_load(map: HashMap<i64, String>) {
    let mut c = company_cache().lock().unwrap();
    for (k, v) in map { c.insert(k, v); }
}

/// 批量补厂牌（并发 4，实际速率由 Client 的全局限速控制）
/// 单张专辑查厂牌：三种办法各试 10 次，全部失败才认输
async fn album_company(c: &Client, aid: i64) -> Result<String, String> {
    let path = format!("/weapi/v1/album/{}", aid);
    let mut last = String::from("未知错误");
    let backoff = |attempt: u64| std::time::Duration::from_millis(200 + attempt * 150);

    let mut net_errs = 0u32;
    // 办法一：网页 UA
    for attempt in 0..10u64 {
        match c.weapi_once(&path, json!({}), crate::client::UA_WEB).await {
            Ok(v) if v["code"].as_i64() == Some(200) => {
                return Ok(v["album"]["company"].as_str().unwrap_or("").to_string());
            }
            Ok(v) => { net_errs = 0; last = format!("weapi/web code {}", v["code"]); }
            Err(e) => { net_errs += 1; last = e; }
        }
        if net_errs >= 3 { break; }
        tokio::time::sleep(backoff(attempt)).await;
    }
    net_errs = 0;
    // 办法二：移动端 UA
    for attempt in 0..10u64 {
        match c.weapi_once(&path, json!({}), crate::client::UA_MOBILE).await {
            Ok(v) if v["code"].as_i64() == Some(200) => {
                return Ok(v["album"]["company"].as_str().unwrap_or("").to_string());
            }
            Ok(v) => { net_errs = 0; last = format!("weapi/mobile code {}", v["code"]); }
            Err(e) => { net_errs += 1; last = e; }
        }
        if net_errs >= 3 { break; }
        tokio::time::sleep(backoff(attempt)).await;
    }
    net_errs = 0;
    // 办法三：eapi
    for attempt in 0..10u64 {
        match c.eapi_once(&format!("/v1/album/{}", aid), json!({ "id": aid.to_string() })).await {
            Ok(v) if v["code"].as_i64() == Some(200) => {
                let cmp = v["album"]["company"].as_str()
                    .or_else(|| v["song"]["album"]["company"].as_str())
                    .unwrap_or("");
                return Ok(cmp.to_string());
            }
            Ok(v) => { net_errs = 0; last = format!("eapi code {}", v["code"]); }
            Err(e) => { net_errs += 1; last = e; }
        }
        if net_errs >= 3 { break; }
        tokio::time::sleep(backoff(attempt)).await;
    }
    Err(last)
}

/// 按 id 批量补厂牌：返回 (专辑 -> 厂牌, 失败的专辑 id, 最后一个错误)
/// 厂牌为空字符串表示查询成功但网易没有标注，与请求失败要区分开
pub async fn fill_companies(
    c: &Client,
    ids: &[i64],
) -> (HashMap<i64, String>, std::collections::HashSet<i64>, Option<String>) {
    let mut out = HashMap::new();
    let mut failed: std::collections::HashSet<i64> = std::collections::HashSet::new();
    let mut last_err: Option<String> = None;
    for chunk in ids.chunks(4) {
        let futs = chunk.iter().map(|aid| {
            let c = c;
            let aid = *aid;
            async move { (aid, album_company(c, aid).await) }
        });
        for (aid, res) in join_all(futs).await {
            match res {
                Ok(company) => {
                    company_cache().lock().unwrap().insert(aid, company.clone());
                    out.insert(aid, company);
                }
                Err(e) => {
                    failed.insert(aid);
                    last_err = Some(format!("专辑 {}：{}", aid, e));
                }
            }
        }
    }
    (out, failed, last_err)
}

/// 歌单详情：曲目 + 专辑信息（含厂牌）
pub async fn playlist_detail(c: &Client, id: i64, with_company: bool) -> Result<Value, String> {
    let r = c.eapi("/v6/playlist/detail", json!({ "id": id.to_string(), "n": 100000, "s": 8, "t": 0 })).await?;
    if r["code"].as_i64() != Some(200) {
        return Err(format!("拉取歌单失败: {}", r["message"].as_str().unwrap_or("未知")));
    }
    let pl = &r["playlist"];
    let songs: Vec<Value> = pl["tracks"].as_array().cloned().unwrap_or_default();
    let ids: Vec<i64> = pl["trackIds"].as_array()
        .map(|a| a.iter().filter_map(|x| x["id"].as_i64()).collect())
        .unwrap_or_default();

    // 可播放状态：privilege.st = -200 是已下架，pl = 0 是没有版权
    let mut privs: HashMap<i64, (i64, i64)> = r["privileges"].as_array()
        .map(|a| a.iter().filter_map(|p| p["id"].as_i64().map(|i| {
            (i, (p["st"].as_i64().unwrap_or(0), p["pl"].as_i64().unwrap_or(1)))
        })).collect())
        .unwrap_or_default();

    let mut got: HashMap<i64, Value> = songs.iter()
        .filter_map(|s| s["id"].as_i64().map(|i| (i, s.clone()))).collect();
    if ids.len() > got.len() {
        for chunk in ids.chunks(400) {
            if got.len() >= ids.len() { break; }
            let cjson: Vec<Value> = chunk.iter().map(|x| json!({ "id": x })).collect();
            if let Ok(sr) = c.weapi("/weapi/v3/song/detail", json!({ "c": serde_json::to_string(&cjson).unwrap_or_default() })).await {
                if let Some(arr) = sr["songs"].as_array() {
                    for s in arr { if let Some(i) = s["id"].as_i64() { got.insert(i, s.clone()); } }
                }
                // 歌单详情只带前 1000 条的 privilege，补齐的这批要自己收
                if let Some(arr) = sr["privileges"].as_array() {
                    for p in arr {
                        if let Some(i) = p["id"].as_i64() {
                            privs.insert(i, (p["st"].as_i64().unwrap_or(0), p["pl"].as_i64().unwrap_or(1)));
                        }
                    }
                }
            }
        }
    }
    let order: Vec<i64> = if ids.is_empty() {
        songs.iter().filter_map(|s| s["id"].as_i64()).collect()
    } else { ids.clone() };

    let mut rows = Vec::new();
    let mut album_ids: Vec<i64> = Vec::new();
    for sid in order {
        let (st, pl) = privs.get(&sid).copied().unwrap_or((0, 1));
        if let Some(s) = got.get(&sid) {
            let (name, ar, al, al_id, dur, ncr) = song_of_album(s);
            if al_id > 0 && !album_ids.contains(&al_id) { album_ids.push(al_id); }
            rows.push(json!({
                "id": sid,
                "name": name, "ar": ar, "al": al, "alId": al_id, "dur": dur,
                "ncr": ncr == 1, "company": "",
                "pop": s["pop"].as_i64().unwrap_or(0),
                "alia": s["alia"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(" / ")).unwrap_or_default(),
                "mv": s["mv"].as_i64().unwrap_or(0),
                "fee": s["fee"].as_i64().unwrap_or(0),
                "st": st, "pl": pl, "missing": false,
                "cover": song_cover(s),
            }));
        } else {
            // 下架/无版权的歌接口不再返回详情，保留一行占位，导出时标成已下架
            rows.push(json!({
                "id": sid, "name": "", "ar": "", "al": "", "alId": 0, "dur": 0,
                "ncr": true, "company": "", "pop": 0, "alia": "", "mv": 0, "fee": 0,
                "st": if st == 0 { -200 } else { st }, "pl": 0, "missing": true,
            }));
        }
    }

    // 厂牌：先用缓存；同步阶段不查（with_company = false），整理阶段再分批补齐
    let mut companies: HashMap<i64, String> = HashMap::new();
    {
        let cache = company_cache().lock().unwrap();
        for aid in album_ids.iter() {
            if let Some(v) = cache.get(aid) { companies.insert(*aid, v.clone()); }
        }
    }
    if with_company {
        let need: Vec<i64> = album_ids.iter().filter(|a| !companies.contains_key(a)).cloned().collect();
        let (filled, _failed, _err) = fill_companies(c, &need).await;
        for (aid, company) in filled { companies.insert(aid, company); }    }
    for row in rows.iter_mut() {
        if let Some(aid) = row["alId"].as_i64() {
            if let Some(cmp) = companies.get(&aid) {
                row["company"] = json!(cmp);
            }
        }
    }

    let (stats, items) = classify_items(&rows);
    Ok(json!({
        "items": items,
        "id": id,
        "name": pl["name"].as_str().unwrap_or(""),
        "cover": pl["coverImgUrl"].as_str().unwrap_or(""),
        "count": rows.len(),
        "stats": stats,
        "rows": rows,
    }))
}

/* ---------------- 专项分类 ---------------- */

/// 是否不可播放：详情缺失 / st=-200（已下架）/ pl=0（无版权）
fn unplayable(r: &Value) -> bool {
    if r["missing"].as_bool().unwrap_or(false) { return true; }
    match r["st"].as_i64() {
        Some(st) => st == -200 || r["pl"].as_i64() == Some(0),
        None => r["ncr"].as_bool().unwrap_or(false) && r["fee"].as_i64().unwrap_or(0) == 0,
    }
}

pub fn classify_items(rows: &[Value]) -> (Value, Vec<Value>) {
    use regex::Regex;
    let special_re = Regex::new(r"[\p{Mn}\p{Mc}\p{Cf}\p{So}\p{Co}]").unwrap();
    let nonlatin_re = Regex::new(r"[\p{Cyrillic}\p{Hiragana}\p{Katakana}\p{Hangul}\p{Arabic}\p{Hebrew}\p{Greek}\p{Devanagari}\p{Tibetan}\p{Thai}\p{Yi}\p{Mongolian}\p{Georgian}\p{Armenian}\p{Ethiopic}\p{Sinhala}\p{Khmer}\p{Lao}\p{Myanmar}]").unwrap();
    let (mut down, mut other_ver, mut special, mut nonlatin) = (0, 0, 0, 0);
    for r in rows {
        if r["ncr"].as_bool().unwrap_or(false) { other_ver += 1; }
        if unplayable(r) { down += 1; }
        let name = r["name"].as_str().unwrap_or("");
        if special_re.is_match(name) { special += 1; }
        if nonlatin_re.is_match(name) { nonlatin += 1; }
    }
    let mut items = Vec::new();
    for r in rows {
        let name = r["name"].as_str().unwrap_or("");
        let kinds: Vec<&str> = [
            (unplayable(r), "down"),
            (r["ncr"].as_bool().unwrap_or(false), "otherVersion"),
            (special_re.is_match(name), "special"),
            (nonlatin_re.is_match(name), "nonLatin"),
        ].iter().filter(|(b, _)| *b).map(|(_, k)| *k).collect();
        if kinds.is_empty() { continue; }
        items.push(json!({
            "id": r["id"].as_i64().unwrap_or(0),
            "name": name,
            "ar": r["ar"].as_str().unwrap_or(""),
            "al": r["al"].as_str().unwrap_or(""),
            "company": r["company"].as_str().unwrap_or(""),
            "missing": r["missing"].as_bool().unwrap_or(false),
            "kinds": kinds,
        }));
    }
    (json!({ "down": down, "otherVersion": other_ver, "special": special, "nonLatin": nonlatin,
             "total": rows.len() }), items)
}

/* ---------------- 收藏专辑 ---------------- */

pub async fn collected_albums(c: &Client) -> Result<Value, String> {
    let mut items = Vec::new();
    let mut offset = 0;
    loop {
        let r = c.weapi("/weapi/album/sublist", json!({ "limit": 25, "offset": offset, "total": true })).await?;
        let arr = r["data"].as_array().or_else(|| r["albums"].as_array()).cloned().unwrap_or_default();
        if arr.is_empty() { break; }
        for a in &arr {
            items.push(json!({
                "id": a["id"].as_i64().unwrap_or(0),
                "name": a["name"].as_str().unwrap_or(""),
                "artists": a["artists"].as_array()
                    .map(|x| x.iter().filter_map(|y| y["name"].as_str()).collect::<Vec<_>>().join(" / "))
                    .unwrap_or_default(),
                "size": a["size"].as_i64().unwrap_or(0),
                "company": a["company"].as_str().unwrap_or(""),
                "publishTime": a["publishTime"].as_i64().unwrap_or(0),
                "pic": a["picUrl"].as_str().unwrap_or(""),
            }));
        }
        if r["hasMore"].as_bool() != Some(true) || arr.len() < 25 { break; }
        offset += 25;
    }
    Ok(json!({ "total": items.len(), "items": items }))
}

/* ---------------- 专辑曲目 ---------------- */

pub async fn album_detail(c: &Client, id: i64) -> Result<Value, String> {
    // 注意：/weapi/v1/album/{id} 的 songs 已恒为空，必须用 /weapi/album/{id}
    let r = c.weapi(&format!("/weapi/album/{}", id), json!({})).await?;
    let a = &r["album"];
    if !a.is_object() { return Err(format!("专辑不存在或接口拒绝: {}", r["code"])); }
    let songs = a["songs"].as_array().cloned().unwrap_or_default();
    let mut rows = Vec::new();
    for s in &songs {
        let (name, ar, al, al_id, dur, ncr) = song_of_album(s);
        rows.push(json!({
            "id": s["id"].as_i64().unwrap_or(0),
            "name": name, "ar": ar, "al": al, "alId": al_id, "dur": dur,
            "ncr": ncr == 1, "company": a["company"].as_str().unwrap_or(""),
            "pop": s["popularity"].as_i64().unwrap_or(0),
            "alia": s["alias"].as_array().map(|x| x.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join(" / ")).unwrap_or_default(),
            "mv": s["mvid"].as_i64().unwrap_or(0),
            "fee": s["fee"].as_i64().unwrap_or(0),
            "cover": song_cover(s),
        }));
    }
    Ok(json!({
        "id": id,
        "name": a["name"].as_str().unwrap_or(""),
        "artists": a["artists"].as_array().map(|x| x.iter().filter_map(|v| v["name"].as_str()).collect::<Vec<_>>().join(" / ")).unwrap_or_default(),
        "company": a["company"].as_str().unwrap_or(""),
        "publishTime": a["publishTime"].as_i64().unwrap_or(0),
        "cover": a["picUrl"].as_str().unwrap_or(""),
        "count": rows.len(),
        "rows": rows,
    }))
}

/* ---------------- 听歌排行 ---------------- */

pub async fn play_record(c: &Client, uid: i64, week: bool) -> Result<Value, String> {
    let r = c.weapi("/weapi/v1/play/record", json!({ "uid": uid, "type": if week { 1 } else { 0 } })).await?;
    let arr = if week { r["weekData"].as_array() } else { r["allData"].as_array() }.cloned().unwrap_or_default();
    let mut out = Vec::new();
    for (i, it) in arr.iter().enumerate() {
        let s = &it["song"];
        let (name, ar, al, al_id, dur, _ncr) = song_of_album(s);
        out.push(json!({
            "rank": i + 1,
            "playCount": it["playCount"].as_i64().unwrap_or(0),
            "name": name, "ar": ar, "al": al, "alId": al_id, "dur": dur,
        }));
    }
    Ok(json!({ "total": out.len(), "items": out }))
}
