/* File handles are stored separately from Chrome's JSON-only settings. */
var YTD_EXPORT_STORAGE = (() => {
  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("ytd-markdown-export", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("handles");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }

  async function directory(action, value) {
    const db = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("handles", action === "get" ? "readonly" : "readwrite");
        const store = tx.objectStore("handles");
        const request = action === "get" ? store.get("default") : action === "put" ? store.put(value, "default") : store.delete("default");
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("目录设置未保存。"));
      });
    } finally { db.close(); }
  }

  async function existingFile(dir, name) {
    try { return await dir.getFileHandle(name); }
    catch (error) { if (error.name === "NotFoundError") return null; throw error; }
  }

  // The caller requests permission directly from the user's click. Confirm
  // before opening a writable stream; never truncate on cancel/failure.
  async function writeDocument(dir, document, confirmOverwrite) {
    let handle = await existingFile(dir, document.filename);
    if (handle && !(await confirmOverwrite(document.filename))) return { saved: false, canceled: true };
    if (!handle) {
      handle = await dir.getFileHandle(document.filename, { create: true });
      // Another application may have created a populated file in between.
      if ((await handle.getFile()).size > 0 && !(await confirmOverwrite(document.filename))) return { saved: false, canceled: true };
    }
    return saveFile(handle, document);
  }

  // A save-file picker grants access only to the explicitly selected file.
  // The browser owns its same-name overwrite confirmation.
  async function saveFile(handle, document) {
    let stream;
    try {
      stream = await handle.createWritable();
      await stream.write(document.markdown);
      await stream.close();
      return { saved: true, filename: handle.name || document.filename };
    } catch (error) {
      if (stream) await stream.abort().catch(() => {});
      throw error;
    }
  }

  async function save(dir, document, confirmOverwrite, locks = globalThis.navigator?.locks) {
    const write = () => writeDocument(dir, document, confirmOverwrite);
    // Serialize our own windows, including the existence check and decision.
    return locks ? locks.request(`ytd-markdown:${document.filename}`, write) : write();
  }
  return { directory, save, saveFile };
})();
if (typeof module !== "undefined" && module.exports) module.exports = YTD_EXPORT_STORAGE;
