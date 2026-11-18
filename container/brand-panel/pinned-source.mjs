export function pinnedPanel(version, sha256) {
  if (typeof version !== "string" || version.trim() === "" || version.trim().toLowerCase() === "latest"
    || version.trim() === "." || version.trim() === ".."
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(version.trim())) {
    throw new Error("PANEL_VERSION must be a specific dashboard release tag, never latest");
  }
  const digest = typeof sha256 === "string" ? sha256.trim().toLowerCase() : "";
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("PANEL_SHA256 must be the pinned dashboard source SHA-256 digest");
  return { version: version.trim(), sha256: digest };
}
