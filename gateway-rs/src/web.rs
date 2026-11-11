use js_sys::{Function, Number, Promise, Reflect, Uint8Array};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::{JsFuture, future_to_promise};
use web_sys::{
    Headers, ReadableStreamDefaultReader, Request, RequestInit, Response, ResponseInit, Url,
    UrlSearchParams,
};

use crate::pages::{login_page, message_page};
use crate::policy::classify_path;
use crate::session::{
    SESSION_COOKIE, SESSION_SECONDS, issue_session, password_matches, read_cookie, session_is_valid,
};

const MIN_PASSWORD_LENGTH: usize = 16;
const MAX_LOGIN_BODY: usize = 4096;
const PASSWORD_NOT_SET: &str =
    "Sign-in is off: set the DASHBOARD_PASSWORD secret to at least 16 characters.";
const NO_CLIENT_KEYS: &str = "No API key is set up yet: add one under API Keys in the dashboard.";
const CPA_UNAVAILABLE: &str = "The gateway is starting or unavailable. Try again shortly.";
const TOO_MANY_ATTEMPTS: &str = "Too many sign-in attempts. Wait a minute and try again.";

#[wasm_bindgen]
pub fn classify(pathname: &str) -> String {
    classify_path(pathname).to_owned()
}

#[wasm_bindgen(js_name = minPasswordLength)]
pub fn min_password_length() -> usize {
    MIN_PASSWORD_LENGTH
}

#[wasm_bindgen(js_name = handleGateway, unchecked_return_type = "Promise<Response>")]
pub fn handle_gateway(
    request: Request,
    password: String,
    now_seconds: Function,
    forward: Function,
    key_state: Function,
    forget_keys: Function,
    limit_login: Function,
) -> Promise {
    let gateway = Gateway {
        password,
        now_seconds,
        forward,
        key_state,
        forget_keys,
        limit_login,
    };
    match dispatch(request, gateway) {
        Ok(response) => response,
        Err(error) => Promise::reject(&error),
    }
}

