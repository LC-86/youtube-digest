const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const os = require("node:os");

const companion = require("../companion.js");
const host = require("../companion/host.js");
const extensionId = require("../companion/extension-id.js");
const options = require("../options.js");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function createRuntime(behavior = {}) {
  const calls = [];
  const runtime = {
    lastError: null,
    sendNativeMessage(hostName, message, callback) {
      calls.push({ hostName, message });
      if (behavior.neverRespond) return;
      queueMicrotask(() => {
        if (behavior.errorMessage) {
          runtime.lastError = { message: behavior.errorMessage };
          callback(undefined);
          runtime.lastError = null;
          return;
        }
        callback(
          typeof behavior.response === "function"
            ? behavior.response(message)
            : behavior.response,
        );
      });
    },
  };
  runtime.calls = calls;
  return runtime;
}

test("status contract reports ready for a compatible companion", async () => {
  const runtime = createRuntime({
    response: {
      v: 1,
      ok: true,
      type: "status",
      status: "ready",
      protocol: 1,
      companionVersion: "1.2.0",
      capabilities: ["status", "auth", "models"],
      auth: { phase: "signed-out" },
    },
  });

  const result = await companion.checkStatus({ runtime });

  assert.deepEqual(result, {
    state: "ready",
    protocol: 1,
    hostVersion: "1.2.0",
    capabilities: ["status", "auth", "models"],
    authSupported: true,
    modelsSupported: true,
    auth: { phase: "signed-out" },
  });
  assert.deepEqual(runtime.calls, [
    { hostName: companion.HOST_NAME, message: { v: 1, type: "status" } },
  ]);
});

test("status contract reports unavailable when the host is missing or blocked", async () => {
  const cases = [
    ["Specified native messaging host not found.", "host-not-installed"],
    [
      "Access to the specified native messaging host is forbidden.",
      "host-not-allowed",
    ],
    ["Failed to start native messaging host.", "host-not-running"],
    [
      "Error when communicating with the native messaging host.",
      "host-not-responding",
    ],
    ["Something unexpected.", "host-error"],
  ];

  for (const [message, reason] of cases) {
    const result = await companion.checkStatus({
      runtime: createRuntime({ errorMessage: message }),
    });
    assert.equal(result.state, "unavailable", message);
    assert.equal(result.reason, reason, message);
  }
});

test("status contract reports unavailable when the host never answers", async () => {
  const result = await companion.checkStatus({
    runtime: createRuntime({ neverRespond: true }),
    timeoutMs: 10,
  });

  assert.equal(result.state, "unavailable");
  assert.equal(result.reason, "host-not-responding");
});

test("status contract reports unavailable outside the extension context", async () => {
  const result = await companion.checkStatus({ runtime: undefined });

  assert.equal(result.state, "unavailable");
  assert.equal(result.reason, "browser-unsupported");
});

test("status contract reports incompatible for unsupported protocol replies", async () => {
  const newer = await companion.checkStatus({
    runtime: createRuntime({ response: { v: 2, ok: false } }),
  });
  assert.deepEqual(newer, {
    state: "incompatible",
    reason: "protocol-unsupported",
    found: 2,
  });

  const shapeless = await companion.checkStatus({
    runtime: createRuntime({ response: { ok: true } }),
  });
  assert.deepEqual(shapeless, {
    state: "incompatible",
    reason: "protocol-unsupported",
    found: null,
  });
});

test("status contract reports host errors without losing the state shape", async () => {
  const result = await companion.checkStatus({
    runtime: createRuntime({ response: { v: 1, ok: false, error: "boom" } }),
  });

  assert.equal(result.state, "unavailable");
  assert.equal(result.reason, "host-error");
});

test("status contract does not report ready when the host is not operational", async () => {
  const result = await companion.checkStatus({
    runtime: createRuntime({
      response: { v: 1, ok: true, status: "degraded", companionVersion: "1.2.0" },
    }),
  });

  assert.equal(result.state, "unavailable");
  assert.equal(result.reason, "host-error");
});

test("extension and host share one connection contract", () => {
  assert.equal(companion.HOST_NAME, host.HOST_NAME);
  assert.equal(companion.PROTOCOL_VERSION, host.PROTOCOL_VERSION);
  assert.deepEqual(
    companion.SUPPORTED_PROTOCOL_VERSIONS,
    host.CONTRACT.SUPPORTED_PROTOCOL_VERSIONS,
  );
  assert.equal(companion.HOST_NAME, "com.youtube_digest.companion");
});

