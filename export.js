/* A dedicated extension page owns a fixed subtitle snapshot while editing. */
const M = YTD_MARKDOWN;
const FILES = YTD_EXPORT_STORAGE;
const SETTINGS_KEY = "ytd_markdown_templates";
const DIRECTORY_KEY = "ytd_markdown_default_directory";
const $ = id => document.getElementById(id);
let source = null, templates = [], selectedId = "", properties = {}, speakers = [];
let directory = null, savedRevision = null, rendered = null, saving = false;
let editor = null, importWarnings = [], speakerRun = 0, identifying = false;
let draftKey = "", restoring = true;

function status(message, error = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", error);
}
function button(label, action) {
  const element = document.createElement("button");
  element.type = "button"; element.textContent = label;
  element.addEventListener("click", action); return element;
}
function input(label, value, onChange, type = "text") {
  const wrapper = document.createElement("label"); wrapper.textContent = label;
  const element = document.createElement("input"); element.type = type; element.value = value;
  element.addEventListener("input", () => onChange(element.value));
  wrapper.append(element); return wrapper;
}
function activeTemplate() { return templates.find(t => t.id === selectedId); }

function confirmAction(message, label = "确认") {
  const dialog = $("confirmDialog");
  $("confirmText").textContent = message; $("confirmAction").textContent = label;
  dialog.returnValue = "";
  return new Promise(resolve => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
    dialog.showModal();
  });
}

async function persistTemplates(nextTemplates, nextId) {
  const update = async () => {
    const stored = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
    if ((stored?.revision ?? null) !== savedRevision) throw new Error("模板已在另一个窗口中修改。请先保留当前编辑内容，再重新打开此窗口。");
    const revision = crypto.randomUUID();
    await chrome.storage.local.set({ [SETTINGS_KEY]: { revision, templates: nextTemplates, selectedId: nextId } });
    templates = nextTemplates; selectedId = nextId; savedRevision = revision;
  };
  return navigator.locks ? navigator.locks.request("ytd-markdown-templates", update) : update();
}

function refreshPreview() {
  rendered = null;
  try {
    if (source) {
      rendered = M.render(activeTemplate(), source, properties, speakers);
      $("preview").value = rendered.markdown;
      $("filename").textContent = rendered.filename;
      $("filenameNotice").textContent = rendered.filename !== `${String(properties.title ?? "").trim()}.md` ? "标题含系统不允许的文件名字符，已替换为下划线；以上为实际文件名。" : "";
    }
  } catch (error) {
    $("preview").value = ""; $("filename").textContent = "—";
    $("filenameNotice").textContent = error.message;
  }
  $("download").disabled = !rendered || !directory || saving || identifying || speakers.some(item => !item.confirmed);
  $("saveFile").disabled = !rendered || saving || identifying || speakers.some(item => !item.confirmed) || typeof showSaveFilePicker !== "function";
  $("manualSpeaker").disabled = !source || identifying;
  if (!restoring && draftKey && source) {
    try { sessionStorage.setItem(`${draftKey}_edits`, JSON.stringify({ templateId: selectedId, template: JSON.stringify(activeTemplate()), properties, speakers })); }
    catch { status("浏览器无法暂存编辑。请保持此窗口打开，完成保存。", true); }
  }
}

function renderProperties() {
  const host = $("properties"); host.replaceChildren();
  for (const property of activeTemplate().properties) {
    const row = document.createElement("div"); row.className = "property";
    const label = document.createElement("label"); label.textContent = property.name;
    const field = document.createElement(property.type === "multitext" ? "textarea" : "input");
    field.id = `property-${host.children.length}`; label.htmlFor = field.id;
    if (property.type === "multitext") field.rows = 1;
    else field.type = property.type === "checkbox" ? "checkbox" : property.type === "date" ? "date" : property.type === "number" ? "number" : "text";
    if (property.type === "number") field.step = "any";
    field.value = properties[property.name] ?? ""; field.checked = field.value === "true";
    if (property.type === "multitext") field.placeholder = "每行一项，也支持 JSON 数组";
    field.addEventListener("input", () => {
      properties[property.name] = property.type === "checkbox" ? String(field.checked) : field.value;
      refreshPreview();
    });
    row.append(label, field); host.append(row);
  }
}

