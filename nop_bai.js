/* =========================================================================
   nop_bai.js - SINH VIÊN NỘP BÀI TẬP (hoạt động cả khi mất mạng)

   Luồng chính:
   1. Sinh viên chọn bài tập (do GV giao) + tệp + ghi chú -> trình duyệt đóng gói thành 1 file
      XML (cấu trúc: api/xsd/bai_nop.xsd; tệp được mã hóa base64 bên trong XML).
   2. CÓ MẠNG : gửi XML lên api/submissions.php ngay -> hiện thông báo "Nộp bài thành công".
      MẤT MẠNG: XML được lưu trên thiết bị (IndexedDB) trong "hàng đợi chờ đồng bộ".
   3. Khi có mạng lại, hàng đợi TỰ ĐỘNG gửi lên chạy nền (sự kiện 'online', mở lại trang, định
      kỳ 30 giây, và Background Sync của Service Worker khi trình duyệt hỗ trợ). Server kiểm tra
      XSD, dùng XPath đọc các trường rồi lưu cho giảng viên xem. Mỗi bài có clientId riêng nên
      gửi lại nhiều lần vẫn chỉ nộp 1 lần.
   4. Sinh viên chỉ thấy bài của mình (server lọc theo tài khoản); giảng viên thấy tất cả.
   ========================================================================= */

const NOP_MAX_BYTES = 10 * 1024 * 1024;
const NOP_DB_NAME = 'studyhub-offline';
const NOP_STORE = 'submissions';
const NOP_MAX_ATTEMPTS = 5;          // lỗi máy chủ (5xx) quá số lần này thì dừng tự thử lại
const NOP_AUTO_SYNC_MS = 30000;
const NOP_SESSION_KEY = 'sh_session';
const NOP_CACHE_PREFIX = 'sh_cache|';

let nopMine = [];            // SV: bài đã nộp (từ server)
let nopGvRows = [];          // GV: bài nộp của sinh viên
let nopPending = [];         // SV: bài trong hàng đợi (thiết bị này)
let nopPendingCount = 0;
let nopLoadSeq = 0;
let nopSyncing = false;
let nopSubmitHwId = null;
let nopSubmitBusy = false;
let nopStoragePersistAsked = false;
const nopNotified = new Set();

/* ---------------------------------------------------------------------
   IndexedDB: hàng đợi bài nộp chờ đồng bộ (mỗi bản ghi giữ nguyên chuỗi XML)
   --------------------------------------------------------------------- */
function nopOpenDb() {
    return new Promise((resolve, reject) => {
        if (!window.indexedDB) {
            reject(new Error('Trình duyệt này không hỗ trợ lưu dữ liệu offline (IndexedDB).'));
            return;
        }
        const req = indexedDB.open(NOP_DB_NAME, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(NOP_STORE)) {
                const st = db.createObjectStore(NOP_STORE, { keyPath: 'clientId' });
                st.createIndex('username', 'username', { unique: false });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('Không mở được IndexedDB.'));
    });
}

function nopReq(mode, fn) {
    return nopOpenDb().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(NOP_STORE, mode);
        const req = fn(tx.objectStore(NOP_STORE));
        tx.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
        tx.onerror = () => { db.close(); reject(tx.error || new Error('Lỗi IndexedDB.')); };
        tx.onabort = () => { db.close(); reject(tx.error || new Error('IndexedDB bị hủy (có thể hết dung lượng lưu trữ).')); };
    }));
}

const nopQueuePut = item => nopReq('readwrite', s => s.put(item));
const nopQueueDelete = key => nopReq('readwrite', s => s.delete(key));

async function nopQueueList(username) {
    const all = await nopReq('readonly', s => s.getAll());
    return (all || [])
        .filter(i => i.username === username)
        .sort((a, b) => a.createdAt - b.createdAt);
}

async function nopRefreshPending() {
    if (!isSV()) {
        nopPending = [];
        nopPendingCount = 0;
    } else {
        try {
            nopPending = await nopQueueList(currentUsername);
        } catch (err) {
            nopPending = [];
        }
        nopPendingCount = nopPending.length;
    }
    nopUpdateNav();
    return nopPending;
}

/* ---------------------------------------------------------------------
   Phiên đăng nhập + cache dữ liệu để mở được trang khi mất mạng
   (server vẫn kiểm tra lại tài khoản thật sự mỗi lần đồng bộ)
   --------------------------------------------------------------------- */
function nopPersistSession(data) {
    try {
        localStorage.setItem(NOP_SESSION_KEY, JSON.stringify({
            username: data.username,
            role: data.role,
            displayName: data.displayName || data.username,
            maSoSv: data.maSoSv || null,
            gioiHanMon: !!data.gioiHanMon
        }));
    } catch (e) { /* hết dung lượng: bỏ qua */ }
}