test("host manifest accepts only the pinned stable extension identity", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const derived = extensionId.deriveExtensionId(manifest.key);

  assert.match(derived, /^[a-p]{32}$/);

  const template = JSON.parse(read("companion/host-manifest.template.json"));
  assert.equal(template.name, companion.HOST_NAME);
  assert.equal(template.type, "stdio");
  assert.deepEqual(template.allowed_origins, [
    `chrome-extension://${derived}/`,
  ]);
  assert.equal(template.path, "__COMPANION_LAUNCHER__");
});

test("host speaks the framed status contract over stdio", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytd-companion-stdio-"));
  const child = spawn(process.execPath, [path.join(root, "companion", "host.js")], {
    env: {
      ...process.env,
      YTD_COMPANION_STATE_DIR: stateDir,
      YTD_COMPANION_KEYCHAIN_SERVICE: `com.youtube_digest.test.${Date.now()}`,
    },
  });
  try {
    const stdout = await new Promise((resolve, reject) => {
      const chunks = [];
      child.stdout.on("data", (chunk) => chunks.push(chunk));
      child.stdout.on("error", reject);
      child.stdin.on("error", reject);
      const timer = setTimeout(
        () => reject(new Error("host did not answer in time")),
        10000,
      );
      child.stdout.on("close", () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks));
      });
      child.stdin.write(host.encodeFrame({ v: 1, type: "status" }));
      child.stdin.end();
    });

    const length = stdout.readUInt32LE(0);
    const response = JSON.parse(stdout.subarray(4, 4 + length).toString("utf8"));
    assert.equal(response.v, 1);
    assert.equal(response.ok, true);
    assert.equal(response.status, "ready");
    assert.equal(response.protocol, 1);
    assert.match(response.companionVersion, /^\d+\.\d+\.\d+$/);
    assert.deepEqual(response.capabilities, [
      "status",
      "auth",
      "models",
      "completions",
    ]);
    assert.equal(response.auth.phase, "signed-out");
  } finally {
    child.kill();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("host rejects unsupported protocol versions with a typed error", async () => {
  const response = await host.handleRequest({ v: 99, type: "status" });

  assert.equal(response.ok, false);
  assert.equal(response.error, "unsupported-protocol");
  assert.equal(response.found, 99);
});

test("host rejects unknown request types and non-object messages", async () => {
  assert.equal(
    (await host.handleRequest({ v: 1, type: "catalog" })).error,
    "unknown-request-type",
  );
  assert.equal((await host.handleRequest(null)).error, "invalid-request");
  assert.equal((await host.handleRequest("status")).error, "invalid-request");
});

test("host frame reader rejects oversized inbound messages", () => {
  const failures = [];
  const reader = host.createFrameReader({
    onMessage() {
      failures.push(new Error("unexpected message"));
    },
    onError(error) {
      failures.push(error);
    },
  });

  const header = Buffer.alloc(4);
  header.writeUInt32LE(host.CONTRACT.MAX_INBOUND_MESSAGE_BYTES + 1, 0);
  reader.push(header);

  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /exceeds/);
});