fn dispatch(request: Request, gateway: Gateway) -> Result<Promise, JsValue> {
    let url = Url::new(&request.url())?;
    match classify_path(&url.pathname()) {
        "api" => gateway.api(request, &url),
        "health" => resolved(response(
            Some(r#"{"status":"ok"}"#),
            200,
            &[
                ("content-type", "application/json"),
                ("cache-control", "no-store"),
            ],
        )),
        "ready" => {
            url.set_pathname("/healthz");
            let target = Request::new_with_str_and_init(&url.href(), request.unchecked_ref())?;
            gateway.forward_native(&without_cookies(&target)?)
        }
        "oauth-callback" => Ok(future_to_promise(async move {
            gateway
                .oauth_callback(&request, &url)
                .await
                .map(JsValue::from)
        })),
        "home" => resolved(redirect(
            if gateway.signed_in(&request)? {
                "/management.html"
            } else {
                "/login"
            },
            None,
        )),
        "login" => match request.method().as_str() {
            "POST" => Ok(future_to_promise(async move {
                gateway.login(&request).await.map(JsValue::from)
            })),
            "GET" => resolved(html(
                &login_page(if gateway.password_configured() {
                    None
                } else {
                    Some(PASSWORD_NOT_SET)
                }),
                200,
            )),
            _ => resolved(not_found()),
        },
        "logout" => resolved(redirect(
            "/login",
            Some(&format!(
                "{SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0"
            )),
        )),
        "dashboard" => {
            if gateway.signed_in(&request)? {
                if matches!(request.method().as_str(), "GET" | "HEAD") {
                    return gateway.forward_native(&without_cookies(&request)?);
                }
                return Ok(future_to_promise(async move {
                    gateway.dashboard(&request).await.map(JsValue::from)
                }));
            }
            if request.method() == "GET" && url.pathname() == "/management.html" {
                return resolved(redirect("/login", None));
            }
            resolved(response(
                Some(r#"{"error":"sign in at /login first"}"#),
                401,
                &[("content-type", "application/json")],
            ))
        }
        _ => resolved(not_found()),
    }
}

fn resolved(response: Result<Response, JsValue>) -> Result<Promise, JsValue> {
    response.map(|response| Promise::resolve(&JsValue::from(response)))
}

struct Gateway {
    password: String,
    now_seconds: Function,
    forward: Function,
    key_state: Function,
    forget_keys: Function,
    limit_login: Function,
}

impl Gateway {
    fn now_seconds(&self) -> Result<f64, JsValue> {
        self.now_seconds
            .call0(&JsValue::UNDEFINED)?
            .as_f64()
            .ok_or_else(|| JsValue::from_str("nowSeconds must return a number"))
    }

    fn password_configured(&self) -> bool {
        // JavaScript's existing policy counts UTF-16 code units, not UTF-8 bytes.
        self.password.encode_utf16().count() >= MIN_PASSWORD_LENGTH
    }

    fn signed_in(&self, request: &Request) -> Result<bool, JsValue> {
        if !self.password_configured() {
            return Ok(false);
        }
        let cookie = request.headers().get("cookie")?;
        let Some(token) = read_cookie(cookie.as_deref(), SESSION_COOKIE) else {
            return Ok(false);
        };
        Ok(session_is_valid(&self.password, token, self.now_seconds()?))
    }

    fn forward_native(&self, request: &Request) -> Result<Promise, JsValue> {
        // Keep the platform Response itself: rewrapping can lose a WebSocket,
        // and reading an API body here would break streaming/backpressure.
        let value = self.forward.call1(&JsValue::UNDEFINED, request.as_ref())?;
        Ok(Promise::resolve(&value))
    }

    async fn forward(&self, request: &Request) -> Result<Response, JsValue> {
        Ok(JsFuture::from(self.forward_native(request)?)
            .await?
            .unchecked_into())
    }

    fn api(self, request: Request, url: &Url) -> Result<Promise, JsValue> {
        let value = self
            .key_state
            .call1(&JsValue::UNDEFINED, &JsValue::from_str(&url.origin()))?;
        // Resolve the native forwarding promise directly after the key guard.
        // No Rust future remains attached to the provider's response stream.
        Ok(future_to_promise(async move {
            let state = JsFuture::from(Promise::resolve(&value)).await?;
            match state.as_string().as_deref() {
                Some("required") => self.forward_native(&without_cookies(&request)?),
                Some("open") => resolved(api_error(401, "authentication_error", NO_CLIENT_KEYS)),
                _ => resolved(api_error(503, "api_error", CPA_UNAVAILABLE)),
            }
            .map(JsValue::from)
        }))
    }

    async fn dashboard(&self, request: &Request) -> Result<Response, JsValue> {
        let writes = !matches!(request.method().as_str(), "GET" | "HEAD");
        if writes {
            self.forget_keys.call0(&JsValue::UNDEFINED)?;
        }
        let response = self.forward(&without_cookies(request)?).await;
        if writes {
            self.forget_keys.call0(&JsValue::UNDEFINED)?;
        }
        response
    }

    async fn oauth_callback(&self, request: &Request, url: &Url) -> Result<Response, JsValue> {
        if request.method() != "GET" {
            return not_found();
        }
        if !self.signed_in(request)? {
            return html(
                &message_page(
                    "Sign in first",
                    "Sign in to the dashboard, then open this address again.",
                    true,
                ),
                401,
            );
        }
        let target = Url::new_with_base(
            &format!("/v0/management/oauth-callback{}", url.search()),
            &url.href(),
        )?;
        let response = self
            .forward(&Request::new_with_str(&target.href())?)
            .await?;
        if response.ok() {
            return html(
                &message_page(
                    "Login received",
                    "CPA is saving this login. Go back to the dashboard to see it.",
                    false,
                ),
                200,
            );
        }
        let reason = match response.json() {
            Ok(json) => JsFuture::from(json)
                .await
                .ok()
                .filter(JsValue::is_object)
                .and_then(|value| Reflect::get(&value, &JsValue::from_str("error")).ok())
                .and_then(|value| value.as_string()),
            Err(_) => None,
        }
        .unwrap_or_else(|| format!("CPA answered {}", response.status()));
        html(
            &message_page(
                "Login not saved",
                &format!("{reason}. Start the login again from the dashboard."),
                true,
            ),
            response.status(),
        )
    }

    async fn login(&self, request: &Request) -> Result<Response, JsValue> {
        if !self.password_configured() {
            return html(&login_page(Some(PASSWORD_NOT_SET)), 503);
        }
        let length = request
            .headers()
            .get("content-length")?
            .unwrap_or_else(|| "0".into())
            .parse::<Number>()
            .expect("JavaScript Number conversion is infallible")
            .value_of();
        if !length.is_finite() || length > MAX_LOGIN_BODY as f64 {
            return html(&login_page(Some("Request too large.")), 413);
        }
        let client = request
            .headers()
            .get("cf-connecting-ip")?
            .unwrap_or_else(|| "unknown".into());
        let value = self
            .limit_login
            .call1(&JsValue::UNDEFINED, &JsValue::from_str(&client))?;
        if JsFuture::from(Promise::resolve(&value)).await?.as_bool() != Some(true) {
            return html(&login_page(Some(TOO_MANY_ATTEMPTS)), 429);
        }
        let form = read_small_form(request).await.ok().flatten();
        let password = form.and_then(|form| form.get("password"));
        if !password.is_some_and(|password| password_matches(&password, &self.password)) {
            return html(&login_page(Some("Wrong password.")), 401);
        }
        let token = issue_session(&self.password, self.now_seconds()?);
        redirect(
            "/management.html",
            Some(&format!(
                "{SESSION_COOKIE}={token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age={SESSION_SECONDS}"
            )),
        )
    }
}

async fn read_small_form(request: &Request) -> Result<Option<UrlSearchParams>, JsValue> {
    let Some(body) = request.body() else {
        return Ok(Some(UrlSearchParams::new()?));
    };
    let reader: ReadableStreamDefaultReader = body.get_reader().unchecked_into();
    let bytes = read_login_bytes(&reader).await;
    reader.release_lock();
    let Some(bytes) = bytes? else {
        return Ok(None);
    };
    // Match TextDecoder's UTF-8 replacement and initial BOM handling from the
    // existing JavaScript form reader. Only this <=4096-byte form enters Wasm.
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    let text = String::from_utf8_lossy(bytes);
    Ok(Some(UrlSearchParams::new_with_str(&text)?))
}

async fn read_login_bytes(
    reader: &ReadableStreamDefaultReader,
) -> Result<Option<Vec<u8>>, JsValue> {
    let mut bytes = Vec::new();
    loop {
        let result = JsFuture::from(reader.read()).await?;
        if Reflect::get(&result, &JsValue::from_str("done"))?.as_bool() == Some(true) {
            break;
        }
        let value = Reflect::get(&result, &JsValue::from_str("value"))?;
        let chunk: Uint8Array = value.dyn_into()?;
        let length = chunk.length() as usize;
        // Check before copying: even one oversized chunk cannot allocate an
        // unbounded Wasm buffer, regardless of the claimed Content-Length.
        if length > MAX_LOGIN_BODY - bytes.len() {
            let _ = JsFuture::from(reader.cancel()).await;
            return Ok(None);
        }
        let offset = bytes.len();
        bytes.resize(offset + length, 0);
        chunk.copy_to(&mut bytes[offset..]);
    }
    Ok(Some(bytes))
}

fn without_cookies(request: &Request) -> Result<Request, JsValue> {
    let headers = Headers::new_with_headers(&request.headers())?;
    headers.delete("cookie")?;
    let init = RequestInit::new();
    init.set_headers_headers(&headers);
    Request::new_with_request_and_init(request, &init)
}

fn response(
    body: Option<&str>,
    status: u16,
    headers: &[(&str, &str)],
) -> Result<Response, JsValue> {
    let init = ResponseInit::new();
    init.set_status(status);
    let result_headers = Headers::new()?;
    for (name, value) in headers {
        result_headers.set(name, value)?;
    }
    init.set_headers_headers(&result_headers);
    Response::new_with_opt_str_and_init(body, &init)
}

fn redirect(location: &str, cookie: Option<&str>) -> Result<Response, JsValue> {
    let response = response(
        None,
        303,
        &[("location", location), ("cache-control", "no-store")],
    )?;
    if let Some(cookie) = cookie {
        response.headers().set("set-cookie", cookie)?;
    }
    Ok(response)
}

fn not_found() -> Result<Response, JsValue> {
    response(
        Some("Not found\n"),
        404,
        &[("content-type", "text/plain; charset=utf-8")],
    )
}

fn html(body: &str, status: u16) -> Result<Response, JsValue> {
    response(
        Some(body),
        status,
        &[
            ("content-type", "text/html; charset=utf-8"),
            ("cache-control", "no-store"),
            (
                "content-security-policy",
                "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
            ),
            ("x-frame-options", "DENY"),
        ],
    )
}

fn api_error(status: u16, error_type: &str, message: &str) -> Result<Response, JsValue> {
    // Both arguments are static gateway policy strings, never provider input.
    response(
        Some(&format!(
            r#"{{"error":{{"type":"{error_type}","message":"{message}"}}}}"#
        )),
        status,
        &[
            ("content-type", "application/json"),
            ("cache-control", "no-store"),
        ],
    )
}