function nopRestoreOfflineSession() {
    try {
        const s = JSON.parse(localStorage.getItem(NOP_SESSION_KEY) || 'null');
        if (s && s.username && (s.role === 'gv' || s.role === 'sv')) {
            isLoggedIn = true;
            currentUsername = s.username;
            currentUserRole = s.role;
            currentDisplayName = s.displayName || s.username;
            currentMaSoSv = s.maSoSv || null;
            currentGioiHanMon = !!s.gioiHanMon;
            return true;
        }
    } catch (e) { /* dữ liệu hỏng: coi như chưa đăng nhập */ }
    return false;
}

function nopOnLogout() {
    try {
        localStorage.removeItem(NOP_SESSION_KEY);
        const prefix = NOP_CACHE_PREFIX + (currentUsername || 'guest') + '|';
        Object.keys(localStorage).forEach(k => { if (k.indexOf(prefix) === 0) localStorage.removeItem(k); });
    } catch (e) { /* bỏ qua */ }
}

function nopCacheable(path) {
    return !/^(session|login|logout)\.php/.test(path);
}
function nopCacheKey(path) {
    return NOP_CACHE_PREFIX + (currentUsername || 'guest') + '|' + path;
}
function nopCacheWrite(path, data) {
    if (!nopCacheable(path)) return;
    try { localStorage.setItem(nopCacheKey(path), JSON.stringify(data)); } catch (e) { /* đầy bộ nhớ */ }
}
function nopCacheRead(path) {
    if (!nopCacheable(path)) return null;
    try {
        const s = localStorage.getItem(nopCacheKey(path));
        return s === null ? null : JSON.parse(s);
    } catch (e) {
        return null;
    }
}

/* ---------------------------------------------------------------------
   Tiện ích
   --------------------------------------------------------------------- */
function nopIsOnline() {
    return navigator.onLine !== false;
}

function nopNewId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
    }
    const b = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) {
        window.crypto.getRandomValues(b);
    } else {
        for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

function nopIsoLocal(d) {
    const p = n => String(n).padStart(2, '0');
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const a = Math.abs(off);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(a / 60))}:${p(a % 60)}`;
}

// 'YYYY-MM-DD HH:MM:SS' (từ server) hoặc số ms (từ thiết bị) -> 'HH:MM DD/MM/YYYY'
function nopFmtTime(v) {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'number') {
        const d = new Date(v);
        const p = n => String(n).padStart(2, '0');
        return `${p(d.getHours())}:${p(d.getMinutes())} ${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
    }
    const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    return m ? `${m[4]}:${m[5]} ${m[3]}/${m[2]}/${m[1]}` : String(v);
}

// Ký tự điều khiển không được phép trong XML 1.0
function nopXmlClean(v) {
    return String(v === null || v === undefined ? '' : v)
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
}

function nopReadBase64(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => {
            const s = String(r.result);
            const i = s.indexOf(',');
            resolve(i >= 0 ? s.slice(i + 1) : '');
        };
        r.onerror = () => reject(r.error || new Error('Không đọc được tệp.'));
        r.readAsDataURL(file);
    });
}

function nopCanViewInline(fileName) {
    return /\.(pdf|png|jpe?g|gif|webp|txt)$/i.test(fileName || '');
}

/* ---------------------------------------------------------------------
   Đóng gói bài nộp thành XML (khớp api/xsd/bai_nop.xsd)
   --------------------------------------------------------------------- */
function nopBuildXml(o) {
    const doc = document.implementation.createDocument('', 'BaiNop', null);
    const root = doc.documentElement;
    root.setAttribute('clientId', o.clientId);
    root.setAttribute('cheDo', o.mode);

    const add = (parent, tag, text, attrs) => {
        const el = doc.createElement(tag);
        if (attrs) Object.keys(attrs).forEach(k => el.setAttribute(k, nopXmlClean(attrs[k])));
        el.appendChild(doc.createTextNode(nopXmlClean(text)));
        parent.appendChild(el);
        return el;
    };

    const sv = doc.createElement('SinhVien');
    root.appendChild(sv);
    add(sv, 'TenDangNhap', o.user.username);
    add(sv, 'HoTen', o.user.displayName || '');
    add(sv, 'MaSoSV', o.user.maSoSv || '');
    add(root, 'MonHoc', o.subjectName || '', { id: o.subjectId || '' });
    add(root, 'BaiTap', o.homeworkTitle || '', { id: o.homeworkId });
    add(root, 'GhiChu', o.note || '');
    add(root, 'ThoiGianNop', nopIsoLocal(o.when));
    add(root, 'Tep', o.base64, {
        ten: o.file.name,
        loai: o.file.type || 'application/octet-stream',
        kichThuoc: String(o.file.size)
    });

    return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(doc);
}

/* Gửi 1 XML lên server. Lỗi được phân loại để biết nên thử lại hay bỏ:
   err.network  : mất mạng/timeout (thử lại sau, không tính là lỗi)
   err.status   : mã HTTP; 401 = hết phiên đăng nhập (thử lại sau khi đăng nhập)
   err.permanent: server từ chối hẳn (XML sai, bài tập bị xóa, tệp quá lớn...) */
