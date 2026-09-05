const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const M = require('../markdown-export.js');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const VIDEO = 'UNzCG3lw6O0';
const url = id => `https://www.youtube.com/watch?v=${id}`;
// Shape and values observed in this video's player/owner data on 2026-09-05.
// Keep only public attribution fields; no session, tracking or account data.
const channel = (name, id) => ({ listItemViewModel: { title: {
  content: name, commandRuns: [{ onTap: { innertubeCommand: { browseEndpoint: { browseId: id } } } }],
} } });
function fixture() {
  return {
    videoDetails: { videoId: VIDEO, title: 'Building Great Agent Skills: The Missing Manual', author: 'AI Engineer', shortDescription: 'Public description', lengthSeconds: '1243' },
    microformat: { playerMicroformatRenderer: { publishDate: '2026-06-29T11:53:10-07:00', uploadDate: '2026-06-29T11:53:10-07:00' } },
  };
}
function harness({ response = fixture(), items = [channel('AI Engineer', 'UCLKPca3kwwd-B59HNr-_lvA'), channel('Matt Pocock', 'UCswG6FSbgZjbWtdf_hMLaow')], watchId = VIDEO } = {}) {
  let listener;
  const events = { addListener() {} };
  const state = { response, items, watchId, tabId: 10, videoId: VIDEO, fail: false };
  const watch = {
    getAttribute: () => state.watchId,
    querySelector: () => ({ data: { navigationEndpoint: { showDialogCommand: { panelLoadingStrategy: { inlineContent: { dialogViewModel: { customContent: { listViewModel: { listItems: state.items } } } } } } } } }),
  };
  const bg = {
    console, URL, importScripts() {}, location: { href: url(VIDEO) },
    document: { getElementById: () => ({ getPlayerResponse: () => state.response }), querySelector: () => watch },
    chrome: {
      storage: { local: { setAccessLevel: async () => {} } },
      action: { onClicked: events }, sidePanel: { setPanelBehavior() {} },
      runtime: { onInstalled: events, onMessage: { addListener(fn) { listener = fn; } } },
      tabs: { onUpdated: events, onActivated: events, query: async () => [{ id: state.tabId, url: url(state.videoId) }], sendMessage: async () => ({ title: 'DOM title', channelName: 'Wrong playlist owner' }) },
      scripting: { executeScript: async ({ func, target, world }) => {
        assert.equal(world, 'MAIN'); assert.equal(target.tabId, state.tabId);
        if (state.fail) throw new Error('script unavailable');
        return [{ result: func() }];
      } },
    },
  };
  vm.runInNewContext(read('background.js'), bg);
  return { bg, state, relay: () => new Promise(resolve => listener({ action: 'relayToContent', payload: { action: 'getVideoInfo' } }, {}, resolve)) };
}

test('real metadata relay includes every collaborative channel and the publication day', async () => {
  const h = harness();
  const result = await h.relay();
  assert.equal(result.success, true);
  const info = result.response;
  assert.equal(info.channelName, 'AI Engineer');
  assert.deepEqual(Array.from(info.authors), ['AI Engineer', 'Matt Pocock']);
  assert.equal(info.published, '2026-06-29');
  const source = M.snapshot({ ...info, author: info.channelName, transcriptText: 'Original subtitle.' });
  const properties = M.initialProperties(M.DEFAULT_TEMPLATE, source);
  assert.equal(properties.author, 'AI Engineer\nMatt Pocock');
  assert.equal(properties.published, '2026-06-29');
  assert.match(M.render(M.DEFAULT_TEMPLATE, source, properties).markdown, /"author": \["AI Engineer","Matt Pocock"\]/);
});

