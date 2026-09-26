/* ═══════════════════════════════════════════════════════════════════════════
   Storage helpers — localStorage with IndexedDB fallback for large payloads.
   localStorage limit is typically ~5MB; SAP MB51 exports can easily exceed
   that. We try localStorage first, fall back to IndexedDB transparently.
═══════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  /* PERF-STORE-NS (MRP Performance v0.1.0-dev, 2026-09-25) — own namespace.
     (Namespace kept as mrpPerf after the 2026-09-26 rename to Calibre Mirror so
     saved datasets and settings carry over.) Tune (Inventory_Optimization) and
     Calibre Mirror (repo Calibre-Mirror, formerly MRP-Performance) are both served from
     aisandbox-bj.github.io, and browser storage is per-ORIGIN, not per path.
     Tune uses 'invOpt' / 'invOptApp'; re-using them here would let this
     app read, overwrite or wipe (Clear session data) Tune's saved intakes.
     Everything this app stores lives under 'mrpPerf' / 'mrpPerfApp'. */
  const NAMESPACE        = 'mrpPerf';
  const IDB_NAME         = 'mrpPerfApp';
  const IDB_STORE        = 'kv';
  const IDB_VERSION      = 1;
  const LOCAL_LIMIT_HINT = 4 * 1024 * 1024;   // 4MB safety threshold; bigger → IDB

  function nsKey(k){ return NAMESPACE + '.' + k; }

  /* ─── IndexedDB primitives ──────────────────────────────────────────────── */
  function openIdb(){
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }
  async function idbPut(key, value){
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror    = () => { db.close(); reject(tx.error); };
    });
  }
  async function idbGet(key){
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => { db.close(); resolve(req.result); };
      req.onerror   = () => { db.close(); reject(req.error); };
    });
  }
  async function idbDel(key){
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror    = () => { db.close(); reject(tx.error); };
    });
  }
  async function idbKeys(){
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).getAllKeys();
      req.onsuccess = () => { db.close(); resolve(req.result || []); };
      req.onerror   = () => { db.close(); reject(req.error); };
    });
  }

  /* ─── Public API ────────────────────────────────────────────────────────── */

  /**
   * Set a value. Returns a promise. Routes large payloads to IDB transparently.
   * Marks where the value lives via a small index entry in localStorage.
   */
  async function set(key, value){
    const fullKey = nsKey(key);
    const json    = JSON.stringify(value);
    const size    = json.length;

    // small → localStorage
    if (size < LOCAL_LIMIT_HINT) {
      try {
        localStorage.setItem(fullKey, json);
        localStorage.setItem(fullKey + '.__store', 'local');
        return { ok: true, store: 'local', size };
      } catch (e) {
        // quota exceeded → fall through to IDB
      }
    }
    // large → IndexedDB
    await idbPut(fullKey, value);
    localStorage.setItem(fullKey + '.__store', 'idb');
    return { ok: true, store: 'idb', size };
  }

  /**
   * Get a value. Checks the index first to know where to look.
   * Returns the parsed value, or null if not found.
   */
  async function get(key){
    const fullKey = nsKey(key);
    const where   = localStorage.getItem(fullKey + '.__store');
    if (where === 'idb') {
      const v = await idbGet(fullKey);
      return v == null ? null : v;
    }
    const raw = localStorage.getItem(fullKey);
    if (raw == null) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  /**
   * Delete a value (from whichever store it lives in).
   */
  async function del(key){
    const fullKey = nsKey(key);
    const where   = localStorage.getItem(fullKey + '.__store');
    if (where === 'idb') {
      await idbDel(fullKey);
    }
    localStorage.removeItem(fullKey);
    localStorage.removeItem(fullKey + '.__store');
  }

  /**
   * List all keys in our namespace (returns short keys without prefix).
   */
  async function keys(){
    const out = new Set();
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(NAMESPACE + '.') && !k.endsWith('.__store')) {
        out.add(k.slice(NAMESPACE.length + 1));
      }
    }
    try {
      const idbKs = await idbKeys();
      for (const k of idbKs) {
        if (typeof k === 'string' && k.startsWith(NAMESPACE + '.')) {
          out.add(k.slice(NAMESPACE.length + 1));
        }
      }
    } catch (e) { /* IDB may not have been used yet */ }
    return [...out];
  }

  /**
   * Wipe everything in our namespace — used by Settings "factory reset".
   */
  async function wipeAll(){
    const ks = await keys();
    for (const k of ks) await del(k);
  }

  global.AppStorage = Object.freeze({ set, get, del, keys, wipeAll, NAMESPACE });

})(window);