function selectTemplate(id) {
  selectedId = id;
  properties = source ? M.initialProperties(activeTemplate(), source) : Object.fromEntries(activeTemplate().properties.map(p => [p.name, ""]));
  $("templateChoices").replaceChildren(...templates.map(template => {
    const choice = button(template.name, async () => {
      if (template.id === selectedId) return;
      if (source && !(await confirmAction("切换模板会重置本次填写的文档属性，是否继续？", "切换模板"))) return;
      selectTemplate(template.id);
    });
    choice.setAttribute("aria-pressed", String(template.id === id)); return choice;
  }));
  renderProperties(); refreshPreview();
}

function updateEditorIssues() {
  editor.name = $("templateName").value;
  editor.noteContentFormat = $("templateBody").value;
  const errors = M.templateErrors(editor);
  $("templateIssues").textContent = [...importWarnings.map(w => `兼容说明：${w}`), ...errors.map(e => `需要修改：${e}`)].join("\n");
  $("ackLabel").hidden = !importWarnings.length;
  $("saveTemplate").disabled = errors.length > 0 || (importWarnings.length > 0 && !$("ackImport").checked);
}

function renderEditorProperties() {
  const host = $("templateProperties"); host.replaceChildren();
  editor.properties.forEach((property, index) => {
    const row = document.createElement("div"); row.className = "template-property";
    row.append(input("属性名称", property.name ?? "", value => { property.name = value; updateEditorIssues(); }));
    const types = document.createElement("div"); types.className = "type-choices";
    const names = { text: "文本", multitext: "列表", number: "数字", checkbox: "复选框", date: "日期", datetime: "日期时间" };
    for (const type of M.TYPES) {
      const choice = button(names[type], () => { property.type = type; renderEditorProperties(); updateEditorIssues(); });
      choice.setAttribute("aria-pressed", String(property.type === type)); types.append(choice);
    }
    row.append(types, input("默认值或变量", typeof property.value === "string" ? property.value : JSON.stringify(property.value ?? ""), value => { property.value = value; updateEditorIssues(); }));
    const actions = document.createElement("div"); actions.className = "actions";
    const move = direction => {
      const target = index + direction;
      if (target < 0 || target >= editor.properties.length) return;
      [editor.properties[index], editor.properties[target]] = [editor.properties[target], editor.properties[index]];
      renderEditorProperties(); updateEditorIssues();
    };
    const up = button("上移", () => move(-1)); up.disabled = index === 0;
    const down = button("下移", () => move(1)); down.disabled = index === editor.properties.length - 1;
    actions.append(up, down, button("删除属性", () => { editor.properties.splice(index, 1); renderEditorProperties(); updateEditorIssues(); }));
    row.append(actions); host.append(row);
  });
}

function openEditor(template, warnings = []) {
  editor = structuredClone(template); importWarnings = warnings;
  if (!Array.isArray(editor.properties)) editor.properties = [];
  editor.properties = editor.properties.map(p => p && typeof p === "object" ? p : { name: "", type: "text", value: "" });
  $("templateName").value = editor.name; $("templateBody").value = editor.noteContentFormat;
  $("ackImport").checked = false;
  renderEditorProperties(); updateEditorIssues(); $("templateDialog").showModal();
}

function showDirectory() {
  $("directoryLabel").textContent = directory ? `目录：${directory.name}` : "尚未选择目录";
  $("chooseDirectory").textContent = directory ? "更换目录" : "选择目录";
  refreshPreview();
}

function renderSpeakers() {
  const host = $("speakers"); host.replaceChildren();
  speakers.forEach((item, index) => {
    const row = document.createElement("div"); row.className = "speaker";
    const first = source.segments.findIndex(s => s.id === item.startId) + 1;
    const last = source.segments.findIndex(s => s.id === item.endId) + 1;
    row.append(input(`候选姓名 · 第 ${first} 至 ${last} 段`, item.name, value => { item.name = value; item.confirmed = false; checkbox.checked = false; refreshPreview(); }));
    const quote = document.createElement("blockquote"); quote.textContent = item.evidence; row.append(quote);
    const details = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = "查看对应的全部发言";
    const all = document.createElement("blockquote");
    const start = source.segments.findIndex(s => s.id === item.startId), end = source.segments.findIndex(s => s.id === item.endId);
    all.textContent = source.segments.slice(start, end + 1).map(s => s.text).join("\n"); details.append(summary, all); row.append(details);
    const label = document.createElement("label"); label.className = "check";
    const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = item.confirmed;
    checkbox.addEventListener("change", () => {
      item.confirmed = checkbox.checked && !!item.name.trim(); checkbox.checked = item.confirmed; refreshPreview();
    });
    label.append(checkbox, document.createTextNode("我确认此姓名及对应发言"));
    row.append(label, button("不采用此候选", () => { speakers.splice(index, 1); renderSpeakers(); }));
    host.append(row);
  });
  refreshPreview();
}