test('all collaborator entries survive without splitting names or reading subscription labels', async () => {
  const h = harness({ items: [channel('AI Engineer', 'UC1'), channel('Last, First', 'UC2'), channel('Research and Design', 'UC3'), channel('第四位', 'UC4'), channel('第四位', 'UC4'), { listItemViewModel: { title: { content: 'Subscribe' } } }] });
  const info = await h.bg.getPlayerVideoDetails(10);
  assert.deepEqual(Array.from(info.authors), ['AI Engineer', 'Last, First', 'Research and Design', '第四位']);
});

test('single-channel video and missing dates stay valid without invented collaborators', async () => {
  const response = fixture(); delete response.microformat;
  const h = harness({ response, items: [] });
  const info = await h.bg.getPlayerVideoDetails(10);
  assert.deepEqual(Array.from(info.authors), ['AI Engineer']); assert.equal(info.published, '');
});

test('publication date precedes upload date and retains its source calendar day across time zones', async () => {
  const response = fixture();
  response.microformat.playerMicroformatRenderer = { publishDate: '2026-06-29T23:53:10-07:00', uploadDate: '2026-06-28' };
  const h = harness({ response });
  assert.equal((await h.bg.getPlayerVideoDetails(10)).published, '2026-06-29');
  response.microformat.playerMicroformatRenderer.publishDate = '2 months ago';
  assert.equal((await h.bg.getPlayerVideoDetails(10)).published, '2026-06-28');
  response.microformat.playerMicroformatRenderer.uploadDate = 'not a date';
  assert.equal((await h.bg.getPlayerVideoDetails(10)).published, '');
});

test('SPA transition rejects mismatched player and does not borrow the old collaborator card', async () => {
  const h = harness({ watchId: 'old-video' });
  assert.deepEqual(Array.from((await h.bg.getPlayerVideoDetails(10)).authors), ['AI Engineer']);
  h.state.response.videoDetails.videoId = 'old-video';
  assert.equal(await h.bg.getPlayerVideoDetails(10), null);
});

test('side panel transfers metadata to save window and resets fields for a subsequent video', async () => {
  const h = harness(), saved = {}, events = { addListener() {} };
  const sandbox = {
    console, URL, TextEncoder, crypto: require('node:crypto').webcrypto,
    setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {},
    document: { addEventListener() {}, querySelectorAll: () => [], getElementById: () => ({ disabled: false }) },
    window: { getSelection: () => null }, YTD_MARKDOWN: M, YTD_SETTINGS: require('../settings.js'),
    alert: error => assert.fail(error),
    chrome: {
      runtime: { onMessage: events, sendMessage: h.relay, getURL: p => `chrome-extension://test/${p}` },
      tabs: { onUpdated: events, onActivated: events, query: h.bg.chrome.tabs.query },
      windows: { getCurrent: async () => ({ id: 1 }), create: async () => {} },
      storage: { session: { set: async values => Object.assign(saved, values), remove: async () => {} } },
    },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(read('sidepanel.js'), ctx);
  vm.runInContext("startDigest = async (id) => {currentVideoId=id;currentTranscriptText='Original subtitle.';};", ctx);
  await sandbox.checkCurrentTab(); await sandbox.exportMarkdown();
  let source = Object.values(saved).at(-1);
  assert.equal(source.author, 'AI Engineer\nMatt Pocock'); assert.equal(source.published, '2026-06-29');
  h.state.videoId = h.state.watchId = h.state.response.videoDetails.videoId = 'next-video';
  h.bg.location.href = url('next-video'); h.state.response.videoDetails.author = 'Solo';
  h.state.items = []; delete h.state.response.microformat;
  await sandbox.checkCurrentTab(); await sandbox.exportMarkdown();
  source = Object.values(saved).at(-1);
  assert.equal(source.author, 'Solo'); assert.equal(source.published, '');
  sandbox.chrome.runtime.sendMessage = async () => ({ success: false });
  await sandbox.checkCurrentTab(); await sandbox.exportMarkdown();
  source = Object.values(saved).at(-1);
  assert.equal(source.author, ''); assert.equal(source.published, '');
});
