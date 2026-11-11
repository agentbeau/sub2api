pub fn classify_path(pathname: &str) -> &'static str {
    let bytes = pathname.as_bytes();
    if pathname.contains('\\')
        || pathname.contains("//")
        || bytes.windows(3).any(|window| {
            window[0] == b'%'
                && matches!(
                    (
                        window[1].to_ascii_lowercase(),
                        window[2].to_ascii_lowercase()
                    ),
                    (b'2', b'f' | b'e') | (b'5', b'c')
                )
        })
    {
        return "blocked";
    }
    match pathname {
        "/" => "home",
        "/login" => "login",
        "/logout" => "logout",
        "/healthz" => "health",
        "/readyz" => "ready",
        "/callback" | "/auth/callback" | "/oauth-callback" => "oauth-callback",
        "/management.html" => "dashboard",
        path if path.starts_with("/v1/") || path.starts_with("/v1beta/") => "api",
        path if path.starts_with("/v0/management/") || path.starts_with("/v8/management/") => {
            "dashboard"
        }
        _ => "blocked",
    }
}

#[cfg(test)]
mod tests {
    use super::classify_path;

    #[test]
    fn classifies_only_the_supported_public_surfaces() {
        for (path, route) in [
            ("/", "home"),
            ("/login", "login"),
            ("/logout", "logout"),
            ("/healthz", "health"),
            ("/readyz", "ready"),
            ("/callback", "oauth-callback"),
            ("/auth/callback", "oauth-callback"),
            ("/oauth-callback", "oauth-callback"),
            ("/management.html", "dashboard"),
            ("/v0/management/config", "dashboard"),
            ("/v8/management/oauth/auth-url", "dashboard"),
            ("/v1/chat/completions", "api"),
            ("/v1beta/models", "api"),
        ] {
            assert_eq!(classify_path(path), route, "{path}");
        }
    }

    #[test]
    fn rejects_path_separator_attacks_and_prefix_lookalikes() {
        for path in [
            "/v1",
            "/v1beta",
            "/v0/management",
            "/v1evil/messages",
            "/management.html/extra",
            "/anthropic/callback",
            "/healthz/",
            "/robots.txt",
            "/v1/%2e%2e/v0/management/config",
            "/v1/..%2Fv0/management/config",
            "/v1/%5Cmessages",
            "/v1/\\messages",
            "/v1//messages",
            "//login",
        ] {
            assert_eq!(classify_path(path), "blocked", "{path}");
        }
    }
}
