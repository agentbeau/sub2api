fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

// Presentation-only cleanup. Provider API bodies and protocol values are not
// changed; this applies only to short messages rendered in the console.
fn display_text(text: &str) -> String {
    text.replace("CLI Proxy API Management Center", "Management console")
        .replace("CLI Proxy API", "gateway")
        .replace("CLIProxyAPI", "gateway")
        .replace("CPAMC", "console")
        .replace("CPA", "gateway")
        .replace("sub2api", "the gateway")
}

pub fn login_page(error: Option<&str>) -> String {
    let message = error
        .map(|error| format!("<p class=\"error\">{}</p>", escape_html(&display_text(error))))
        .unwrap_or_default();
    page(&format!(
        r#"<form method="post" action="/login">
  <h1>Sign in</h1>
  <p>Enter your dashboard password to continue.</p>
  {message}
  <input type="password" name="password" autocomplete="current-password" placeholder="Dashboard password" required autofocus>
  <button type="submit">Sign in</button>
</form>"#
    ))
}

pub fn message_page(title: &str, text: &str, failed: bool) -> String {
    let title = escape_html(&display_text(title));
    let text = escape_html(&display_text(text));
    let class = if failed { " class=\"error\"" } else { "" };
    page(&format!(
        r#"<form method="get" action="/management.html">
  <h1>{title}</h1>
  <p{class}>{text}</p>
  <button type="submit">Open the dashboard</button>
</form>"#
    ))
}

fn page(content: &str) -> String {
    include_str!("page.html").replace("{{content}}", content)
}

#[cfg(test)]
mod tests {
    use super::{login_page, message_page};

    #[test]
    fn escapes_provider_errors_before_showing_them_in_a_page() {
        let page = message_page("<script>", "bad & \"unsafe\" <img>", true);
        assert!(page.contains("&lt;script&gt;"));
        assert!(page.contains("bad &amp; &quot;unsafe&quot; &lt;img&gt;"));
        assert!(!page.contains("<script>"));
        assert!(page.contains("class=\"error\""));
        assert!(login_page(Some("<invalid>")).contains("&lt;invalid&gt;"));
    }

    #[test]
    fn login_and_callback_pages_have_no_product_branding() {
        for page in [
            login_page(None),
            message_page("CLIProxyAPI", "sub2api is saving this login.", false),
        ] {
            assert!(page.contains("<title>Console</title>"));
            assert!(!page.contains("sub2api"));
            assert!(!page.contains("CLIProxyAPI"));
            assert!(!page.contains("CPAMC"));
            assert!(!page.contains("github.com"));
        }
        assert!(login_page(None).contains("<h1>Sign in</h1>"));
    }
}
