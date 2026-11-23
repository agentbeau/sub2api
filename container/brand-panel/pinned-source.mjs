export const PANEL_SOURCE_PIN = Object.freeze({
  version: "v1.28.1",
  sha256: "c00ac5577db8feb12d37de6ecb783cf919bb81536902308079f754337d7a7bc5",
});

export function pinnedPanel(version = PANEL_SOURCE_PIN.version, sha256 = PANEL_SOURCE_PIN.sha256) {
  if (typeof version !== "string" || version.trim() === "" || version.trim().toLowerCase() === "latest"
    || version.trim() === "." || version.trim() === ".."
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(version.trim())) {
    throw new Error("PANEL_VERSION must be a specific dashboard release tag, never latest");
  }
  const digest = typeof sha256 === "string" ? sha256.trim().toLowerCase() : "";
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("PANEL_SHA256 must be the pinned dashboard source SHA-256 digest");
  if (version.trim() !== PANEL_SOURCE_PIN.version || digest !== PANEL_SOURCE_PIN.sha256) {
    throw new Error("Dashboard inputs must match the reviewed source pin in pinned-source.mjs");
  }
  return { version: version.trim(), sha256: digest };
}