async function nopPostXml(xml) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    let res;
    try {
        res = await fetch(API_BASE + 'submissions.php?action=sync', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/xml; charset=UTF-8' },
            body: xml,
            signal: ctrl.signal
        });
    } catch (err) {
        clearTimeout(timer);
        const e = new Error('Mất kết nối mạng.');
        e.network = true;
        throw e;
    }
    clearTimeout(timer);

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { /* không phải JSON */ }

    if (res.ok && data && data.success) return data;

    const e = new Error((data && data.error) || `Lỗi máy chủ (HTTP ${res.status}).`);
    e.status = res.status;
    e.permanent = res.status >= 400 && res.status < 500 && ![401, 408, 429].includes(res.status);
    throw e;
}

/* ---------------------------------------------------------------------
   Đồng bộ nền: gửi các bài trong hàng đợi khi có mạng
   --------------------------------------------------------------------- */
async function nopSyncNow(opts) {
    const manual = !!(opts && opts.manual);
    if (nopSyncing || !isSV()) return;
    if (!nopIsOnline()) {
        if (manual) showToast('Hiện chưa có mạng, bài nộp vẫn được giữ trên thiết bị.', 'warning');
        return;
    }

    nopSyncing = true;
    nopRenderBanner();
    const done = [];
    let failed = 0;
    let needLogin = false;
    let noNetwork = false;

    try {
        const items = (await nopQueueList(currentUsername)).filter(i => i.status === 'pending');
        for (const it of items) {
            try {
                await nopPostXml(it.xml);
                await nopQueueDelete(it.clientId);
                done.push(it);
            } catch (err) {
                if (err.network) { noNetwork = true; break; }
                if (err.status === 401) { needLogin = true; break; }
                it.lastError = err.message;
                if (err.permanent) {
                    it.status = 'error';
                } else {
                    it.attempts = (it.attempts || 0) + 1;
                    if (it.attempts >= NOP_MAX_ATTEMPTS) it.status = 'error';
                }
                failed++;
                try { await nopQueuePut(it); } catch (e2) { /* bỏ qua */ }
            }
        }
    } catch (err) {
        console.error('nopSyncNow:', err);
    } finally {
        nopSyncing = false;
    }

    if (done.length === 1) {
        const it = done[0];
        if (!nopNotified.has(it.clientId)) {
            nopNotified.add(it.clientId);
            showToast(`Đã tự động nộp bài thành công: "${it.homeworkTitle}"`, 'success');
        }
    } else if (done.length > 1) {
        done.forEach(it => nopNotified.add(it.clientId));
        showToast(`Đã tự động nộp thành công ${done.length} bài tập đang chờ.`, 'success');
    }
    if (failed > 0) {
        showToast(`${failed} bài nộp bị máy chủ từ chối, xem chi tiết ở mục "Đang chờ đồng bộ" dưới bảng bài tập.`, 'error');
    }
    if (needLogin) {
        showToast('Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại để hoàn tất nộp bài đang chờ.', 'warning');
    }
    if (manual && done.length === 0 && failed === 0 && !needLogin) {
        showToast(noNetwork ? 'Chưa kết nối được máy chủ, sẽ tự thử lại.' : 'Không có bài nào đang chờ đồng bộ.', 'info');
    }

    await nopRefreshPending();
    if (done.length > 0) {
        await nopReloadIfTabActive();
    } else {
        nopRenderBanner();
        nopRenderPendingList();
    }
}

function nopRequestBackgroundSync() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.ready
        .then(reg => (reg.sync ? reg.sync.register('sync-submissions') : null))
        .catch(() => { /* trình duyệt không hỗ trợ Background Sync: dùng đồng bộ trong trang */ });
}

/* ---------------------------------------------------------------------
   Nộp bài (modal)
   --------------------------------------------------------------------- */
function nopSubjectOpen(hw) {
    if (!hw || !hw.subjectId) return true;
    const sub = subjects.find(s => s.id === hw.subjectId);
    return !sub || sub.choPhepNopBai !== false;
}

function nopCanSubmitTo(hw) {
    return isSV() && hw && hw.createdByRole === 'gv' && nopSubjectOpen(hw);
}

function openSubmitModal(homeworkId) {
    const hw = homeworks.find(h => h.id === homeworkId);
    if (hw && isSV() && hw.createdByRole === 'gv' && !nopSubjectOpen(hw)) {
        showToast('Giảng viên đã đóng nộp bài tập của môn này.', 'warning');
        return;
    }
    if (!nopCanSubmitTo(hw)) {
        showToast('Chỉ sinh viên mới nộp được bài tập do giảng viên giao.', 'warning');
        return;
    }
    nopSubmitHwId = homeworkId;
    nopSubmitBusy = false;

    const subject = subjects.find(s => s.id === hw.subjectId);
    document.getElementById('submit-hw-info').innerHTML = `
        <div class="font-medium text-slate-900 dark:text-white">${escapeHtml(hw.title || '(Không có tiêu đề)')}</div>
        <div class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Môn: ${escapeHtml(subject ? subject.name : 'Chưa phân môn')}</div>
        ${hw.description ? `<div class="text-xs text-slate-500 dark:text-slate-400 mt-1">${escapeHtml(hw.description)}</div>` : ''}`;

    document.getElementById('form-submit').reset();
    document.getElementById('submit-form-view').classList.remove('hidden');
    const resultBox = document.getElementById('submit-result-view');
    resultBox.classList.add('hidden');
    resultBox.innerHTML = '';
    document.getElementById('submit-offline-note').classList.toggle('hidden', nopIsOnline());
    nopSetSubmitBusy(false);
    openModal('modal-submit');
}

