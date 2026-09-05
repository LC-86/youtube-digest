# ChatGPT / Codex companion release acceptance record

- Issue: LC-86/youtube-digest#7 (parent #1; this record gates closing #1)
- Scope: release readiness of the local ChatGPT / Codex connection: companion installation, authorization, model selection, AI actions, DeepSeek fallback, and disconnect.
- Record opened: 2026-09-04
- Record completed: 2026-09-05
- Machine: macOS arm64 (darwin 25.5.0), Node.js v24.19.0

## Automated verification

Completed on 2026-09-04 on a development Mac. The installer smoke test used an isolated `$HOME` and a non-existent Keychain service name, so it never touched the real Chrome profile, the real Keychain entry, or any ChatGPT account.

| Check | How | Result |
| --- | --- | --- |
| Unit and contract tests | `npm test` | Pass, 173 tests, 0 failures |
| Release allowlist, manifest reference validation, syntax, credential scan (API keys, OAuth authorization URLs and codes, JWT, bearer, and session token shapes) | `npm run check` | Pass |
| Extension ZIP build | `npm run package` | Pass, `dist/youtube-digest-v1.2.0.zip` |
| Companion installer smoke test | `bash companion/install.sh` with isolated `$HOME` | Pass, evidence below |
| Native-messaging handshake without Chrome | framed `status` and `disconnect` requests piped to the installed launcher | Pass, evidence below |

### Installer smoke test evidence

- `install.sh` ran with `HOME` pointed at a temporary directory; afterwards the sandbox and the generated launcher were deleted.
- The host manifest was written to `<sandbox>/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.youtube_digest.companion.json` with `type: stdio`, `name: com.youtube_digest.companion`, exactly one `allowed_origins` entry equal to `chrome-extension://<stable id>/` derived from this checkout's `manifest.json` key, and `path` pointing at the generated launcher.
- The launcher `companion/bin/com.youtube_digest.companion` was created executable and started successfully.
- The handshake requests below ran with `YTD_COMPANION_KEYCHAIN_SERVICE=ytd.acceptance.smoke` (a Keychain service that does not exist) and `YTD_COMPANION_STATE_DIR` inside the sandbox, so no real Keychain entry or state file was read or written.

### Native-messaging handshake evidence

- A framed `{"v":1,"type":"status"}` request piped to the launcher replied `ok: true`, `status: "ready"`, `protocol: 1`, all four capabilities (`status`, `auth`, `models`, `completions`), `auth.phase: "signed-out"`, and no account label.
- A framed `{"v":1,"type":"disconnect"}` request replied `ok: true` with `phase: "signed-out"`.
- Neither request involved a browser, an account, or a stored credential. The real Chrome profile of the development Mac had no `com.youtube_digest.companion.json` at record time, so the real-profile steps below are still outstanding.

## Manual acceptance checklist (requires a real ChatGPT account)

These steps need the user's real ChatGPT account, this Mac's Chrome, and a real YouTube video. They are deliberately manual: no automated step may hold real account credentials. Work through them in order and record the date and outcome below. Parent issue #1 stays open until every row is Pass.

- [x] Helper installation in the real Chrome profile: run `bash companion/install.sh`, reload the unpacked extension at `chrome://extensions`, reopen YouTube Digest Settings, and confirm the companion card shows Ready.
- [x] Real ChatGPT login: choose Sign in with ChatGPT, approve in the browser, and confirm Settings shows Connected with a masked account label.
- [x] Model selection: choose Get models, pick one Codex model, and Save settings.
- [x] Real-video Digest: open a captioned YouTube video and generate the overview through the selected model.
- [x] One remaining AI action: explain selected transcript text (or translate a section) through ChatGPT / Codex.
- [x] DeepSeek regression: switch the AI provider back to DeepSeek and generate an overview again with the existing API key.
- [x] Disconnect: choose Disconnect in Settings, confirm the card returns to not signed in, and optionally confirm `security find-generic-password -s com.youtube_digest.companion` reports the item could not be found.

## Result log

| Step | Date | Result | Notes |
| --- | --- | --- | --- |
| Automated checks (table above) | 2026-09-04 | Pass | see Automated verification |
| Helper installation (real Chrome profile) | 2026-09-05 | Pass | user manual acceptance |
| Real ChatGPT login | 2026-09-05 | Pass | user manual acceptance |
| Model selection | 2026-09-05 | Pass | user manual acceptance; live GPT-5.6 catalog |
| Real-video Digest | 2026-09-05 | Pass | user manual acceptance |
| Remaining AI action | 2026-09-05 | Pass | user manual acceptance |
| DeepSeek regression | 2026-09-05 | Pass | user manual acceptance |
| Disconnect | 2026-09-05 | Pass | user manual acceptance |

The manual rows record the user's own run on this Mac on 2026-09-05, reported as passed in full; the user confirmed the connection works for daily use. Defects found along the way — proxy-aware outbound (b83c2be), Keychain argv writes (3e4b52a), live model catalog (f44377a), dedicated models timeout (c7dc4b2), and save-order fix (d595c57) — are fixed and pushed to main.

## Boundaries this record certifies

- Packaging and logs stay clean: `scripts/check-release.sh` enforces the extension ZIP allowlist and scans publishable repository files for API keys, OAuth authorization URLs, authorization codes, JWT, bearer, and session token shapes; companion tests assert OAuth values are redacted before they can reach stderr, the state file, or extension replies, and that transcript and prompt content stays out of logs, the state file, and extension replies even when a failing provider echoes request content in its error body.
- Documentation makes no false claims: the READMEs state that a ChatGPT subscription is not an OpenAI API credential and that the companion's model catalog does not guarantee per-account entitlement.
- Data flow stays local-to-provider: transcripts and prompts for ChatGPT / Codex features travel from the extension to the companion over Chrome Native Messaging and then directly from this Mac to OpenAI, with no YouTube Digest server, proxy, or database in between (see PRIVACY.md and SECURITY.md).
