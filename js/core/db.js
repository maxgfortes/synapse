// IndexedDB: biblioteca, playlists, eventos, audio local e modelo.

const NAME = 'synapse';
const VERSION = 1;
let connection = null;

function open() {
  if (connection) return connection;
  connection = new Promise((resolve, reject) => {
    const request = indexedDB.open(NAME, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('tracks', { keyPath: 'id' });
      db.createObjectStore('playlists', { keyPath: 'id' });
      db.createObjectStore('audio', { keyPath: 'id' });
      db.createObjectStore('kv', { keyPath: 'key' });
      const events = db.createObjectStore('events', { keyPath: 'seq', autoIncrement: true });
      events.createIndex('ts', 'ts');
      events.createIndex('trackId', 'trackId');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return connection;
}

const done = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export const db = {
  async all(name) {
    return done((await store(name)).getAll());
  },
  async get(name, key) {
    return done((await store(name)).get(key));
  },
  async put(name, value) {
    return done((await store(name, 'readwrite')).put(value));
  },
  async remove(name, key) {
    return done((await store(name, 'readwrite')).delete(key));
  },
  async clear(name) {
    return done((await store(name, 'readwrite')).clear());
  },
  async bulkPut(name, values) {
    const instance = await open();
    return new Promise((resolve, reject) => {
      const tx = instance.transaction(name, 'readwrite');
      const objects = tx.objectStore(name);
      for (const value of values) objects.put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
  async getKV(key, fallback = null) {
    const row = await this.get('kv', key);
    return row ? row.value : fallback;
  },
  setKV(key, value) {
    return this.put('kv', { key, value });
  },
  async addEvent(event) {
    return this.put('events', event);
  },
  async trimEvents(limit = 20000) {
    const objects = await store('events', 'readwrite');
    const total = await done(objects.count());
    if (total <= limit) return;
    let excess = total - limit;
    await new Promise((resolve) => {
      const cursor = objects.openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c || excess-- <= 0) return resolve();
        c.delete();
        c.continue();
      };
    });
  },
  async wipe() {
    await Promise.all(['tracks', 'playlists', 'audio', 'kv', 'events'].map((name) => this.clear(name)));
  },
};
