const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../markdown-export.js");
const FILES = require("../export-storage.js");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const template = () => structuredClone(M.DEFAULT_TEMPLATE);
const source = () => M.snapshot({ title: "中文对话", author: "频道", url: "https://www.youtube.com/watch?v=example1234", language: "en", transcript: [{ rawText: ">> Alice: Hello.", text: "Alice: Hello.", start: 20 }, { rawText: ">> Bob: Hi {{title}}.", text: "Bob: Hi.", start: 32 }] });

test("export freezes actual extracted language, raw names and turn boundaries without timestamps", () => {
  const input = { title: "One", transcript: [{ rawText: ">> Alice: Hello.", text: "cleaned", start: 321 }] };
  const frozen = M.snapshot(input); input.transcript[0].rawText = "changed";
  assert.equal(frozen.segments[0].text, ">> Alice: Hello.");
  const s = source(), t = template();
  const doc = M.render(t, s, M.initialProperties(t, s));
  assert.equal(s.language, "en");
  assert.match(doc.markdown, /Alice: Hello\./);
  assert.match(doc.markdown, /Bob: Hi {{title}}\./);
  assert.doesNotMatch(doc.markdown, /\[0:20\]|\[0:32\]|cleaned/);
  assert.ok(doc.markdown.includes("\n\n\\>\\> Bob:"));
  assert.equal(doc.filename, "中文对话.md");
  assert.throws(() => M.snapshot({}), /获取字幕/);
});

test("title edits drive filename and content; YAML scalars cannot escape frontmatter", () => {
  const s = source(), t = template(), props = M.initialProperties(t, s);
  props.title = "新标题:问答/中文";
  props.author = '["Alice", "Bob"]'; props.status = "待处理\n---\nmalicious: true";
  const doc = M.render(t, s, props);
  assert.equal(doc.filename, "新标题_问答_中文.md");
  assert.match(doc.markdown, /# 新标题:问答\/中文/);
  assert.match(doc.markdown, /"author": \["Alice","Bob"\]/);
  assert.match(doc.markdown, /"status": "待处理\\n---\\nmalicious: true"/);
  assert.equal(doc.markdown.split("\n---\n").length, 2);
  assert.throws(() => M.filename(".."), /有效/);
  assert.throws(() => M.filename("CON"), /保留/);
  assert.throws(() => M.filename("字".repeat(100)), /过长/);
});

test("common Web Clipper templates import with explicit behavior/path warnings", () => {
  const original = { ...template(), behavior: "append-daily", path: "Inbox", vault: "Personal", noteNameFormat: '{{date|date:"YYYY-MM-DD"}} {{title}}', triggers: ["https://youtube.com"], context: "{{content}}" };
  const result = M.importTemplate(JSON.stringify(original));
  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.length, 5);
  assert.equal(result.template.behavior, "create");
  assert.equal(result.template.noteNameFormat, "{{title}}");
  assert.equal(original.behavior, "append-daily");
  assert.equal(M.interpolate('{{date|date:"YYYY-MM-DD"}}', { date: "2026-09-05" }), "2026-09-05");
});

test("unsupported template code is reported, never executed or silently rendered", () => {
  for (const body of ['{{content}} {{"summarize the video"}}', '{{content}} {{selector:h1}}', '{% if title %}{{content}}{% endif %}', '{{content}} {{title|safe_name}}', '{{content}} {{unknown}}', '{{content}} {{title']) {
    const result = M.importTemplate(JSON.stringify({ ...template(), noteContentFormat: body }));
    assert.ok(result.errors.length, body);
  }
  assert.ok(M.templateErrors({ ...template(), properties: [] }).some(e => e.includes("title")));
  assert.ok(M.templateErrors({ ...template(), noteContentFormat: "only a heading" }).some(e => e.includes("content")));
  assert.throws(() => M.importTemplate("[]"), /单个/);
  assert.throws(() => M.propertyValue({ name: "tags", type: "multitext" }, '[{"x":1}]'), /文字列表/);
  assert.throws(() => M.propertyValue({ name: "score", type: "number" }, "NaN"), /有效数字/);
});

test("only confirmed speaker annotations enter the original transcript", () => {
  const s = source();
  const suggestion = { startId: "s0", endId: "s0", name: "候选姓名", evidence: "Alice: Hello.", confirmed: false };
  assert.doesNotMatch(M.transcriptText(s.segments, [suggestion]), /候选姓名/);
  suggestion.confirmed = true;
  assert.match(M.transcriptText(s.segments, [suggestion]), /\*\*候选姓名\*\*/);
  assert.match(M.transcriptText(s.segments, [suggestion]), /Alice: Hello\./);
  assert.throws(() => M.transcriptText(s.segments, [suggestion, suggestion]), /重叠/);
});

