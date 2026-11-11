fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

pub fn login_page(error: Option<&str>) -> String {
    let message = error
        .map(|error| format!("<p class=\"error\">{}</p>", escape_html(error)))
        .unwrap_or_default();
    page(&format!(
        r#"<form method="post" action="/login">
  <h1>sub2api</h1>
  <p>Sign in to open the CPA dashboard.</p>
  {message}
  <input type="password" name="password" autocomplete="current-password" placeholder="Dashboard password" required autofocus>
  <button type="submit">Sign in</button>
</form>"#
    ))
}

pub fn message_page(title: &str, text: &str, failed: bool) -> String {
    let title = escape_html(title);
    let text = escape_html(text);
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
}
