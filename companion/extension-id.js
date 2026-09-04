#!/usr/bin/env node
/**
 * Derives Chrome's extension ID from the public key pinned in
 * manifest.json. YouTube Digest ships that key so the unpacked extension
 * keeps one stable identity regardless of where the folder lives, and the
 * native messaging host can trust exactly that identity.
 *
 * Chrome computes the ID as the first 128 bits of SHA-256 over the DER
 * public key, rendered as 32 hex digits and mapped 0-9a-f -> a-p.
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function deriveExtensionId(manifestKey) {
  if (typeof manifestKey !== "string" || manifestKey.length === 0) return null;
  const der = Buffer.from(manifestKey, "base64");
  // A DER SubjectPublicKeyInfo blob is far larger; anything tiny means the
  // key field is malformed rather than a real identity.
  if (der.length < 64) return null;
  const hex = crypto.createHash("sha256").update(der).digest("hex").slice(0, 32);
  const id = [...hex].map((digit) => "abcdefghijklmnop"[parseInt(digit, 16)]).join("");
  return /^[a-p]{32}$/.test(id) ? id : null;
}

function deriveFromManifestFile(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  return deriveExtensionId(manifest.key);
}

if (require.main === module) {
  const manifestPath =
    process.argv[2] || path.join(__dirname, "..", "manifest.json");
  const id = deriveFromManifestFile(manifestPath);
  if (!id) {
    process.stderr.write(
      "Could not derive a stable extension ID from manifest.json (missing or invalid key).\n",
    );
    process.exit(1);
  }
  process.stdout.write(id);
}

module.exports = { deriveExtensionId, deriveFromManifestFile };