test("speaker validation rejects invented quotes, IDs and overlaps; empty is allowed", () => {
  const s = source().segments;
  const item = { startId: "s0", endId: "s0", name: "Alice", evidence: "Alice: Hello." };
  const result = M.validateSpeakers({ speakers: [item] }, s);
  assert.equal(result[0].confirmed, false);
  assert.deepEqual(M.validateSpeakers({ speakers: [] }, s), []);
  assert.throws(() => M.validateSpeakers({ speakers: [{ ...item, startId: "s999" }] }, s), /范围/);
  assert.throws(() => M.validateSpeakers({ speakers: [{ ...item, evidence: "I am Alice" }] }, s), /依据/);
  assert.throws(() => M.validateSpeakers({ speakers: [item, item] }, s), /重叠/);
  const many = Array.from({ length: 130 }, (_, i) => ({ id: `s${i}`, text: "line" }));
  assert.equal(M.speakerBatches(many).flat().length, many.length);
  assert.equal(M.speakerBatches(many).length, 3);
  assert.throws(() => M.speakerBatches([{ id: "s0", text: "x".repeat(10001) }]), /过长/);
});

function fakeDirectory({ exists = true, fail = "" } = {}) {
  let content = "original notes", opened = 0, aborted = 0, closed = 0;
  const handle = {
    getFile: async () => ({ size: exists ? content.length : 0 }),
    async createWritable() {
      opened++; let pending = content;
      return {
        async write(value) { if (fail === "write") throw new Error("disk full"); pending = value; },
        async close() { if (fail === "close") throw new Error("close failed"); closed++; content = pending; },
        async abort() { aborted++; },
      };
    },
  };
  return {
    dir: { async getFileHandle(name, options) { if (!exists && !options?.create) throw Object.assign(new Error("missing"), { name: "NotFoundError" }); return handle; } },
    state: () => ({ content, opened, aborted, closed }),
  };
}
test("canceling overwrite never opens a writer or changes existing user notes", async () => {
  const f = fakeDirectory();
  const result = await FILES.save(f.dir, { filename: "Title.md", markdown: "new" }, async () => false);
  assert.equal(result.canceled, true);
  assert.deepEqual(f.state(), { content: "original notes", opened: 0, aborted: 0, closed: 0 });
});
test("file success occurs after close; write and close failures abort", async () => {
  for (const fail of ["write", "close"]) {
    const f = fakeDirectory({ fail });
    await assert.rejects(FILES.save(f.dir, { filename: "Title.md", markdown: "new" }, async () => true));
    assert.equal(f.state().content, "original notes"); assert.equal(f.state().aborted, 1);
  }
  const f = fakeDirectory();
  assert.equal((await FILES.save(f.dir, { filename: "Title.md", markdown: "new" }, async () => true)).saved, true);
  assert.equal(f.state().content, "new"); assert.equal(f.state().closed, 1);
});

test("real sidepanel entry freezes raw subtitles before opening its independent save window", async () => {
  const stored = {}, opened = [], removed = [], alerts = [];
  const button = { disabled: false };
  const listeners = { addListener() {} };
  const sandbox = {
    console, URL, TextEncoder, TextDecoder, crypto: require("node:crypto").webcrypto,
    setTimeout: () => 0, clearTimeout() {}, setInterval() {}, clearInterval() {},
    window: { getSelection: () => null, close() {} },
    document: { addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, getElementById: () => button },
    alert: text => alerts.push(text), YTD_MARKDOWN: M,
    YTD_SETTINGS: require("../settings.js"),
    chrome: {
      runtime: { onMessage: listeners, getURL: file => `chrome-extension://test/${file}` },
      windows: { getCurrent: async () => ({ id: 1 }), create: async options => opened.push(options) },
      tabs: { onUpdated: listeners, onActivated: listeners },
      storage: { session: { set: async values => Object.assign(stored, values), remove: async key => { removed.push(key); delete stored[key]; } } },
    },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../sidepanel.js"), "utf8"), ctx);
  vm.runInContext(`currentVideoId='example1234';currentVideoTitle='Original';currentChannelName='Channel';currentTranscriptLanguage='en';currentTranscriptMode='zh';currentTranscript=[{rawText:'>> Alice: Hello.',text:'Alice: Hello.'}];currentTranscriptText='Original plain text';`, ctx);
  await sandbox.exportMarkdown();
  assert.equal(opened.length, 1); assert.equal(opened[0].type, "popup");
  const key = Object.keys(stored)[0];
  assert.match(opened[0].url, /export\.html\?draft=/);
  assert.equal(stored[key].segments[0].text, ">> Alice: Hello.");
  assert.equal(stored[key].language, "en");
  vm.runInContext("currentTranscript[0].rawText='changed';currentVideoTitle='Another video';", ctx);
  assert.equal(stored[key].title, "Original");
  assert.equal(stored[key].segments[0].text, ">> Alice: Hello.");
  sandbox.chrome.windows.create = async () => { throw new Error("window rejected"); };
  await sandbox.exportMarkdown();
  assert.equal(removed.length, 1); assert.equal(Object.keys(stored).length, 1);
  assert.equal(button.disabled, false); assert.equal(alerts.length, 1);
});