async function identifySpeakers() {
  if (identifying) {
    speakerRun++; identifying = false; $("identifySpeakers").textContent = "用模型识别姓名";
    $("speakerStatus").textContent = "已停止后续识别。已发出的请求可能仍在完成，结果不会再应用。";
    refreshPreview(); return;
  }
  if (!source) return;
  if (speakers.length && !(await confirmAction("重新识别会替换当前的候选及确认标注，是否继续？", "重新识别"))) return;
  const run = ++speakerRun;
  try {
    const batches = M.speakerBatches(source.segments);
    identifying = true; $("identifySpeakers").textContent = "停止识别"; refreshPreview();
    // Preserve existing annotations if any batch fails or the user stops.
    const candidates = [];
    for (let index = 0; index < batches.length; index++) {
      $("speakerStatus").textContent = `正在识别 ${index + 1} / ${batches.length} 批字幕；请稍候…`;
      const response = await chrome.runtime.sendMessage({ action: "identifyExportSpeakers", segments: batches[index], title: source.title, author: source.author, context: source.segments.slice(0, 8).map(s => s.text).join("\n").slice(0, 2000) });
      if (run !== speakerRun) return;
      if (!response?.success) throw new Error(response?.error || "识别未完成，请重试。");
      candidates.push(...M.validateSpeakers({ speakers: response.speakers }, batches[index]));
    }
    speakers = candidates; renderSpeakers();
    $("speakerStatus").textContent = candidates.length ? "请逐项检查姓名和对应发言，修改后勾选确认；不采用的候选可移除。未标注的字幕保持原文。" : "模型未找到有依据的姓名。可以手动标注，或直接保留字幕原文。";
  } catch (error) { if (run === speakerRun) $("speakerStatus").textContent = `识别失败：${error.message} 已有标注保留，可重试或手动填写。`; }
  finally { if (run === speakerRun) { identifying = false; $("identifySpeakers").textContent = "用模型识别姓名"; refreshPreview(); } }
}

async function saveDocument() {
  if (saving || !directory || !rendered) return;
  const document = rendered; const target = directory;
  saving = true; $("workspace").disabled = true; status("正在保存…");
  try {
    // Request directly from the click, before any storage or model waits.
    if (await target.requestPermission({ mode: "readwrite" }) !== "granted") throw new Error("目录未授权，文件未保存。请重新选择目录或允许访问。");
    const result = await FILES.save(target, document, name => confirmAction(`目录「${target.name}」中已存在「${name}」。覆盖会替换其中的全部内容，包括你手动补写的内容。`, "覆盖文件"));
    status(result.saved ? `已保存：${target.name} / ${result.filename}` : "已取消覆盖，原文件保持不变。");
  } catch (error) {
    status(error.name === "AbortError" ? "已取消，未完成保存。" : `未完成保存：${error.message} 你的编辑内容仍在此窗口。`, true);
  } finally { saving = false; $("workspace").disabled = false; refreshPreview(); }
}

async function saveSingleFile() {
  if (saving || !rendered || identifying || speakers.some(item => !item.confirmed)) return;
  const document = rendered;
  saving = true; $("workspace").disabled = true; status("请选择文件保存位置…");
  try {
    // Invoke the picker before any await to retain the click's user activation.
    // Let Chrome enforce sensitive-path restrictions for this file as well.
    const handle = await showSaveFilePicker({
      suggestedName: document.filename, id: "ytd-markdown-file",
      types: [{ description: "Markdown 文档", accept: { "text/markdown": [".md"] } }],
      excludeAcceptAllOption: true,
    });
    const result = await FILES.saveFile(handle, document);
    status(`已保存：${result.filename}`);
  } catch (error) {
    status(error.name === "AbortError" ? "已取消另存为，未完成保存。你的编辑内容仍在此窗口。" : `未完成另存为：${error.message} 你的编辑内容仍在此窗口。`, true);
  } finally { saving = false; $("workspace").disabled = false; refreshPreview(); }
}