test("host replaces oversized outbound frames with a typed error reply", () => {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const writes = [];
  process.stdout.write = (chunk, ...rest) => {
    writes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  };
  try {
    host.writeFrame({ v: 1, ok: true, blob: "x".repeat(1024 * 1024) });
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.equal(writes.length, 1);
  const frame = writes[0];
  const length = frame.readUInt32LE(0);
  assert.ok(length <= host.CONTRACT.MAX_OUTBOUND_MESSAGE_BYTES);
  const response = JSON.parse(frame.subarray(4, 4 + length).toString("utf8"));
  assert.equal(response.ok, false);
  assert.equal(response.error, "response-too-large");
});

test("host reports its version and protocol for installers", () => {
  const output = execFileSync(
    process.execPath,
    [path.join(root, "companion", "host.js"), "--version"],
    { encoding: "utf8" },
  );
  const version = JSON.parse(output);

  assert.equal(version.protocol, host.PROTOCOL_VERSION);
  assert.equal(version.hostName, host.HOST_NAME);
  assert.match(version.companionVersion, /^\d+\.\d+\.\d+$/);
});

test("installer script has valid bash syntax", () => {
  execFileSync("bash", ["-n", path.join(root, "companion", "install.sh")], {
    stdio: "pipe",
  });
});

test(
  "installer registers the companion under the stable identity",
  { skip: process.platform !== "darwin" },
  () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ytd-companion-home-"));
    const launcherDir = path.join(root, "companion", "bin");
    try {
      execFileSync("bash", [path.join(root, "companion", "install.sh")], {
        stdio: "pipe",
        env: { ...process.env, HOME: home },
      });

      const manifestPath = path.join(
        home,
        "Library",
        "Application Support",
        "Google",
        "Chrome",
        "NativeMessagingHosts",
        `${companion.HOST_NAME}.json`,
      );
      const installed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const derived = extensionId.deriveFromManifestFile(
        path.join(root, "manifest.json"),
      );

      assert.equal(installed.name, companion.HOST_NAME);
      assert.equal(installed.type, "stdio");
      assert.deepEqual(installed.allowed_origins, [
        `chrome-extension://${derived}/`,
      ]);
      assert.ok(fs.existsSync(installed.path));
      assert.equal(fs.statSync(installed.path).mode & 0o111, 0o111);
      assert.match(fs.readFileSync(installed.path, "utf8"), /companion\/host\.js/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(launcherDir, { recursive: true, force: true });
    }
  },
);

test("settings map each contract state to actionable bilingual copy", () => {
  const views = [
    [
      { state: "ready", hostVersion: "1.2.0" },
      "companionReadyBadge",
      "companionReadyDetail",
      false,
    ],
    [{ state: "checking" }, "companionChecking", null, false],
    [
      { state: "unavailable", reason: "host-not-installed" },
      "companionUnavailableBadge",
      "companionReasonHostNotInstalled",
      true,
    ],
    [
      { state: "unavailable", reason: "host-not-allowed" },
      "companionUnavailableBadge",
      "companionReasonHostNotAllowed",
      true,
    ],
    [
      { state: "unavailable", reason: "host-not-running" },
      "companionUnavailableBadge",
      "companionReasonHostNotRunning",
      true,
    ],
    [
      { state: "unavailable", reason: "host-not-responding" },
      "companionUnavailableBadge",
      "companionReasonHostNotResponding",
      true,
    ],
    [
      { state: "unavailable", reason: "browser-unsupported" },
      "companionUnavailableBadge",
      "companionReasonBrowserUnsupported",
      false,
    ],
    [
      { state: "unavailable", reason: "host-error" },
      "companionUnavailableBadge",
      "companionReasonHostError",
      true,
    ],
    [
      { state: "unavailable", reason: "future-reason" },
      "companionUnavailableBadge",
      "companionReasonHostError",
      true,
    ],
    [
      { state: "incompatible", reason: "protocol-unsupported", found: 2 },
      "companionIncompatibleBadge",
      "companionReasonProtocolUnsupported",
      true,
    ],
  ];

  for (const [result, badgeKey, detailKey, showInstallSteps] of views) {
    const view = options.describeCompanionStatus(result);
    assert.equal(view.badgeKey, badgeKey, JSON.stringify(result));
    assert.equal(view.detailKey, detailKey, JSON.stringify(result));
    assert.equal(
      view.showInstallSteps,
      showInstallSteps,
      JSON.stringify(result),
    );
    for (const language of ["en", "zh-CN"]) {
      assert.ok(
        options.translate(language, badgeKey),
        `${language} copy for ${badgeKey}`,
      );
      if (detailKey) {
        assert.ok(
          options.translate(language, detailKey, {
            version: result.hostVersion ?? null,
            found: result.found ?? null,
          }),
          `${language} copy for ${detailKey}`,
        );
      }
    }
  }

  const readyView = options.describeCompanionStatus({
    state: "ready",
    hostVersion: "1.2.0",
  });
  assert.match(
    options.translate("en", "companionReadyDetail", readyView.detailParams),
    /Chrome Native Messaging/,
  );
  const outdatedView = options.describeCompanionStatus({
    state: "incompatible",
    reason: "protocol-unsupported",
    found: 2,
  });
  assert.match(
    options.translate(
      "en",
      "companionReasonProtocolUnsupported",
      outdatedView.detailParams,
    ),
    /protocol 2/,
  );
});

test("settings page exposes the companion card with an install path", () => {
  const html = read("options.html");
  const script = read("options.js");

  assert.match(html, /<script src="companion\.js"><\/script>/);
  assert.match(
    html,
    /class="card companion-card"[\s\S]*data-companion-state="checking"/,
  );
  assert.match(html, /id="companionBadge"/);
  assert.match(html, /id="companionDetail"[\s\S]*role="status"/);
  assert.match(html, /id="companionCheckBtn"/);
  assert.match(html, /id="companionInstall"[^>]*hidden/);
  assert.match(html, /bash companion\/install\.sh/);
  assert.match(script, /YTD_COMPANION/);
  assert.match(script, /checkStatus/);
  assert.match(script, /describeCompanionStatus/);
});