function nopSetSubmitBusy(busy) {
    nopSubmitBusy = busy;
    const btn = document.getElementById('btn-submit-send');
    if (!btn) return;
    btn.disabled = busy;
    btn.classList.toggle('opacity-60', busy);
    btn.innerHTML = busy
        ? '<i class="fa-solid fa-spinner fa-spin"></i> Đang xử lý...'
        : '<i class="fa-solid fa-paper-plane"></i> Nộp bài';
}

function nopShowResult(kind, hw, fileName, whenText, extra) {
    const box = document.getElementById('submit-result-view');
    const ok = kind === 'success';
    const colors = ok
        ? 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300'
        : 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300';
    box.innerHTML = `
        <div class="text-center py-2">
            <div class="mx-auto w-14 h-14 rounded-full flex items-center justify-center ${ok ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600' : 'bg-amber-100 dark:bg-amber-900/40 text-amber-600'} mb-3">
                <i class="fa-solid ${ok ? 'fa-circle-check' : 'fa-cloud-arrow-up'} text-3xl"></i>
            </div>
            <h4 class="text-lg font-bold text-slate-900 dark:text-white">${ok ? 'Nộp bài thành công!' : 'Đã lưu bài trên thiết bị'}</h4>
            <p class="text-sm text-slate-600 dark:text-slate-300 mt-1">${ok
                ? 'Giảng viên có thể xem bài của bạn ngay bây giờ.'
                : 'Hiện chưa gửi được lên máy chủ. Bài nộp đã được lưu dưới dạng XML trên thiết bị và sẽ TỰ ĐỘNG nộp khi có mạng trở lại.'}</p>
        </div>
        <div class="mt-3 text-sm rounded-xl border px-4 py-3 ${colors}">
            <div><span class="font-medium">Bài tập:</span> ${escapeHtml(hw.title || '(Không có tiêu đề)')}</div>
            <div><span class="font-medium">Tệp:</span> ${escapeHtml(fileName)}</div>
            <div><span class="font-medium">Thời gian:</span> ${escapeHtml(whenText)}</div>
            ${extra ? `<div class="mt-1 text-xs">${extra}</div>` : ''}
        </div>
        <div class="flex justify-end mt-5">
            <button type="button" onclick="closeModal('modal-submit')" class="px-4 py-2 rounded-xl text-sm font-medium text-white hsr-btn bg-indigo-600 hover:bg-indigo-700 transition-colors shadow-sm">Đóng</button>
        </div>`;
    document.getElementById('submit-form-view').classList.add('hidden');
    box.classList.remove('hidden');
}

