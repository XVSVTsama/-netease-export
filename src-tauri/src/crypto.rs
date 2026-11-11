use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyInit, KeyIvInit};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use num_bigint::BigUint;
use rand::RngCore;

const IV: &[u8] = b"0102030405060708";
const PRESET_KEY: &[u8] = b"0CoJUm6Qyw8W8jud";
const EAPI_KEY: &[u8] = b"e82ckenh8dichen8";
const PUBKEY_EXP: &str = "010001";
const MODULUS: &str = "00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7";

fn aes_cbc_b64(text: &str, key: &[u8]) -> String {
    let ct = cbc::Encryptor::<aes::Aes128>::new(key.into(), IV.into())
        .encrypt_padded_vec_mut::<Pkcs7>(text.as_bytes());
    B64.encode(ct)
}

fn rsa_enc_hex(secret: &str) -> String {
    let reversed: String = secret.chars().rev().collect();
    let hexed = hex::encode(reversed.as_bytes());
    let base = BigUint::parse_bytes(hexed.as_bytes(), 16).unwrap_or_default();
    let exp = BigUint::parse_bytes(PUBKEY_EXP.as_bytes(), 16).unwrap_or_default();
    let modulus = BigUint::parse_bytes(MODULUS.as_bytes(), 16).unwrap();
    let out = base.modpow(&exp, &modulus).to_str_radix(16);
    format!("{:0>256}", out)
}

/// 生成 weapi 的请求体：params + encSecKey
pub fn weapi_body(object: &serde_json::Value) -> Vec<(String, String)> {
    let text = object.to_string();
    let mut secret_raw = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut secret_raw);
    // 与网页端一致的 16 字符随机串（base64 字符集）
    let secret: String = secret_raw
        .iter()
        .map(|b| {
            const CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
            CHARS[(*b as usize) % CHARS.len()] as char
        })
        .collect();
    let params = aes_cbc_b64(&aes_cbc_b64(&text, PRESET_KEY), secret.as_bytes());
    vec![
        ("params".into(), params),
        ("encSecKey".into(), rsa_enc_hex(&secret)),
    ]
}

/// 生成 eapi 的 params（大写 hex）
pub fn eapi_params(path: &str, object: &serde_json::Value) -> String {
    let text = object.to_string();
    let digest = format!(
        "{:x}",
        md5::compute(format!("nobody{}use{}md5forencrypt", path, text))
    );
    let data = format!("{}-36cd479b6b5-{}-36cd479b6b5-{}", path, text, digest);
    let ct = ecb::Encryptor::<aes::Aes128>::new(EAPI_KEY.into())
        .encrypt_padded_vec_mut::<Pkcs7>(data.as_bytes());
    hex::encode_upper(ct)
}
