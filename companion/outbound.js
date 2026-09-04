/**
 * Proxy-aware outbound HTTP for the companion's OpenAI traffic.
 *
 * Node's global fetch ignores the macOS system proxy, so a machine whose
 * browser reaches OpenAI through a local proxy still sends the companion's
 * token and completion requests directly, and OpenAI's edge rejects them by
 * region. This module resolves the proxy once (YTD_COMPANION_PROXY, then
 * HTTPS_PROXY/https_proxy, then the macOS system proxy) and routes requests
 * through an HTTP CONNECT tunnel when one exists. Without a proxy it defers
 * to the native fetch unchanged, so only proxied machines take the tunnel.
 *
 * Only HTTP CONNECT proxies are supported. A PAC-configured system proxy is
 * not resolved; set YTD_COMPANION_PROXY explicitly in that case.
 */
"use strict";

const http = require("http");
const https = require("https");
const tls = require("tls");
const { execFile } = require("child_process");

const OUTBOUND = Object.freeze({
  SCUTIL_TIMEOUT_MS: 5000,
  CONNECT_TIMEOUT_MS: 10_000,
});

// Parses `scutil --proxy` output. Only a manual HTTPS (fallback HTTP) proxy
// is used; PAC and SOCKS entries are not resolved here.
function parseScutilProxy(text) {
  const values = {};
  for (const line of String(text || "").split("\n")) {
    const match = line.match(/^\s*([A-Za-z]+)\s*:\s*(.+?)\s*$/);
    if (match) values[match[1]] = match[2];
  }
  const manual = (enabled, host, port) =>
    values[enabled] === "1" &&
    typeof values[host] === "string" &&
    /^\d+$/.test(values[port] || "")
      ? { host: values[host], port: Number(values[port]) }
      : null;
  return (
    manual("HTTPSEnable", "HTTPSProxy", "HTTPSPort") ||
    manual("HTTPEnable", "HTTPProxy", "HTTPPort")
  );
}

// Accepts "http://host:port", "https://host:port", or "host:port".
// "direct", "off", and "none" force the native fetch path. Anything else
// (including socks URLs, which this module cannot tunnel) is ignored so the
// next precedence level applies.
function parseProxyValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return undefined;
  if (/^(direct|off|none)$/i.test(raw)) return null;
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch (_error) {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (!url.hostname || !url.port) return undefined;
  return { host: url.hostname, port: Number(url.port) };
}

// Precedence: YTD_COMPANION_PROXY, HTTPS_PROXY/https_proxy, macOS system
// proxy. `null` (direct) and `undefined` (not specified) stay distinct so an
// explicit "direct" can override an inherited system proxy.
async function resolveProxy({
  env = process.env,
  platform = process.platform,
  readSystemProxy = createSystemProxyReader(),
} = {}) {
  const explicit = parseProxyValue(env.YTD_COMPANION_PROXY);
  if (explicit !== undefined) return explicit;

  const fromEnv = parseProxyValue(env.HTTPS_PROXY ?? env.https_proxy);
  if (fromEnv !== undefined) return fromEnv;

  if (platform !== "darwin") return null;
  try {
    return (await readSystemProxy()) ?? null;
  } catch (_error) {
    return null;
  }
}

function createSystemProxyReader({ execFileImpl = execFile } = {}) {
  return () =>
    new Promise((resolve, reject) => {
      execFileImpl(
        "scutil",
        ["--proxy"],
        { timeout: OUTBOUND.SCUTIL_TIMEOUT_MS, encoding: "utf8" },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(parseScutilProxy(stdout));
        },
      );
    });
}

function abortErrorFrom(signal) {
  const error = new Error("The operation was aborted");
  error.name = signal?.reason?.name || "AbortError";
  return error;
}

function readStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.once("error", reject);
  });
}

// Minimal fetch-like view over a Node response: the companion's callers use
// ok/status/headers.get/text/json only (the completions reader falls back to
// text() when no streaming body is exposed).
function shimResponse(response) {
  return {
    ok: response.statusCode >= 200 && response.statusCode < 300,
    status: response.statusCode,
    headers: {
      get: (name) => response.headers[String(name).toLowerCase()] ?? null,
    },
    async text() {
      return readStream(response);
    },
    async json() {
      return JSON.parse(await readStream(response));
    },
  };
}

function requestThroughProxy({ proxy, target, init, tlsImpl }) {
  return new Promise((resolve, reject) => {
    const signal = init.signal;
    if (signal?.aborted) {
      reject(abortErrorFrom(signal));
      return;
    }

    const isHttps = target.protocol === "https:";
    const targetPort = Number(target.port) || (isHttps ? 443 : 80);
    const authority = `${target.hostname}:${targetPort}`;

    const connectRequest = http.request({
      host: proxy.host,
      port: proxy.port,
      method: "CONNECT",
      path: authority,
      headers: { host: authority },
    });
    connectRequest.setTimeout(OUTBOUND.CONNECT_TIMEOUT_MS, () => {
      connectRequest.destroy(new Error("proxy-connect-timeout"));
    });

    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    connectRequest.once("error", fail);
    connectRequest.once("connect", (connectResponse, socket) => {
      if (connectResponse.statusCode !== 200) {
        socket.destroy();
        fail(new Error(`proxy-refused-connection: http ${connectResponse.statusCode}`));
        return;
      }

      let wire = socket;
      if (isHttps) {
        wire = tlsImpl.connect({ socket, servername: target.hostname });
      }

      const request = (isHttps ? https : http).request({
        createConnection: () => wire,
        host: target.hostname,
        port: targetPort,
        method: init.method || "GET",
        path: `${target.pathname}${target.search}`,
        headers: { ...init.headers },
      });

      const onAbort = () => {
        request.destroy();
        wire.destroy();
        fail(abortErrorFrom(signal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      request.once("response", (response) => {
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve(shimResponse(response));
      });
      request.once("error", (error) => {
        signal?.removeEventListener("abort", onAbort);
        wire.destroy();
        fail(error);
      });

      if (init.body !== undefined && init.body !== null) {
        request.write(
          typeof init.body === "string" ||
            Buffer.isBuffer(init.body) ||
            init.body instanceof Uint8Array
            ? init.body
            : String(init.body),
        );
      }
      request.end();
    });

    connectRequest.end();
  });
}

// Returns a fetch-compatible function. `proxyAware` marks the wiring so
// tests can pin that the host and auth worker use it by default.
function createProxyFetch({
  resolveProxyImpl = resolveProxy,
  tlsImpl = tls,
} = {}) {
  let proxyPromise;
  const ensureProxy = () => {
    if (!proxyPromise) {
      proxyPromise = Promise.resolve()
        .then(() => resolveProxyImpl())
        .catch(() => null);
    }
    return proxyPromise;
  };

  async function proxyFetch(url, init = {}) {
    const target = new URL(url);
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      throw new TypeError("outbound fetch supports http and https URLs only");
    }
    const proxy = await ensureProxy();
    if (!proxy) return fetch(url, init);
    return requestThroughProxy({ proxy, target, init, tlsImpl });
  }

  proxyFetch.proxyAware = true;
  return proxyFetch;
}

module.exports = {
  OUTBOUND,
  parseScutilProxy,
  parseProxyValue,
  resolveProxy,
  createSystemProxyReader,
  createProxyFetch,
};
