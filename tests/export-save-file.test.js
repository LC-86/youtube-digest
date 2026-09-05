const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const M = require('../markdown-export.js');
const FILES = require('../export-storage.js');

function screen(picker) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { disabled: false, textContent: '', value: '', classList: { toggle() {} }, addEventListener() {} });
    return elements.get(id);
  };
  const sandbox = {
    YTD_MARKDOWN: M, YTD_EXPORT_STORAGE: FILES, document: { getElementById: element },
    showSaveFilePicker: picker, console, navigator: {},
    fixture: M.snapshot({ title: '测试标题', transcriptText: 'Original subtitle.' }),
  };
  const ctx = vm.createContext(sandbox);
  // Exercise real event registration, preview guards and save handler without
  // loading Chrome settings. No browser APIs or file permissions are bypassed.
  const code = fs.readFileSync(require.resolve('../export.js'), 'utf8');
  vm.runInContext(code.replace(/init\(\)\.catch\(error => status\(`无法打开保存窗口：[\s\S]*$/, ''), ctx);
  vm.runInContext("source=fixture;templates=[M.DEFAULT_TEMPLATE];selectedId=M.DEFAULT_TEMPLATE.id;properties=M.initialProperties(M.DEFAULT_TEMPLATE,source);refreshPreview();", ctx);
  return { sandbox, ctx, element };
}

function file(failure) {
  const events = []; let content = 'existing file';
  return {
    events, content: () => content,
    handle: { name: '测试标题.md', createWritable: async () => {
      events.push('open'); let pending;
      return {
        write: async text => { events.push('write'); if (failure === 'write') throw new Error('Disk full'); pending = text; },
        close: async () => { events.push('close'); if (failure === 'close') throw new Error('Close failed'); content = pending; },
        abort: async () => { events.push('abort'); },
      };
    } },
  };
}

test('single-file save is available without directory access and writes preview after explicit picker choice', async () => {
  const target = file(); let options;
  const s = screen(async value => { options = value; return target.handle; });
  assert.equal(s.element('download').disabled, true);
  assert.equal(s.element('saveFile').disabled, false);
  await s.sandbox.saveSingleFile();
  assert.equal(options.suggestedName, '测试标题.md');
  assert.equal(options.types[0].accept['text/markdown'][0], '.md');
  assert.equal(target.content(), s.element('preview').value);
  assert.deepEqual(target.events, ['open', 'write', 'close']);
  assert.equal(s.element('status').textContent, '已保存：测试标题.md');
});

test('canceled or restricted file picker keeps edits and never opens a writer', async () => {
  for (const name of ['AbortError', 'SecurityError', 'NotAllowedError']) {
    const target = file();
    const s = screen(async () => { throw Object.assign(new Error('Access denied'), { name }); });
    const before = s.element('preview').value;
    await s.sandbox.saveSingleFile();
    assert.deepEqual(target.events, []);
    assert.equal(s.element('preview').value, before);
    assert.match(s.element('status').textContent, /未完成/);
    assert.equal(s.element('workspace').disabled, false);
    assert.equal(s.element('saveFile').disabled, false);
  }
});

test('single-file write/close failures abort, preserve old content and never report success', async () => {
  for (const failure of ['write', 'close']) {
    const target = file(failure), s = screen(async () => target.handle);
    await s.sandbox.saveSingleFile();
    assert.equal(target.events.at(-1), 'abort');
    assert.equal(target.content(), 'existing file');
    assert.match(s.element('status').textContent, /未完成另存为/);
  }
});

test('unconfirmed speakers block the alternate save path too', async () => {
  let calls = 0;
  const s = screen(async () => { calls++; return file().handle; });
  vm.runInContext("speakers=[{name:'Candidate',confirmed:false}];refreshPreview();", s.ctx);
  assert.equal(s.element('saveFile').disabled, true);
  await s.sandbox.saveSingleFile(); assert.equal(calls, 0);
});

test('pending picker prevents double saves and freezes the document to save', async () => {
  const target = file(); let resolve, calls = 0;
  const s = screen(() => { calls++; return new Promise(done => { resolve = done; }); });
  const before = s.element('preview').value;
  const pending = s.sandbox.saveSingleFile();
  assert.equal(calls, 1); assert.equal(s.element('workspace').disabled, true);
  await s.sandbox.saveSingleFile(); assert.equal(calls, 1);
  vm.runInContext("properties.title='Later edit';refreshPreview();", s.ctx);
  resolve(target.handle); await pending;
  assert.equal(target.content(), before);
});
