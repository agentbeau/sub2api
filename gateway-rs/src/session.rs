use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

pub const SESSION_COOKIE: &str = "__Host-gateway_session";
pub const SESSION_SECONDS: u64 = 12 * 60 * 60;

fn session_mac(password: &str) -> Hmac<Sha256> {
    let mut material = Sha256::new();
    material.update(b"sub2api session v1\0");
    material.update(password.as_bytes());
    Hmac::<Sha256>::new_from_slice(&material.finalize()).expect("SHA-256 produces a valid HMAC key")
}

pub fn issue_session(password: &str, now_seconds: f64) -> String {
    let expires = (now_seconds + SESSION_SECONDS as f64).to_string();
    let mut mac = session_mac(password);
    mac.update(expires.as_bytes());
    format!(
        "{expires}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    )
}

pub fn session_is_valid(password: &str, token: &str, now_seconds: f64) -> bool {
    let Some((expires, signature)) = token.split_once('.') else {
        return false;
    };
    if expires.is_empty()
        || expires.len() > 12
        || !expires.bytes().all(|byte| byte.is_ascii_digit())
    {
        return false;
    }
    let Ok(expiry) = expires.parse::<u64>() else {
        return false;
    };
    if !now_seconds.is_finite() || expiry as f64 <= now_seconds {
        return false;
    }
    let Ok(signature) = URL_SAFE_NO_PAD.decode(signature) else {
        return false;
    };
    let mut mac = session_mac(password);
    mac.update(expires.as_bytes());
    mac.verify_slice(&signature).is_ok()
}

pub fn password_matches(given: &str, expected: &str) -> bool {
    let left = Sha256::digest(given.as_bytes());
    let right = Sha256::digest(expected.as_bytes());
    bool::from(left.ct_eq(&right)) && !expected.is_empty()
}

pub fn read_cookie<'a>(header: Option<&'a str>, name: &str) -> Option<&'a str> {
    for part in header?.split(';') {
        let (key, value) = part.trim().split_once('=').unwrap_or((part.trim(), ""));
        if key == name {
            return Some(value);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{issue_session, password_matches, read_cookie, session_is_valid};

    const PASSWORD: &str = "correct-horse-battery-staple-0123456789";
    const NOW: f64 = 1_800_000_000.0;
    // Fixtures produced by the existing worker/src/session.ts WebCrypto implementation.
    const LEGACY_TOKEN: &str = "1800043200.0TqCH41AptKO4Y7NWwVEFmwDPU6bw2B4fhDNr6t_A5k";

    #[test]
    fn issues_byte_identical_legacy_webcrypto_sessions() {
        assert_eq!(issue_session(PASSWORD, NOW), LEGACY_TOKEN);
        assert_eq!(
            issue_session("pässword🔒-0123456789", NOW),
            "1800043200.DK47ykKeYRsCG4YRuD0WH78mpYpx_mtUyM374qkIgS8"
        );
    }

    #[test]
    fn accepts_legacy_cookies_only_before_their_expiry() {
        assert!(session_is_valid(PASSWORD, LEGACY_TOKEN, NOW));
        assert!(session_is_valid(PASSWORD, LEGACY_TOKEN, 1_800_043_199.0));
        assert!(!session_is_valid(PASSWORD, LEGACY_TOKEN, 1_800_043_200.0));
    }

    #[test]
    fn rejects_tampering_wrong_passwords_and_malformed_tokens() {
        assert!(!session_is_valid("another-password", LEGACY_TOKEN, NOW));
        for token in [
            "garbage",
            ".",
            "1800043200.",
            "1800043200.0TqCH41AptKO4Y7NWwVEFmwDPU6bw2B4fhDNr6t_A5k.extra",
            "1800043201.0TqCH41AptKO4Y7NWwVEFmwDPU6bw2B4fhDNr6t_A5k",
            "1800043200.1TqCH41AptKO4Y7NWwVEFmwDPU6bw2B4fhDNr6t_A5k",
            "1800043200.a",
            "1800043200.💥",
            "1e12.invalid",
            "1000000000000.invalid",
        ] {
            assert!(!session_is_valid(PASSWORD, token, NOW), "{token}");
        }
    }

    #[test]
    fn compares_passwords_exactly_and_refuses_an_empty_secret() {
        assert!(password_matches(PASSWORD, PASSWORD));
        assert!(!password_matches("wrong", PASSWORD));
        assert!(!password_matches("", ""));
        assert!(!password_matches("pässword", "password"));
    }

    #[test]
    fn reads_the_first_exact_cookie_name_without_losing_equals() {
        assert_eq!(read_cookie(Some("a=1; b=two=2; c=3"), "b"), Some("two=2"));
        assert_eq!(read_cookie(Some("b=first; b=second"), "b"), Some("first"));
        assert_eq!(read_cookie(Some("ab=wrong; b=right"), "b"), Some("right"));
        assert_eq!(read_cookie(Some("a=1"), "b"), None);
        assert_eq!(read_cookie(None, "b"), None);
    }
}
