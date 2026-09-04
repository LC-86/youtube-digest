/**
 * macOS Keychain storage for the companion's OAuth credentials.
 *
 * The refresh credential is the only long-lived secret in the whole feature,
 * and it lives exclusively in the login Keychain as a generic password. The
 * extension never sees it, the companion's state file never contains it, and
 * a browser-data reset cannot remove it; only the Disconnect action does.
 *
 * The default runner shells out to the macOS `security` tool. Writes go
 * through `security -i`, so the secret travels on stdin and never appears in
 * the process argument list, where other local processes could read it via
 * ps. Tests inject a fake runner through the same interface, so no test
 * writes to the real login Keychain (the stdio integration check only
 * performs a read-only lookup that misses).
 */
"use strict";

const { execFile } = require("child_process");

const KEYCHAIN = Object.freeze({
  SERVICE: "com.youtube_digest.companion",
  ACCOUNT: "codex-account",
  RUN_TIMEOUT_MS: 5000,
  MAX_SECRET_BYTES: 64 * 1024,
  NAME_PATTERN: /^[A-Za-z0-9._-]+$/,
});

function execSecurity(args, { input, platform = process.platform } = {}) {
  if (platform !== "darwin") {
    return Promise.reject(new Error("keychain-unavailable: macOS only"));
  }
  return new Promise((resolve, reject) => {
    execFile(
      "security",
      args,
      { timeout: KEYCHAIN.RUN_TIMEOUT_MS, encoding: "utf8", input },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function isItemMissing(error) {
  return /could not be found/i.test(String(error?.message || ""));
}

// Quotes a value for `security -i`'s interactive command line, which parses
// double-quoted tokens with backslash escapes.
function quoteForSecurityCli(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function createKeychainStore({
  service = KEYCHAIN.SERVICE,
  account = KEYCHAIN.ACCOUNT,
  run = execSecurity,
} = {}) {
  if (!KEYCHAIN.NAME_PATTERN.test(service) || !KEYCHAIN.NAME_PATTERN.test(account)) {
    throw new Error("keychain-invalid-name");
  }

  async function save(secret) {
    if (typeof secret !== "string" || !secret) {
      throw new Error("keychain-invalid-secret");
    }
    if (Buffer.byteLength(secret, "utf8") > KEYCHAIN.MAX_SECRET_BYTES) {
      throw new Error("keychain-secret-too-large");
    }
    await run(["-i"], {
      input: `add-generic-password -U -s ${service} -a ${account} -w ${quoteForSecurityCli(secret)}\n`,
    });
    return true;
  }

  async function load() {
    try {
      const secret = await run([
        "find-generic-password",
        "-s",
        service,
        "-a",
        account,
        "-w",
      ]);
      return typeof secret === "string" && secret ? secret : null;
    } catch (error) {
      if (isItemMissing(error)) return null;
      throw error;
    }
  }

  async function remove() {
    try {
      await run(["delete-generic-password", "-s", service, "-a", account]);
      return true;
    } catch (error) {
      if (isItemMissing(error)) return false;
      throw error;
    }
  }

  return { service, account, save, load, remove };
}

module.exports = { KEYCHAIN, createKeychainStore, execSecurity, isItemMissing };
