/* =========================================================================
   sw.js - Service Worker của StudyHub

   1. Lưu (cache) giao diện để sinh viên MỞ ĐƯỢC TRANG khi mất mạng
      (cần mở trang khi có mạng ít nhất 1 lần; chỉ chạy trên HTTPS hoặc localhost).
   2. Background Sync: khi có mạng lại, tự gửi các bài nộp XML còn trong hàng đợi
      (IndexedDB 'studyhub-offline') kể cả khi sinh viên đã đóng trang
      (chỉ Chrome/Edge/Android hỗ trợ; các trình duyệt khác đồng bộ lúc mở lại trang).
   Không bao giờ cache các yêu cầu tới api/ - dữ liệu luôn lấy trực tiếp từ máy chủ.
   ========================================================================= */
const SHELL_CACHE = 'studyhub-shell-v2';
const SHELL_FILES = ['./', 'index.html', 'style.css', 'script.js', 'nop_bai.js', 'excel_import.js'];
const CDN_HOSTS = [
    'cdn.tailwindcss.com',
    'cdnjs.cloudflare.com',
    'fonts.googleapis.com',
    'fonts.gstatic.com'
];
const DB_NAME = 'studyhub-offline';
const STORE = 'submissions';
const SYNC_TAG = 'sync-submissions';

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(SHELL_CACHE)
            .then(cache => Promise.allSettled(SHELL_FILES.map(f => cache.add(f))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== SHELL_CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    const sameOrigin = url.origin === self.location.origin;

    if (sameOrigin) {
        // API: luôn đi thẳng tới máy chủ
        if (url.pathname.indexOf('/api/') !== -1 || url.pathname.indexOf('/storage/') !== -1) return;
        // Giao diện: ưu tiên bản mới từ mạng, mất mạng thì dùng bản đã lưu
        event.respondWith(networkFirst(req));
        return;
    }

    if (CDN_HOSTS.indexOf(url.hostname) !== -1) {
        // Thư viện/phông chữ trên CDN: dùng bản đã lưu nếu có, đồng thời cập nhật ngầm
        event.respondWith(staleWhileRevalidate(req));
    }
});

async function networkFirst(req) {
    const cache = await caches.open(SHELL_CACHE);
    try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
    } catch (err) {
        const hit = await cache.match(req, { ignoreSearch: true });
        if (hit) return hit;
        if (req.mode === 'navigate') {
            const page = await cache.match('index.html', { ignoreSearch: true });
            if (page) return page;
        }
        throw err;
    }
}

async function staleWhileRevalidate(req) {
    const cache = await caches.open(SHELL_CACHE);
    const hit = await cache.match(req);
    const refresh = fetch(req)
        .then(res => {
            if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
            return res;
        })
        .catch(() => null);
    return hit || (await refresh) || Response.error();
}

/* ---------------- Background Sync: gửi hàng đợi bài nộp ---------------- */

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                const st = db.createObjectStore(STORE, { keyPath: 'clientId' });
                st.createIndex('username', 'username', { unique: false });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function dbRun(mode, fn) {
    return openDb().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
        tx.onerror = () => { db.close(); reject(tx.error); };
        tx.onabort = () => { db.close(); reject(tx.error); };
    }));
}

async function notifyClients(item) {
    const list = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    list.forEach(c => c.postMessage({
        type: 'submission-synced',
        clientId: item.clientId,
        homeworkTitle: item.homeworkTitle,
        fileName: item.fileName
    }));
}

async function drainQueue() {
    const items = (await dbRun('readonly', s => s.getAll()) || [])
        .filter(i => i.status === 'pending')
        .sort((a, b) => a.createdAt - b.createdAt);

    for (const item of items) {
        let res;
        try {
            res = await fetch('api/submissions.php?action=sync', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/xml; charset=UTF-8' },
                body: item.xml
            });
        } catch (err) {
            throw err; // vẫn chưa có mạng: để trình duyệt tự thử lại sau
        }

        if (res.ok) {
            await dbRun('readwrite', s => s.delete(item.clientId));
            await notifyClients(item);
        } else if (res.status === 401 || res.status >= 500) {
            throw new Error('Chưa thể đồng bộ (HTTP ' + res.status + ')'); // thử lại sau
        }
        // 4xx khác (bài bị từ chối, sai tài khoản...): để trang web xử lý và báo lỗi cho sinh viên
    }
}

self.addEventListener('sync', event => {
    if (event.tag === SYNC_TAG) {
        event.waitUntil(drainQueue());
    }
});
