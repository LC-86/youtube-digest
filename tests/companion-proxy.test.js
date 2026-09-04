const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");

const outbound = require("../companion/outbound.js");
const host = require("../companion/host.js");
const authWorker = require("../companion/auth-worker.js");

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("scutil parser reads a manual macOS proxy and ignores the rest", () => {
  const enabled = outbound.parseScutilProxy(`
<dictionary> {
  ExceptionsList : <array> {
    0 : localhost
  }
  HTTPEnable : 1
  HTTPPort : 10808
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSProxy : 127.0.0.1
  HTTPSPort : 10808
  SOCKSEnable : 1
  SOCKSProxy : 127.0.0.1
  SOCKSPort : 10808
}
`);
  assert.deepEqual(enabled, { host: "127.0.0.1", port: 10808 });

  const httpOnly = outbound.parseScutilProxy("HTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : 8888\n");
  assert.deepEqual(httpOnly, { host: "127.0.0.1", port: 8888 });

  const disabled = outbound.parseScutilProxy("HTTPSEnable : 0\nHTTPEnable : 0\n");
  const pacOnly = outbound.parseScutilProxy("ProxyAutoConfigEnable : 1\nProxyAutoConfigURLString : http://127.0.0.1/proxy.pac\n");
  assert.equal(disabled, null);
  assert.equal(pacOnly, null);
  assert.equal(outbound.parseScutilProxy("not a proxy file"), null);
});

test("proxy values parse leniently and honor the direct override", () => {
  assert.deepEqual(outbound.parseProxyValue("http://127.0.0.1:10808"), {
    host: "127.0.0.1",
    port: 10808,
  });
  assert.deepEqual(outbound.parseProxyValue("127.0.0.1:8080"), {
    host: "127.0.0.1",
    port: 8080,
  });
  assert.equal(outbound.parseProxyValue("direct"), null);
  assert.equal(outbound.parseProxyValue("socks5://127.0.0.1:1080"), undefined);
  assert.equal(outbound.parseProxyValue("http://127.0.0.1"), undefined);
  assert.equal(outbound.parseProxyValue(""), undefined);
});

test("proxy resolution precedence: explicit, env, then macOS system proxy", async () => {
  const system = { host: "127.0.0.1", port: 10808 };

  assert.deepEqual(
    await outbound.resolveProxy({
      env: { YTD_COMPANION_PROXY: "http://127.0.0.1:9999", HTTPS_PROXY: "http://127.0.0.1:8888" },
      platform: "darwin",
      readSystemProxy: async () => system,
    }),
    { host: "127.0.0.1", port: 9999 },
  );

  assert.equal(
    await outbound.resolveProxy({
      env: { YTD_COMPANION_PROXY: "direct" },
      platform: "darwin",
      readSystemProxy: async () => system,
    }),
    null,
  );

  assert.deepEqual(
    await outbound.resolveProxy({
      env: { https_proxy: "127.0.0.1:8888" },
      platform: "darwin",
      readSystemProxy: async () => system,
    }),
    { host: "127.0.0.1", port: 8888 },
  );

  assert.deepEqual(
    await outbound.resolveProxy({
      env: {},
      platform: "darwin",
      readSystemProxy: async () => system,
    }),
    system,
  );

  assert.equal(
    await outbound.resolveProxy({
      env: {},
      platform: "linux",
      readSystemProxy: async () => system,
    }),
    null,
  );
});

test("proxied fetch tunnels through CONNECT and preserves request semantics", async () => {
  const seen = [];
  const origin = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      seen.push({ method: request.method, url: request.url, host: request.headers.host, body });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ accepted: true }));
    });
  });
  const proxy = http.createServer();
  const tunnels = [];
  proxy.on("connect", (request, clientSocket, head) => {
    tunnels.push(request.url);
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const upstream = net.connect(
      Number(request.url.split(":")[1]),
      "127.0.0.1",
      () => {
        upstream.write(head);
        clientSocket.pipe(upstream).pipe(clientSocket);
      },
    );
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });

  const originInfo = await listen(origin);
  const proxyInfo = await listen(proxy);
  const fetchImpl = outbound.createProxyFetch({
    resolveProxyImpl: async () => ({ host: "127.0.0.1", port: proxyInfo.port }),
  });

  try {
    const response = await fetchImpl(
      `http://127.0.0.1:${originInfo.port}/oauth/token?x=1`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=authorization_code",
      },
    );

    assert.equal(response.ok, true);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "application/json");
    assert.deepEqual(await response.json(), { accepted: true });
    assert.deepEqual(tunnels, [`127.0.0.1:${originInfo.port}`]);
    assert.deepEqual(seen, [
      {
        method: "POST",
        url: "/oauth/token?x=1",
        host: `127.0.0.1:${originInfo.port}`,
        body: "grant_type=authorization_code",
      },
    ]);
  } finally {
    await closeServer(origin);
    await closeServer(proxy);
  }
});