async function init() {
  const token = new URLSearchParams(location.search).get("draft");
  if (token && /^[a-f0-9-]{36}$/.test(token)) {
    const key = `ytd_markdown_draft_${token}`;
    draftKey = key;
    source = JSON.parse(sessionStorage.getItem(key) || "null");
    if (!source) {
      source = (await chrome.storage.session.get(key))[key] ?? null;
      if (source) { sessionStorage.setItem(key, JSON.stringify(source)); await chrome.storage.session.remove(key); }
    }
  }
  const settings = await chrome.storage.local.get([SETTINGS_KEY, DIRECTORY_KEY]);
  const stored = settings[SETTINGS_KEY]; savedRevision = stored?.revision ?? null;
  templates = stored?.templates ?? [{ ...structuredClone(M.DEFAULT_TEMPLATE), id: "default-youtube-transcript" }];
  if (!templates.length || templates.some(t => M.templateErrors(t).length)) throw new Error("已保存的模板格式无效。请导出备份后重新配置模板。");
  if (settings[DIRECTORY_KEY]) {
    try { directory = await FILES.directory("get"); $("rememberDirectory").checked = !!directory; }
    catch { status("默认目录暂时无法读取，请重新选择目录。文档和模板仍可编辑。", true); }
  }
  $("sourceInfo").textContent = source ? `${source.title} · ${source.author} · 字幕语言：${source.language}` : "模板管理：在视频字幕页点击「保存 Markdown」即可预览并保存视频文档。";
  if (token && !source) status("这份保存草稿已失效。请回到视频字幕页重新点击「保存 Markdown」。", true);
  else if (source?.legacySource) status("此视频使用已有字幕缓存，早先被清理的说话人标记无法恢复；文字中的名字仍会保留。");
  if (typeof showDirectoryPicker !== "function") status("此浏览器不支持目录保存。可尝试另存为单个文件，或使用新版 Chrome。", true);
  $("identifySpeakers").disabled = !source; $("manualSpeaker").disabled = !source;
  $("workspace").disabled = false;
  selectTemplate(templates.some(t => t.id === stored?.selectedId) ? stored.selectedId : templates[0].id);
  const edits = draftKey ? JSON.parse(sessionStorage.getItem(`${draftKey}_edits`) || "null") : null;
  if (edits && templates.some(t => t.id === edits.templateId && JSON.stringify(t) === edits.template)) {
    selectTemplate(edits.templateId); properties = edits.properties; speakers = edits.speakers;
    renderProperties(); renderSpeakers();
  }
  restoring = false;
  showDirectory();
}