async function handleSubmitHomework(e) {
    e.preventDefault();
    if (nopSubmitBusy) return;
    const hw = homeworks.find(h => h.id === nopSubmitHwId);
    if (!nopCanSubmitTo(hw)) return;

    const file = document.getElementById('input-submit-file').files[0];
    const note = document.getElementById('input-submit-note').value.trim();
    if (!file) {
        showToast('Vui lòng chọn tệp bài làm để nộp.', 'error');
        return;
    }
    if (file.size === 0) {
        showToast('Tệp rỗng, vui lòng chọn tệp khác.', 'error');
        return;
    }
    if (file.size > NOP_MAX_BYTES) {
        showToast(`Tệp quá lớn (${formatFileSize(file.size)}). Tối đa ${NOP_MAX_BYTES / 1024 / 1024}MB.`, 'error');
        return;
    }

    nopSetSubmitBusy(true);
    try {
        const subject = subjects.find(s => s.id === hw.subjectId);
        const when = new Date();
        const clientId = nopNewId();
        const base64 = await nopReadBase64(file);
        const online = nopIsOnline();

        let xml = nopBuildXml({
            clientId,
            mode: online ? 'online' : 'offline',
            user: { username: currentUsername, displayName: currentDisplayName, maSoSv: currentMaSoSv },
            subjectId: hw.subjectId,
            subjectName: subject ? subject.name : '',
            homeworkId: hw.id,
            homeworkTitle: hw.title,
            note,
            when,
            file,
            base64
        });

        let queueReason = online ? '' : 'offline';
        if (online) {
            try {
                await nopPostXml(xml);
                nopShowResult('success', hw, file.name, nopFmtTime(when.getTime()));
                showToast('Nộp bài thành công! Giảng viên đã nhận được bài của bạn.', 'success');
                await nopReloadIfTabActive();
                return;
            } catch (err) {
                if (err.permanent) throw err;                 // bị từ chối hẳn: báo lỗi, không đưa vào hàng đợi
                queueReason = err.status === 401 ? 'login' : (err.network ? 'offline' : 'server');
                // Lưu theo chế độ offline vì bài sẽ được đồng bộ sau
                xml = xml.replace('cheDo="online"', 'cheDo="offline"');
            }
        }

        await nopQueuePut({
            clientId,
            username: currentUsername,
            homeworkId: hw.id,
            homeworkTitle: hw.title || '(Không có tiêu đề)',
            subjectId: hw.subjectId || '',
            subjectName: subject ? subject.name : '',
            fileName: file.name,
            fileSize: file.size,
            createdAt: when.getTime(),
            status: 'pending',
            attempts: 0,
            lastError: '',
            xml
        });

        if (!nopStoragePersistAsked && navigator.storage && navigator.storage.persist) {
            nopStoragePersistAsked = true;
            navigator.storage.persist().catch(() => {});
        }
        nopRequestBackgroundSync();
        await nopRefreshPending();

        const extra = queueReason === 'login'
            ? 'Phiên đăng nhập đã hết hạn: hãy đăng nhập lại để bài được nộp.'
            : (queueReason === 'server' ? 'Máy chủ đang bận, hệ thống sẽ tự thử lại.' : '');
        nopShowResult('queued', hw, file.name, nopFmtTime(when.getTime()), extra);
        showToast('Chưa có mạng: bài đã lưu trên thiết bị, sẽ tự nộp khi có mạng.', 'warning');
        await nopReloadIfTabActive();
    } catch (err) {
        showToast('Nộp bài thất bại: ' + err.message, 'error');
    } finally {
        nopSetSubmitBusy(false);
    }
}

/* ---------------------------------------------------------------------
   Tab "Nộp bài"
   --------------------------------------------------------------------- */
function nopTabActive() {
    const t = document.getElementById('tab-homeworks');
    return !!(t && t.classList.contains('active'));
}

async function nopReloadIfTabActive() {
    await nopRefreshPending();
    if (nopTabActive()) {
        await loadSubmissionsView();
    }
}

function nopUpdateNav() {
    // Đã gộp vào tab Bài tập: không còn nút "Nộp bài" riêng trên menu.
}

// switchTab() đặt lại className của nút -> áp lại trạng thái ẩn/hiện, rồi nạp dữ liệu tab
function nopAfterSwitchTab(tabId) {
    nopUpdateNav();
    if (tabId === 'homeworks') {
        loadSubmissionsView();
    }
}

// Gọi từ updateAuthUI() mỗi khi đăng nhập/đăng xuất
function onSubmissionAuthChange() {
    nopUpdateNav();
    if (!isLoggedIn) {
        nopPending = [];
        nopPendingCount = 0;
        nopMine = [];
        nopGvRows = [];
        nopUpdateNav();
    }
    nopRefreshPending().then(() => {
        if (isSV()) nopSyncNow();
        if (nopTabActive()) loadSubmissionsView();
    });
}

function nopFillSubjectFilter() { /* dùng chung bộ lọc môn #filter-subject của tab Bài tập */ }

function nopFillHomeworkFilter() {
    const sel = document.getElementById('filter-submission-homework');
    if (!sel) return;
    const prev = sel.value || 'all';
    const subjectId = nopSubjectFilterValue();
    const list = homeworks.filter(h => h.createdByRole === 'gv' && (subjectId === 'all' || h.subjectId === subjectId));
    sel.innerHTML = '<option value="all">Tất cả bài tập</option>' +
        list.map(h => `<option value="${escapeHtml(h.id)}">${escapeHtml(h.title || '(Không có tiêu đề)')}</option>`).join('');
    sel.value = list.some(h => h.id === prev) ? prev : 'all';
    sel.classList.toggle('hidden', !isGV());
}

function onSubmissionSubjectChange() {
    nopFillHomeworkFilter();
    loadSubmissionsView();
}

