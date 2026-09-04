#!/usr/bin/env bash
#
# Installs the YouTube Digest local Codex companion for this Mac's default
# Chrome profile. Chrome Native Messaging is the only connection: the
# installer registers a host manifest that accepts exactly YouTube Digest's
# stable extension identity, writes a launcher next to the companion, and
# never asks for or stores any API key, token, or password.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
host_name="com.youtube_digest.companion"
template_path="$script_dir/host-manifest.template.json"
launcher_dir="$script_dir/bin"
launcher_path="$launcher_dir/$host_name"
manifest_dir="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
manifest_path="$manifest_dir/$host_name.json"

log() {
  printf '%s\n' "$*" >&2
}

fail() {
  printf 'Companion install failed: %s\n' "$*" >&2
  exit 1
}

[[ "$(uname -s)" == "Darwin" ]] || fail "the companion currently supports macOS only"
command -v node >/dev/null 2>&1 || fail "Node.js is required (install it from https://nodejs.org, then retry)"
node_bin="$(command -v node)"
node_bin="$(cd "$(dirname "$node_bin")" && pwd)/$(basename "$node_bin")"
[[ -x "$node_bin" ]] || fail "could not resolve the Node.js executable"

# Derive the stable extension identity from this checkout and verify it
# matches the identity the host manifest template accepts. A mismatch means
# manifest.json's key changed without updating the template, and the host
# would silently refuse to serve the extension.
extension_id="$("$node_bin" "$script_dir/extension-id.js")" || fail "could not derive the extension identity from manifest.json"
[[ "$extension_id" =~ ^[a-p]{32}$ ]] || fail "unexpected extension identity: $extension_id"
expected_origin="chrome-extension://$extension_id/"
grep -q "\"$expected_origin\"" "$template_path" || fail "the host manifest template does not accept this checkout's extension identity; update companion/host-manifest.template.json"

"$node_bin" "$script_dir/host.js" --version >/dev/null || fail "the companion host failed to start; check your Node.js installation"

mkdir -p "$launcher_dir"
printf '#!/bin/sh\nexec "%s" "%s/companion/host.js" "$@"\n' "$node_bin" "$repo_root" > "$launcher_path"
chmod 755 "$launcher_path"

mkdir -p "$manifest_dir"
"$node_bin" - "$template_path" "$launcher_path" "$manifest_path" <<'NODE'
const fs = require("fs");
const [templatePath, launcherPath, manifestPath] = process.argv.slice(2);
const template = fs.readFileSync(templatePath, "utf8");
const manifest = template.replace(
  "__COMPANION_LAUNCHER__",
  JSON.stringify(launcherPath).slice(1, -1),
);
JSON.parse(manifest);
fs.writeFileSync(manifestPath, manifest);
NODE

log "Installed the YouTube Digest companion for Chrome."
log "  Host manifest: $manifest_path"
log "  Launcher:      $launcher_path"
log "Next steps:"
log "  1. Reload the unpacked YouTube Digest extension at chrome://extensions."
log "  2. Open YouTube Digest Settings and confirm the ChatGPT / Codex companion shows Ready."
