#!/usr/bin/env node
/**
 * YouTube Digest local Codex companion: a Chrome Native Messaging host.
 *
 * Chrome launches this process with a stdio pipe and speaks a versioned
 * JSON contract: every message is a UTF-8 JSON body prefixed with a 4-byte
 * little-endian length, per Chrome's native messaging framing.
 *
 * Today the companion answers `status` requests only. Authorization,
 * model catalogs, and completions arrive in later protocol additions;
 * every request type stays inside this envelope so Settings can detect
 * outdated companions through the version negotiation.
 */
"use strict";

const CONTRACT = Object.freeze({
  HOST_NAME: "com.youtube_digest.companion",
  PROTOCOL_VERSION: 1,
  SUPPORTED_PROTOCOL_VERSIONS: Object.freeze([1]),
  MAX_INBOUND_MESSAGE_BYTES: 4 * 1024 * 1024,
  // Chrome closes the port when a host message exceeds 1 MB; stay below it.
  MAX_OUTBOUND_MESSAGE_BYTES: 900 * 1024,
});

const COMPANION_VERSION = require("../package.json").version;

function encodeFrame(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

function errorResponse(error) {
  return { v: CONTRACT.PROTOCOL_VERSION, ok: false, error };
}

function handleRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    return errorResponse("invalid-request");
  }
  if (
    !Number.isInteger(request.v) ||
    !CONTRACT.SUPPORTED_PROTOCOL_VERSIONS.includes(request.v)
  ) {
    return {
      ...errorResponse("unsupported-protocol"),
      found: Number.isInteger(request.v) ? request.v : null,
    };
  }
  if (request.type === "status") {
    return {
      v: request.v,
      ok: true,
      type: "status",
      status: "ready",
      protocol: CONTRACT.PROTOCOL_VERSION,
      companionVersion: COMPANION_VERSION,
      capabilities: ["status"],
    };
  }
  return errorResponse("unknown-request-type");
}

function createFrameReader({ onMessage, onError }) {
  let buffer = Buffer.alloc(0);
  let failed = false;

  return {
    push(chunk) {
      if (failed || !chunk?.length) return;
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);
        if (length > CONTRACT.MAX_INBOUND_MESSAGE_BYTES) {
          failed = true;
          onError(
            new Error(
              `inbound message of ${length} bytes exceeds the ${CONTRACT.MAX_INBOUND_MESSAGE_BYTES} byte limit`,
            ),
          );
          return;
        }
        if (buffer.length < 4 + length) return;
        const payload = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        let message;
        try {
          message = JSON.parse(payload.toString("utf8"));
        } catch (_error) {
          failed = true;
          onError(new Error("inbound frame is not valid JSON"));
          return;
        }
        onMessage(message);
      }
    },
  };
}

function writeFrame(payload) {
  let body = Buffer.from(JSON.stringify(payload), "utf8");
  if (body.length > CONTRACT.MAX_OUTBOUND_MESSAGE_BYTES) {
    // Chrome silently drops oversized host messages, which would leave the
    // extension waiting for a reply. Answer with a typed error instead.
    process.stderr.write("outbound message exceeds the native messaging size limit; replying with an error\n");
    body = Buffer.from(
      JSON.stringify(errorResponse("response-too-large")),
      "utf8",
    );
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function main() {
  if (process.argv.includes("--version")) {
    process.stdout.write(
      `${JSON.stringify({
        companionVersion: COMPANION_VERSION,
        protocol: CONTRACT.PROTOCOL_VERSION,
        hostName: CONTRACT.HOST_NAME,
      })}\n`,
    );
    return;
  }

  const reader = createFrameReader({
    onMessage(message) {
      writeFrame(handleRequest(message));
    },
    onError(error) {
      process.stderr.write(`companion error: ${error.message}\n`);
      process.exit(1);
    },
  });

  process.stdin.on("data", (chunk) => reader.push(chunk));
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("error", () => process.exit(0));
  process.stdin.resume();
}

if (require.main === module) {
  main();
}

module.exports = {
  CONTRACT,
  COMPANION_VERSION,
  HOST_NAME: CONTRACT.HOST_NAME,
  PROTOCOL_VERSION: CONTRACT.PROTOCOL_VERSION,
  encodeFrame,
  createFrameReader,
  handleRequest,
  writeFrame,
  main,
};