// GV bấm "Bài nộp" ở 1 bài tập -> cuộn xuống phần "Bài sinh viên đã nộp", lọc đúng bài tập đó
function openSubmissionsForHomework(homeworkId) {
    const hw = homeworks.find(h => h.id === homeworkId);
    if (!hw) return;
    nopFillHomeworkFilter();
    document.getElementById('filter-submission-homework').value = homeworkId;
    loadSubmissionsView().then(() => {
        const box = document.getElementById('submissions-gv');
        if (box) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
}

// Nút ở cột "Thao tác" của bảng Bài tập (gọi từ renderHomeworks)
function nopHomeworkRowButtons(hw) {
    if (isSV() && hw.createdByRole === 'gv') {
        if (!nopSubjectOpen(hw)) {
            return `<span class="text-xs font-medium text-amber-700 dark:text-amber-300 mr-1 whitespace-nowrap" title="Giảng viên đã đóng nộp bài môn này"><i class="fa-solid fa-lock mr-1"></i>Đóng nộp bài</span>`;
        }
        return `<button onclick="openSubmitModal('${hw.id}')" class="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 px-2.5 py-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-900/30 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition-colors mr-1 whitespace-nowrap" title="Nộp bài tập này"><i class="fa-solid fa-paper-plane mr-1"></i>${(nopMine.some(m => m.homeworkId === hw.id) || nopPending.some(p => p.homeworkId === hw.id && p.status === 'pending')) ? 'Nộp lại' : 'Nộp bài'}</button>`;
    }
    if (isGV() && hw.createdByRole === 'gv') {
        return `<button onclick="openSubmissionsForHomework('${hw.id}')" class="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 px-2.5 py-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-900/30 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition-colors mr-1 whitespace-nowrap" title="Xem bài sinh viên đã nộp"><i class="fa-solid fa-inbox mr-1"></i>Bài nộp</button>`;
    }
    return '';
}

async function loadSubmissionsView() {
    nopFillHomeworkFilter();

    const gvBox = document.getElementById('submissions-gv');
    const banner = document.getElementById('submissions-banner');
    if (!gvBox || !banner) return;

    gvBox.classList.toggle('hidden', !isGV());
    if (!isLoggedIn) {
        banner.classList.add('hidden');
        document.getElementById('sv-pending-wrap').classList.add('hidden');
        return;
    }

    const seq = ++nopLoadSeq;
    try {
        if (isGV()) {
            const q = [];
            const sub = nopSubjectFilterValue();
            const hw = document.getElementById('filter-submission-homework').value;
            if (sub !== 'all') q.push('subject_id=' + encodeURIComponent(sub));
            if (hw !== 'all') q.push('homework_id=' + encodeURIComponent(hw));
            const rows = await apiRequest('GET', 'submissions.php' + (q.length ? '?' + q.join('&') : ''));
            if (seq !== nopLoadSeq) return;
            nopGvRows = rows;
        } else if (isSV()) {
            const rows = await apiRequest('GET', 'submissions.php');
            await nopRefreshPending();
            if (seq !== nopLoadSeq) return;
            nopMine = rows;
        }
    } catch (err) {
        if (seq !== nopLoadSeq) return;
        showToast('Không tải được danh sách bài nộp: ' + err.message, 'error');
    }

    if (isGV()) {
        nopRenderGv();
    } else if (isSV()) {
        nopRenderBanner();
        nopRenderPendingList();
        renderHomeworks(); // cập nhật trạng thái Đã nộp / Chờ đồng bộ ngay trên từng dòng bài tập
    }
}

function nopRenderBanner() {
    const el = document.getElementById('submissions-banner');
    if (!el) return;
    if (!isSV()) {
        el.classList.add('hidden');
        return;
    }
    const online = nopIsOnline();
    const waiting = nopPending.filter(i => i.status === 'pending').length;
    let cls = '';
    let html = '';

    if (!online) {
        cls = 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200';
        html = `<i class="fa-solid fa-wifi text-amber-500"></i>
            <span><b>Bạn đang offline.</b> Bài nộp sẽ được lưu dưới dạng XML trên thiết bị và tự động gửi cho giảng viên khi có mạng${waiting ? ` (đang chờ: ${waiting} bài)` : ''}.</span>`;
    } else if (nopSyncing) {
        cls = 'bg-sky-50 dark:bg-sky-900/20 border-sky-200 dark:border-sky-800 text-sky-800 dark:text-sky-200';
        html = `<i class="fa-solid fa-spinner fa-spin"></i><span>Đang tự động nộp các bài đang chờ...</span>`;
    } else if (waiting > 0) {
        cls = 'bg-sky-50 dark:bg-sky-900/20 border-sky-200 dark:border-sky-800 text-sky-800 dark:text-sky-200';
        html = `<i class="fa-solid fa-cloud-arrow-up"></i><span>Có <b>${waiting}</b> bài đang chờ đồng bộ, hệ thống sẽ tự gửi.</span>
            <button type="button" onclick="nopSyncNow({manual:true})" class="ml-auto text-xs font-medium underline whitespace-nowrap">Đồng bộ ngay</button>`;
    } else {
        el.classList.add('hidden');
        return;
    }
    el.className = `flex items-center gap-3 text-sm rounded-xl border px-4 py-3 mb-4 ${cls}`;
    el.innerHTML = html;
}

function nopSubjectFilterValue() {
    const sel = document.getElementById('filter-subject');
    return sel ? sel.value : 'all';
}

// Trạng thái nộp của 1 bài tập (hiện ngay dưới tên bài tập trong bảng, chỉ dành cho sinh viên)
function nopHomeworkStatusBadges(hw) {
    if (!isSV() || hw.createdByRole !== 'gv') return '';
    const sent = nopMine.filter(m => m.homeworkId === hw.id);
    const waiting = nopPending.filter(p => p.homeworkId === hw.id && p.status === 'pending').length;
    const badges = [];
    if (sent.length > 0) {
        badges.push(`<span class="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-900/30 px-2 py-0.5 rounded-full"><i class="fa-solid fa-circle-check"></i> Đã nộp${sent.length > 1 ? ` (${sent.length} lần)` : ''} · ${escapeHtml(nopFmtTime(sent[0].submittedAt))}</span>`);
    }
    if (waiting > 0) {
        badges.push(`<span class="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/30 px-2 py-0.5 rounded-full"><i class="fa-regular fa-clock"></i> Chờ đồng bộ (${waiting})</span>`);
    }
    if (badges.length === 0) {
        badges.push(`<span class="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-700/60 px-2 py-0.5 rounded-full">Chưa nộp</span>`);
    }
    return `<div class="flex flex-wrap gap-2 mt-1.5">${badges.join('')}</div>`;
}

// Giữ tên cũ vì nơi khác còn gọi: danh sách bài cần nộp chính là bảng Bài tập
function nopRenderSvAssignments() {
    if (typeof renderHomeworks === 'function') renderHomeworks();
}

function nopRenderPendingList() {
    const wrap = document.getElementById('sv-pending-wrap');
    const box = document.getElementById('sv-pending');
    if (!wrap || !box) return;
    const sub = nopSubjectFilterValue();
    const items = nopPending.filter(p => sub === 'all' || p.subjectId === sub);
    wrap.classList.toggle('hidden', items.length === 0);

    box.innerHTML = items.map(p => {
        const isErr = p.status === 'error';
        return `
            <div class="bg-white dark:bg-slate-800 rounded-2xl border ${isErr ? 'border-red-200 dark:border-red-800' : 'border-amber-200 dark:border-amber-800'} px-5 py-3 flex items-center gap-3">
                <i class="fa-solid ${isErr ? 'fa-circle-exclamation text-red-500' : 'fa-clock text-amber-500'} text-lg"></i>
                <div class="flex-1 min-w-0">
                    <div class="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">${escapeHtml(p.homeworkTitle)}</div>
                    <div class="text-xs text-slate-500 dark:text-slate-400 truncate">${escapeHtml(p.fileName)} · ${formatFileSize(p.fileSize)} · lưu lúc ${escapeHtml(nopFmtTime(p.createdAt))}</div>
                    <div class="text-xs mt-0.5 ${isErr ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'}">${isErr ? 'Không nộp được: ' + escapeHtml(p.lastError || 'lỗi không xác định') : 'Chờ có mạng để tự động nộp (XML trên thiết bị)'}</div>
                </div>
                ${isErr ? `<button onclick="nopRetryPending('${p.clientId}')" class="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline whitespace-nowrap">Thử lại</button>` : ''}
                <button onclick="nopDeletePending('${p.clientId}')" class="text-slate-400 hover:text-red-500 transition-colors p-2 rounded-lg" title="Xóa bài chờ này"><i class="fa-regular fa-trash-can"></i></button>
            </div>`;
    }).join('');
}

async function nopRetryPending(clientId) {
    const it = nopPending.find(p => p.clientId === clientId);
    if (!it) return;
    it.status = 'pending';
    it.attempts = 0;
    it.lastError = '';
    await nopQueuePut(it);
    await nopRefreshPending();
    nopRenderPendingList();
    nopRenderBanner();
    nopSyncNow({ manual: true });
}

function nopDeletePending(clientId) {
    showConfirmDialog('Xóa bài nộp đang chờ này khỏi thiết bị? Bài sẽ KHÔNG được gửi cho giảng viên.', async () => {
        await nopQueueDelete(clientId);
        await nopRefreshPending();
        nopRenderPendingList();
        nopRenderSvAssignments();
        nopRenderBanner();
        showToast('Đã xóa bài chờ nộp.', 'info');
    });
}

function nopFileLinks(row) {
    const url = `${API_BASE}submissions.php?id=${row.id}`;
    return `
        ${nopCanViewInline(row.fileName) ? `<a href="${url}" target="_blank" rel="noopener" class="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline mr-3 whitespace-nowrap"><i class="fa-regular fa-eye mr-1"></i>Xem</a>` : ''}
        <a href="${url}&download=1" class="text-xs font-medium text-indigo-600 dark:text-indigo-400 hover:underline whitespace-nowrap"><i class="fa-solid fa-download mr-1"></i>Tải về</a>`;
}

function nopRenderSvSubmitted() {
    const box = document.getElementById('sv-submitted');
    const empty = document.getElementById('sv-submitted-empty');
    if (!box || !empty) return; // mục "Bài đã nộp của tôi" đã được gỡ khỏi giao diện sinh viên
    const sub = nopSubjectFilterValue();
    const rows = nopMine.filter(m => sub === 'all' || m.subjectId === sub);
    empty.classList.toggle('hidden', rows.length > 0);

    box.innerHTML = rows.map(r => `
        <div class="bg-white dark:bg-slate-800 rounded-2xl border border-slate-100 dark:border-slate-700 px-5 py-3 flex flex-col sm:flex-row sm:items-center gap-2">
            <i class="fa-solid fa-circle-check text-emerald-500 text-lg hidden sm:block"></i>
            <div class="flex-1 min-w-0">
                <div class="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">${escapeHtml(r.homeworkTitle || '')}${r.subjectName ? ` <span class="text-xs font-normal text-slate-400">· ${escapeHtml(r.subjectName)}</span>` : ''}</div>
                <div class="text-xs text-slate-500 dark:text-slate-400 truncate">${escapeHtml(r.fileName)} · ${formatFileSize(r.fileSize)} · nộp lúc ${escapeHtml(nopFmtTime(r.submittedAt))}${r.mode === 'offline' ? ' · soạn khi offline, đã tự đồng bộ' : ''}</div>
                ${r.note ? `<div class="text-xs text-slate-500 dark:text-slate-400 mt-0.5 italic truncate">Ghi chú: ${escapeHtml(r.note)}</div>` : ''}
            </div>
            <div class="flex-shrink-0">${nopFileLinks(r)}</div>
        </div>`).join('');
}

function nopRenderGv() {
    const body = document.getElementById('gv-submissions');
    const empty = document.getElementById('gv-empty');
    empty.classList.toggle('hidden', nopGvRows.length > 0);
    document.getElementById('gv-count').textContent = nopGvRows.length;

    body.innerHTML = nopGvRows.map(r => `
        <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors align-top">
            <td class="px-4 py-3">
                <div class="text-sm font-medium text-slate-900 dark:text-slate-100">${escapeHtml(r.studentName || r.student)}</div>
                <div class="text-xs text-slate-500 dark:text-slate-400">${r.maSoSv ? 'MSSV ' + escapeHtml(r.maSoSv) : escapeHtml(r.student)}</div>
            </td>
            <td class="px-4 py-3">
                <div class="text-sm text-slate-800 dark:text-slate-200">${escapeHtml(r.homeworkTitle || '(Không có tiêu đề)')}</div>
                <div class="text-xs text-slate-500 dark:text-slate-400">${escapeHtml(r.subjectName || 'Chưa phân môn')}</div>
            </td>
            <td class="px-4 py-3">
                <div class="text-sm text-slate-800 dark:text-slate-200 break-all">${escapeHtml(r.fileName)}</div>
                <div class="text-xs text-slate-500 dark:text-slate-400">${formatFileSize(r.fileSize)}</div>
                ${r.note ? `<div class="text-xs text-slate-500 dark:text-slate-400 mt-1 italic max-w-xs">“${escapeHtml(r.note)}”</div>` : ''}
            </td>
            <td class="px-4 py-3 whitespace-nowrap text-sm text-slate-600 dark:text-slate-300">
                ${escapeHtml(nopFmtTime(r.submittedAt))}
                ${r.mode === 'offline' ? '<div class="text-[11px] text-amber-600 dark:text-amber-400">nộp khi offline, nhận lúc ' + escapeHtml(nopFmtTime(r.receivedAt)) + '</div>' : ''}
            </td>
            <td class="px-4 py-3 whitespace-nowrap text-right">${nopFileLinks(r)}</td>
        </tr>`).join('');
}

/* ---------------------------------------------------------------------
   Khởi tạo: Service Worker, lắng nghe mạng, đồng bộ nền định kỳ
   --------------------------------------------------------------------- */
function nopRegisterServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js').catch(err => {
        // Service Worker chỉ chạy trên HTTPS hoặc localhost
        console.warn('Không đăng ký được Service Worker (cần HTTPS/localhost):', err && err.message);
    });
    navigator.serviceWorker.addEventListener('message', ev => {
        const d = ev.data;
        if (d && d.type === 'submission-synced') {
            if (!nopNotified.has(d.clientId)) {
                nopNotified.add(d.clientId);
                showToast(`Đã tự động nộp bài thành công: "${d.homeworkTitle || d.fileName || ''}"`, 'success');
            }
            nopReloadIfTabActive();
        }
    });
}

let nopInitDone = false;
function nopInit() {
    if (nopInitDone) return;
    nopInitDone = true;

    nopFillSubjectFilter();
    nopFillHomeworkFilter();
    nopUpdateNav();

    window.addEventListener('online', () => {
        nopRenderBanner();
        setTimeout(() => nopSyncNow(), 1000);
    });
    window.addEventListener('offline', () => {
        nopRenderBanner();
        showToast('Mất kết nối mạng. Bạn vẫn có thể nộp bài, hệ thống sẽ lưu trên thiết bị.', 'warning');
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') nopSyncNow();
    });
    setInterval(() => {
        if (nopPendingCount > 0) nopSyncNow();
    }, NOP_AUTO_SYNC_MS);

    nopRefreshPending().then(() => {
        if (isSV()) nopSyncNow();
    });
}

nopRegisterServiceWorker();