test("proxied fetch rejects when the proxy refuses the tunnel", async () => {
  const proxy = http.createServer();
  proxy.on("connect", (request, clientSocket) => {
    clientSocket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
    clientSocket.destroy();
  });
  const proxyInfo = await listen(proxy);
  const fetchImpl = outbound.createProxyFetch({
    resolveProxyImpl: async () => ({ host: "127.0.0.1", port: proxyInfo.port }),
  });

  try {
    await assert.rejects(
      fetchImpl("https://auth.openai.com/oauth/token", { method: "POST" }),
      /proxy-refused-connection: http 407/,
    );
  } finally {
    await closeServer(proxy);
  }
});

test("proxied fetch honors an abort signal like native fetch", async () => {
  const origin = http.createServer(() => {
    // Never respond: the abort must be the only way out.
  });
  const proxy = http.createServer();
  proxy.on("connect", (request, clientSocket, head) => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const upstream = net.connect(
      Number(request.url.split(":")[1]),
      "127.0.0.1",
      () => {
        upstream.write(head);
        clientSocket.pipe(upstream).pipe(clientSocket);
      },
    );
    clientSocket.on("error", () => upstream.destroy());
    upstream.on("error", () => clientSocket.destroy());
  });

  const originInfo = await listen(origin);
  const proxyInfo = await listen(proxy);
  const fetchImpl = outbound.createProxyFetch({
    resolveProxyImpl: async () => ({ host: "127.0.0.1", port: proxyInfo.port }),
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);

  try {
    await assert.rejects(
      fetchImpl(`http://127.0.0.1:${originInfo.port}/hang`, {
        method: "POST",
        signal: controller.signal,
      }),
      (error) => error.name === "AbortError",
    );
  } finally {
    await closeServer(origin);
    await closeServer(proxy);
  }
});

test("https targets TLS-wrap the tunnel with the target servername", async () => {
  const captured = {};
  const fakeTlsSocket = new net.Socket();
  const httpsModule = require("node:https");
  const originalRequest = httpsModule.request;

  const proxy = http.createServer();
  proxy.on("connect", (request, clientSocket) => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    // The capture happens synchronously after the 200; tearing the socket
    // down afterwards lets the test server actually close.
    setTimeout(() => clientSocket.destroy(), 15);
  });
  const proxyInfo = await listen(proxy);

  const fetchImpl = outbound.createProxyFetch({
    resolveProxyImpl: async () => ({ host: "127.0.0.1", port: proxyInfo.port }),
    tlsImpl: {
      connect(options) {
        captured.tlsOptions = options;
        return fakeTlsSocket;
      },
    },
  });

  // Replace https.request for the duration of the call: the fake records
  // the options and absorbs the request without a real TLS handshake.
  httpsModule.request = (options) => {
    captured.requestOptions = options;
    const pending = new net.Socket();
    return Object.assign(pending, {
      end() {
        return this;
      },
      write() {
        return this;
      },
      setTimeout() {
        return this;
      },
    });
  };

  try {
    const pending = fetchImpl("https://auth.openai.com/oauth/token", {
      method: "POST",
      body: "x=1",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await Promise.race([
      pending.catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 10)),
    ]);
  } finally {
    httpsModule.request = originalRequest;
    await closeServer(proxy);
    fakeTlsSocket.destroy();
  }

  assert.equal(captured.tlsOptions?.servername, "auth.openai.com");
  assert.equal(captured.tlsOptions?.socket instanceof net.Socket, true);
  assert.equal(typeof captured.requestOptions?.createConnection, "function");
  assert.equal(captured.requestOptions?.host, "auth.openai.com");
  assert.equal(captured.requestOptions?.port, 443);
});

test("host and auth worker default to the proxy-aware outbound fetch", () => {
  assert.equal(host.createDefaultDeps().fetchImpl.proxyAware, true);
  assert.equal(
    authWorker.createDefaultDependencies().fetchImpl.proxyAware,
    true,
  );
});

test("failure page includes the redacted reason when one exists", () => {
  assert.equal(
    authWorker.failurePage("error", "token-endpoint-rejected: http 403").body,
    "Authorization could not be completed (error: token-endpoint-rejected: http 403). Close this tab and try again from YouTube Digest Settings.",
  );
  assert.equal(
    authWorker.failurePage("denied").body,
    "Authorization could not be completed (denied). Close this tab and try again from YouTube Digest Settings.",
  );
});