$("editTemplate").addEventListener("click", () => openEditor(activeTemplate()));
$("newTemplate").addEventListener("click", () => openEditor({ ...structuredClone(M.DEFAULT_TEMPLATE), id: crypto.randomUUID(), name: "新模板" }));
$("duplicateTemplate").addEventListener("click", () => openEditor({ ...structuredClone(activeTemplate()), id: crypto.randomUUID(), name: `${activeTemplate().name} 副本` }));
$("cancelTemplate").addEventListener("click", () => $("templateDialog").close());
$("templateName").addEventListener("input", updateEditorIssues);
$("templateBody").addEventListener("input", updateEditorIssues);
$("ackImport").addEventListener("change", updateEditorIssues);
$("addProperty").addEventListener("click", () => { editor.properties.push({ name: "", type: "text", value: "" }); renderEditorProperties(); updateEditorIssues(); });
$("templateForm").addEventListener("submit", async event => {
  event.preventDefault(); updateEditorIssues(); if ($("saveTemplate").disabled) return;
  try {
    editor.id ||= crypto.randomUUID();
    const next = templates.some(t => t.id === editor.id) ? templates.map(t => t.id === editor.id ? editor : t) : [...templates, editor];
    if (next.length > 50) throw new Error("最多保存 50 个模板。");
    await persistTemplates(next, editor.id); selectTemplate(editor.id); $("templateDialog").close(); status("模板已保存，文档属性已应用新的默认值。");
  } catch (error) { $("templateIssues").textContent = error.message; }
});
$("importTemplate").addEventListener("click", () => $("templateFile").click());
$("templateFile").addEventListener("change", async () => {
  const file = $("templateFile").files[0]; $("templateFile").value = ""; if (!file) return;
  try {
    if (file.size > 1024 * 1024) throw new Error("模板文件不能超过 1 MiB。");
    const result = M.importTemplate(await file.text());
    openEditor({ ...result.template, id: crypto.randomUUID() }, result.warnings);
  } catch (error) { status(`导入失败：${error.message}`, true); }
});
$("exportTemplate").addEventListener("click", () => {
  const { id, ...template } = activeTemplate();
  const url = URL.createObjectURL(new Blob([JSON.stringify(template, null, 2)], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = "youtube-digest-template.json"; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
});
$("deleteTemplate").addEventListener("click", async () => {
  if (templates.length === 1) { status("请至少保留一个模板。"); return; }
  if (!(await confirmAction(`删除模板「${activeTemplate().name}」？已保存的 Markdown 文件不会改变。`, "删除模板"))) return;
  try { const next = templates.filter(t => t.id !== selectedId); await persistTemplates(next, next[0].id); selectTemplate(selectedId); status("模板已删除。"); }
  catch (error) { status(error.message, true); }
});
$("chooseDirectory").addEventListener("click", async () => {
  try {
    const picked = await showDirectoryPicker({ mode: "readwrite", id: "ytd-markdown-export" });
    directory = picked;
    if ($("rememberDirectory").checked) { await FILES.directory("put", picked); await chrome.storage.local.set({ [DIRECTORY_KEY]: true }); }
    showDirectory(); status("目录已选择。检查预览后点击下载。");
  } catch (error) {
    status(error.name === "AbortError"
      ? "未选择新目录。若 Chrome 提示“含有系统文件”，请选择普通子文件夹，或点击“另存为单个文件”。你的编辑内容已保留。"
      : `无法选择目录：${error.message} 可另选普通子文件夹，或点击“另存为单个文件”。`, true);
  }
});
$("rememberDirectory").addEventListener("change", async () => {
  try {
    if ($("rememberDirectory").checked) {
      if (!directory) { $("rememberDirectory").checked = false; status("请先选择一个目录。"); return; }
      await FILES.directory("put", directory); await chrome.storage.local.set({ [DIRECTORY_KEY]: true }); status("已记住默认目录。");
    } else { await FILES.directory("delete"); await chrome.storage.local.remove(DIRECTORY_KEY); status("已取消默认目录，本次仍可保存到当前目录。"); }
  } catch (error) { $("rememberDirectory").checked = false; status(`未能保存目录设置：${error.message}`, true); }
});
$("forgetDirectory").addEventListener("click", async () => {
  try { await FILES.directory("delete"); await chrome.storage.local.remove(DIRECTORY_KEY); $("rememberDirectory").checked = false; directory = null; showDirectory(); status("已忘记默认目录。"); }
  catch (error) { status(error.message, true); }
});
$("identifySpeakers").addEventListener("click", identifySpeakers);
$("manualSpeaker").addEventListener("click", () => {
  $("manualStart").max = source.segments.length; $("manualEnd").max = source.segments.length;
  $("manualName").value = ""; $("manualError").textContent = "";
  updateManualExcerpt(); $("manualDialog").showModal();
});
function updateManualExcerpt() {
  const start = Number($("manualStart").value) - 1, end = Number($("manualEnd").value);
  $("manualExcerpt").value = start >= 0 && end > start ? source.segments.slice(start, end).map((s, i) => `第 ${start + i + 1} 段：${s.text}`).join("\n\n") : "请选择有效的起止段落。";
}
$("manualStart").addEventListener("input", updateManualExcerpt);
$("manualEnd").addEventListener("input", updateManualExcerpt);
$("cancelManual").addEventListener("click", () => $("manualDialog").close());
$("manualForm").addEventListener("submit", event => {
  event.preventDefault();
  const start = Number($("manualStart").value) - 1, end = Number($("manualEnd").value) - 1;
  const name = $("manualName").value.trim();
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= source.segments.length || !name) { $("manualError").textContent = "请填写有效的姓名和字幕范围。"; return; }
  speakers.push({ startId: source.segments[start].id, endId: source.segments[end].id, name, evidence: source.segments.slice(start, end + 1).map(s => s.text).join("\n"), confirmed: false });
  renderSpeakers(); $("manualDialog").close();
});
$("download").addEventListener("click", saveDocument);
$("saveFile").addEventListener("click", saveSingleFile);
init().catch(error => status(`无法打开保存窗口：${error.message}`, true));
