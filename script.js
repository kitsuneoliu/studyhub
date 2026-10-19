(function initPageLoader() {
    const loader = document.getElementById('page-loader');
    if (!loader) return;
    const loaderText = loader.querySelector('.tetris-loader-text');

    function detectNetworkStatus() {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            return 'offline';
        }
        const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (conn) {
            if (conn.saveData) return 'slow';
            if (conn.effectiveType && ['slow-2g', '2g', '3g'].includes(conn.effectiveType)) return 'slow';
            if (typeof conn.downlink === 'number' && conn.downlink > 0 && conn.downlink < 1.5) return 'slow';
        }
        return 'fast';
    }

    const networkStatus = detectNetworkStatus();
    let minDisplayTime = 0;

    if (networkStatus === 'offline') {
        minDisplayTime = 2500;
        if (loaderText) loaderText.textContent = 'Mất kết nối mạng...';
    } else if (networkStatus === 'slow') {
        minDisplayTime = 1800;
        if (loaderText) loaderText.textContent = 'Mạng yếu, đang tải...';
    } else {
        minDisplayTime = 0;
    }

    const startTime = Date.now();
    function hideLoader() {
        const elapsed = Date.now() - startTime;
        const remaining = Math.max(0, minDisplayTime - elapsed);
        setTimeout(() => {
            loader.classList.add('page-loader-hide');
            setTimeout(() => loader.remove(), 500);
        }, remaining);
    }

    if (document.readyState === 'complete') {
        hideLoader();
    } else {
        window.addEventListener('load', hideLoader);
    }
})();

let isLoggedIn = false;
let editingHwId = null;
let editingSubId = null;

let currentUsername = null;
let currentUserRole = null;
let currentDisplayName = null;
let currentMaSoSv = null;
let currentGioiHanMon = false; // true = giảng viên theo môn (chỉ thấy/thao tác môn mình phụ trách)

let subjects = [];
let curriculumList = [];
let editingCurriculumId = null;
let homeworks = [];

let selectedSubjectColor = 'bg-blue-500';

let _confirmCallback = null;

let quizBuilderQuestions = [];
let currentQuizzesSubjectId = null;
let currentQuizTitle = '';
let quizResultNames = {};
let quizResultScores = {};   // luotId -> { diem: '8.50' | '-', chamTay: bool }
let quizResultMaxDiem = 10;  // tổng điểm của bài đang xem kết quả
let accountsList = [];
let teachersList = [];
let classesList = [];
let editingTeacherUsername = null;
let editingAccountUsername = null;

const API_BASE = 'api/';

async function apiRequest(method, path, body) {
    const options = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
    }

    let res;
    try {
        res = await fetch(API_BASE + path, options);
    } catch (err) {
        // Mất mạng: dùng lại dữ liệu GET lần trước (nếu có) để vẫn xem/nộp bài được khi offline
        if (method === 'GET' && typeof nopCacheRead === 'function') {
            const cached = nopCacheRead(path);
            if (cached !== null) return cached;
        }
        const netErr = new Error(`Không kết nối được tới ${API_BASE}${path} (kiểm tra lại đường dẫn/PHP có đang chạy không).`);
        netErr.offline = true;
        throw netErr;
    }

    const rawText = await res.text();
    let data = null;
    try {
        data = rawText ? JSON.parse(rawText) : null;
    } catch (err) {
        console.error(`Phản hồi từ ${API_BASE}${path} không phải JSON hợp lệ:`, rawText);
    }

    if (!res.ok || data === null) {
        const serverMessage = (data && (data.error || data.message)) || null;
        const fallback = rawText
            ? `Lỗi máy chủ (HTTP ${res.status}) tại ${path}: ${rawText.slice(0, 300)}`
            : `Lỗi máy chủ (HTTP ${res.status}) tại ${path}, không có phản hồi.`;
        throw new Error(serverMessage || fallback);
    }

    if (method === 'GET' && typeof nopCacheWrite === 'function') {
        nopCacheWrite(path, data);
    }
    return data;
}

async function restoreSession() {
    try {
        const data = await apiRequest('GET', 'session.php');
        if (data && data.loggedIn) {
            isLoggedIn = true;
            currentUsername = data.username;
            currentUserRole = data.role;
            currentDisplayName = data.displayName || data.username;
            currentMaSoSv = data.maSoSv || null;
            currentGioiHanMon = !!data.gioiHanMon;
            if (typeof nopPersistSession === 'function') nopPersistSession(data);
            return;
        }
    } catch (err) {
        // Mất mạng lúc mở trang: dùng lại phiên đăng nhập đã lưu trên thiết bị
        if (err && err.offline && typeof nopRestoreOfflineSession === 'function' && nopRestoreOfflineSession()) {
            return;
        }
    }
    isLoggedIn = false;
    currentUsername = null;
    currentUserRole = null;
    currentDisplayName = null;
}

async function fetchSubjects() {
    try {
        subjects = await apiRequest('GET', 'subjects.php');
    } catch (err) {
        subjects = [];
        showToast('Không thể tải danh sách môn học: ' + err.message, 'error');
    }
}

async function fetchHomeworks() {
    try {
        homeworks = await apiRequest('GET', 'homeworks.php');
    } catch (err) {
        homeworks = [];
        showToast('Không thể tải danh sách bài tập: ' + err.message, 'error');
    }
}

async function loadCurriculum() {
    try {
        curriculumList = await apiRequest('GET', 'curriculum.php');
    } catch (err) {
        curriculumList = [];
        showToast('Không thể tải danh sách giáo trình: ' + err.message, 'error');
    }
    renderCurriculum();
}

// Sau khi đăng nhập/đăng xuất phải tải lại môn học, bài tập, giáo trình: dữ liệu tải lúc mở trang là của KHÁCH
// (thấy mọi môn), còn giảng viên theo môn chỉ được thấy các môn mình phụ trách.
async function reloadDataAfterAuthChange() {
    await Promise.all([fetchSubjects(), fetchHomeworks(), loadCurriculum()]);
    updateSubjectDropdowns();
    if (typeof nopFillSubjectFilter === 'function') nopFillSubjectFilter();
    if (typeof nopFillHomeworkFilter === 'function') nopFillHomeworkFilter();
}

window.onload = async () => {
    await restoreSession();
    await Promise.all([fetchSubjects(), fetchHomeworks(), loadCurriculum()]);
    initApp();
    initThemeToggle();
    if (typeof nopInit === 'function') nopInit();
    restoreUiStateAfterReturn();

    const loginRadarForm = document.querySelector('#modal-login form');
    if (loginRadarForm) {
        loginRadarForm.addEventListener('submit', handleLogin);
    }
};

function initApp() {
    renderSubjects();
    updateSubjectDropdowns();
    renderHomeworks();
    renderCurriculum();
    updateAuthUI();
}

function getRoleLabel(role) {
    switch (role) {
        case 'gv': return 'Giảng viên';
        case 'sv': return 'Sinh viên';
        default: return 'Không xác định';
    }
}

function isGV() {
    return isLoggedIn && currentUserRole === 'gv';
}

function isSV() {
    return isLoggedIn && currentUserRole === 'sv';
}

// GV: quản lý toàn bộ môn học. SV: chỉ được xem, không được thêm/sửa/xóa.
function canManageSubjects() {
    return isGV();
}

// Thêm/xóa môn học: chỉ giảng viên quản trị. Giảng viên theo môn chỉ sửa/đóng-mở nộp bài môn của mình.
function canAddDeleteSubjects() {
    return isGV() && !currentGioiHanMon;
}

// GV: tạo/sửa/xóa giáo trình. SV: chỉ được xem/mở link, không được thêm/sửa/xóa.
function canManageCurriculum() {
    return isGV();
}

// Bất kỳ ai đã đăng nhập (GV hoặc SV) đều tạo được bài tập mới.
function canCreateHomework() {
    return isGV() || isSV();
}

// GV sửa/xóa được MỌI bài tập. SV chỉ sửa/xóa được bài tập do chính mình tạo.
function canModifyHomework(hw) {
    if (isGV()) return true;
    if (isSV() && hw && hw.createdBy && hw.createdBy === currentUsername) return true;
    return false;
}

function initThemeToggle() {
    const themeCheckbox = document.getElementById('theme-toggle-input');
    
    const applyTheme = (isDark) => {
        if(isDark) {
            document.documentElement.classList.add('dark');
        } else {
            document.documentElement.classList.remove('dark');
        }
    };

    applyTheme(themeCheckbox.checked);

    themeCheckbox.addEventListener('change', (e) => {
        applyTheme(e.target.checked);
    });
}

async function handleLogin(e) {
    e.preventDefault();
    const user = document.getElementById('user-input').value.trim();
    const pass = document.getElementById('pass-input').value;

    try {
        const data = await apiRequest('POST', 'login.php', { username: user, password: pass });
        isLoggedIn = true;
        currentUsername = data.username;
        currentUserRole = data.role;
        currentDisplayName = data.displayName || data.username;
        currentMaSoSv = data.maSoSv || null;
        currentGioiHanMon = !!data.gioiHanMon;
        if (typeof nopPersistSession === 'function') nopPersistSession(data);
        closeModal('modal-login');
        showToast(`Đăng nhập thành công với quyền: ${getRoleLabel(currentUserRole)}.`, 'success');
        await reloadDataAfterAuthChange();
        updateAuthUI();
    } catch (err) {
        showToast(err.message || 'Sai tài khoản hoặc mật khẩu!', 'error');
    }
}

async function handleLogout() {
    if (typeof nopOnLogout === 'function') nopOnLogout();
    try {
        await apiRequest('POST', 'logout.php');
    } catch (err) {
    }
    isLoggedIn = false;
    currentUsername = null;
    currentUserRole = null;
    currentDisplayName = null;
    currentMaSoSv = null;
    currentGioiHanMon = false;
    showToast('Đã đăng xuất. Bạn chuyển sang chế độ Chỉ Xem.', 'info');
    await reloadDataAfterAuthChange();
    updateAuthUI();
}

function updateAuthUI() {
    const btnLogin = document.getElementById('btn-login');
    const btnLogout = document.getElementById('btn-logout');
    const btnAddHw = document.getElementById('btn-add-hw');
    const btnAddSub = document.getElementById('btn-add-subject');
    const btnAddCurriculum = document.getElementById('btn-add-curriculum');
    const roleBadge = document.getElementById('role-badge');
    const thActions = document.getElementById('th-actions');
    const btnAddQuiz = document.getElementById('btn-add-quiz');
    const navCheatLog = document.getElementById('nav-cheat-log');
    const navAccounts = document.getElementById('nav-accounts');
    const navSubjects = document.getElementById('nav-subjects');

    // Giảng viên theo môn KHÔNG được xem tab "Môn học" (chỉ ql1, ql2 quản trị, sinh viên và khách xem được).
    const hideSubjectsTab = isLoggedIn && isGV() && currentGioiHanMon;
    if (navSubjects) {
        navSubjects.classList.toggle('hidden', hideSubjectsTab);
        const tabSub = document.getElementById('tab-subjects');
        if (hideSubjectsTab && tabSub && tabSub.classList.contains('active')) {
            switchTab('homeworks');
        }
    }

    if(isLoggedIn) {
        btnLogin.classList.add('hidden');
        btnLogout.classList.remove('hidden');

        if (navCheatLog) {
            updateCheatLogNavVisibility();
        }

        if (canCreateHomework()) {
            btnAddHw.classList.remove('hidden');
        } else {
            btnAddHw.classList.add('hidden');
        }

        if (canAddDeleteSubjects()) {
            btnAddSub.classList.remove('hidden');
        } else {
            btnAddSub.classList.add('hidden');
        }

        if (btnAddCurriculum) {
            if (canManageCurriculum()) {
                btnAddCurriculum.classList.remove('hidden');
            } else {
                btnAddCurriculum.classList.add('hidden');
            }
        }

        if (btnAddQuiz) {
            if (isGV()) {
                btnAddQuiz.classList.remove('hidden');
            } else {
                btnAddQuiz.classList.add('hidden');
            }
        }

        if (navAccounts) {
            if (isGV()) {
                navAccounts.classList.remove('hidden');
            } else {
                navAccounts.classList.add('hidden');
            }
        }

        if (roleBadge) {
            roleBadge.innerText = `${currentDisplayName || currentUsername} · ${getRoleLabel(currentUserRole)}`;
            roleBadge.classList.remove('hidden');
        }
    } else {
        btnLogin.classList.remove('hidden');
        btnLogout.classList.add('hidden');
        btnAddHw.classList.add('hidden');
        btnAddSub.classList.add('hidden');
        if (btnAddCurriculum) btnAddCurriculum.classList.add('hidden');
        if (btnAddQuiz) btnAddQuiz.classList.add('hidden');
        if (navCheatLog) navCheatLog.classList.add('hidden');
        if (navAccounts) navAccounts.classList.add('hidden');
        if (roleBadge) roleBadge.classList.add('hidden');
    }

    if (thActions) {
        if (isLoggedIn) {
            thActions.classList.remove('hidden');
        } else {
            thActions.classList.add('hidden');
        }
    }

    renderHomeworks();
    renderSubjects();
    renderCurriculum();
    loadQuizzesForSelectedSubject();
    if (typeof onSubmissionAuthChange === 'function') onSubmissionAuthChange();
}

function formatCheatDuration(giay) {
    const total = parseInt(giay, 10) || 0;
    const m = Math.floor(total / 60);
    const sec = total % 60;
    return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
}

async function openCheatLogModal() {
    if (!isGV()) return;
    const body = document.getElementById('cheat-log-body');
    const msg = document.getElementById('cheat-log-message');
    body.innerHTML = '<tr><td colspan="6" class="py-4 text-slate-400">Đang tải dữ liệu...</td></tr>';
    msg.classList.add('hidden');
    openModal('modal-cheat-log');

    try {
        const res = await fetch(API_BASE + 'cheat_log.php', { credentials: 'same-origin' });
        const raw = await res.text();
        let data = null;
        try {
            data = JSON.parse(raw);
        } catch (err) {
            data = null;
        }
        if (!res.ok || !data || data.error) {
            throw new Error((data && data.error) || 'Máy chủ trả về phản hồi không hợp lệ (mã ' + res.status + ').');
        }
        const items = data.items || [];
        if (items.length === 0) {
            body.innerHTML = '<tr><td colspan="6" class="py-4 text-slate-400">Chưa có vi phạm nào được ghi nhận.</td></tr>';
            return;
        }
        body.innerHTML = items.map(it => `
            <tr class="border-b border-slate-100 dark:border-slate-700">
                <td class="py-2 pr-3">${escapeHtml(formatStudentLabel(it.ho_ten, it.ma_so_sv, it.hoc_sinh_id))}</td>
                <td class="py-2 pr-3">${escapeHtml(it.tieu_de)}</td>
                <td class="py-2 pr-3">${escapeHtml(it.loai_vi_pham)}</td>
                <td class="py-2 pr-3">${escapeHtml(it.thoi_gian_bat_dau)}</td>
                <td class="py-2 pr-3">${escapeHtml(it.thoi_gian_ket_thuc)}</td>
                <td class="py-2">${formatCheatDuration(it.tong_thoi_gian_vang_mat)}</td>
            </tr>
        `).join('');
    } catch (err) {
        body.innerHTML = '';
        msg.textContent = 'Không tải được dữ liệu giám sát: ' + err.message;
        msg.classList.remove('hidden');
        showToast('Không tải được dữ liệu giám sát: ' + err.message, 'error');
    }
}

function updateCheatLogNavVisibility() {
    const navCheatLog = document.getElementById('nav-cheat-log');
    if (!navCheatLog) return;
    if (isGV()) {
        navCheatLog.classList.remove('hidden');
    } else {
        navCheatLog.classList.add('hidden');
    }
}

/* ---------------------------------------------------------------------
   Giữ nguyên vị trí khi mở tài liệu ở CÙNG tab rồi bấm "Quay lại":
   - Trước khi rời trang: lưu tab đang xem, bộ lọc môn giáo trình, vị trí cuộn.
   - Khi trang tải lại: nếu có cờ "returning" thì mở lại đúng tab/bộ lọc/vị trí.
   --------------------------------------------------------------------- */
const UI_STATE_KEY = 'studyhub-ui-state';
let uiActiveTab = 'homeworks';

function uiStateRememberTab(tabId) {
    uiActiveTab = tabId;
}

function saveUiStateBeforeLeave() {
    try {
        const filter = document.getElementById('filter-curriculum-subject');
        sessionStorage.setItem(UI_STATE_KEY, JSON.stringify({
            tab: uiActiveTab,
            curriculumSubject: filter ? filter.value : 'all',
            scrollY: window.scrollY || 0,
            returning: true
        }));
    } catch (e) { /* sessionStorage bị chặn: bỏ qua, chỉ mất tính năng nhớ vị trí */ }
}

function restoreUiStateAfterReturn() {
    let st = null;
    try {
        st = JSON.parse(sessionStorage.getItem(UI_STATE_KEY) || 'null');
        sessionStorage.removeItem(UI_STATE_KEY); // chỉ khôi phục 1 lần
    } catch (e) { return; }
    if (!st || !st.returning) return;

    try { history.scrollRestoration = 'manual'; } catch (e) {}

    const filter = document.getElementById('filter-curriculum-subject');
    if (filter && st.curriculumSubject) {
        const exists = Array.from(filter.options).some(o => o.value === st.curriculumSubject);
        if (exists) {
            filter.value = st.curriculumSubject;
            renderCurriculum();
        }
    }

    const tabEl = st.tab && document.getElementById('tab-' + st.tab);
    const navEl = st.tab && document.getElementById('nav-' + st.tab);
    if (tabEl && navEl && !navEl.classList.contains('hidden')) {
        switchTab(st.tab);
    }

    requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, st.scrollY || 0)));
}

// Trình duyệt khôi phục trang từ bộ nhớ đệm (bfcache) khi bấm Quay lại: trang còn nguyên, không cần làm gì.
// Trường hợp trang bị tải lại thì window.onload sẽ gọi restoreUiStateAfterReturn().

function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
    });
    document.getElementById(`tab-${tabId}`).classList.add('active');

    document.querySelectorAll('.nav-btn:not(#nav-cheat-log)').forEach(btn => {
        btn.className = 'nav-btn px-3 py-2 rounded-md text-sm font-medium text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 hover:text-slate-900 dark:hover:text-white transition-colors';
    });
    const activeBtn = document.getElementById(`nav-${tabId}`);
    activeBtn.className = 'nav-btn px-3 py-2 rounded-md text-sm font-medium text-indigo-600 bg-indigo-50 dark:bg-indigo-900/30 dark:text-indigo-400 transition-colors';
    updateCheatLogNavVisibility();
    uiStateRememberTab(tabId);

    if (tabId === 'quizzes') {
        loadQuizzesForSelectedSubject();
    }
    if (tabId === 'curriculum') {
        loadCurriculum();
    }
    if (typeof nopAfterSwitchTab === 'function') nopAfterSwitchTab(tabId);
}

function openModal(modalId) {
    const modal = document.getElementById(modalId);
    modal.classList.remove('hidden');
    
    if(modalId === 'modal-homework') {
        if(subjects.length === 0) {
            showToast("Vui lòng thêm môn học trước khi tạo bài tập!", "warning");
            closeModal(modalId);
            switchTab('subjects');
            setTimeout(() => openModal('modal-subject'), 300);
            return;
        }
        if(!editingHwId) {
            document.getElementById('modal-hw-title').innerText = "Thêm Bài Tập Mới";
            document.getElementById('form-homework').reset();
            modalExistingFiles = [];
            modalPendingFiles = [];
            renderHwFilesUI();
        }
    } else if(modalId === 'modal-subject') {
        if(!editingSubId) {
            document.getElementById('modal-sub-title').innerText = "Thêm Môn Học Mới";
            document.getElementById('form-subject').reset();
            resetSubjectColorPicker();
        }
    } else if(modalId === 'modal-curriculum') {
        if(subjects.length === 0) {
            showToast("Vui lòng thêm môn học trước khi tạo giáo trình!", "warning");
            closeModal(modalId);
            switchTab('subjects');
            setTimeout(() => openModal('modal-subject'), 300);
            return;
        }
        if(!editingCurriculumId) {
            document.getElementById('modal-curriculum-title').innerText = "Thêm Giáo Trình Mới";
            document.getElementById('form-curriculum').reset();
            document.getElementById('input-curriculum-subject').disabled = false;
            document.getElementById('curriculum-existing-file-note').classList.add('hidden');
            document.getElementById('input-curriculum-link').disabled = false;
        }
    }
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.add('hidden');
    if(modalId === 'modal-homework') {
        editingHwId = null;
    } else if(modalId === 'modal-subject') {
        editingSubId = null;
    } else if(modalId === 'modal-curriculum') {
        editingCurriculumId = null;
        const subjectSelect = document.getElementById('input-curriculum-subject');
        if (subjectSelect) subjectSelect.disabled = false;
        const linkInput = document.getElementById('input-curriculum-link');
        if (linkInput) linkInput.disabled = false;
    } else if(modalId === 'modal-login') {
        const passInput = document.getElementById('pass-input');
        const toggleIcon = document.querySelector('#modal-login .toggle-password');
        const loginForm = document.querySelector('#modal-login form');
        if (passInput) passInput.type = 'password';
        if (toggleIcon) {
            toggleIcon.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>';
        }
        if (loginForm) loginForm.reset();
    }
}

function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    const toastMsg = document.getElementById('toast-message');
    const icon = toast.querySelector('i');
    
    toastMsg.innerText = message;
    
    if(type === 'success') {
        icon.className = 'fa-solid fa-circle-check text-emerald-400';
    } else if (type === 'warning' || type === 'error') {
        icon.className = 'fa-solid fa-triangle-exclamation text-amber-400';
    } else {
        icon.className = 'fa-solid fa-circle-info text-blue-400';
    }

    toast.classList.remove('translate-y-24', 'opacity-0');
    setTimeout(() => {
        toast.classList.add('translate-y-24', 'opacity-0');
    }, 3000);
}

function showConfirmDialog(message, onConfirm) {
    document.getElementById('confirm-message').innerText = message;
    _confirmCallback = onConfirm;
    document.getElementById('modal-confirm').classList.remove('hidden');
}

function closeConfirmDialog(result) {
    document.getElementById('modal-confirm').classList.add('hidden');
    const cb = _confirmCallback;
    _confirmCallback = null;
    if (result && typeof cb === 'function') {
        cb();
    }
}

function handlePresetColorChange(value) {
    selectedSubjectColor = value;
    const preview = document.getElementById('custom-color-preview');
    if (preview) {
        preview.classList.add('hidden');
        preview.classList.remove('selected');
    }
}

function handleCustomColorChange(value) {
    selectedSubjectColor = value;
    document.querySelectorAll('input[name="subject_color"]').forEach(r => r.checked = false);
    const preview = document.getElementById('custom-color-preview');
    if (preview) {
        preview.style.backgroundColor = value;
        preview.classList.remove('hidden');
        preview.classList.add('selected');
    }
}

function resetSubjectColorPicker() {
    selectedSubjectColor = 'bg-blue-500';
    const firstRadio = document.querySelector('input[name="subject_color"]');
    if (firstRadio) firstRadio.checked = true;
    const colorInput = document.getElementById('input-custom-color');
    if (colorInput) colorInput.value = '#6366f1';
    const preview = document.getElementById('custom-color-preview');
    if (preview) {
        preview.classList.add('hidden');
        preview.classList.remove('selected');
    }
}

let modalExistingFiles = [];
let modalPendingFiles = [];

function renderHwFilesUI() {
    const container = document.getElementById('hw-files-container');
    if (!container) return;

    let html = '';

    modalExistingFiles.forEach(f => {
        html += `
            <div class="flex items-center gap-2 border border-slate-200 dark:border-slate-600 rounded-xl p-2.5 bg-slate-50 dark:bg-slate-900/50">
                <i class="fa-solid fa-file text-slate-400 flex-shrink-0"></i>
                <a href="${API_BASE}homework_files.php?id=${encodeURIComponent(f.id)}" target="_blank" rel="noopener noreferrer" class="text-sm flex-1 min-w-0 text-indigo-600 dark:text-indigo-400 hover:underline">
                    ${f.label ? `<span class="block truncate">${escapeHtml(f.label)}</span>` : ''}
                    <span class="block truncate ${f.label ? 'text-xs opacity-70' : ''}" title="${escapeHtml(f.fileName)}">${escapeHtml(f.fileName)}${f.fileSize ? ' · ' + formatFileSize(f.fileSize) : ''}</span>
                </a>
                <button type="button" onclick="removeExistingFile('${f.id}')" class="text-slate-400 hover:text-red-500 p-1.5 flex-shrink-0" title="Xóa tệp này">
                    <i class="fa-regular fa-trash-can"></i>
                </button>
            </div>
        `;
    });

    modalPendingFiles.forEach(pf => {
        html += `
            <div class="flex items-center gap-2 border border-dashed border-indigo-300 dark:border-indigo-600 rounded-xl p-2.5 bg-indigo-50 dark:bg-indigo-900/20">
                <i class="fa-solid fa-file-arrow-up text-indigo-400 flex-shrink-0"></i>
                <span class="text-sm flex-1 min-w-0 truncate text-slate-700 dark:text-slate-200" title="${escapeHtml(pf.file.name)}">${escapeHtml(pf.file.name)}</span>
                <input type="text" value="${escapeHtml(pf.label)}" oninput="updatePendingFileLabel('${pf.tempId}', this.value)" placeholder="Nhãn (không bắt buộc)" class="w-36 px-2 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-indigo-500 flex-shrink-0">
                <button type="button" onclick="removePendingFile('${pf.tempId}')" class="text-slate-400 hover:text-red-500 p-1.5 flex-shrink-0" title="Bỏ tệp này">
                    <i class="fa-regular fa-trash-can"></i>
                </button>
            </div>
        `;
    });

    if (modalExistingFiles.length === 0 && modalPendingFiles.length === 0) {
        html = `<p class="text-xs text-slate-400 dark:text-slate-500">Chưa có tệp nào được đính kèm.</p>`;
    }

    container.innerHTML = html;
}

function handleFilesSelected(event) {
    const files = Array.from(event.target.files || []);
    const maxSize = 1024 * 1024 * 1024;
    files.forEach(file => {
        if (file.size > maxSize) {
            showToast(`Tệp "${file.name}" quá lớn, tối đa 1GB.`, 'warning');
            return;
        }
        modalPendingFiles.push({
            tempId: 'tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2),
            file: file,
            label: ''
        });
    });
    event.target.value = '';
    renderHwFilesUI();
}

function updatePendingFileLabel(tempId, value) {
    const pf = modalPendingFiles.find(p => p.tempId === tempId);
    if (pf) pf.label = value;
}

function removePendingFile(tempId) {
    modalPendingFiles = modalPendingFiles.filter(p => p.tempId !== tempId);
    renderHwFilesUI();
}

async function removeExistingFile(fileId) {
    const hw = homeworks.find(h => h.id === editingHwId);
    if (!canModifyHomework(hw)) return;
    try {
        await apiRequest('DELETE', `homework_files.php?id=${encodeURIComponent(fileId)}`);
        modalExistingFiles = modalExistingFiles.filter(f => f.id !== fileId);
        renderHwFilesUI();
        showToast('Đã xóa tệp.', 'info');
    } catch (err) {
        showToast('Xóa tệp thất bại: ' + err.message, 'error');
    }
}

async function uploadPendingFiles(homeworkId) {
    for (const pf of modalPendingFiles) {
        const formData = new FormData();
        formData.append('homeworkId', homeworkId);
        formData.append('label', pf.label || '');
        formData.append('file', pf.file);

        let res;
        try {
            res = await fetch(API_BASE + 'homework_files.php', {
                method: 'POST',
                credentials: 'same-origin',
                body: formData
            });
        } catch (err) {
            throw new Error(`Không tải lên được tệp "${pf.file.name}" (mất kết nối).`);
        }

        const rawText = await res.text();
        let data = null;
        try {
            data = rawText ? JSON.parse(rawText) : null;
        } catch (err) {
            console.error('Phản hồi homework_files.php không phải JSON:', rawText);
        }

        if (!res.ok || data === null) {
            const message = (data && (data.error || data.message)) || `Tải lên thất bại cho tệp "${pf.file.name}".`;
            throw new Error(message);
        }
    }
    modalPendingFiles = [];
}

function formatFileSize(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let size = bytes;
    while (size >= 1024 && i < units.length - 1) {
        size /= 1024;
        i++;
    }
    return `${size.toFixed(size < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function escapeHtml(str) {
    if (str === undefined || str === null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function normalizeLink(link) {
    if (!link) return '';
    if (/^https?:\/\//i.test(link)) return link;
    return 'https://' + link;
}

function viewHomeworkCode(id) {
    const hw = homeworks.find(h => h.id === id);
    if (!hw) return;

    const container = document.getElementById('view-code-content');

    let html = '';

    if (hw.link) {
        html += `
            <a href="${escapeHtml(hw.link)}" target="_blank" rel="noopener noreferrer" class="flex items-center gap-2 mb-4 px-4 py-3 rounded-xl bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition-colors text-sm font-medium">
                <i class="fa-solid fa-arrow-up-right-from-square"></i>
                Mở link tài liệu đính kèm
            </a>
        `;
    }

    if (hw.textContent) {
        html += `
            <div class="card">
                <div class="header">
                    <div class="top">
                        <div class="circle">
                            <span class="red circle2"></span>
                        </div>
                        <div class="circle">
                            <span class="yellow circle2"></span>
                        </div>
                        <div class="circle">
                            <span class="green circle2"></span>
                        </div>
                        <div class="title">
                            <p id="title2">${escapeHtml(hw.title || 'noi-dung.txt')}</p>
                        </div>
                    </div>
                </div>
                <div class="code-container">
                    <textarea class="area" id="code" name="code" readonly>${escapeHtml(hw.textContent)}</textarea>
                </div>
            </div>
        `;
    }

    if (hw.files && hw.files.length > 0) {
        html += '<div class="space-y-2">';
        hw.files.forEach(f => {
            html += `
                <a href="${API_BASE}homework_files.php?id=${encodeURIComponent(f.id)}&download=1" class="flex items-center gap-3 px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors">
                    <i class="fa-solid fa-file-arrow-down text-indigo-500 text-lg flex-shrink-0"></i>
                    <div class="flex-1 min-w-0">
                        ${f.label ? `<div class="text-sm font-medium text-slate-900 dark:text-white truncate">${escapeHtml(f.label)}</div>` : ''}
                        <div class="text-xs text-slate-400 truncate">${escapeHtml(f.fileName)}${f.fileSize ? ' · ' + formatFileSize(f.fileSize) : ''}</div>
                    </div>
                </a>
            `;
        });
        html += '</div>';
    }

    if (!hw.link && !hw.textContent && (!hw.files || hw.files.length === 0)) {
        html += `<p class="text-sm text-slate-500 dark:text-slate-400 text-center py-6">Chưa có link, nội dung hoặc tệp đính kèm nào cho bài tập này.</p>`;
    }

    container.innerHTML = html;
    openModal('modal-view-code');
}

function getColorAttrs(color) {
    if (color && color.startsWith('#')) {
        return { cls: '', style: `background-color:${color};` };
    }
    return { cls: color || 'bg-slate-400', style: '' };
}

function renderSubjects() {
    const grid = document.getElementById('subjects-grid');
    
    if (subjects.length === 0) {
        grid.innerHTML = `<div class="col-span-full text-center py-10 text-slate-500 dark:text-slate-400">Chưa có môn học nào. Hãy đăng nhập để thêm môn học mới!</div>`;
        return;
    }

    grid.innerHTML = subjects.map(sub => {
        const count = homeworks.filter(hw => hw.subjectId === sub.id).length;
        const colorAttrs = getColorAttrs(sub.color);
        
        const editBtnHtml = canManageSubjects() ? `
                <button onclick="editSubject('${sub.id}')" class="p-1.5 text-slate-400 hover:text-blue-500 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors" title="Sửa môn">
                    <i class="fa-solid fa-pen text-xs"></i>
                </button>` : '';
        const deleteBtnHtml = canAddDeleteSubjects() ? `
                <button onclick="deleteSubject('${sub.id}')" class="p-1.5 text-slate-400 hover:text-red-500 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors" title="Xóa môn">
                    <i class="fa-regular fa-trash-can text-xs"></i>
                </button>` : '';
        const adminActions = canManageSubjects() ? `
            <div class="flex items-center gap-1">
                ${editBtnHtml}${deleteBtnHtml}
            </div>
        ` : '';
        const nopOpen = sub.choPhepNopBai !== false;
        const nopToggleHtml = canManageSubjects() ? `
                <label class="mt-3 flex items-center justify-between gap-3 text-xs font-medium text-slate-600 dark:text-slate-300 cursor-pointer select-none">
                    <span><i class="fa-solid fa-paper-plane mr-1"></i> Cho phép sinh viên nộp bài tập</span>
                    <input type="checkbox" ${nopOpen ? 'checked' : ''} onchange="toggleSubjectSubmission('${sub.id}', this.checked)" class="w-4 h-4 accent-indigo-600">
                </label>` : (nopOpen ? '' : `
                <div class="mt-3 text-xs font-medium text-amber-700 dark:text-amber-300"><i class="fa-solid fa-lock mr-1"></i> Môn này đang đóng nộp bài tập</div>`);

        return `
            <div class="hsr-panel bg-white dark:bg-slate-800 p-5 rounded-2xl shadow-sm border border-slate-100 dark:border-slate-700 hover:shadow-md transition-all relative overflow-hidden group">
                <div class="absolute top-0 right-0 w-16 h-16 opacity-10 rounded-bl-full ${colorAttrs.cls} transform translate-x-4 -translate-y-4 group-hover:scale-110 transition-transform" style="${colorAttrs.style}"></div>
                <div class="flex items-center justify-between mb-3">
                    <div class="flex items-center gap-3">
                        <div class="w-4 h-4 rounded-full ${colorAttrs.cls} shadow-inner" style="${colorAttrs.style}"></div>
                        <h3 class="font-bold text-lg text-slate-900 dark:text-white">${sub.name}</h3>
                    </div>
                    ${adminActions}
                </div>
                ${nopToggleHtml}
                <div class="mt-4 flex justify-between items-center">
                    <span class="text-xs font-medium text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-700 px-3 py-1 rounded-lg">
                        ${count} bài tập
                    </span>
                    <button onclick="filterBySubject('${sub.id}')" class="text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 text-sm font-medium">
                        Xem <i class="fa-solid fa-arrow-right text-xs ml-1"></i>
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

async function toggleSubjectSubmission(subId, allowed) {
    const sub = subjects.find(s => s.id === subId);
    if (!sub) return;
    try {
        const updated = await apiRequest('PUT', 'subjects.php?id=' + encodeURIComponent(subId), { choPhepNopBai: allowed });
        sub.choPhepNopBai = updated.choPhepNopBai !== false;
        showToast(sub.choPhepNopBai ? `Đã mở nộp bài tập môn "${sub.name}".` : `Đã đóng nộp bài tập môn "${sub.name}".`, 'success');
    } catch (err) {
        showToast('Không thể cập nhật: ' + err.message, 'error');
    }
    renderSubjects();
    renderHomeworks();
}

function updateSubjectDropdowns() {
    const filterDropdown = document.getElementById('filter-subject');
    const formDropdown = document.getElementById('input-hw-subject');
    
    let optionsHTML = subjects.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
    
    filterDropdown.innerHTML = `<option value="all">Tất cả môn học</option>` + optionsHTML;
    formDropdown.innerHTML = optionsHTML;

    updateQuizSubjectDropdowns();
    updateCurriculumSubjectDropdowns();
}

function updateCurriculumSubjectDropdowns() {
    const filterDropdown = document.getElementById('filter-curriculum-subject');
    const formDropdown = document.getElementById('input-curriculum-subject');
    if (!filterDropdown || !formDropdown) return;

    const optionsHTML = subjects.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
    const previousValue = filterDropdown.value;

    filterDropdown.innerHTML = `<option value="all">Tất cả môn</option>` + optionsHTML;
    formDropdown.innerHTML = optionsHTML;

    const stillExists = subjects.some(s => s.id === previousValue);
    filterDropdown.value = (previousValue && stillExists) ? previousValue : 'all';
}

function updateQuizSubjectDropdowns() {
    const quizFilterDropdown = document.getElementById('filter-quiz-subject');
    const quizFormDropdown = document.getElementById('input-quiz-subject');
    if (!quizFilterDropdown || !quizFormDropdown) return;

    let optionsHTML = subjects.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
    quizFormDropdown.innerHTML = optionsHTML;

    const previousValue = quizFilterDropdown.value;
    quizFilterDropdown.innerHTML = optionsHTML;

    if (subjects.length === 0) {
        currentQuizzesSubjectId = null;
        return;
    }

    const stillExists = subjects.some(s => s.id === previousValue);
    quizFilterDropdown.value = stillExists ? previousValue : subjects[0].id;
    currentQuizzesSubjectId = quizFilterDropdown.value;
}

function filterBySubject(subjectId) {
    switchTab('homeworks');
    document.getElementById('filter-subject').value = subjectId;
    renderHomeworks();
}

// Giảng viên: chọn môn mình dạy (bộ lọc môn) rồi bật/tắt cho phép sinh viên nộp bài tập của môn đó.
function renderHwSubmitPanel() {
    const panel = document.getElementById('hw-submit-panel');
    if (!panel) return;
    if (!isGV() || subjects.length === 0) {
        panel.classList.add('hidden');
        panel.innerHTML = '';
        return;
    }
    const filterValue = document.getElementById('filter-subject').value;
    const list = filterValue === 'all' ? subjects : subjects.filter(s => s.id === filterValue);
    panel.innerHTML = `
        <div class="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3"><i class="fa-solid fa-paper-plane mr-2"></i>Cho phép sinh viên nộp bài tập</div>
        <div class="flex flex-wrap gap-3">
            ${list.map(sub => {
                const open = sub.choPhepNopBai !== false;
                return `
                <label class="flex items-center gap-3 px-4 py-2 rounded-xl border ${open ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-900/20' : 'border-slate-200 dark:border-slate-600 bg-slate-50 dark:bg-slate-900/40'} cursor-pointer select-none">
                    <input type="checkbox" ${open ? 'checked' : ''} onchange="toggleSubjectSubmission('${sub.id}', this.checked)" class="w-4 h-4 accent-indigo-600">
                    <span class="text-sm font-medium text-slate-700 dark:text-slate-200">${escapeHtml(sub.name)}</span>
                    <span class="text-xs ${open ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400'}">${open ? 'Đang mở' : 'Đã đóng'}</span>
                </label>`;
            }).join('')}
        </div>`;
    panel.classList.remove('hidden');
}

function renderHomeworks() {
    renderHwSubmitPanel();
    const tbody = document.getElementById('homework-list');
    const emptyState = document.getElementById('empty-homework-state');
    const filterValue = document.getElementById('filter-subject').value;

    document.getElementById('stat-total-hw').innerText = homeworks.length;

    let filteredHW = homeworks;
    if (filterValue !== 'all') {
        filteredHW = filteredHW.filter(hw => hw.subjectId === filterValue);
    }

    if (filteredHW.length === 0) {
        tbody.innerHTML = '';
        emptyState.classList.remove('hidden');
        emptyState.classList.add('flex');
        return;
    }

    emptyState.classList.add('hidden');
    emptyState.classList.remove('flex');

    tbody.innerHTML = filteredHW.map(hw => {
        const subject = subjects.find(s => s.id === hw.subjectId) || { name: 'Chưa phân môn', color: 'bg-slate-400' };
        const subjectColorAttrs = getColorAttrs(subject.color);

        const editHwBtnHtml = canModifyHomework(hw) ? `
            <button onclick="editHomework('${hw.id}')" class="text-slate-400 hover:text-blue-500 dark:hover:text-blue-400 transition-colors p-2 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-900/30 mr-1" title="Sửa bài">
                <i class="fa-solid fa-pen"></i>
            </button>` : '';
        const deleteHwBtnHtml = canModifyHomework(hw) ? `
            <button onclick="deleteHomework('${hw.id}')" class="text-slate-400 hover:text-red-500 dark:hover:text-red-400 transition-colors p-2 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/30" title="Xóa bài">
                <i class="fa-regular fa-trash-can"></i>
            </button>` : '';
        const submitBtnHtml = (typeof nopHomeworkRowButtons === 'function') ? nopHomeworkRowButtons(hw) : '';
        const actionButtons = `${submitBtnHtml}${editHwBtnHtml}${deleteHwBtnHtml}`;
        const hasRowActions = canModifyHomework(hw) || submitBtnHtml !== '';

        const isStudentPost = hw.createdByRole === 'sv';
        const uploaderBadgeClass = isStudentPost
            ? 'text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/30'
            : 'text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-700/60';
        const uploaderIcon = isStudentPost ? 'fa-graduation-cap' : 'fa-chalkboard-user';
        const uploaderTitle = isStudentPost
            ? 'Bài tập do sinh viên này tự đăng'
            : 'Bài tập do giảng viên này đăng';
        const uploaderHtml = (isLoggedIn && hw.createdBy) ? `
                        <span class="inline-flex items-center gap-1 text-[11px] font-medium ${uploaderBadgeClass} px-2 py-0.5 rounded-full" title="${uploaderTitle}">
                            <i class="fa-solid ${uploaderIcon} text-[10px]"></i> Đăng bởi: ${escapeHtml(hw.createdByName || hw.createdBy)}${isStudentPost ? ' (SV)' : ''}
                        </span>` : '';

        return `
            <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors group">
                <td class="px-6 py-4">
                    <div class="flex items-center gap-2 flex-wrap">
                        <div class="${hw.title ? 'text-slate-900 dark:text-slate-100 font-medium' : 'text-slate-400 dark:text-slate-500 italic'}">${hw.title ? escapeHtml(hw.title) : '(Không có tiêu đề)'}</div>
                        ${uploaderHtml}
                    </div>
                    ${hw.description ? `<div class="text-xs text-slate-500 dark:text-slate-400 mt-1 truncate max-w-[200px] sm:max-w-xs">${escapeHtml(hw.description)}</div>` : ''}
                    ${(typeof nopHomeworkStatusBadges === 'function') ? nopHomeworkStatusBadges(hw) : ''}
                    ${(hw.link || hw.textContent || (hw.files && hw.files.length > 0)) ? `
                    <div class="flex items-center gap-3 mt-1.5 flex-wrap">
                        ${hw.link ? `<a href="${escapeHtml(hw.link)}" target="_blank" rel="noopener noreferrer" class="text-xs text-indigo-600 dark:text-indigo-400 hover:underline inline-flex items-center gap-1"><i class="fa-solid fa-link"></i> Link</a>` : ''}
                        ${hw.textContent ? `<button type="button" onclick="viewHomeworkCode('${hw.id}')" class="text-xs text-indigo-600 dark:text-indigo-400 hover:underline inline-flex items-center gap-1"><i class="fa-solid fa-code"></i> Xem nội dung</button>` : ''}
                        ${hw.files && hw.files.length > 0 ? `<button type="button" onclick="viewHomeworkCode('${hw.id}')" class="text-xs text-indigo-600 dark:text-indigo-400 hover:underline inline-flex items-center gap-1"><i class="fa-solid fa-paperclip"></i> Xem tệp (${hw.files.length})</button>` : ''}
                    </div>` : ''}
                </td>
                <td class="px-6 py-4 whitespace-nowrap">
                    <div class="flex items-center gap-2">
                        <span class="w-2 h-2 rounded-full ${subjectColorAttrs.cls}" style="${subjectColorAttrs.style}"></span>
                        <span class="text-sm text-slate-600 dark:text-slate-300">${subject.name}</span>
                    </div>
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-right auth-col ${hasRowActions ? '' : 'hidden'}">
                    ${actionButtons}
                </td>
            </tr>
        `;
    }).join('');
}

async function handleSaveSubject(e) {
    e.preventDefault();
    if(!canManageSubjects()) return;

    const name = document.getElementById('input-subject-name').value.trim();
    const color = selectedSubjectColor;

    if(!name) return;

    if(editingSubId) {
        const duplicate = subjects.find(s => s.id !== editingSubId && s.name.trim().toLowerCase() === name.toLowerCase());

        if(duplicate) {
            showConfirmDialog(
                `Môn học "${name}" đã tồn tại. Bạn có muốn gộp tất cả bài tập của môn hiện tại vào môn "${duplicate.name}" không?`,
                async () => {
                    try {
                        const affected = homeworks.filter(hw => hw.subjectId === editingSubId);
                        for (const hw of affected) {
                            await apiRequest('PUT', `homeworks.php?id=${encodeURIComponent(hw.id)}`, { subjectId: duplicate.id });
                        }
                        await apiRequest('DELETE', `subjects.php?id=${encodeURIComponent(editingSubId)}`);

                        await Promise.all([fetchSubjects(), fetchHomeworks()]);
                        updateSubjectDropdowns();
                        renderSubjects();
                        renderHomeworks();
                        closeModal('modal-subject');
                        document.getElementById('form-subject').reset();
                        showToast('Đã gộp môn học thành công!', 'success');
                    } catch (err) {
                        showToast('Gộp môn học thất bại: ' + err.message, 'error');
                    }
                }
            );
            return;
        }

        try {
            await apiRequest('PUT', `subjects.php?id=${encodeURIComponent(editingSubId)}`, { name, color });
            await fetchSubjects();
            updateSubjectDropdowns();
            renderSubjects();
            renderHomeworks();
            closeModal('modal-subject');
            document.getElementById('form-subject').reset();
            showToast('Đã cập nhật môn học thành công!', 'success');
        } catch (err) {
            showToast('Cập nhật môn học thất bại: ' + err.message, 'error');
        }
    } else {
        try {
            await apiRequest('POST', 'subjects.php', { name, color });
            await fetchSubjects();
            updateSubjectDropdowns();
            renderSubjects();
            renderHomeworks();
            closeModal('modal-subject');
            document.getElementById('form-subject').reset();
            showToast('Đã thêm môn học thành công!', 'success');
        } catch (err) {
            showToast('Thêm môn học thất bại: ' + err.message, 'error');
        }
    }
}

function editSubject(subId) {
    if(!canManageSubjects()) return;
    const sub = subjects.find(s => s.id === subId);
    if(sub) {
        editingSubId = subId;
        document.getElementById('modal-sub-title').innerText = "Sửa Môn Học";
        document.getElementById('input-subject-name').value = sub.name;
        
        selectedSubjectColor = sub.color;
        if(sub.color && sub.color.startsWith('#')) {
            document.querySelectorAll('input[name="subject_color"]').forEach(r => r.checked = false);
            const colorInput = document.getElementById('input-custom-color');
            if(colorInput) colorInput.value = sub.color;
            const preview = document.getElementById('custom-color-preview');
            if(preview) {
                preview.style.backgroundColor = sub.color;
                preview.classList.remove('hidden');
                preview.classList.add('selected');
            }
        } else {
            const colorRadio = document.querySelector(`input[name="subject_color"][value="${sub.color}"]`);
            if(colorRadio) colorRadio.checked = true;
            const preview = document.getElementById('custom-color-preview');
            if(preview) {
                preview.classList.add('hidden');
                preview.classList.remove('selected');
            }
        }

        openModal('modal-subject');
    }
}

function deleteSubject(subId) {
    if(!canAddDeleteSubjects()) return;
    const sub = subjects.find(s => s.id === subId);
    showConfirmDialog(
        `Bạn có chắc chắn muốn xóa môn học "${sub ? sub.name : ''}"? Các bài tập thuộc môn này sẽ chuyển sang "Chưa phân môn" chứ không bị xóa.`,
        async () => {
            try {
                await apiRequest('DELETE', `subjects.php?id=${encodeURIComponent(subId)}`);
                await Promise.all([fetchSubjects(), fetchHomeworks()]);
                updateSubjectDropdowns();
                renderSubjects();
                renderHomeworks();
                showToast('Đã xóa môn học! Các bài tập liên quan chuyển sang "Chưa phân môn".', 'info');
            } catch (err) {
                showToast('Xóa môn học thất bại: ' + err.message, 'error');
            }
        }
    );
}

/* ---------- Giáo trình / Tài liệu môn học ---------- */

function getSubjectName(subjectId) {
    const sub = subjects.find(s => s.id === subjectId);
    return sub ? sub.name : 'Chưa phân môn';
}

function formatCurriculumFileSize(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
    }
    return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function getCurriculumFileIcon(fileName) {
    const ext = (fileName || '').split('.').pop().toLowerCase();
    const map = {
        pdf: 'fa-file-pdf text-red-500',
        doc: 'fa-file-word text-blue-500',
        docx: 'fa-file-word text-blue-500',
        ppt: 'fa-file-powerpoint text-orange-500',
        pptx: 'fa-file-powerpoint text-orange-500',
        xls: 'fa-file-excel text-emerald-500',
        xlsx: 'fa-file-excel text-emerald-500',
        zip: 'fa-file-zipper text-amber-500',
        rar: 'fa-file-zipper text-amber-500',
        txt: 'fa-file-lines text-slate-500',
    };
    return map[ext] || 'fa-file text-slate-400';
}

function renderCurriculum() {
    const listEl = document.getElementById('curriculum-list');
    const noSubjectState = document.getElementById('curriculum-no-subject-state');
    const emptyState = document.getElementById('curriculum-empty-state');
    if (!listEl) return;

    if (subjects.length === 0) {
        listEl.innerHTML = '';
        listEl.classList.add('hidden');
        if (emptyState) emptyState.classList.add('hidden');
        if (noSubjectState) noSubjectState.classList.remove('hidden');
        return;
    }
    if (noSubjectState) noSubjectState.classList.add('hidden');

    const filterSelect = document.getElementById('filter-curriculum-subject');
    const selectedSubjectId = filterSelect ? filterSelect.value : 'all';

    const filtered = curriculumList.filter(item => selectedSubjectId === 'all' || item.subjectId === selectedSubjectId);

    if (filtered.length === 0) {
        listEl.innerHTML = '';
        listEl.classList.add('hidden');
        if (emptyState) emptyState.classList.remove('hidden');
        return;
    }
    listEl.classList.remove('hidden');
    if (emptyState) emptyState.classList.add('hidden');

    const canManage = canManageCurriculum();

    listEl.innerHTML = filtered.map(item => {
        const adminActions = canManage ? `
            <div class="flex items-center gap-1 flex-shrink-0">
                <button onclick="editCurriculum('${item.id}')" class="p-1.5 text-slate-400 hover:text-blue-500 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors" title="Sửa giáo trình">
                    <i class="fa-solid fa-pen text-xs"></i>
                </button>
                <button onclick="deleteCurriculum('${item.id}')" class="p-1.5 text-slate-400 hover:text-red-500 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors" title="Xóa giáo trình">
                    <i class="fa-regular fa-trash-can text-xs"></i>
                </button>
            </div>` : '';

        const isFile = item.loai === 'file';
        const linkBlock = isFile ? `
                <div class="flex items-center gap-2 text-sm">
                    <a href="${API_BASE}curriculum.php?action=download&id=${encodeURIComponent(item.id)}" onclick="saveUiStateBeforeLeave()" class="inline-flex items-center gap-2 font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300">
                        <i class="fa-solid ${getCurriculumFileIcon(item.fileName)}"></i> Xem tệp
                    </a>
                    <a href="${API_BASE}curriculum.php?action=download&id=${encodeURIComponent(item.id)}&download=1" class="inline-flex items-center gap-1 text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400" title="Tải xuống">
                        <i class="fa-solid fa-download"></i>
                    </a>
                    <span class="text-[11px] text-slate-400">${escapeHtml(item.fileName || '')} · ${formatCurriculumFileSize(item.fileSize)}</span>
                </div>` : `
                <a href="${escapeHtml(item.duongDan)}" onclick="saveUiStateBeforeLeave()" class="inline-flex items-center gap-2 text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300">
                    <i class="fa-solid fa-arrow-up-right-from-square"></i> Mở tài liệu
                </a>`;

        return `
            <div class="hsr-panel bg-white dark:bg-slate-800 p-5 rounded-2xl shadow-sm border border-slate-100 dark:border-slate-700 hover:shadow-md transition-all">
                <div class="flex items-start justify-between gap-2 mb-2">
                    <div class="min-w-0">
                        <span class="inline-block text-[11px] font-medium text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/30 px-2 py-0.5 rounded-full mb-1.5">${escapeHtml(getSubjectName(item.subjectId))}</span>
                        <h3 class="font-bold text-base text-slate-900 dark:text-white truncate" title="${escapeHtml(item.tieuDe)}">${escapeHtml(item.tieuDe)}</h3>
                    </div>
                    ${adminActions}
                </div>
                ${item.moTa ? `<p class="text-sm text-slate-500 dark:text-slate-400 mb-3 line-clamp-2">${escapeHtml(item.moTa)}</p>` : ''}
                ${linkBlock}
                <div class="mt-3 pt-3 border-t border-slate-100 dark:border-slate-700 text-[11px] text-slate-400 dark:text-slate-500">
                    Đăng bởi: ${escapeHtml(item.createdBy || '—')}
                </div>
            </div>
        `;
    }).join('');
}

async function handleSaveCurriculum(e) {
    e.preventDefault();
    if (!canManageCurriculum()) return;

    const subjectId = document.getElementById('input-curriculum-subject').value;
    const tieuDe = document.getElementById('input-curriculum-title').value.trim();
    const moTa = document.getElementById('input-curriculum-desc').value.trim();

    if (!subjectId || !tieuDe) {
        showToast('Vui lòng nhập đầy đủ môn học và tiêu đề.', 'warning');
        return;
    }

    // ---- Sửa tài liệu đã có ----
    if (editingCurriculumId) {
        const existing = curriculumList.find(c => String(c.id) === String(editingCurriculumId));
        const payload = { tieuDe, moTa };
        if (existing && existing.loai === 'link') {
            const duongDan = document.getElementById('input-curriculum-link').value.trim();
            if (!duongDan) {
                showToast('Vui lòng nhập đường dẫn tài liệu.', 'warning');
                return;
            }
            payload.duongDan = duongDan;
        }
        try {
            await apiRequest('PUT', `curriculum.php?id=${encodeURIComponent(editingCurriculumId)}`, payload);
            await loadCurriculum();
            closeModal('modal-curriculum');
            document.getElementById('form-curriculum').reset();
            showToast('Đã cập nhật giáo trình thành công!', 'success');
        } catch (err) {
            showToast('Cập nhật giáo trình thất bại: ' + err.message, 'error');
        }
        return;
    }

    // ---- Thêm mới ----
    const duongDan = document.getElementById('input-curriculum-link').value.trim();
    if (!duongDan) {
        showToast('Vui lòng nhập đường dẫn tài liệu.', 'warning');
        return;
    }
    try {
        await apiRequest('POST', 'curriculum.php', { subjectId, tieuDe, moTa, duongDan });
        await loadCurriculum();
        closeModal('modal-curriculum');
        document.getElementById('form-curriculum').reset();
        showToast('Đã thêm giáo trình thành công!', 'success');
    } catch (err) {
        showToast('Thêm giáo trình thất bại: ' + err.message, 'error');
    }
}

function editCurriculum(id) {
    if (!canManageCurriculum()) return;
    const item = curriculumList.find(c => String(c.id) === String(id));
    if (!item) return;

    editingCurriculumId = id;
    document.getElementById('modal-curriculum-title').innerText = 'Sửa Giáo Trình';
    document.getElementById('input-curriculum-subject').value = item.subjectId;
    document.getElementById('input-curriculum-subject').disabled = true;
    document.getElementById('input-curriculum-title').value = item.tieuDe;
    document.getElementById('input-curriculum-desc').value = item.moTa || '';

    if (item.loai === 'file') {
        document.getElementById('input-curriculum-link').value = '';
        document.getElementById('input-curriculum-link').required = false;
        document.getElementById('input-curriculum-link').disabled = true;
        document.getElementById('curriculum-existing-file-note').classList.remove('hidden');
    } else {
        document.getElementById('input-curriculum-link').value = item.duongDan || '';
        document.getElementById('input-curriculum-link').required = true;
        document.getElementById('input-curriculum-link').disabled = false;
        document.getElementById('curriculum-existing-file-note').classList.add('hidden');
    }

    openModal('modal-curriculum');
}

function deleteCurriculum(id) {
    if (!canManageCurriculum()) return;
    const item = curriculumList.find(c => String(c.id) === String(id));
    showConfirmDialog(
        `Bạn có chắc chắn muốn xóa giáo trình "${item ? escapeHtml(item.tieuDe) : ''}"?`,
        async () => {
            try {
                await apiRequest('DELETE', `curriculum.php?id=${encodeURIComponent(id)}`);
                await loadCurriculum();
                showToast('Đã xóa giáo trình.', 'info');
            } catch (err) {
                showToast('Xóa giáo trình thất bại: ' + err.message, 'error');
            }
        }
    );
}

async function handleSaveHomework(e) {
    e.preventDefault();

    if(editingHwId) {
        const existing = homeworks.find(h => h.id === editingHwId);
        if(!canModifyHomework(existing)) return;
    } else {
        if(!canCreateHomework()) return;
    }

    const title = document.getElementById('input-hw-title').value.trim();
    const subjectId = document.getElementById('input-hw-subject').value;
    const desc = document.getElementById('input-hw-desc').value.trim();
    const link = normalizeLink(document.getElementById('input-hw-link').value.trim());
    const textContent = document.getElementById('input-hw-textcontent').value;

    if(!subjectId) {
        showToast('Vui lòng chọn môn học!', 'error');
        return;
    }

    const payload = { title, subjectId, description: desc, link, textContent };

    try {
        let hwId = editingHwId;
        if(editingHwId) {
            await apiRequest('PUT', `homeworks.php?id=${encodeURIComponent(editingHwId)}`, payload);
        } else {
            const created = await apiRequest('POST', 'homeworks.php', payload);
            hwId = created.id;
        }

        if (modalPendingFiles.length > 0) {
            await uploadPendingFiles(hwId);
        }

        showToast(editingHwId ? 'Đã cập nhật bài tập!' : 'Đã thêm bài tập mới!', 'success');
        await fetchHomeworks();
        renderHomeworks();
        renderSubjects();
        closeModal('modal-homework');
    } catch (err) {
        showToast('Lưu bài tập thất bại: ' + err.message, 'error');
    }
}

function editHomework(id) {
    const hw = homeworks.find(h => h.id === id);
    if(!canModifyHomework(hw)) return;
    if(hw) {
        editingHwId = id;
        document.getElementById('modal-hw-title').innerText = "Sửa Bài Tập";
        
        document.getElementById('input-hw-title').value = hw.title;
        document.getElementById('input-hw-subject').value = hw.subjectId;
        document.getElementById('input-hw-desc').value = hw.description;
        document.getElementById('input-hw-link').value = hw.link || '';
        document.getElementById('input-hw-textcontent').value = hw.textContent || '';

        modalExistingFiles = (hw.files || []).map(f => ({ ...f }));
        modalPendingFiles = [];
        renderHwFilesUI();

        openModal('modal-homework');
    }
}

function deleteHomework(id) {
    const hw = homeworks.find(h => h.id === id);
    if(!canModifyHomework(hw)) return;
    showConfirmDialog(
        `Bạn có chắc chắn muốn xóa bài tập "${hw ? hw.title : ''}"?`,
        async () => {
            try {
                await apiRequest('DELETE', `homeworks.php?id=${encodeURIComponent(id)}`);
                await fetchHomeworks();
                renderHomeworks();
                renderSubjects();
                showToast('Đã xóa bài tập.', 'info');
            } catch (err) {
                showToast('Xóa bài tập thất bại: ' + err.message, 'error');
            }
        }
    );
}
/* =========================================================
   KIỂM TRA / THI CỬ
   - GV: tạo bài kiểm tra (trắc nghiệm/tự luận) theo môn học, xem điểm sinh viên.
   - SV: xem danh sách bài kiểm tra của môn học, vào làm bài, nộp bài.
   ========================================================= */

let quizTimerInterval;
let quizTimeRemaining = 0;

async function loadQuizzesForSelectedSubject() {
    const noSubjectState = document.getElementById('quiz-no-subject-state');
    const emptyState = document.getElementById('quiz-empty-state');
    const listContainer = document.getElementById('quiz-list-container');
    const subjectSelect = document.getElementById('filter-quiz-subject');
    if (!listContainer) return;

    if (subjects.length === 0) {
        listContainer.innerHTML = '';
        if (emptyState) emptyState.classList.add('hidden');
        if (noSubjectState) noSubjectState.classList.remove('hidden');
        return;
    }
    if (noSubjectState) noSubjectState.classList.add('hidden');

    const subjectId = subjectSelect ? subjectSelect.value : currentQuizzesSubjectId;
    currentQuizzesSubjectId = subjectId;
    if (!subjectId) {
        listContainer.innerHTML = '';
        return;
    }

    try {
        const res = await fetch(`${API_BASE}quizzes.php?action=list&mon_hoc_id=${encodeURIComponent(subjectId)}`, { credentials: 'same-origin' });
        const str = await res.text();
        const xmlDoc = new window.DOMParser().parseFromString(str, 'text/xml');
        renderQuizList(xmlDoc);
    } catch (err) {
        listContainer.innerHTML = '';
        showToast('Không thể tải danh sách bài kiểm tra: ' + err.message, 'error');
    }
}

function renderQuizList(xmlDoc) {
    const emptyState = document.getElementById('quiz-empty-state');
    const listContainer = document.getElementById('quiz-list-container');
    if (!listContainer) return;

    const errResp = xmlDoc.getElementsByTagName('Response')[0];
    if (errResp) {
        if (emptyState) emptyState.classList.add('hidden');
        listContainer.innerHTML = `<div class="col-span-full text-center py-12 text-slate-500 dark:text-slate-400">Vui lòng đăng nhập để xem danh sách bài kiểm tra.</div>`;
        return;
    }

    const quizList = Array.from(xmlDoc.getElementsByTagName('BaiKiemTra'));

    if (quizList.length === 0) {
        listContainer.innerHTML = '';
        if (emptyState) emptyState.classList.remove('hidden');
        return;
    }
    if (emptyState) emptyState.classList.add('hidden');

    listContainer.innerHTML = quizList.map(buildQuizCardHtml).join('');
}

function buildQuizCardHtml(q) {
    const id = q.getAttribute('id');
    const title = q.getElementsByTagName('TieuDe')[0].textContent;
    const moTaNode = q.getElementsByTagName('MoTa')[0];
    const moTa = moTaNode ? moTaNode.textContent : '';
    const thoiGian = q.getElementsByTagName('ThoiGianLamBai')[0].textContent;
    const soCauHoi = q.getElementsByTagName('SoCauHoi')[0].textContent;
    const hienThi = q.getElementsByTagName('HienThi')[0]?.textContent === '1';
    const choPhepLamBai = q.getElementsByTagName('ChoPhepLamBai')[0]?.textContent === '1';

    let footerHtml;

    if (isGV()) {
        const soLuotNopNode = q.getElementsByTagName('SoLuotNop')[0];
        const soLuotNop = soLuotNopNode ? soLuotNopNode.textContent : '0';
        footerHtml = `
            <div class="mt-6 pt-5 border-t border-slate-100 dark:border-slate-700 space-y-4">
                <div class="flex items-center justify-between">
                    <span class="text-base text-slate-500 dark:text-slate-400">${soLuotNop} lượt đã nộp</span>
                    <div class="flex items-center gap-5">
                        <button type="button" onclick="openEditQuizModal('${id}')" class="text-base font-medium text-sky-600 dark:text-sky-400 hover:text-sky-800 dark:hover:text-sky-300">
                            <i class="fa-solid fa-pen mr-1"></i>Sửa
                        </button>
                        <button type="button" onclick="viewQuizResults('${id}')" class="text-base font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300">
                            <i class="fa-solid fa-chart-simple mr-1"></i>Xem kết quả
                        </button>
                        <button type="button" onclick="deleteQuiz('${id}')" class="text-base font-medium text-red-500 hover:text-red-700" title="Xóa bài kiểm tra">
                            <i class="fa-regular fa-trash-can"></i>
                        </button>
                    </div>
                </div>
                <div class="flex items-center gap-3">
                    <button type="button" onclick="toggleQuizVisibility('${id}')"
                        class="flex-1 text-base font-medium px-4 py-3 rounded-lg transition-colors ${hienThi ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400'}">
                        <i class="fa-solid ${hienThi ? 'fa-eye' : 'fa-eye-slash'} mr-1"></i>${hienThi ? 'Đang hiện đề' : 'Đang ẩn đề'}
                    </button>
                    <button type="button" onclick="toggleQuizOpen('${id}')"
                        class="flex-1 text-base font-medium px-4 py-3 rounded-lg transition-colors ${choPhepLamBai ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400'}">
                        <i class="fa-solid ${choPhepLamBai ? 'fa-lock-open' : 'fa-lock'} mr-1"></i>${choPhepLamBai ? 'Đang mở làm bài' : 'Đang đóng làm bài'}
                    </button>
                </div>
            </div>
        `;
    } else if (isSV()) {
        const biCam = q.getElementsByTagName('BiCam')[0]?.textContent === '1';
        const trangThaiLamBaiNode = q.getElementsByTagName('TrangThaiLamBai')[0];
        const trangThaiLamBai = trangThaiLamBaiNode ? trangThaiLamBaiNode.textContent : 'chua_lam';

        if (biCam) {
            footerHtml = `
                <div class="mt-6 pt-5 border-t border-slate-100 dark:border-slate-700 text-base font-medium text-red-500 dark:text-red-400">
                    <i class="fa-solid fa-ban mr-1"></i>Bạn đã bị cấm thi bài kiểm tra này.
                </div>
            `;
        } else if (trangThaiLamBai === 'da_nop') {
            const diemSoNode = q.getElementsByTagName('DiemSo')[0];
            const diemSo = diemSoNode ? Number(diemSoNode.textContent).toFixed(2) : '-';
            footerHtml = `
                <div class="mt-6 pt-5 border-t border-slate-100 dark:border-slate-700 flex items-center justify-between">
                    <span class="text-base font-medium text-emerald-600 dark:text-emerald-400"><i class="fa-solid fa-circle-check mr-1"></i>Đã nộp bài</span>
                    <span class="text-lg font-bold text-slate-800 dark:text-white">Điểm: ${diemSo}/10</span>
                </div>
            `;
        } else if (!choPhepLamBai) {
            footerHtml = `
                <div class="mt-6 pt-5 border-t border-slate-100 dark:border-slate-700 text-base text-slate-400 dark:text-slate-500">
                    <i class="fa-solid fa-lock mr-1"></i>Giáo viên chưa mở cho phép làm bài này.
                </div>
            `;
        } else {
            const btnLabel = trangThaiLamBai === 'dang_lam' ? 'Tiếp tục làm bài' : 'Bắt đầu làm bài';
            footerHtml = `
                <div class="mt-6 pt-5 border-t border-slate-100 dark:border-slate-700">
                    <button type="button" onclick="startQuiz('${id}')" class="w-full hsr-btn bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3.5 rounded-xl text-lg font-semibold transition-colors">
                        <i class="fa-solid fa-pen-to-square mr-1"></i> ${btnLabel}
                    </button>
                </div>
            `;
        }
    } else {
        footerHtml = `
            <div class="mt-6 pt-5 border-t border-slate-100 dark:border-slate-700 text-base text-slate-400 dark:text-slate-500">
                Đăng nhập với tài khoản Sinh viên để làm bài kiểm tra này.
            </div>
        `;
    }

    return `
        <div class="hsr-panel bg-white dark:bg-slate-800 p-8 rounded-2xl shadow-sm border border-slate-100 dark:border-slate-700">
            <h3 class="text-2xl font-bold text-slate-900 dark:text-white">${escapeHtml(title)}</h3>
            ${moTa ? `<p class="text-lg text-slate-500 dark:text-slate-400 mt-2">${escapeHtml(moTa)}</p>` : ''}
            <div class="flex items-center gap-6 mt-4 text-lg text-slate-500 dark:text-slate-400">
                <span><i class="fa-regular fa-clock mr-1"></i>${escapeHtml(thoiGian)} phút</span>
                <span><i class="fa-solid fa-list-ol mr-1"></i>${escapeHtml(soCauHoi)} câu hỏi</span>
            </div>
            ${footerHtml}
        </div>
    `;
}

/* ---------- GV: sửa câu hỏi & đáp án của bài kiểm tra ----------
   Chỉ sửa nội dung đề (câu hỏi, 4 đáp án, đáp án đúng). Câu trả lời của sinh
   viên nằm ở bảng khác và KHÔNG bị thay đổi. */
let quizEditState = null;

async function openEditQuizModal(quizId) {
    if (!isGV()) return;
    try {
        const res = await fetch(`${API_BASE}quizzes.php?action=edit_get&id=${quizId}`, { credentials: 'same-origin' });
        const str = await res.text();
        const data = new window.DOMParser().parseFromString(str, 'text/xml');

        const errResp = data.getElementsByTagName('Response')[0];
        if (errResp) {
            const msg = errResp.getElementsByTagName('Message')[0];
            showToast(msg ? msg.textContent : 'Không thể tải bài kiểm tra.', 'error');
            return;
        }

        const root = data.getElementsByTagName('BaiKiemTraSua')[0];
        const txt = (parent, tag) => parent.getElementsByTagName(tag)[0]?.textContent || '';

        quizEditState = {
            id: quizId,
            questions: Array.from(root.getElementsByTagName('CauHoi')).map(ch => ({
                id: ch.getAttribute('id'),
                loai: ch.getAttribute('loai'),
                noiDung: txt(ch, 'NoiDung'),
                dapA: txt(ch, 'DapAnA'), dapB: txt(ch, 'DapAnB'),
                dapC: txt(ch, 'DapAnC'), dapD: txt(ch, 'DapAnD'),
                dapDung: txt(ch, 'DapAnDung') || 'A'
            }))
        };

        document.getElementById('edit-quiz-title').value = txt(root, 'TieuDe');
        document.getElementById('edit-quiz-desc').value = txt(root, 'MoTa');
        document.getElementById('edit-quiz-thoigian').value = txt(root, 'ThoiGianLamBai');
        document.getElementById('edit-quiz-thoigianketqua').value = txt(root, 'ThoiGianHienThiKetQua');
        document.getElementById('edit-quiz-chonggianlan').checked = txt(root, 'ChongGianLan') !== '0';

        const editReport = document.getElementById('edit-excel-import-report');
        if (editReport) { editReport.innerHTML = ''; editReport.classList.add('hidden'); }
        renderQuizEditQuestions();
        openModal('modal-quiz-edit');
    } catch (err) {
        showToast('Không thể tải bài kiểm tra: ' + err.message, 'error');
    }
}

function quizEditUpdate(index, field, value) {
    if (quizEditState && quizEditState.questions[index]) {
        quizEditState.questions[index][field] = value;
    }
}

function addQuizEditQuestion(loai) {
    if (!quizEditState) return;
    quizEditState.questions.push({
        id: null,
        isNew: true,
        loai: loai,
        noiDung: '',
        dapA: '', dapB: '', dapC: '', dapD: '',
        dapDung: 'A'
    });
    renderQuizEditQuestions();
    const container = document.getElementById('edit-quiz-questions');
    const last = container && container.lastElementChild;
    if (last) {
        last.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const ta = last.querySelector('textarea');
        if (ta) ta.focus();
    }
}

// Chỉ cho xóa câu hỏi MỚI thêm (chưa lưu). Câu hỏi đã có trong đề được giữ lại
// để không làm mất câu trả lời sinh viên đã làm.
function removeQuizEditQuestion(index) {
    if (!quizEditState) return;
    const q = quizEditState.questions[index];
    if (!q || !q.isNew) return;
    quizEditState.questions.splice(index, 1);
    renderQuizEditQuestions();
}

function renderQuizEditQuestions() {
    const container = document.getElementById('edit-quiz-questions');
    if (!container || !quizEditState) return;

    const inputCls = 'w-full px-4 py-3 text-lg rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500';

    container.innerHTML = quizEditState.questions.map((q, index) => {
        const isTN = q.loai === 'trac_nghiem';
        return `
            <div class="border border-slate-200 dark:border-slate-600 rounded-xl p-6 bg-slate-50 dark:bg-slate-900/40">
                <div class="flex items-center justify-between mb-4">
                    <span class="text-xl font-semibold text-slate-800 dark:text-slate-100">Câu ${index + 1}</span>
                    <div class="flex items-center gap-3">
                        ${q.isNew ? '<span class="text-sm font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/30 px-2 py-1 rounded-lg">Mới</span>' : ''}
                        <span class="text-base text-slate-500 dark:text-slate-400">${isTN ? 'Trắc nghiệm' : 'Tự luận'}</span>
                        ${q.isNew ? `<button type="button" onclick="removeQuizEditQuestion(${index})" class="text-slate-400 hover:text-red-500" title="Xóa câu hỏi mới"><i class="fa-regular fa-trash-can text-lg"></i></button>` : ''}
                    </div>
                </div>
                <textarea rows="2" oninput="quizEditUpdate(${index}, 'noiDung', this.value)" placeholder="Nội dung câu hỏi..." class="${inputCls} mb-4">${escapeHtml(q.noiDung)}</textarea>
                ${isTN ? `
                    <div class="space-y-3">
                        ${['A', 'B', 'C', 'D'].map(letter => `
                            <div class="flex items-center gap-3">
                                <input type="radio" name="edit_dung_${index}" class="w-5 h-5" ${q.dapDung === letter ? 'checked' : ''} onchange="quizEditUpdate(${index}, 'dapDung', '${letter}')" title="Đáp án đúng">
                                <span class="text-lg font-semibold text-slate-600 dark:text-slate-300 w-6">${letter}.</span>
                                <input type="text" value="${escapeHtml(q['dap' + letter])}" oninput="quizEditUpdate(${index}, 'dap${letter}', this.value)" placeholder="Đáp án ${letter}" class="${inputCls}">
                            </div>
                        `).join('')}
                    </div>
                    <p class="text-base text-slate-400 mt-3">Chọn nút tròn cạnh đáp án đúng.</p>
                ` : ''}
            </div>
        `;
    }).join('');
}

async function handleEditQuizSubmit(e) {
    e.preventDefault();
    if (!isGV() || !quizEditState) return;

    const title = document.getElementById('edit-quiz-title').value.trim();
    const desc = document.getElementById('edit-quiz-desc').value.trim();
    const thoiGian = parseInt(document.getElementById('edit-quiz-thoigian').value, 10) || 45;
    const thoiGianKetQua = Math.max(0, parseInt(document.getElementById('edit-quiz-thoigianketqua').value, 10) || 0);

    if (!title) {
        showToast('Tiêu đề không được để trống!', 'error');
        return;
    }
    for (const q of quizEditState.questions) {
        if (!q.noiDung.trim()) {
            showToast('Vui lòng nhập đầy đủ nội dung cho tất cả câu hỏi!', 'error');
            return;
        }
        if (q.loai === 'trac_nghiem' && (!q.dapA.trim() || !q.dapB.trim() || !q.dapC.trim() || !q.dapD.trim())) {
            showToast('Vui lòng nhập đầy đủ 4 đáp án cho các câu trắc nghiệm!', 'error');
            return;
        }
    }

    const xmlDoc = document.implementation.createDocument(null, 'SuaBaiKiemTra');
    const root = xmlDoc.documentElement;
    const append = (parent, tag, text) => {
        const node = xmlDoc.createElement(tag);
        node.textContent = text;
        parent.appendChild(node);
        return node;
    };
    append(root, 'QuizId', String(quizEditState.id));
    append(root, 'TieuDe', title);
    append(root, 'MoTa', desc);
    append(root, 'ThoiGianLamBai', String(thoiGian));
    append(root, 'ThoiGianHienThiKetQua', String(thoiGianKetQua));
    append(root, 'ChongGianLan', document.getElementById('edit-quiz-chonggianlan').checked ? '1' : '0');

    quizEditState.questions.forEach(q => {
        const chNode = xmlDoc.createElement('CauHoi');
        if (q.isNew) {
            chNode.setAttribute('loai', q.loai);
        } else {
            chNode.setAttribute('id', q.id);
        }
        append(chNode, 'NoiDung', q.noiDung);
        if (q.loai === 'trac_nghiem') {
            ['A', 'B', 'C', 'D'].forEach(letter => append(chNode, 'DapAn' + letter, q['dap' + letter]));
            append(chNode, 'DapAnDung', q.dapDung);
        }
        root.appendChild(chNode);
    });

    const saveBtn = document.getElementById('btn-quiz-edit-save');
    if (saveBtn) saveBtn.disabled = true;
    try {
        const res = await fetch(`${API_BASE}quizzes.php?action=edit_save`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/xml' },
            body: new XMLSerializer().serializeToString(xmlDoc)
        });
        const str = await res.text();
        const data = new window.DOMParser().parseFromString(str, 'text/xml');
        const status = data.getElementsByTagName('Status')[0]?.textContent;
        if (status === 'Success') {
            showToast('Đã lưu thay đổi bài kiểm tra.', 'success');
            closeModal('modal-quiz-edit');
            quizEditState = null;
            loadQuizzesForSelectedSubject();
        } else {
            const msg = data.getElementsByTagName('Message')[0];
            showToast(msg ? msg.textContent : 'Không thể lưu thay đổi.', 'error');
        }
    } catch (err) {
        showToast('Không thể lưu thay đổi: ' + err.message, 'error');
    } finally {
        if (saveBtn) saveBtn.disabled = false;
    }
}

/* ---------- GV: hiện/ẩn đề & bật/tắt cho phép làm bài ---------- */

async function toggleQuizVisibility(quizId) {
    if (!isGV()) return;
    try {
        const res = await fetch(`${API_BASE}quizzes.php?action=toggle_visibility&id=${quizId}`, { method: 'POST', credentials: 'same-origin' });
        const str = await res.text();
        const data = new window.DOMParser().parseFromString(str, 'text/xml');
        const status = data.getElementsByTagName('Status')[0]?.textContent;
        if (status === 'Success') {
            loadQuizzesForSelectedSubject();
        } else {
            const msg = data.getElementsByTagName('Message')[0];
            showToast(msg ? msg.textContent : 'Thao tác thất bại.', 'error');
        }
    } catch (err) {
        showToast('Thao tác thất bại: ' + err.message, 'error');
    }
}

async function toggleQuizOpen(quizId) {
    if (!isGV()) return;
    try {
        const res = await fetch(`${API_BASE}quizzes.php?action=toggle_open&id=${quizId}`, { method: 'POST', credentials: 'same-origin' });
        const str = await res.text();
        const data = new window.DOMParser().parseFromString(str, 'text/xml');
        const status = data.getElementsByTagName('Status')[0]?.textContent;
        if (status === 'Success') {
            loadQuizzesForSelectedSubject();
        } else {
            const msg = data.getElementsByTagName('Message')[0];
            showToast(msg ? msg.textContent : 'Thao tác thất bại.', 'error');
        }
    } catch (err) {
        showToast('Thao tác thất bại: ' + err.message, 'error');
    }
}

/* ---------- GV: tạo bài kiểm tra ---------- */

function openCreateQuizModal() {
    if (!isGV()) return;
    if (subjects.length === 0) {
        showToast('Vui lòng thêm môn học trước khi tạo bài kiểm tra!', 'warning');
        return;
    }
    document.getElementById('form-quiz').reset();
    if (currentQuizzesSubjectId) {
        document.getElementById('input-quiz-subject').value = currentQuizzesSubjectId;
    }
    quizBuilderQuestions = [];
    const importReport = document.getElementById('excel-import-report');
    if (importReport) { importReport.innerHTML = ''; importReport.classList.add('hidden'); }
    addQuizQuestionRow();
    openModal('modal-quiz');
}
function addQuizQuestionRow() {
    quizBuilderQuestions.push({
        tempId: 'q-' + Date.now() + '-' + Math.random().toString(36).slice(2),
        loai: 'trac_nghiem',
        noiDung: '', dapA: '', dapB: '', dapC: '', dapD: '', dapDung: 'A'
    });
    renderQuizQuestionsBuilder();
}

function removeQuizQuestionRow(tempId) {
    quizBuilderQuestions = quizBuilderQuestions.filter(q => q.tempId !== tempId);
    renderQuizQuestionsBuilder();
}

function updateQuizQuestionField(tempId, field, value) {
    const q = quizBuilderQuestions.find(item => item.tempId === tempId);
    if (q) q[field] = value;
    if (field === 'loai') renderQuizQuestionsBuilder();
}

/* GV KHÔNG tự chấm điểm từng câu nữa - tổng bài luôn là 10 điểm, tự động
   chia đều cho số câu hỏi (VD: 1 câu = 10đ, 2 câu = 5đ/câu, 4 câu = 2.5đ/câu).
   Tính theo "xu" (phần trăm điểm, 10.00đ = 1000 xu) để chia hết tuyệt đối,
   phần dư (nếu có) được dồn vào câu cuối cùng cho tổng luôn đúng = 10. */
function computeAutoDiemList(count) {
    if (count <= 0) return [];
    const TONG_XU = 1000; // 10.00 điểm
    const base = Math.floor(TONG_XU / count);
    const du = TONG_XU - base * count;
    const xuList = new Array(count).fill(base);
    for (let i = 0; i < du; i++) {
        xuList[count - 1 - i] += 1;
    }
    return xuList.map(xu => xu / 100);
}

function updateQuizTotalDiem() {
    const totalEl = document.getElementById('quiz-total-diem');
    const saveBtn = document.getElementById('btn-quiz-save');
    if (!totalEl) return true;

    const total = quizBuilderQuestions.length > 0 ? 10 : 0;
    totalEl.textContent = total.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
    if (saveBtn) saveBtn.disabled = false;
    return true;
}

function renderQuizQuestionsBuilder() {
    const container = document.getElementById('quiz-questions-builder');
    if (!container) return;

    if (quizBuilderQuestions.length === 0) {
        container.innerHTML = `<p class="text-xs text-slate-400 dark:text-slate-500">Chưa có câu hỏi nào. Bấm "Thêm câu hỏi" để bắt đầu.</p>`;
        updateQuizTotalDiem();
        return;
    }

    const diemList = computeAutoDiemList(quizBuilderQuestions.length);

    container.innerHTML = quizBuilderQuestions.map((q, index) => {
        const isTracNghiem = q.loai === 'trac_nghiem';
        const diemCauNay = diemList[index];
        const diemLabel = diemCauNay.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
        return `
            <div class="border border-slate-200 dark:border-slate-600 rounded-xl p-4 bg-slate-50 dark:bg-slate-900/40">
                <div class="flex items-center justify-between mb-3">
                    <span class="text-sm font-semibold text-slate-700 dark:text-slate-200">Câu ${index + 1}</span>
                    <div class="flex items-center gap-3">
                        <span class="text-xs font-medium text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/30 px-2 py-1 rounded-lg" title="Tự động chia đều 10 điểm cho tất cả các câu">${diemLabel} điểm</span>
                        <select onchange="updateQuizQuestionField('${q.tempId}', 'loai', this.value)" class="text-xs px-2 py-1 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200">
                            <option value="trac_nghiem" ${isTracNghiem ? 'selected' : ''}>Trắc nghiệm</option>
                            <option value="tu_luan" ${!isTracNghiem ? 'selected' : ''}>Tự luận</option>
                        </select>
                        <button type="button" onclick="removeQuizQuestionRow('${q.tempId}')" class="text-slate-400 hover:text-red-500" title="Xóa câu hỏi">
                            <i class="fa-regular fa-trash-can"></i>
                        </button>
                    </div>
                </div>
                <textarea rows="2" placeholder="Nội dung câu hỏi..." oninput="updateQuizQuestionField('${q.tempId}', 'noiDung', this.value)" class="w-full mb-3 px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none">${escapeHtml(q.noiDung)}</textarea>
                ${isTracNghiem ? `
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    ${['A', 'B', 'C', 'D'].map(letter => `
                        <div class="flex items-center gap-2">
                            <input type="radio" name="dung_${q.tempId}" ${q.dapDung === letter ? 'checked' : ''} onchange="updateQuizQuestionField('${q.tempId}', 'dapDung', '${letter}')" title="Đáp án đúng">
                            <input type="text" placeholder="Đáp án ${letter}" value="${escapeHtml(q['dap' + letter])}" oninput="updateQuizQuestionField('${q.tempId}', 'dap${letter}', this.value)" class="flex-1 px-3 py-1.5 text-sm rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
                        </div>
                    `).join('')}
                </div>
                <p class="text-[11px] text-slate-400 mt-1.5">Chọn nút tròn cạnh đáp án đúng.</p>
                ` : ''}
            </div>
        `;
    }).join('');

    updateQuizTotalDiem();
}

async function handleCreateQuizSubmit(e) {
    e.preventDefault();
    if (!isGV()) return;

    const subjectId = document.getElementById('input-quiz-subject').value;
    const title = document.getElementById('input-quiz-title').value.trim();
    const desc = document.getElementById('input-quiz-desc').value.trim();
    const thoiGian = parseInt(document.getElementById('input-quiz-thoigian').value, 10) || 45;
    const thoiGianKetQuaRaw = document.getElementById('input-quiz-thoigianketqua').value;
    // Số giây hiển thị ô xem lại kết quả sau khi nộp bài. 0 = vô hạn.
    const thoiGianKetQua = Math.max(0, parseInt(thoiGianKetQuaRaw, 10) || 0);

    if (!subjectId || !title) {
        showToast('Vui lòng chọn môn học và nhập tiêu đề!', 'error');
        return;
    }
    if (quizBuilderQuestions.length === 0) {
        showToast('Vui lòng thêm ít nhất 1 câu hỏi!', 'error');
        return;
    }
    if (!updateQuizTotalDiem()) {
        showToast('Tổng điểm các câu hỏi phải lớn hơn 0 và không vượt quá 10!', 'error');
        return;
    }
    for (const q of quizBuilderQuestions) {
        if (!q.noiDung.trim()) {
            showToast('Vui lòng nhập đầy đủ nội dung cho tất cả câu hỏi!', 'error');
            return;
        }
        if (q.loai === 'trac_nghiem' && (!q.dapA.trim() || !q.dapB.trim() || !q.dapC.trim() || !q.dapD.trim())) {
            showToast('Vui lòng nhập đầy đủ 4 đáp án cho các câu trắc nghiệm!', 'error');
            return;
        }
    }

    const xmlDoc = document.implementation.createDocument(null, 'BaiKiemTraMoi');
    const root = xmlDoc.documentElement;
    const append = (tag, text) => {
        const node = xmlDoc.createElement(tag);
        node.textContent = text;
        root.appendChild(node);
    };
    append('TieuDe', title);
    append('MoTa', desc);
    append('MonHocId', subjectId);
    append('ThoiGianLamBai', String(thoiGian));
    append('ThoiGianHienThiKetQua', String(thoiGianKetQua));
    append('ChongGianLan', document.getElementById('input-quiz-chonggianlan').checked ? '1' : '0');

    // Điểm từng câu KHÔNG do GV tự nhập - luôn tự động chia đều 10 điểm
    // cho tổng số câu hỏi của bài (VD: 1 câu = 10đ, 2 câu = 5đ/câu...).
    const diemTuDongList = computeAutoDiemList(quizBuilderQuestions.length);

    quizBuilderQuestions.forEach((q, index) => {
        const chNode = xmlDoc.createElement('CauHoi');
        chNode.setAttribute('loai', q.loai);
        const noiDungNode = xmlDoc.createElement('NoiDung');
        noiDungNode.textContent = q.noiDung;
        chNode.appendChild(noiDungNode);
        const diemNode = xmlDoc.createElement('Diem');
        diemNode.textContent = String(diemTuDongList[index]);
        chNode.appendChild(diemNode);
        if (q.loai === 'trac_nghiem') {
            ['A', 'B', 'C', 'D'].forEach(letter => {
                const node = xmlDoc.createElement('DapAn' + letter);
                node.textContent = q['dap' + letter];
                chNode.appendChild(node);
            });
            const dungNode = xmlDoc.createElement('DapAnDung');
            dungNode.textContent = q.dapDung;
            chNode.appendChild(dungNode);
        }
        root.appendChild(chNode);
    });

    const xmlString = new XMLSerializer().serializeToString(xmlDoc);

    try {
        const res = await fetch(`${API_BASE}quizzes.php?action=create`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/xml' },
            body: xmlString
        });
        const str = await res.text();
        const data = new window.DOMParser().parseFromString(str, 'text/xml');
        const parseErrorNode = data.getElementsByTagName('parsererror')[0];
        const status = !parseErrorNode ? data.getElementsByTagName('Status')[0]?.textContent : null;

        if (status === 'Success') {
            showToast('Đã tạo bài kiểm tra thành công!', 'success');
            closeModal('modal-quiz');
            currentQuizzesSubjectId = subjectId;
            const filterSelect = document.getElementById('filter-quiz-subject');
            if (filterSelect) filterSelect.value = subjectId;
            loadQuizzesForSelectedSubject();
        } else {
            // Nếu PHP lỗi (VD: database chưa cập nhật đúng cấu trúc bảng),
            // máy chủ có thể trả về JSON thay vì XML -> parse XML sẽ ra
            // "parsererror". Thử đọc tiếp dạng JSON để lấy thông báo lỗi
            // thật, thay vì chỉ hiện "thất bại" chung chung không rõ nguyên nhân.
            let errText = !parseErrorNode ? data.getElementsByTagName('Message')[0]?.textContent : null;
            if (!errText) {
                try {
                    const asJson = JSON.parse(str);
                    if (asJson && asJson.error) errText = asJson.error;
                } catch (e) { /* không phải JSON, bỏ qua */ }
            }
            console.error('Tạo bài kiểm tra thất bại - phản hồi thô từ máy chủ:', str);
            showToast(errText || 'Tạo bài kiểm tra thất bại (phản hồi không hợp lệ từ máy chủ - xem Console [F12] để biết chi tiết).', 'error');
        }
    } catch (err) {
        showToast('Tạo bài kiểm tra thất bại: ' + err.message, 'error');
    }
}

/* ---------- Tên sinh viên hiển thị: "Tên (MSSV)", không có tên thì dùng tên đăng nhập ---------- */

function formatStudentLabel(hoTen, maSoSv, username) {
    const name = hoTen && String(hoTen).trim() !== '' ? hoTen : username;
    return maSoSv ? `${name} (${maSoSv})` : (name || '');
}

/* ---------- GV: nạp câu hỏi trắc nghiệm từ file Excel ----------
   Cột A: câu hỏi. Cột B-E: đáp án A-D. Đáp án IN ĐẬM là đáp án đúng.
   Việc đọc file nằm trong excel_import.js (parseQuizExcel). Câu hỏi nạp vào
   được đưa vào form (tạo mới hoặc sửa bài) để GV xem lại trước khi lưu. */

function isBlankBuilderQuestion(q) {
    return !q.noiDung.trim() && !q.dapA.trim() && !q.dapB.trim() && !q.dapC.trim() && !q.dapD.trim();
}

function showExcelImportReport(mode, kq, fileName) {
    const box = document.getElementById(mode === 'edit' ? 'edit-excel-import-report' : 'excel-import-report');
    if (!box) return;

    const nOk = kq.questions.length;
    const nErr = kq.errors.length;
    const MAX_SHOW = 8;

    let html;
    if (nOk === 0 && nErr === 0) {
        html = `<div class="rounded-xl border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
            Không tìm thấy câu hỏi nào trong file <b>${escapeHtml(fileName)}</b>. Cột A là câu hỏi, cột B-E là 4 đáp án (dòng chỉ có cột A là câu tự luận).</div>`;
    } else {
        const okLine = nOk > 0
            ? `<div class="text-emerald-700 dark:text-emerald-300"><i class="fa-solid fa-circle-check mr-1"></i>Đã nạp <b>${nOk}</b> câu hỏi (${kq.questions.filter(q => q.loai === 'tu_luan').length} tự luận) từ file <b>${escapeHtml(fileName)}</b>. Hãy kiểm tra lại đáp án đúng trước khi lưu.</div>`
            : '';
        let errHtml = '';
        if (nErr > 0) {
            const lines = kq.errors.slice(0, MAX_SHOW).map(e => `<li>Dòng ${e.dong}: ${escapeHtml(e.message)}</li>`).join('');
            const more = nErr > MAX_SHOW ? `<li>... và ${nErr - MAX_SHOW} dòng lỗi khác</li>` : '';
            errHtml = `<div class="mt-2 text-amber-800 dark:text-amber-200">
                <i class="fa-solid fa-triangle-exclamation mr-1"></i>Bỏ qua <b>${nErr}</b> dòng bị lỗi (sửa trong Excel rồi thêm lại các câu này):
                <ul class="list-disc ml-6 mt-1">${lines}${more}</ul></div>`;
        }
        html = `<div class="rounded-xl border border-slate-200 dark:border-slate-600 bg-slate-50 dark:bg-slate-900/40 px-4 py-3 text-sm">${okLine}${errHtml}</div>`;
    }
    box.innerHTML = html;
    box.classList.remove('hidden');
}

async function handleImportQuizExcel(mode, input) {
    if (!isGV()) return;
    const file = input.files && input.files[0];
    input.value = ''; // cho phép chọn lại đúng file đó lần sau
    if (!file) return;

    if (!/\.xlsx$/i.test(file.name)) {
        showToast('Chỉ hỗ trợ file Excel đuôi .xlsx.', 'error');
        return;
    }
    if (mode === 'edit' && !quizEditState) return;

    try {
        const kq = await parseQuizExcel(file);
        const newId = () => 'q-' + Date.now() + '-' + Math.random().toString(36).slice(2);

        if (kq.questions.length > 0) {
            if (mode === 'edit') {
                kq.questions.forEach(q => quizEditState.questions.push({
                    id: null, isNew: true, loai: q.loai || 'trac_nghiem',
                    noiDung: q.noiDung, dapA: q.dapA, dapB: q.dapB, dapC: q.dapC, dapD: q.dapD, dapDung: q.dapDung
                }));
                renderQuizEditQuestions();
                const c = document.getElementById('edit-quiz-questions');
                if (c && c.lastElementChild) c.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } else {
                // bỏ các dòng câu hỏi trống (VD dòng trống mặc định khi mở form)
                quizBuilderQuestions = quizBuilderQuestions.filter(q => !isBlankBuilderQuestion(q));
                kq.questions.forEach(q => quizBuilderQuestions.push({
                    tempId: newId(), loai: q.loai || 'trac_nghiem',
                    noiDung: q.noiDung, dapA: q.dapA, dapB: q.dapB, dapC: q.dapC, dapD: q.dapD, dapDung: q.dapDung
                }));
                renderQuizQuestionsBuilder();
            }
        }

        showExcelImportReport(mode, kq, file.name);

        if (kq.questions.length > 0 && kq.errors.length === 0) {
            showToast(`Đã nạp ${kq.questions.length} câu hỏi từ Excel.`, 'success');
        } else if (kq.questions.length > 0) {
            showToast(`Đã nạp ${kq.questions.length} câu, bỏ qua ${kq.errors.length} dòng lỗi.`, 'warning');
        } else {
            showToast('Không nạp được câu hỏi nào từ file Excel.', 'error');
        }
    } catch (err) {
        showToast(err.message || 'Không đọc được file Excel.', 'error');
    }
}

/* ---------- GV: quản lý tài khoản sinh viên ---------- */

async function openAccountsModal() {
    if (!isGV()) return;
    // Nút "Quản lý giảng viên": chỉ giảng viên quản trị (ql1, ql2...) mới thấy
    document.getElementById('btn-open-teachers').classList.toggle('hidden', !canAddDeleteSubjects());
    openModal('modal-accounts');
    await loadAccounts();
}

async function loadAccounts() {
    const body = document.getElementById('accounts-body');
    body.innerHTML = '<tr><td colspan="4" class="py-4 text-slate-400">Đang tải dữ liệu...</td></tr>';
    try {
        const [all, classes] = await Promise.all([
            apiRequest('GET', 'users.php'),
            apiRequest('GET', 'classes.php').catch(() => [])
        ]);
        classesList = classes;
        accountsList = all.filter(u => u.role !== 'gv');
        renderAccountsTable();
    } catch (err) {
        accountsList = [];
        body.innerHTML = '';
        showToast('Không tải được danh sách tài khoản: ' + err.message, 'error');
    }
}

function renderAccountsTable() {
    const body = document.getElementById('accounts-body');
    if (accountsList.length === 0) {
        body.innerHTML = '<tr><td colspan="5" class="py-4 text-slate-400">Chưa có tài khoản sinh viên nào. Bấm "Thêm sinh viên" để tạo.</td></tr>';
        return;
    }
    body.innerHTML = accountsList.map((u, i) => `
        <tr class="border-b border-slate-100 dark:border-slate-700">
            <td class="py-2 pr-3">${escapeHtml(u.maSoSv) || '<span class="text-slate-400">-</span>'}</td>
            <td class="py-2 pr-3 font-medium">${escapeHtml(u.hoTen) || '<span class="text-slate-400">(chưa có tên)</span>'}</td>
            <td class="py-2 pr-3">${escapeHtml(u.lop) || '<span class="text-slate-400">-</span>'}</td>
            <td class="py-2 pr-3">${escapeHtml(u.username)}</td>
            <td class="py-2 text-right">
                <button type="button" onclick="openAccountForm(${i})" class="text-sm text-sky-600 dark:text-sky-400 hover:underline">
                    <i class="fa-solid fa-pen mr-1"></i>Sửa
                </button>
            </td>
        </tr>
    `).join('');
}

// index = null: thêm mới. index = số: sửa tài khoản accountsList[index].
function openAccountForm(index) {
    if (!isGV()) return;
    const form = document.getElementById('form-account');
    const userInput = document.getElementById('input-account-username');
    const passInput = document.getElementById('input-account-password');
    form.reset();
    const lopSelect = document.getElementById('input-account-lop');
    lopSelect.innerHTML = '<option value="">(Chưa xếp lớp)</option>' +
        classesList.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.ten)}</option>`).join('');
    lopSelect.value = '';

    if (index === null || index === undefined) {
        editingAccountUsername = null;
        document.getElementById('modal-account-title').textContent = 'Thêm tài khoản sinh viên';
        document.getElementById('btn-account-submit').textContent = 'Tạo tài khoản';
        userInput.disabled = false;
        document.getElementById('input-account-hoten').required = true;
        document.getElementById('input-account-mssv').required = true;
        document.getElementById('btn-account-delete').classList.add('hidden');
        passInput.required = true;
        document.getElementById('account-pass-required').classList.remove('hidden');
        document.getElementById('account-pass-hint').classList.add('hidden');
    } else {
        const u = accountsList[index];
        if (!u) return;
        editingAccountUsername = u.username;
        document.getElementById('modal-account-title').textContent = 'Sửa tài khoản sinh viên';
        document.getElementById('btn-account-submit').textContent = 'Lưu thay đổi';
        userInput.value = u.username;
        userInput.disabled = true;
        document.getElementById('input-account-hoten').required = false;
        document.getElementById('input-account-mssv').required = false;
        document.getElementById('btn-account-delete').classList.remove('hidden');
        document.getElementById('input-account-hoten').value = u.hoTen || '';
        document.getElementById('input-account-mssv').value = u.maSoSv || '';
        lopSelect.value = u.lopId || '';
        passInput.required = false;
        document.getElementById('account-pass-required').classList.add('hidden');
        document.getElementById('account-pass-hint').classList.remove('hidden');
    }
    openModal('modal-account-form');
}

async function handleSaveAccount(e) {
    e.preventDefault();
    if (!isGV()) return;

    const username = document.getElementById('input-account-username').value.trim();
    const hoTen = document.getElementById('input-account-hoten').value.trim();
    const maSoSv = document.getElementById('input-account-mssv').value.trim();
    const password = document.getElementById('input-account-password').value;
    const lopId = document.getElementById('input-account-lop').value;

    try {
        if (editingAccountUsername === null) {
            await apiRequest('POST', 'users.php', { username, password, hoTen, maSoSv, lopId, role: 'sv' });
            showToast('Đã tạo tài khoản sinh viên.', 'success');
        } else {
            const payload = { hoTen, maSoSv, lopId };
            if (password !== '') payload.password = password;
            await apiRequest('PUT', `users.php?username=${encodeURIComponent(editingAccountUsername)}`, payload);
            showToast('Đã cập nhật tài khoản sinh viên.', 'success');
        }
        closeModal('modal-account-form');
        await loadAccounts();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function deleteAccount() {
    if (!isGV() || editingAccountUsername === null) return;
    const u = accountsList.find(x => x.username === editingAccountUsername);
    if (!u) return;
    const label = formatStudentLabel(u.hoTen, u.maSoSv, u.username);
    const username = u.username;

    showConfirmDialog(
        `Xóa tài khoản sinh viên "${label}"? Toàn bộ bài làm, điểm và nhật ký vi phạm của sinh viên này cũng sẽ bị xóa và không thể khôi phục.`,
        async () => {
            try {
                await apiRequest('DELETE', `users.php?username=${encodeURIComponent(username)}`);
                showToast('Đã xóa tài khoản sinh viên.', 'success');
                closeModal('modal-account-form');
                await loadAccounts();
            } catch (err) {
                showToast(err.message, 'error');
            }
        }
    );
}

/* ---------- Lớp học: tạo / đổi tên / xóa lớp, gắn sinh viên vào lớp ---------- */
let classAssignId = null;

async function openClassesModal() {
    if (!isGV()) return;
    closeClassAssign();
    openModal('modal-classes');
    await refreshClassesManage();
}

async function refreshClassesManage() {
    try {
        classesList = await apiRequest('GET', 'classes.php');
        renderClassesManage();
    } catch (err) {
        showToast('Không tải được danh sách lớp: ' + err.message, 'error');
    }
}

function renderClassesManage() {
    const body = document.getElementById('classes-body');
    if (!body) return;
    if (classesList.length === 0) {
        body.innerHTML = '<tr><td colspan="3" class="py-4 text-slate-400">Chưa có lớp nào. Nhập tên lớp ở trên rồi bấm "Tạo lớp".</td></tr>';
        return;
    }
    body.innerHTML = classesList.map(c => `
        <tr class="border-b border-slate-100 dark:border-slate-700">
            <td class="py-2 pr-3 font-medium">${escapeHtml(c.ten)}</td>
            <td class="py-2 pr-3">${c.soSinhVien}</td>
            <td class="py-2 text-right whitespace-nowrap">
                <button type="button" onclick="openClassAssign('${escapeHtml(c.id)}')" class="text-sm text-emerald-600 dark:text-emerald-400 hover:underline mr-3"><i class="fa-solid fa-user-plus mr-1"></i>Gắn sinh viên</button>
                <button type="button" onclick="renameClass('${escapeHtml(c.id)}')" class="text-sm text-sky-600 dark:text-sky-400 hover:underline mr-3"><i class="fa-solid fa-pen mr-1"></i>Đổi tên</button>
                <button type="button" onclick="deleteClass('${escapeHtml(c.id)}')" class="text-sm text-red-600 dark:text-red-400 hover:underline"><i class="fa-solid fa-trash mr-1"></i>Xóa</button>
            </td>
        </tr>
    `).join('');
}

async function handleCreateClass(e) {
    e.preventDefault();
    if (!isGV()) return;
    const input = document.getElementById('input-class-name');
    const ten = input.value.trim();
    if (!ten) {
        showToast('Vui lòng nhập tên lớp.', 'warning');
        return;
    }
    try {
        await apiRequest('POST', 'classes.php', { ten });
        input.value = '';
        showToast('Đã tạo lớp "' + ten + '".', 'success');
        await refreshClassesManage();
        await loadAccounts();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function renameClass(id) {
    const c = classesList.find(x => x.id === id);
    if (!c) return;
    const ten = (window.prompt('Tên mới cho lớp:', c.ten) || '').trim();
    if (!ten || ten === c.ten) return;
    try {
        await apiRequest('PUT', `classes.php?id=${encodeURIComponent(id)}`, { ten });
        showToast('Đã đổi tên lớp.', 'success');
        await refreshClassesManage();
        await loadAccounts();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function deleteClass(id) {
    const c = classesList.find(x => x.id === id);
    if (!c) return;
    showConfirmDialog(
        `Xóa lớp "${c.ten}"? ${c.soSinhVien} sinh viên trong lớp sẽ chuyển về "chưa xếp lớp" (tài khoản sinh viên không bị xóa).`,
        async () => {
            try {
                await apiRequest('DELETE', `classes.php?id=${encodeURIComponent(id)}`);
                showToast('Đã xóa lớp.', 'success');
                if (classAssignId === id) closeClassAssign();
                await refreshClassesManage();
                await loadAccounts();
            } catch (err) {
                showToast(err.message, 'error');
            }
        }
    );
}

function openClassAssign(id) {
    const c = classesList.find(x => x.id === id);
    if (!c) return;
    classAssignId = id;
    document.getElementById('class-assign-name').textContent = '"' + c.ten + '"';
    document.getElementById('class-assign-search').value = '';
    document.getElementById('class-assign-panel').classList.remove('hidden');
    renderClassAssignList();
}

function closeClassAssign() {
    classAssignId = null;
    const panel = document.getElementById('class-assign-panel');
    if (panel) panel.classList.add('hidden');
    const listBox = document.getElementById('class-assign-list');
    if (listBox) { listBox._state = null; listBox.innerHTML = ''; }
}

function renderClassAssignList() {
    const box = document.getElementById('class-assign-list');
    if (!box || classAssignId === null) return;
    // giữ trạng thái đang tick khi người dùng gõ tìm kiếm (box._state.chon)
    const q = (document.getElementById('class-assign-search').value || '').trim().toLowerCase();

    const hienCo = new Set(accountsList.filter(u => u.lopId === classAssignId).map(u => u.username));
    if (!box._state) box._state = null;
    if (box._state === null || box._state.classId !== classAssignId) {
        box._state = { classId: classAssignId, chon: new Set(hienCo) };
    } else {
        Array.from(box.querySelectorAll('input[type="checkbox"]')).forEach(cb => {
            if (cb.checked) box._state.chon.add(cb.value); else box._state.chon.delete(cb.value);
        });
    }
    const chon = box._state.chon;

    const ds = accountsList.filter(u => {
        if (!q) return true;
        return ((u.hoTen || '') + ' ' + (u.maSoSv || '') + ' ' + u.username).toLowerCase().includes(q);
    });
    if (ds.length === 0) {
        box.innerHTML = '<p class="text-sm text-slate-400">Không có sinh viên phù hợp.</p>';
        return;
    }
    box.innerHTML = ds.map(u => `
        <label class="flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700/50 cursor-pointer text-sm">
            <input type="checkbox" value="${escapeHtml(u.username)}" ${chon.has(u.username) ? 'checked' : ''} class="w-4 h-4 accent-indigo-600">
            <span class="font-medium">${escapeHtml(u.hoTen || u.username)}</span>
            <span class="text-slate-400">${escapeHtml(u.maSoSv || '')} · ${escapeHtml(u.username)}</span>
            <span class="ml-auto text-xs ${u.lopId && u.lopId !== classAssignId ? 'text-amber-600 dark:text-amber-300' : 'text-slate-400'}">${u.lop ? escapeHtml(u.lop) : 'chưa xếp lớp'}</span>
        </label>
    `).join('');
}

async function saveClassAssign() {
    if (!isGV() || classAssignId === null) return;
    const box = document.getElementById('class-assign-list');
    // cập nhật lần cuối trạng thái các ô đang hiển thị
    renderClassAssignList();
    const chon = box._state ? Array.from(box._state.chon) : [];
    try {
        await apiRequest('POST', 'classes.php?action=assign', { lopId: classAssignId, usernames: chon });
        showToast('Đã cập nhật danh sách sinh viên của lớp.', 'success');
        box._state = null;
        closeClassAssign();
        await refreshClassesManage();
        await loadAccounts();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

/* ---------- Nạp nhanh danh sách sinh viên từ Excel ----------
   Cột A: mã số SV | B: tên | C: lớp | D: user | E: mật khẩu (xem baitap/sinhvien.xlsx). */
async function handleImportStudentsExcel(input) {
    if (!isGV()) return;
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    if (!/\.xlsx$/i.test(file.name)) {
        showToast('Chỉ hỗ trợ file Excel đuôi .xlsx.', 'error');
        return;
    }
    const box = document.getElementById('accounts-import-report');
    const showBox = html => { box.innerHTML = html; box.classList.remove('hidden'); };
    const lines = (arr, max) => arr.slice(0, max).map(e => `<li>Dòng ${e.dong}: ${escapeHtml(e.message)}</li>`).join('') +
        (arr.length > max ? `<li>... và ${arr.length - max} dòng lỗi khác</li>` : '');

    try {
        const kq = await parseStudentExcel(file);
        if (kq.students.length === 0) {
            showBox(`<div class="rounded-xl border border-amber-200 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
                Không có sinh viên hợp lệ trong file <b>${escapeHtml(file.name)}</b>. Cột A: mã số SV, B: tên, C: lớp, D: user, E: mật khẩu.
                ${kq.errors.length ? `<ul class="list-disc ml-6 mt-1">${lines(kq.errors, 8)}</ul>` : ''}</div>`);
            showToast('Không nạp được sinh viên nào từ file Excel.', 'error');
            return;
        }
        const res = await apiRequest('POST', 'import_students.php', { students: kq.students });
        const allErr = kq.errors.concat(res.loi || []);
        showBox(`<div class="rounded-xl border border-slate-200 dark:border-slate-600 bg-slate-50 dark:bg-slate-900/40 px-4 py-3 text-sm">
            <div class="text-emerald-700 dark:text-emerald-300"><i class="fa-solid fa-circle-check mr-1"></i>File <b>${escapeHtml(file.name)}</b>: tạo mới <b>${res.taoMoi}</b>, cập nhật <b>${res.capNhat}</b> sinh viên${(res.lopMoi || []).length ? `, tự tạo lớp: <b>${res.lopMoi.map(escapeHtml).join(', ')}</b>` : ''}.</div>
            ${allErr.length ? `<div class="mt-2 text-amber-800 dark:text-amber-200"><i class="fa-solid fa-triangle-exclamation mr-1"></i>Bỏ qua <b>${allErr.length}</b> dòng lỗi:<ul class="list-disc ml-6 mt-1">${lines(allErr, 8)}</ul></div>` : ''}
        </div>`);
        showToast(`Đã nạp ${res.taoMoi + res.capNhat} sinh viên từ Excel.` + (allErr.length ? ` Bỏ qua ${allErr.length} dòng lỗi.` : ''), allErr.length ? 'warning' : 'success');
        await loadAccounts();
    } catch (err) {
        showToast(err.message || 'Không đọc được file Excel.', 'error');
    }
}

/* ---------- Giảng viên quản trị: quản lý tài khoản giảng viên + môn phụ trách ---------- */

function subjectNamesOf(ids) {
    const names = (ids || []).map(id => {
        const s = subjects.find(x => x.id === id);
        return s ? s.name : null;
    }).filter(Boolean);
    return names;
}

async function openTeachersModal() {
    if (!canAddDeleteSubjects()) return;
    openModal('modal-teachers');
    await loadTeachers();
}

async function loadTeachers() {
    const body = document.getElementById('teachers-body');
    body.innerHTML = '<tr><td colspan="4" class="py-4 text-slate-400">Đang tải dữ liệu...</td></tr>';
    try {
        const all = await apiRequest('GET', 'users.php');
        teachersList = all.filter(u => u.role === 'gv');
        renderTeachersTable();
    } catch (err) {
        teachersList = [];
        body.innerHTML = '';
        showToast('Không tải được danh sách giảng viên: ' + err.message, 'error');
    }
}

function renderTeachersTable() {
    const body = document.getElementById('teachers-body');
    if (teachersList.length === 0) {
        body.innerHTML = '<tr><td colspan="4" class="py-4 text-slate-400">Chưa có giảng viên nào.</td></tr>';
        return;
    }
    body.innerHTML = teachersList.map((u, i) => {
        let monHtml;
        let actionHtml;
        if (u.gioiHanMon) {
            const names = subjectNamesOf(u.subjectIds);
            monHtml = names.length
                ? names.map(n => `<span class="inline-block text-xs bg-slate-100 dark:bg-slate-700 rounded-lg px-2 py-0.5 mr-1 mb-1">${escapeHtml(n)}</span>`).join('')
                : '<span class="text-amber-500">Chưa được gán môn nào</span>';
            actionHtml = `<button type="button" onclick="openTeacherForm(${i})" class="text-sm text-sky-600 dark:text-sky-400 hover:underline"><i class="fa-solid fa-pen mr-1"></i>Sửa</button>`;
        } else {
            monHtml = '<span class="text-emerald-600 dark:text-emerald-400">Tất cả các môn (quản trị)</span>';
            actionHtml = '<span class="text-slate-400">-</span>';
        }
        return `
        <tr class="border-b border-slate-100 dark:border-slate-700">
            <td class="py-2 pr-3 font-medium">${escapeHtml(u.username)}</td>
            <td class="py-2 pr-3">${escapeHtml(u.hoTen) || '<span class="text-slate-400">-</span>'}</td>
            <td class="py-2 pr-3">${monHtml}</td>
            <td class="py-2 text-right">${actionHtml}</td>
        </tr>`;
    }).join('');
}

// index = null: thêm giảng viên mới. index = số: sửa teachersList[index].
function openTeacherForm(index) {
    if (!canAddDeleteSubjects()) return;
    const u = index === null ? null : teachersList[index];
    editingTeacherUsername = u ? u.username : null;

    document.getElementById('modal-teacher-title').textContent = u ? 'Sửa giảng viên' : 'Thêm giảng viên';
    const userInput = document.getElementById('input-teacher-username');
    userInput.value = u ? u.username : '';
    userInput.disabled = !!u;
    document.getElementById('input-teacher-hoten').value = u ? (u.hoTen || '') : '';
    document.getElementById('input-teacher-password').value = '';
    document.getElementById('teacher-pass-required').classList.toggle('hidden', !!u);
    document.getElementById('teacher-pass-hint').classList.toggle('hidden', !u);
    document.getElementById('btn-teacher-delete').classList.toggle('hidden', !u);

    const chosen = new Set(u ? (u.subjectIds || []) : []);
    const box = document.getElementById('teacher-subject-checks');
    box.innerHTML = subjects.length === 0
        ? '<div class="text-sm text-slate-400 p-2">Chưa có môn học nào.</div>'
        : subjects.map(sub => `
            <label class="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-700/50 cursor-pointer text-sm text-slate-700 dark:text-slate-200">
                <input type="checkbox" class="teacher-subject-check w-4 h-4 accent-indigo-600" value="${escapeHtml(sub.id)}" ${chosen.has(sub.id) ? 'checked' : ''}>
                <span>${escapeHtml(sub.name)}</span>
            </label>`).join('');
    openModal('modal-teacher-form');
}

async function handleSaveTeacher(e) {
    e.preventDefault();
    if (!canAddDeleteSubjects()) return;

    const username = document.getElementById('input-teacher-username').value.trim();
    const hoTen = document.getElementById('input-teacher-hoten').value.trim();
    const password = document.getElementById('input-teacher-password').value;
    const subjectIds = Array.from(document.querySelectorAll('.teacher-subject-check:checked')).map(c => c.value);

    if (subjectIds.length === 0) {
        showToast('Hãy chọn ít nhất 1 môn học cho giảng viên.', 'warning');
        return;
    }
    try {
        if (editingTeacherUsername === null) {
            if (password === '') {
                showToast('Vui lòng nhập mật khẩu.', 'warning');
                return;
            }
            await apiRequest('POST', 'users.php', { username, password, hoTen, role: 'gv', subjectIds });
            showToast('Đã tạo tài khoản giảng viên.', 'success');
        } else {
            const payload = { hoTen, subjectIds };
            if (password !== '') payload.password = password;
            await apiRequest('PUT', `users.php?username=${encodeURIComponent(editingTeacherUsername)}`, payload);
            showToast('Đã cập nhật giảng viên.', 'success');
        }
        closeModal('modal-teacher-form');
        await loadTeachers();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

function deleteTeacher() {
    if (!canAddDeleteSubjects() || editingTeacherUsername === null) return;
    const username = editingTeacherUsername;
    showConfirmDialog(
        `Xóa tài khoản giảng viên "${username}"? Bài kiểm tra, giáo trình và bài tập họ đã tạo sẽ được chuyển sang tài khoản của bạn, không bị mất.`,
        async () => {
            try {
                await apiRequest('DELETE', `users.php?username=${encodeURIComponent(username)}`);
                showToast('Đã xóa tài khoản giảng viên.', 'success');
                closeModal('modal-teacher-form');
                await loadTeachers();
            } catch (err) {
                showToast(err.message, 'error');
            }
        }
    );
}

/* ---------- GV: chấm điểm tay ngay trong ô Điểm của bảng kết quả ----------
   Bấm vào điểm -> nhập điểm mới -> Enter (hoặc dấu tick) để lưu, Esc để hủy.
   Để trống rồi lưu = bỏ điểm chấm tay, quay về điểm tự chấm trắc nghiệm. */

function diemCellHtml(luotId, quizId, diemText, chamTay, canEdit) {
    if (!canEdit) return escapeHtml(diemText);
    return `
        <button type="button" onclick="startEditDiem('${luotId}', '${quizId}')" title="Bấm để chấm điểm"
            class="inline-flex items-center gap-2 px-3 py-1 rounded-lg border border-dashed border-slate-300 dark:border-slate-600 hover:border-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors">
            <span>${escapeHtml(diemText)}</span><i class="fa-solid fa-pen text-xs text-slate-400"></i>
        </button>
        ${chamTay ? '<div class="text-[11px] font-normal text-amber-500 mt-0.5">Đã chấm tay</div>' : ''}`;
}

function renderDiemCell(luotId, quizId) {
    const cell = document.getElementById('diem-cell-' + luotId);
    const sc = quizResultScores[luotId];
    if (!cell || !sc) return;
    cell.innerHTML = diemCellHtml(luotId, quizId, sc.diem, sc.chamTay, true);
}

function startEditDiem(luotId, quizId) {
    if (!isGV()) return;
    const cell = document.getElementById('diem-cell-' + luotId);
    const sc = quizResultScores[luotId];
    if (!cell || !sc) return;

    const maxLabel = String(Number(quizResultMaxDiem.toFixed(2)));
    cell.innerHTML = `
        <div class="flex items-center justify-end gap-1">
            <input id="diem-input-${luotId}" type="number" step="0.25" min="0" max="${quizResultMaxDiem}"
                value="${sc.diem === '-' ? '' : escapeHtml(sc.diem)}"
                onkeydown="handleDiemKey(event, '${luotId}', '${quizId}')"
                class="w-24 px-2 py-1 text-right rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
            <button type="button" onclick="saveDiem('${luotId}', '${quizId}')" title="Lưu điểm" class="px-2 py-1 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 rounded-lg"><i class="fa-solid fa-check"></i></button>
            <button type="button" onclick="renderDiemCell('${luotId}', '${quizId}')" title="Hủy" class="px-2 py-1 text-slate-400 hover:text-red-500 rounded-lg"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="text-[11px] font-normal text-slate-400 mt-1">Tối đa ${maxLabel} điểm &middot; để trống = tự chấm</div>`;
    const input = document.getElementById('diem-input-' + luotId);
    if (input) { input.focus(); input.select(); }
}

function handleDiemKey(e, luotId, quizId) {
    if (e.key === 'Enter') {
        e.preventDefault();
        saveDiem(luotId, quizId);
    } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        renderDiemCell(luotId, quizId);
    }
}

async function saveDiem(luotId, quizId) {
    if (!isGV()) return;
    const input = document.getElementById('diem-input-' + luotId);
    if (!input || input.disabled) return;

    // type=number: nếu gõ chữ thì value = '' nhưng badInput = true -> không được coi là "để trống"
    if (input.validity && input.validity.badInput) {
        showToast('Điểm không hợp lệ, vui lòng nhập một số.', 'error');
        return;
    }
    const raw = input.value.trim().replace(',', '.');
    if (raw !== '') {
        const n = Number(raw);
        if (!isFinite(n) || n < 0 || n > quizResultMaxDiem + 0.0001) {
            showToast(`Điểm phải từ 0 đến ${Number(quizResultMaxDiem.toFixed(2))}.`, 'error');
            return;
        }
    }

    input.disabled = true;
    try {
        const url = `${API_BASE}quizzes.php?action=cham_diem&luot_id=${encodeURIComponent(luotId)}&diem=${encodeURIComponent(raw)}`;
        const res = await fetch(url, { method: 'POST', credentials: 'same-origin' });
        const data = new window.DOMParser().parseFromString(await res.text(), 'text/xml');
        const status = data.getElementsByTagName('parsererror').length ? null : data.getElementsByTagName('Status')[0]?.textContent;

        if (status === 'Success') {
            const diem = Number(data.getElementsByTagName('DiemSo')[0]?.textContent);
            quizResultScores[luotId] = {
                diem: isFinite(diem) ? diem.toFixed(2) : '-',
                chamTay: data.getElementsByTagName('ChamTay')[0]?.textContent === '1'
            };
            renderDiemCell(luotId, quizId);
            showToast(quizResultScores[luotId].chamTay ? 'Đã lưu điểm chấm tay.' : 'Đã quay về điểm tự chấm.', 'success');
            // Điểm đổi -> cập nhật lại khung thống kê phía trên
            if (document.getElementById('quiz-stats-box')) loadQuizStats(quizId);
        } else {
            const msg = data.getElementsByTagName('Message')[0];
            showToast(msg ? msg.textContent : 'Không lưu được điểm.', 'error');
            input.disabled = false;
            input.focus();
        }
    } catch (err) {
        showToast('Không lưu được điểm: ' + err.message, 'error');
        input.disabled = false;
    }
}

/* ---------- GV: khung thống kê bài kiểm tra (dữ liệu XML từ thong_ke.php) ---------- */

async function loadQuizStats(quizId) {
    const box = document.getElementById('quiz-stats-box');
    if (!box) return;
    try {
        const res = await fetch(`${API_BASE}thong_ke.php?id=${encodeURIComponent(quizId)}`, { credentials: 'same-origin' });
        const doc = new window.DOMParser().parseFromString(await res.text(), 'text/xml');

        // Người dùng đã mở bài khác trong lúc chờ -> bỏ kết quả cũ
        const modal = document.getElementById('modal-quiz-results');
        if (modal.getAttribute('data-quiz-id') !== String(quizId) || !document.getElementById('quiz-stats-box')) return;

        const root = doc.getElementsByTagName('ThongKe')[0];
        if (doc.getElementsByTagName('parsererror').length > 0 || !root) {
            box.innerHTML = '';
            return;
        }

        const g = (tag) => root.getElementsByTagName(tag)[0]?.textContent ?? '';
        const soBai = parseInt(g('SoBaiNop'), 10) || 0;
        if (soBai === 0) {
            box.innerHTML = '';
            return;
        }

        const tongDiem = Number(g('TongDiem'));
        const fmt = (v) => Number(v).toFixed(2);
        const card = (label, value, sub) => `
            <div class="rounded-xl border border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40 px-4 py-3">
                <div class="text-sm text-slate-500 dark:text-slate-400">${label}</div>
                <div class="text-2xl font-bold text-slate-800 dark:text-slate-100">${value}</div>
                ${sub ? `<div class="text-xs text-slate-400 mt-0.5">${sub}</div>` : ''}
            </div>`;

        const khoang = Array.from(root.getElementsByTagName('PhanKhoang')).map(k => ({
            tu: k.getAttribute('tu'),
            den: k.getAttribute('den'),
            soLuong: parseInt(k.getAttribute('soLuong'), 10) || 0,
        }));
        const maxKhoang = Math.max(1, ...khoang.map(k => k.soLuong));
        const bars = khoang.map(k => `
            <div class="flex items-center gap-3 text-sm">
                <span class="w-24 text-slate-500 dark:text-slate-400 shrink-0">${escapeHtml(Number(k.tu).toFixed(1))} - ${escapeHtml(Number(k.den).toFixed(1))}</span>
                <div class="flex-1 h-4 rounded bg-slate-100 dark:bg-slate-700 overflow-hidden">
                    <div class="h-4 rounded bg-indigo-500" style="width:${(k.soLuong / maxKhoang * 100).toFixed(1)}%"></div>
                </div>
                <span class="w-8 text-right font-medium text-slate-700 dark:text-slate-200">${k.soLuong}</span>
            </div>`).join('');

        const cauSai = Array.from(root.getElementsByTagName('CauHoiSaiNhieuNhat')[0]?.getElementsByTagName('CauHoi') || []);
        const cauSaiHtml = cauSai.length === 0
            ? '<p class="text-sm text-slate-400">Chưa có câu trắc nghiệm nào bị làm sai.</p>'
            : cauSai.map((c, i) => `
                <div class="flex gap-3 text-sm py-1.5">
                    <span class="font-bold text-slate-400 w-5 shrink-0">${i + 1}.</span>
                    <span class="flex-1 text-slate-700 dark:text-slate-200">${escapeHtml(c.getElementsByTagName('NoiDung')[0]?.textContent || '')}</span>
                    <span class="shrink-0 text-red-500 font-medium">${escapeHtml(c.getAttribute('soLanSai'))}/${escapeHtml(c.getAttribute('soLanLam'))} sai (${escapeHtml(c.getAttribute('tyLeSai'))}%)</span>
                </div>`).join('');

        box.innerHTML = `
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
                ${card('Số bài đã nộp', soBai)}
                ${card('Điểm trung bình', fmt(g('DiemTrungBinh')), `trên tổng ${fmt(tongDiem)} điểm`)}
                ${card('Cao nhất / Thấp nhất', `${fmt(g('DiemCaoNhat'))} / ${fmt(g('DiemThapNhat'))}`)}
                ${card('Tỷ lệ đạt', `${escapeHtml(g('TyLeDat'))}%`, `${escapeHtml(g('SoBaiDat'))}/${soBai} bài đạt (từ 50% điểm)`)}
                ${card('Thời gian làm trung bình', escapeHtml(formatThoiGianLamBai(g('ThoiGianTrungBinhGiay'))))}
                ${card('Tổng số vi phạm', escapeHtml(g('TongSoViPham')))}
            </div>
            <div class="grid md:grid-cols-2 gap-6">
                <div>
                    <h4 class="font-semibold text-slate-800 dark:text-slate-100 mb-2">Phân bố điểm</h4>
                    <div class="space-y-1.5">${bars}</div>
                </div>
                <div>
                    <h4 class="font-semibold text-slate-800 dark:text-slate-100 mb-2">Câu hỏi sai nhiều nhất</h4>
                    ${cauSaiHtml}
                </div>
            </div>
            <hr class="mt-6 border-slate-100 dark:border-slate-700">
        `;
    } catch (err) {
        // Thống kê chỉ là phần phụ: lỗi thì ẩn đi, không làm hỏng bảng kết quả
        if (box) box.innerHTML = '';
        console.error('Không tải được thống kê:', err);
    }
}

/* ---------- GV: xuất kết quả bài kiểm tra ra Excel ---------- */

function formatThoiGianLamBai(giay) {
    if (giay === null || giay === undefined) return '';
    const total = Math.max(0, parseInt(giay, 10) || 0);
    return `${Math.floor(total / 60)} phút ${total % 60} giây`;
}

function sanitizeFileName(name) {
    return String(name || 'ket-qua')
        .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80) || 'ket-qua';
}

async function exportQuizResultsExcel() {
    if (!isGV()) return;
    const quizId = document.getElementById('modal-quiz-results').getAttribute('data-quiz-id');
    if (!quizId) return;

    if (typeof XLSX === 'undefined') {
        showToast('Không tải được thư viện xuất Excel (cần kết nối Internet). Vui lòng tải lại trang rồi thử lại.', 'error');
        return;
    }

    const btn = document.getElementById('btn-export-excel');
    if (btn) btn.disabled = true;
    try {
        const data = await apiRequest('GET', `export_results.php?id=${encodeURIComponent(quizId)}`);
        const rows = data.rows || [];
        if (rows.length === 0) {
            showToast('Chưa có sinh viên nào nộp bài, không có dữ liệu để xuất.', 'warning');
            return;
        }

        const header = ['Mã số sinh viên', 'Tên sinh viên', 'Điểm', 'Số câu đúng', 'Số câu sai', 'Thời gian làm bài', 'Tổng số lần vi phạm'];
        const aoa = [header].concat(rows.map(r => [
            String(r.maSoSv || ''),
            String(r.hoTen || ''),
            Number(r.diem),
            Number(r.soDung),
            Number(r.soSai),
            formatThoiGianLamBai(r.thoiGianGiay),
            Number(r.soViPham),
        ]));

        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = [{ wch: 18 }, { wch: 28 }, { wch: 8 }, { wch: 13 }, { wch: 11 }, { wch: 20 }, { wch: 20 }];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Kết quả');

        const today = new Date();
        const stamp = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
        XLSX.writeFile(wb, `KetQua_${sanitizeFileName(data.quiz.title)}_${stamp}.xlsx`);
        showToast(`Đã xuất ${rows.length} kết quả ra file Excel.`, 'success');
    } catch (err) {
        showToast('Xuất Excel thất bại: ' + err.message, 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

/* ---------- GV: xem kết quả / xóa bài kiểm tra ---------- */

async function viewQuizResults(quizId) {
    if (!isGV()) return;
    try {
        const res = await fetch(`${API_BASE}quizzes.php?action=results&id=${quizId}`, { credentials: 'same-origin' });
        const str = await res.text();
        const data = new window.DOMParser().parseFromString(str, 'text/xml');

        const errResp = data.getElementsByTagName('Response')[0];
        if (errResp) {
            const msg = errResp.getElementsByTagName('Message')[0];
            showToast(msg ? msg.textContent : 'Không thể tải kết quả.', 'error');
            return;
        }

        const root = data.getElementsByTagName('KetQuaBaiKiemTra')[0];
        const title = root.getElementsByTagName('TieuDe')[0].textContent;
        document.getElementById('quiz-results-title').textContent = 'Kết quả: ' + title;
        document.getElementById('modal-quiz-results').setAttribute('data-quiz-id', quizId);

        const luotList = Array.from(root.getElementsByTagName('LuotLamBai'));
        const content = document.getElementById('quiz-results-content');
        quizResultNames = {};
        quizResultScores = {};
        quizResultMaxDiem = Number(root.getElementsByTagName('TongDiem')[0]?.textContent) || 10;

        if (luotList.length === 0) {
            content.innerHTML = `<p class="text-lg text-slate-500 dark:text-slate-400 text-center py-10">Chưa có sinh viên nào làm bài này.</p>`;
        } else {
            content.innerHTML = `
                <table class="w-full text-left text-lg">
                    <thead>
                        <tr class="text-slate-500 dark:text-slate-400 border-b border-slate-100 dark:border-slate-700">
                            <th class="py-4 pr-3 font-medium">Mã số SV</th>
                            <th class="py-4 pr-3 font-medium">Sinh viên</th>
                            <th class="py-4 pr-3 font-medium">Trạng thái</th>
                            <th class="py-4 pr-3 font-medium text-right">Điểm</th>
                            <th class="py-4 pl-3 font-medium text-right">Thao tác</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-slate-100 dark:divide-slate-700">
                        ${luotList.map(l => {
                            const luotId = l.getAttribute('id');
                            const hocSinh = l.getElementsByTagName('HocSinh')[0].textContent;
                            const hoTen = l.getElementsByTagName('HoTen')[0]?.textContent || hocSinh;
                            const maSoSv = l.getElementsByTagName('MaSoSV')[0]?.textContent || '';
                            quizResultNames[hocSinh] = hoTen;
                            const trangThai = l.getElementsByTagName('TrangThai')[0].textContent;
                            const diemSoNode = l.getElementsByTagName('DiemSo')[0];
                            const diemSo = diemSoNode && diemSoNode.textContent !== '' ? Number(diemSoNode.textContent).toFixed(2) : '-';
                            const biCam = l.getElementsByTagName('BiCam')[0]?.textContent === '1';
                            const chamTay = l.getElementsByTagName('ChamTay')[0]?.textContent === '1';
                            quizResultScores[luotId] = { diem: diemSo, chamTay: chamTay };
                            const trangThaiLabel = trangThai === 'da_nop' ? 'Đã nộp' : 'Đang làm';
                            const trangThaiClass = trangThai === 'da_nop' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400';
                            return `
                                <tr>
                                    <td class="py-4 pr-3 text-slate-600 dark:text-slate-300">${escapeHtml(maSoSv) || '-'}</td>
                                    <td class="py-4 pr-3 font-medium text-slate-800 dark:text-slate-100">
                                        ${escapeHtml(hoTen)}
                                        ${biCam ? '<span class="ml-1 text-[10px] text-red-500" title="Đã bị cấm thi"><i class="fa-solid fa-ban"></i></span>' : ''}
                                    </td>
                                    <td class="py-4 pr-3 ${trangThaiClass}">${trangThaiLabel}</td>
                                    <td id="diem-cell-${luotId}" class="py-4 pr-3 text-right font-semibold text-slate-800 dark:text-slate-100">${diemCellHtml(luotId, quizId, diemSo, chamTay, trangThai === 'da_nop')}</td>
                                    <td class="py-4 pl-3 text-right whitespace-nowrap">
                                        <button type="button" onclick="viewAttemptDetail('${luotId}')" class="text-base text-indigo-600 dark:text-indigo-400 hover:underline mr-4" title="Xem chi tiết từng câu">Chi tiết</button>
                                        ${trangThai === 'da_nop' ? `<button type="button" onclick="reopenAttempt('${luotId}', '${quizId}')" class="text-base text-sky-600 dark:text-sky-400 hover:underline mr-4" title="Mở lại cho làm tiếp, GIỮ NGUYÊN các câu đã trả lời trước đó (dùng khi sinh viên lỡ nộp bài)">Mở lại</button>` : ''}
                                        <button type="button" onclick="resetAttempt('${luotId}', '${quizId}')" class="text-base text-amber-600 dark:text-amber-400 hover:underline mr-4" title="Xóa hẳn lượt làm này để sinh viên làm lại từ đầu (mất toàn bộ câu trả lời cũ)">Reset</button>
                                        <button type="button" onclick="toggleBanStudent('${quizId}', '${hocSinh}', ${biCam})" class="text-xs ${biCam ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'} hover:underline">${biCam ? 'Bỏ cấm' : 'Cấm thi'}</button>
                                    </td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            `;
        }

        // Khung thống kê (server tính bằng XPath trên XML bài làm lưu ngầm)
        if (luotList.length > 0) {
            content.insertAdjacentHTML('afterbegin', '<div id="quiz-stats-box" class="mb-8"></div>');
            loadQuizStats(quizId);
        }

        openModal('modal-quiz-results');
    } catch (err) {
        showToast('Không thể tải kết quả: ' + err.message, 'error');
    }
}

async function reopenAttempt(luotId, quizId) {
    if (!isGV()) return;
    showConfirmDialog(
        'Mở lại lượt làm bài này cho sinh viên làm tiếp? Các câu trả lời trước đó vẫn được GIỮ NGUYÊN, đồng hồ đếm giờ sẽ được tính lại từ đầu.',
        async () => {
            try {
                const res = await fetch(`${API_BASE}quizzes.php?action=reopen_attempt&luot_id=${luotId}`, { method: 'POST', credentials: 'same-origin' });
                const str = await res.text();
                const data = new window.DOMParser().parseFromString(str, 'text/xml');
                const status = data.getElementsByTagName('Status')[0]?.textContent;
                if (status === 'Success') {
                    showToast('Đã mở lại bài làm. Sinh viên có thể vào làm tiếp, các câu trả lời cũ vẫn được giữ nguyên.', 'success');
                    viewQuizResults(quizId);
                    loadQuizzesForSelectedSubject();
                } else {
                    const msg = data.getElementsByTagName('Message')[0];
                    showToast(msg ? msg.textContent : 'Mở lại thất bại.', 'error');
                }
            } catch (err) {
                showToast('Mở lại thất bại: ' + err.message, 'error');
            }
        }
    );
}

async function resetAttempt(luotId, quizId) {
    if (!isGV()) return;
    showConfirmDialog(
        'Xóa lượt làm bài này để sinh viên có thể làm lại từ đầu? Điểm và câu trả lời hiện tại sẽ bị xóa vĩnh viễn.',
        async () => {
            try {
                const res = await fetch(`${API_BASE}quizzes.php?action=reset_attempt&luot_id=${luotId}`, { method: 'POST', credentials: 'same-origin' });
                const str = await res.text();
                const data = new window.DOMParser().parseFromString(str, 'text/xml');
                const status = data.getElementsByTagName('Status')[0]?.textContent;
                if (status === 'Success') {
                    showToast('Đã reset lượt làm bài. Sinh viên có thể làm lại từ đầu.', 'success');
                    viewQuizResults(quizId);
                    loadQuizzesForSelectedSubject();
                } else {
                    const msg = data.getElementsByTagName('Message')[0];
                    showToast(msg ? msg.textContent : 'Reset thất bại.', 'error');
                }
            } catch (err) {
                showToast('Reset thất bại: ' + err.message, 'error');
            }
        }
    );
}

async function toggleBanStudent(quizId, hocSinh, currentlyBanned) {
    if (!isGV()) return;
    const action = currentlyBanned ? 'bỏ cấm' : 'cấm thi';
    showConfirmDialog(
        `Bạn có chắc muốn ${action} sinh viên "${quizResultNames[hocSinh] || hocSinh}" đối với bài kiểm tra này? ${!currentlyBanned ? 'Nếu sinh viên đang làm bài dở dang, bài làm sẽ được tự động nộp ngay lập tức.' : ''}`,
        async () => {
            try {
                const res = await fetch(`${API_BASE}quizzes.php?action=toggle_ban&id=${quizId}&hoc_sinh=${encodeURIComponent(hocSinh)}`, { method: 'POST', credentials: 'same-origin' });
                const str = await res.text();
                const data = new window.DOMParser().parseFromString(str, 'text/xml');
                const status = data.getElementsByTagName('Status')[0]?.textContent;
                if (status === 'Success') {
                    showToast(currentlyBanned ? 'Đã bỏ cấm thi.' : 'Đã cấm thi tài khoản này.', 'success');
                    viewQuizResults(quizId);
                } else {
                    const msg = data.getElementsByTagName('Message')[0];
                    showToast(msg ? msg.textContent : 'Thao tác thất bại.', 'error');
                }
            } catch (err) {
                showToast('Thao tác thất bại: ' + err.message, 'error');
            }
        }
    );
}

async function viewAttemptDetail(luotId) {
    if (!isGV()) return;
    try {
        const res = await fetch(`${API_BASE}quizzes.php?action=chi_tiet&luot_id=${luotId}`, { credentials: 'same-origin' });
        const str = await res.text();
        const data = new window.DOMParser().parseFromString(str, 'text/xml');

        const errResp = data.getElementsByTagName('Response')[0];
        if (errResp) {
            const msg = errResp.getElementsByTagName('Message')[0];
            showToast(msg ? msg.textContent : 'Không thể tải chi tiết bài làm.', 'error');
            return;
        }

        const root = data.getElementsByTagName('ChiTietBaiLam')[0];
        const tieuDe = root.getElementsByTagName('TieuDeBaiKiemTra')[0].textContent;
        const hocSinh = root.getElementsByTagName('HoTen')[0]?.textContent || root.getElementsByTagName('HocSinh')[0].textContent;
        const diemSoNode = root.getElementsByTagName('DiemSo')[0];
        const diemSo = diemSoNode && diemSoNode.textContent !== '' ? Number(diemSoNode.textContent).toFixed(2) : '-';

        document.getElementById('quiz-detail-title').textContent = `${tieuDe} — ${hocSinh}`;
        document.getElementById('quiz-detail-score').textContent = `Tổng điểm: ${diemSo}/10`;

        const cauHoiList = Array.from(root.getElementsByTagName('CauHoi'));
        const content = document.getElementById('quiz-detail-content');

        content.innerHTML = cauHoiList.map((ch, index) => {
            const loai = ch.getAttribute('loai');
            const noiDung = ch.getElementsByTagName('NoiDung')[0].textContent;
            const dapAnSV = ch.getElementsByTagName('DapAnSinhVien')[0]?.textContent || '';

            if (loai === 'trac_nghiem') {
                const dapAnDung = ch.getElementsByTagName('DapAnDung')[0].textContent;
                const dung = ch.getElementsByTagName('Dung')[0]?.textContent === '1';
                const ops = ['A', 'B', 'C', 'D'].map(letter => {
                    const text = ch.getElementsByTagName('DapAn' + letter)[0]?.textContent || '';
                    return { letter, text };
                });
                return `
                    <div class="border border-slate-200 dark:border-slate-600 rounded-xl p-6 ${dung ? 'bg-emerald-50/50 dark:bg-emerald-900/10' : (dapAnSV ? 'bg-red-50/50 dark:bg-red-900/10' : '')}">
                        <p class="text-xl font-semibold text-slate-800 dark:text-slate-100 mb-4">Câu ${index + 1}: ${escapeHtml(noiDung)}</p>
                        <div class="space-y-2 text-lg">
                            ${ops.map(op => `
                                <div class="flex items-center gap-2 ${op.letter === dapAnDung ? 'text-emerald-600 dark:text-emerald-400 font-medium' : 'text-slate-600 dark:text-slate-300'}">
                                    <span>${op.letter === dapAnSV ? '<i class="fa-solid fa-circle-dot"></i>' : '<i class="fa-regular fa-circle"></i>'}</span>
                                    <span>${op.letter}. ${escapeHtml(op.text)}</span>
                                    ${op.letter === dapAnDung ? '<span class="text-base">(Đáp án đúng)</span>' : ''}
                                </div>
                            `).join('')}
                        </div>
                        <p class="text-base mt-3 ${dung ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'}">
                            ${!dapAnSV ? 'Sinh viên không trả lời' : (dung ? 'Trả lời đúng' : 'Trả lời sai')}
                        </p>
                    </div>
                `;
            }

            return `
                <div class="border border-slate-200 dark:border-slate-600 rounded-xl p-6">
                    <p class="text-xl font-semibold text-slate-800 dark:text-slate-100 mb-4">Câu ${index + 1} (Tự luận): ${escapeHtml(noiDung)}</p>
                    <p class="text-lg text-slate-600 dark:text-slate-300 whitespace-pre-wrap">${dapAnSV ? escapeHtml(dapAnSV) : '<span class="italic text-slate-400">Sinh viên không trả lời</span>'}</p>
                </div>
            `;
        }).join('');

        openModal('modal-quiz-detail');
    } catch (err) {
        showToast('Không thể tải chi tiết bài làm: ' + err.message, 'error');
    }
}

function deleteQuiz(quizId) {
    if (!isGV()) return;
    showConfirmDialog(
        'Bạn có chắc chắn muốn xóa bài kiểm tra này? Toàn bộ câu hỏi và bài làm của sinh viên sẽ bị xóa.',
        async () => {
            try {
                const res = await fetch(`${API_BASE}quizzes.php?action=delete&id=${quizId}`, {
                    method: 'DELETE',
                    credentials: 'same-origin'
                });
                const str = await res.text();
                const data = new window.DOMParser().parseFromString(str, 'text/xml');
                const status = data.getElementsByTagName('Status')[0]?.textContent;
                if (status === 'Success') {
                    showToast('Đã xóa bài kiểm tra.', 'info');
                    loadQuizzesForSelectedSubject();
                } else {
                    showToast('Xóa bài kiểm tra thất bại.', 'error');
                }
            } catch (err) {
                showToast('Xóa bài kiểm tra thất bại: ' + err.message, 'error');
            }
        }
    );
}

/* ---------- SV: làm bài kiểm tra ---------- */

/* Chống gian lận trong lúc làm bài: chặn chuột phải, chặn các phím tắt mở
   DevTools/Xem mã nguồn, và dò tìm (ở mức tương đối, KHÔNG thể tuyệt đối vì
   trình duyệt không cho web tự khóa DevTools) khi DevTools đang mở để tự
   động nộp bài ngay, tránh sinh viên dùng Inspect để xem đáp án đúng trong
   dữ liệu trả về hoặc sửa điểm trên giao diện. */
let quizDevToolsCheckInterval = null;
let quizDevToolsOpenStreak = 0;
let quizAntiCheatLuotLamBaiId = null;
let quizAbsenceStartMs = null;
let quizViolationCount = 0;
let quizOfflineSyncInProgress = false;

function getQuizAnswersKey(luotLamBaiId) {
    return 'quiz_offline_answers_' + luotLamBaiId;
}

function getQuizViolationsKey(luotLamBaiId) {
    return 'quiz_offline_violations_' + luotLamBaiId;
}

function getQuizViolationCountKey(luotLamBaiId) {
    return 'quiz_violation_count_' + luotLamBaiId;
}

function getQuizForceSubmitKey(luotLamBaiId) {
    return 'quiz_force_submit_' + luotLamBaiId;
}

function readLocalJson(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        return JSON.parse(raw);
    } catch (err) {
        return fallback;
    }
}

function writeLocalJson(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
    }
}

function saveOfflineAnswer(luotLamBaiId, cauHoiId, dapAn) {
    const key = getQuizAnswersKey(luotLamBaiId);
    const answers = readLocalJson(key, {});
    answers[cauHoiId] = dapAn;
    writeLocalJson(key, answers);
}

function loadOfflineAnswers(luotLamBaiId) {
    return readLocalJson(getQuizAnswersKey(luotLamBaiId), {});
}

function loadQuizViolationCount(luotLamBaiId) {
    const raw = localStorage.getItem(getQuizViolationCountKey(luotLamBaiId));
    const n = parseInt(raw, 10);
    return isNaN(n) ? 0 : n;
}

function saveQuizViolationCount(luotLamBaiId, count) {
    localStorage.setItem(getQuizViolationCountKey(luotLamBaiId), String(count));
}

function queueOfflineViolation(luotLamBaiId, item) {
    const key = getQuizViolationsKey(luotLamBaiId);
    const list = readLocalJson(key, []);
    list.push(item);
    writeLocalJson(key, list);
}

function clearQuizOfflineData(luotLamBaiId) {
    localStorage.removeItem(getQuizAnswersKey(luotLamBaiId));
    localStorage.removeItem(getQuizViolationsKey(luotLamBaiId));
    localStorage.removeItem(getQuizViolationCountKey(luotLamBaiId));
    localStorage.removeItem(getQuizForceSubmitKey(luotLamBaiId));
}

const QUIZ_ABSENCE_GRACE_SEC = 5; // ra ngoài (chuột/tab/cửa sổ) quá số giây này thì bài tự động được nộp
let quizAbsenceReason = null;      // 'mouse' (con trỏ ra ngoài) | 'tab' (chuyển tab/cửa sổ)
let quizAbsenceTickTimer = null;
let quizAbsenceRecorded = false;   // đợt vắng mặt này đã bị tính 1 vi phạm chưa
let quizAbsenceLogged = false;     // đợt vắng mặt này đã được ghi vào nhật ký (cheat_log) chưa
let quizAbsenceForced = false;     // đã kích hoạt tự động nộp bài chưa
let quizAbsenceNoticeHideTimer = null;
function getQuizAbsenceBox() {
    let box = document.getElementById('quiz-absence-warning-overlay');
    if (!box) {
        box = document.createElement('div');
        box.id = 'quiz-absence-warning-overlay';
        box.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:10000;' +
            'padding:28px 36px;border-radius:18px;width:520px;max-width:92vw;text-align:center;color:#fff;' +
            'box-shadow:0 24px 60px rgba(0,0,0,.5);font-family:inherit;display:none;';
        document.body.appendChild(box);
    }
    return box;
}

function ensureQuizAbsenceOverlay() {
    getQuizAbsenceBox();
}

function hideQuizAbsenceWarning() {
    clearTimeout(quizAbsenceNoticeHideTimer);
    const box = document.getElementById('quiz-absence-warning-overlay');
    if (box) box.style.display = 'none';
}

function renderQuizAbsenceBox() {
    if (quizAbsenceStartMs === null) return;
    const box = getQuizAbsenceBox();
    const elapsed = Math.floor((Date.now() - quizAbsenceStartMs) / 1000);
    const remaining = Math.max(0, QUIZ_ABSENCE_GRACE_SEC - elapsed);
    const where = quizAbsenceReason === 'tab' ? 'chuyển sang tab/cửa sổ khác' : 'đưa chuột ra ngoài trang';

    if (quizAbsenceRecorded) {
        box.style.background = '#b91c1c';
        box.innerHTML =
            '<div style="font-size:22px;font-weight:800;margin-bottom:8px;">⛔ ĐÃ GHI NHẬN VI PHẠM</div>' +
            '<div style="font-size:15px;margin-bottom:10px;">Bạn vừa ' + where + '. Vi phạm lần ' + quizViolationCount + '. ' +
            'Quay lại ngay, nếu ra ngoài quá ' + QUIZ_ABSENCE_GRACE_SEC + ' giây bài sẽ tự động nộp.</div>' +
            '<div style="font-size:64px;font-weight:800;line-height:1;">' + remaining + '</div>' +
            '<div style="font-size:13px;opacity:.9;margin-top:4px;">giây trước khi tự động nộp bài</div>';
    } else {
        box.style.background = '#d97706';
        box.innerHTML =
            '<div style="font-size:22px;font-weight:800;margin-bottom:8px;">⚠ CẢNH BÁO: BẠN ĐANG RỜI KHỎI TRANG LÀM BÀI</div>' +
            '<div style="font-size:15px;margin-bottom:10px;">Bạn vừa ' + where + '. Quay lại ngay, nếu ra ngoài quá ' + QUIZ_ABSENCE_GRACE_SEC + ' giây bài sẽ tự động nộp.</div>' +
            '<div style="font-size:64px;font-weight:800;line-height:1;">' + remaining + '</div>' +
            '<div style="font-size:13px;opacity:.9;margin-top:4px;">giây</div>';
    }
    box.style.display = 'block';
}

// Tính 1 vi phạm cho đợt vắng mặt hiện tại (mỗi đợt chỉ tính 1 lần).
function countQuizAbsenceViolation() {
    if (quizAbsenceRecorded) return;
    const luotLamBaiId = quizAntiCheatLuotLamBaiId;
    if (!luotLamBaiId) return;
    quizAbsenceRecorded = true;
    quizViolationCount = loadQuizViolationCount(luotLamBaiId) + 1;
    saveQuizViolationCount(luotLamBaiId, quizViolationCount);
}

// Ghi đợt vắng mặt vào nhật ký (để giảng viên xem), kèm thời gian vắng thực tế.
function logQuizAbsence(endMs) {
    if (!quizAbsenceRecorded || quizAbsenceLogged || quizAbsenceStartMs === null) return;
    quizAbsenceLogged = true;
    const tongGiay = Math.max(0, Math.round((endMs - quizAbsenceStartMs) / 1000));
    recordQuizViolation('roi_khoi_man_hinh', quizAbsenceStartMs, endMs, tongGiay);
}

function quizAbsenceTick() {
    if (quizAbsenceStartMs === null || quizAbsenceForced) return;
    const now = Date.now();
    const elapsedSec = Math.floor((now - quizAbsenceStartMs) / 1000);
    if (elapsedSec >= QUIZ_ABSENCE_GRACE_SEC) {
        // Ra ngoài quá 5 giây -> ghi vi phạm (nếu chưa) và tự động nộp bài ngay
        quizAbsenceForced = true;
        clearInterval(quizAbsenceTickTimer);
        quizAbsenceTickTimer = null;
        const luotLamBaiId = quizAntiCheatLuotLamBaiId;
        countQuizAbsenceViolation();
        logQuizAbsence(now);
        renderQuizAbsenceBox();
        if (luotLamBaiId) forceSubmitQuizDueToViolations(luotLamBaiId);
        return;
    }
    renderQuizAbsenceBox();
}

function quizHandleAbsenceStart(reason) {
    if (quizAbsenceForced) return;
    if (quizAbsenceStartMs === null) {
        quizAbsenceStartMs = Date.now();
        quizAbsenceReason = reason || 'mouse';
        quizAbsenceRecorded = false;
        quizAbsenceLogged = false;
        clearTimeout(quizAbsenceNoticeHideTimer);
        // Đưa chuột ra ngoài: báo vi phạm NGAY, không chờ 5 giây
        if (quizAbsenceReason === 'mouse') {
            countQuizAbsenceViolation();
        }
        renderQuizAbsenceBox();
        clearInterval(quizAbsenceTickTimer);
        quizAbsenceTickTimer = setInterval(quizAbsenceTick, 250);
    } else if (reason === 'tab') {
        // đã ra ngoài bằng chuột rồi chuyển luôn sang tab khác
        quizAbsenceReason = 'tab';
    }
}

function quizHandleAbsenceEnd() {
    if (quizAbsenceStartMs === null || quizAbsenceForced) return;
    const now = Date.now();
    const durationMs = now - quizAbsenceStartMs;
    const reason = quizAbsenceReason;
    const violated = quizAbsenceRecorded;
    logQuizAbsence(now);
    quizAbsenceStartMs = null;
    quizAbsenceReason = null;
    quizAbsenceRecorded = false;
    quizAbsenceLogged = false;
    clearInterval(quizAbsenceTickTimer);
    quizAbsenceTickTimer = null;
    hideQuizAbsenceWarning(); // đưa chuột / quay lại trang thì ô thông báo tự ẩn

    // Chuyển tab/cửa sổ: sinh viên không thấy ô lúc đang vắng, nên báo lại ngắn gọn khi quay về
    if (reason === 'tab' && quizAntiCheatLuotLamBaiId) {
        const tongGiay = Math.max(1, Math.round(durationMs / 1000));
        const box = getQuizAbsenceBox();
        box.style.background = violated ? '#b91c1c' : '#d97706';
        box.innerHTML =
            '<div style="font-size:22px;font-weight:800;margin-bottom:8px;">' + (violated ? '⛔ ĐÃ GHI NHẬN VI PHẠM' : '⚠ CẢNH BÁO') + '</div>' +
            '<div style="font-size:15px;">Bạn đã rời khỏi trang làm bài ' + tongGiay + ' giây (chuyển tab/cửa sổ).' +
            (violated ? ' Vi phạm lần ' + quizViolationCount + '.' : ' Lần này chưa bị ghi vi phạm, nhưng nếu ra ngoài quá ' + QUIZ_ABSENCE_GRACE_SEC + ' giây bài sẽ tự động nộp.') + '</div>';
        box.style.display = 'block';
        quizAbsenceNoticeHideTimer = setTimeout(hideQuizAbsenceWarning, 5000);
    }
}

function handleQuizVisibilityChange() {
    if (document.hidden) {
        quizHandleAbsenceStart('tab');
    } else {
        quizHandleAbsenceEnd();
    }
}

function handleQuizMouseLeave(e) {
    // Con trỏ rời khỏi cửa sổ trang (trên/dưới/trái/phải) -> relatedTarget = null
    if (!e.relatedTarget) {
        quizHandleAbsenceStart('mouse');
    }
}

function handleQuizWindowBlur() {
    // Chuyển sang cửa sổ/ứng dụng khác (Alt+Tab...) mà tab vẫn hiển thị
    quizHandleAbsenceStart('tab');
}

function handleQuizWindowFocus() {
    quizHandleAbsenceEnd();
}

// Dự phòng: một số trình duyệt không bắn sự kiện mouseleave khi chuột lướt nhanh lên thanh tab/thanh địa chỉ,
// nên coi chuột sát mép trang (vùng giáp thanh trình duyệt) là đã ra ngoài.
const QUIZ_EDGE_MARGIN_PX = 6;
function handleQuizMouseMoveEdge(e) {
    const m = QUIZ_EDGE_MARGIN_PX;
    const nearEdge = e.clientY <= m || e.clientX <= m ||
        e.clientX >= window.innerWidth - m || e.clientY >= window.innerHeight - m;
    if (nearEdge) {
        quizHandleAbsenceStart('mouse');
    } else if (quizAbsenceReason === 'mouse') {
        quizHandleAbsenceEnd();
    }
}

function handleQuizMouseEnter() {
    // Đang vắng vì chuyển tab/cửa sổ (cửa sổ chưa được focus lại) thì chuột lướt qua trang không tính là quay lại
    if (quizAbsenceReason === 'tab' && (document.hidden || !document.hasFocus())) return;
    quizHandleAbsenceEnd();
}

function recordQuizViolation(loaiViPham, startedAtMs, endedAtMs, tongGiay) {
    const luotLamBaiId = quizAntiCheatLuotLamBaiId;
    if (!luotLamBaiId) return;

    const item = {
        luotLamBaiId: luotLamBaiId,
        loaiViPham: loaiViPham,
        thoiGianBatDau: startedAtMs,
        thoiGianKetThuc: endedAtMs,
        tongThoiGianVangMat: tongGiay
    };

    queueOfflineViolation(luotLamBaiId, item);

    if (navigator.onLine) {
        flushQuizOfflineData(luotLamBaiId);
    }
}

function forceSubmitQuizDueToViolations(luotLamBaiId) {
    showToast('Bạn đã rời khỏi trang làm bài quá ' + QUIZ_ABSENCE_GRACE_SEC + ' giây, bài làm được tự động nộp.', 'error');
    if (navigator.onLine) {
        submitQuizAnswers(luotLamBaiId, true);
    } else {
        localStorage.setItem(getQuizForceSubmitKey(luotLamBaiId), '1');
        lockQuizUI();
        clearInterval(quizTimerInterval);
        showToast('Bài làm sẽ được nộp ngay khi có kết nối mạng trở lại.', 'warning');
    }
}

function flushQuizOfflineData(luotLamBaiId) {
    if (quizOfflineSyncInProgress) return;
    quizOfflineSyncInProgress = true;

    const violationsKey = getQuizViolationsKey(luotLamBaiId);
    const pendingViolations = readLocalJson(violationsKey, []);

    const sendViolations = pendingViolations.length > 0
        ? fetch(API_BASE + 'cheat_log.php', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: pendingViolations })
        }).then(() => {
            localStorage.removeItem(violationsKey);
        }).catch(() => {
        })
        : Promise.resolve();

    sendViolations.then(() => {
        const answers = loadOfflineAnswers(luotLamBaiId);
        const answerList = Object.keys(answers).map(cauHoiId => ({
            cauHoiId: cauHoiId,
            dapAn: answers[cauHoiId]
        }));
        const forceSubmit = localStorage.getItem(getQuizForceSubmitKey(luotLamBaiId)) === '1';

        if (answerList.length === 0 && !forceSubmit) {
            quizOfflineSyncInProgress = false;
            return;
        }

        fetch(API_BASE + 'quizzes.php?action=sync_offline', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                luotLamBaiId: luotLamBaiId,
                answers: answerList,
                forceSubmit: forceSubmit
            })
        }).then(res => res.json()).then(data => {
            quizOfflineSyncInProgress = false;
            if (data && data.daNop) {
                clearQuizOfflineData(luotLamBaiId);
                stopQuizStatusPolling();
                disableQuizAntiCheat();
                closeModal('modal-quiz-taking');
                showToast('Bài làm đã được nộp tự động sau khi có mạng trở lại.', 'success');
                loadQuizzesForSelectedSubject();
            }
        }).catch(() => {
            quizOfflineSyncInProgress = false;
        });
    });
}

function handleQuizOnlineEvent() {
    const luotLamBaiId = quizAntiCheatLuotLamBaiId;
    if (!luotLamBaiId) return;
    flushQuizOfflineData(luotLamBaiId);
}

function handleQuizAnswerInputChange(e) {
    const target = e.target;
    if (!target.classList || !target.classList.contains('quiz-answer-input')) return;
    if (target.type === 'radio' && !target.checked) return;

    const luotLamBaiId = quizAntiCheatLuotLamBaiId;
    if (!luotLamBaiId) return;

    const cauHoiId = target.getAttribute('data-question-id');
    saveOfflineAnswer(luotLamBaiId, cauHoiId, target.value);
}

/* ---------- Bảng số câu hỏi khi SV làm bài ----------
   Mỗi lần chỉ hiện 1 câu; bấm số để nhảy tới câu đó. Số màu trắng = chưa trả
   lời, màu xanh = đã trả lời. Nút "Xóa câu trả lời" xóa đáp án câu đang xem. */
let quizNavQuestionIds = [];
let quizNavCurrentIndex = 0;

function isQuizQuestionAnswered(cauHoiId) {
    const inputs = document.querySelectorAll('.quiz-answer-input[data-question-id="' + cauHoiId + '"]');
    for (const input of inputs) {
        if (input.type === 'radio') {
            if (input.checked) return true;
        } else if (input.value.trim() !== '') {
            return true;
        }
    }
    return false;
}

function updateQuizNavigatorStatus() {
    const grid = document.getElementById('quiz-nav-grid');
    if (!grid) return;
    let answered = 0;
    Array.from(grid.children).forEach((btn, index) => {
        const done = isQuizQuestionAnswered(quizNavQuestionIds[index]);
        if (done) answered++;
        btn.classList.toggle('answered', done);
        btn.classList.toggle('current', index === quizNavCurrentIndex);
    });
    const countEl = document.getElementById('quiz-nav-count');
    if (countEl) countEl.textContent = 'Đã trả lời ' + answered + '/' + quizNavQuestionIds.length;

    // Chỉ khi TẤT CẢ ô đều xanh thì nút Nộp bài mới sáng lên (xem handleManualSubmitQuiz)
    const submitBtn = document.getElementById('quiz-submit-btn');
    if (submitBtn) {
        const complete = quizNavQuestionIds.length > 0 && answered === quizNavQuestionIds.length;
        submitBtn.classList.toggle('quiz-submit-incomplete', !complete);
        submitBtn.title = complete ? '' : 'Hãy trả lời tất cả các câu hỏi (tất cả ô số phải màu xanh) để nộp bài';
    }
}

function getUnansweredQuizIndexes() {
    const list = [];
    quizNavQuestionIds.forEach((cauHoiId, index) => {
        if (!isQuizQuestionAnswered(cauHoiId)) list.push(index);
    });
    return list;
}

function showQuizQuestion(index) {
    if (index < 0 || index >= quizNavQuestionIds.length) return;
    quizNavCurrentIndex = index;
    quizNavQuestionIds.forEach((cauHoiId, i) => {
        const block = document.getElementById('quiz-question-block-' + cauHoiId);
        if (block) block.classList.toggle('quiz-q-hidden', i !== index);
    });
    const container = document.getElementById('quiz-questions-container');
    if (container) container.scrollTop = 0;
    updateQuizNavigatorStatus();
}

function clearCurrentQuizAnswer() {
    const submitBtn = document.getElementById('quiz-submit-btn');
    if (submitBtn && submitBtn.disabled) return; // đã nộp/khóa bài
    const cauHoiId = quizNavQuestionIds[quizNavCurrentIndex];
    if (!cauHoiId) return;

    document.querySelectorAll('.quiz-answer-input[data-question-id="' + cauHoiId + '"]').forEach(input => {
        if (input.type === 'radio') {
            input.checked = false;
        } else {
            input.value = '';
        }
    });

    // Lưu câu trả lời rỗng để lần đồng bộ/nộp bài sau không khôi phục đáp án cũ
    const luotLamBaiId = document.getElementById('quiz-container').getAttribute('data-luot-lam-bai');
    if (luotLamBaiId) saveOfflineAnswer(luotLamBaiId, cauHoiId, '');
    updateQuizNavigatorStatus();
}

function clearQuizNavigatorUI() {
    quizNavQuestionIds = [];
    quizNavCurrentIndex = 0;
    const grid = document.getElementById('quiz-nav-grid');
    if (grid) grid.innerHTML = '';
    const countEl = document.getElementById('quiz-nav-count');
    if (countEl) countEl.textContent = 'Đã trả lời 0/0';
}

function renderQuizNavigator(questionIds) {
    quizNavQuestionIds = questionIds.slice();
    quizNavCurrentIndex = 0;
    const grid = document.getElementById('quiz-nav-grid');
    if (!grid) return;
    grid.innerHTML = '';
    questionIds.forEach((cauHoiId, index) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'quiz-nav-btn';
        btn.textContent = String(index + 1);
        btn.onclick = function () { showQuizQuestion(index); };
        grid.appendChild(btn);
    });

    // Cập nhật màu số mỗi khi SV chọn/gõ đáp án
    const container = document.getElementById('quiz-questions-container');
    if (container) {
        container.oninput = updateQuizNavigatorStatus;
        container.onchange = updateQuizNavigatorStatus;
    }
    showQuizQuestion(0);
}

function removeQuizNavigator() {
    // Giữ lại bảng số câu hỏi trên màn hình (kể cả lúc khóa bài); sẽ được dựng lại ở lần làm bài kế tiếp.
}

function blockContextMenuDuringQuiz(e) {
    e.preventDefault();
    showToast('Không được sử dụng chuột phải trong lúc làm bài kiểm tra.', 'warning');
}

function blockDevToolsKeysDuringQuiz(e) {
    const key = (e.key || '').toLowerCase();
    const isF12 = e.keyCode === 123 || key === 'f12';
    const isInspectCombo = (e.ctrlKey || e.metaKey) && e.shiftKey && ['i', 'j', 'c'].includes(key);
    const isViewSource = (e.ctrlKey || e.metaKey) && key === 'u';
    const isSaveOrPrint = (e.ctrlKey || e.metaKey) && ['s', 'p'].includes(key);

    if (isF12 || isInspectCombo || isViewSource || isSaveOrPrint) {
        e.preventDefault();
        e.stopPropagation();
        showToast('Thao tác này bị chặn trong lúc làm bài kiểm tra.', 'warning');
        return false;
    }
}

function blockSelectDuringQuiz(e) {
    e.preventDefault();
}

function blockCopyPasteDuringQuiz(e) {
    e.preventDefault();
}

/* Chặn bôi đen bằng double-click / triple-click (chọn từ / chọn cả đoạn) -
   một số trình duyệt vẫn cho chọn kiểu này dù đã có CSS user-select:none
   và chặn selectstart, vì sự kiện chọn có thể bắt đầu ngay tại mousedown. */
function blockMultiClickSelectDuringQuiz(e) {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'textarea' || tag === 'input') return; // vẫn cho gõ/chọn chữ trong ô trả lời
    if (e.detail > 1) {
        e.preventDefault();
    }
}

/* ---- Phát hiện DevTools đang mở ----
   LƯU Ý QUAN TRỌNG: trình duyệt KHÔNG cho phép JavaScript chặn tuyệt đối
   F12/Ctrl+Shift+I (đây là quyết định bảo mật cố ý của trình duyệt, không
   phải lỗi có thể sửa). Vì vậy giải pháp thực tế là PHÁT HIỆN DevTools đang
   mở rồi phản ứng ngay (tự nộp bài + khóa lại), thay vì cố "chặn" nó.
   Kết hợp 2 kỹ thuật để tăng độ chính xác:
   1) Đo chênh lệch kích thước cửa sổ trình duyệt - bắt được DevTools ở chế
      độ gắn liền (docked, mặc định khi bấm F12).
   2) Đo thời gian thực thi câu lệnh "debugger" - bắt được cả trường hợp
      DevTools mở RỜI thành cửa sổ riêng (undocked), khi cách (1) không thấy
      được vì kích thước cửa sổ chính không đổi. */
function isDevToolsOpenBySize() {
    const threshold = 120;
    const widthDiff = window.outerWidth - window.innerWidth;
    const heightDiff = window.outerHeight - window.innerHeight;
    return widthDiff > threshold || heightDiff > threshold;
}

function isDevToolsOpenByTiming() {
    const before = performance.now();
    // eslint-disable-next-line no-debugger
    debugger;
    const after = performance.now();
    return (after - before) > 100;
}

function startDevToolsWatch(luotLamBaiId) {
    quizDevToolsOpenStreak = 0;
    quizAntiCheatLuotLamBaiId = luotLamBaiId;
    clearInterval(quizDevToolsCheckInterval);
    quizDevToolsCheckInterval = setInterval(() => {
        const openBySize = isDevToolsOpenBySize();
        const openByTiming = isDevToolsOpenByTiming();

        if (openByTiming) {
            // Kỹ thuật debugger-timing đã trực tiếp gây tạm dừng thực thi khi
            // DevTools mở và dừng tại breakpoint -> đủ tin cậy, xử lý ngay.
            triggerDevToolsViolation();
            return;
        }

        if (openBySize) {
            quizDevToolsOpenStreak++;
            // Cần lặp lại 2 lần liên tiếp mới kết luận, để tránh báo nhầm do
            // cửa sổ trình duyệt được thu nhỏ/resize thông thường.
            if (quizDevToolsOpenStreak >= 2) {
                triggerDevToolsViolation();
            }
        } else {
            quizDevToolsOpenStreak = 0;
        }
    }, 700);
}

function triggerDevToolsViolation() {
    clearInterval(quizDevToolsCheckInterval);
    quizDevToolsCheckInterval = null;
    stopQuizStatusPolling();
    clearInterval(quizTimerInterval);
    disableQuizAntiCheat();

    const overlay = document.getElementById('quiz-devtools-warning-overlay');
    if (overlay) overlay.classList.add('visible');

    const luotLamBaiId = quizAntiCheatLuotLamBaiId
        || document.getElementById('quiz-container')?.getAttribute('data-luot-lam-bai');
    if (luotLamBaiId) {
        submitQuizAnswers(luotLamBaiId, true);
    }

    setTimeout(() => {
        if (overlay) overlay.classList.remove('visible');
    }, 4000);
}

function enableQuizAntiCheat(luotLamBaiId, chongGianLan = true) {
    if (!chongGianLan) {
        // GV đã TẮT chống gian lận cho bài này: không chặn, không cảnh báo, không ghi nhận,
        // không tự nộp. Chỉ giữ việc lưu tạm câu trả lời để đồng bộ khi mất mạng.
        quizAntiCheatLuotLamBaiId = luotLamBaiId;
        quizViolationCount = 0;
        quizAbsenceStartMs = null;
        document.addEventListener('change', handleQuizAnswerInputChange, true);
        document.addEventListener('input', handleQuizAnswerInputChange, true);
        window.addEventListener('online', handleQuizOnlineEvent);
        return;
    }
    document.addEventListener('contextmenu', blockContextMenuDuringQuiz);
    document.addEventListener('keydown', blockDevToolsKeysDuringQuiz, true);
    document.addEventListener('selectstart', blockSelectDuringQuiz);
    document.addEventListener('mousedown', blockMultiClickSelectDuringQuiz);
    document.addEventListener('copy', blockCopyPasteDuringQuiz);
    document.addEventListener('cut', blockCopyPasteDuringQuiz);
    document.addEventListener('paste', blockCopyPasteDuringQuiz);
    startDevToolsWatch(luotLamBaiId);

    quizAntiCheatLuotLamBaiId = luotLamBaiId;
    quizViolationCount = loadQuizViolationCount(luotLamBaiId);
    quizAbsenceStartMs = null;
    quizAbsenceRecorded = false;
    quizAbsenceLogged = false;
    quizAbsenceForced = false;
    ensureQuizAbsenceOverlay();
    document.addEventListener('visibilitychange', handleQuizVisibilityChange);
    document.documentElement.addEventListener('mouseleave', handleQuizMouseLeave);
    document.documentElement.addEventListener('mouseenter', handleQuizMouseEnter);
    document.addEventListener('mouseleave', handleQuizMouseLeave);
    document.addEventListener('mouseout', handleQuizMouseLeave);
    document.addEventListener('mouseover', handleQuizMouseEnter);
    document.addEventListener('mousemove', handleQuizMouseMoveEdge);
    window.addEventListener('blur', handleQuizWindowBlur);
    window.addEventListener('focus', handleQuizWindowFocus);
    document.addEventListener('change', handleQuizAnswerInputChange, true);
    document.addEventListener('input', handleQuizAnswerInputChange, true);
    window.addEventListener('online', handleQuizOnlineEvent);
}

function disableQuizAntiCheat() {
    document.removeEventListener('contextmenu', blockContextMenuDuringQuiz);
    document.removeEventListener('keydown', blockDevToolsKeysDuringQuiz, true);
    document.removeEventListener('selectstart', blockSelectDuringQuiz);
    document.removeEventListener('mousedown', blockMultiClickSelectDuringQuiz);
    document.removeEventListener('copy', blockCopyPasteDuringQuiz);
    document.removeEventListener('cut', blockCopyPasteDuringQuiz);
    document.removeEventListener('paste', blockCopyPasteDuringQuiz);
    clearInterval(quizDevToolsCheckInterval);
    quizDevToolsCheckInterval = null;
    quizDevToolsOpenStreak = 0;

    document.removeEventListener('visibilitychange', handleQuizVisibilityChange);
    document.documentElement.removeEventListener('mouseleave', handleQuizMouseLeave);
    document.documentElement.removeEventListener('mouseenter', handleQuizMouseEnter);
    document.removeEventListener('mouseleave', handleQuizMouseLeave);
    document.removeEventListener('mouseout', handleQuizMouseLeave);
    document.removeEventListener('mouseover', handleQuizMouseEnter);
    document.removeEventListener('mousemove', handleQuizMouseMoveEdge);
    window.removeEventListener('blur', handleQuizWindowBlur);
    window.removeEventListener('focus', handleQuizWindowFocus);
    document.removeEventListener('change', handleQuizAnswerInputChange, true);
    document.removeEventListener('input', handleQuizAnswerInputChange, true);
    window.removeEventListener('online', handleQuizOnlineEvent);
    hideQuizAbsenceWarning();
    clearInterval(quizAbsenceTickTimer);
    quizAbsenceTickTimer = null;
    quizAbsenceReason = null;
    removeQuizNavigator();
    quizAbsenceStartMs = null;
    quizAbsenceRecorded = false;
    quizAbsenceLogged = false;
    quizAbsenceForced = false;
    quizAntiCheatLuotLamBaiId = null;
}

function restoreOfflineAnswersIntoUI(luotLamBaiId) {
    const answers = loadOfflineAnswers(luotLamBaiId);
    Object.keys(answers).forEach(cauHoiId => {
        const value = answers[cauHoiId];
        const inputs = document.querySelectorAll('.quiz-answer-input[data-question-id="' + cauHoiId + '"]');
        inputs.forEach(input => {
            if (input.type === 'radio') {
                input.checked = input.value === value;
            } else {
                input.value = value;
            }
        });
    });
    updateQuizNavigatorStatus();
}

function startQuiz(quizId) {
    if (!isSV()) return;

    const overlay = document.getElementById('quiz-devtools-warning-overlay');
    if (overlay) overlay.classList.remove('visible');

    openModal('modal-quiz-taking');
    document.getElementById('quiz-taking-title').textContent = 'Đang tải...';
    document.getElementById('quiz-timer-display').textContent = '--:--';
    clearQuizNavigatorUI();
    document.getElementById('quiz-questions-container').innerHTML = `<p class="text-sm text-slate-400">Đang tải bài kiểm tra...</p>`;
    const submitBtn = document.getElementById('quiz-submit-btn');
    if (submitBtn) submitBtn.disabled = false;

    fetch(`${API_BASE}quizzes.php?action=get&id=${quizId}`, { credentials: 'same-origin' })
        .then(response => response.text())
        .then(str => new window.DOMParser().parseFromString(str, "text/xml"))
        .then(data => {
            const errResp = data.getElementsByTagName('Response')[0];
            if (errResp) {
                const msg = errResp.getElementsByTagName('Message')[0];
                showToast(msg ? msg.textContent : 'Không thể tải bài kiểm tra.', 'error');
                closeModal('modal-quiz-taking');
                loadQuizzesForSelectedSubject();
                return;
            }

            const baiKiemTra = data.getElementsByTagName("BaiKiemTra")[0];
            document.getElementById('quiz-taking-title').textContent = baiKiemTra.getElementsByTagName("TieuDe")[0].textContent;

            // Thời gian còn lại được server tính sẵn (giây) để tránh lệch múi
            // giờ/đồng hồ giữa trình duyệt và server gây tự nộp bài sai.
            quizTimeRemaining = parseInt(baiKiemTra.getElementsByTagName("ThoiGianConLai")[0].textContent, 10);
            const luotLamBaiId = baiKiemTra.getElementsByTagName("LuotLamBaiId")[0].textContent;

            document.getElementById("quiz-container").setAttribute("data-luot-lam-bai", luotLamBaiId);
            document.getElementById("quiz-container").setAttribute("data-quiz-id", quizId);

            if (quizTimeRemaining <= 0) {
                submitQuizAnswers(luotLamBaiId, true);
                return;
            }

            renderQuizUI(baiKiemTra);
            restoreOfflineAnswersIntoUI(luotLamBaiId);
            startCountdown();
            startQuizStatusPolling(quizId, luotLamBaiId);
            const chongGianLan = baiKiemTra.getElementsByTagName('ChongGianLan')[0]?.textContent !== '0';
            enableQuizAntiCheat(luotLamBaiId, chongGianLan);

            if (localStorage.getItem(getQuizForceSubmitKey(luotLamBaiId)) === '1' && navigator.onLine) {
                flushQuizOfflineData(luotLamBaiId);
            }
        })
        .catch(err => {
            showToast('Lỗi khi tải bài kiểm tra: ' + err.message, 'error');
            closeModal('modal-quiz-taking');
        });
}

/* Thăm dò định kỳ trong lúc SV đang làm bài: nếu bị GV cấm thi hoặc đóng
   làm bài giữa chừng, tự động nộp bài ngay lập tức và khóa lại. */
let quizStatusPollInterval;

function startQuizStatusPolling(quizId, luotLamBaiId) {
    stopQuizStatusPolling();
    quizStatusPollInterval = setInterval(async () => {
        try {
            const res = await fetch(`${API_BASE}quizzes.php?action=trang_thai&id=${quizId}`, { credentials: 'same-origin' });
            const str = await res.text();
            const data = new window.DOMParser().parseFromString(str, 'text/xml');
            const biCam = data.getElementsByTagName('BiCam')[0]?.textContent === '1';
            const choPhepLamBai = data.getElementsByTagName('ChoPhepLamBai')[0]?.textContent === '1';
            const daNop = data.getElementsByTagName('DaNop')[0]?.textContent === '1';

            if (biCam) {
                stopQuizStatusPolling();
                clearInterval(quizTimerInterval);
                showToast('Bạn đã bị giáo viên cấm thi bài kiểm tra này. Bài làm hiện tại đã được tự động nộp.', 'error');
                submitQuizAnswers(luotLamBaiId, true);
                return;
            }
            if (!choPhepLamBai || daNop) {
                stopQuizStatusPolling();
                clearInterval(quizTimerInterval);
                showToast('Giáo viên đã đóng bài kiểm tra này. Bài làm hiện tại đã được tự động nộp.', 'warning');
                submitQuizAnswers(luotLamBaiId, true);
            }
        } catch (err) {
        }
    }, 5000);
}

function stopQuizStatusPolling() {
    if (quizStatusPollInterval) {
        clearInterval(quizStatusPollInterval);
        quizStatusPollInterval = null;
    }
}

function closeQuizTakingModal() {
    clearInterval(quizTimerInterval);
    stopQuizStatusPolling();
    disableQuizAntiCheat();
    closeModal('modal-quiz-taking');
}

function startCountdown() {
    const timerDisplay = document.getElementById("quiz-timer-display");
    clearInterval(quizTimerInterval);

    quizTimerInterval = setInterval(() => {
        quizTimeRemaining--;

        let minutes = Math.floor(quizTimeRemaining / 60);
        let seconds = quizTimeRemaining % 60;

        minutes = minutes < 10 ? "0" + minutes : minutes;
        seconds = seconds < 10 ? "0" + seconds : seconds;

        timerDisplay.textContent = minutes + ":" + seconds;

        if (quizTimeRemaining <= 0) {
            clearInterval(quizTimerInterval);
            const luotLamBaiId = document.getElementById("quiz-container").getAttribute("data-luot-lam-bai");
            submitQuizAnswers(luotLamBaiId, true);
        }
    }, 1000);
}

function handleManualSubmitQuiz() {
    const luotLamBaiId = document.getElementById('quiz-container').getAttribute('data-luot-lam-bai');
    if (!luotLamBaiId) return;

    // Không cho nộp bài khi còn câu chưa trả lời (ô số còn màu trắng).
    // Hết giờ / bị GV đóng bài thì hệ thống vẫn tự nộp (không đi qua hàm này).
    const chuaLam = getUnansweredQuizIndexes();
    if (chuaLam.length > 0) {
        const dsSo = chuaLam.map(i => i + 1);
        const hienThi = dsSo.length > 10 ? dsSo.slice(0, 10).join(', ') + '...' : dsSo.join(', ');
        showToast('Bạn còn ' + chuaLam.length + ' câu chưa trả lời (câu ' + hienThi + '). Hãy trả lời hết mọi câu mới được nộp bài.', 'warning');
        showQuizQuestion(chuaLam[0]);
        return;
    }
    showConfirmDialog('Bạn có chắc chắn muốn nộp bài?', () => {
        clearInterval(quizTimerInterval);
        submitQuizAnswers(luotLamBaiId, false);
    });
}

function submitQuizAnswers(luotLamBaiId, isAuto) {
    lockQuizUI();
    stopQuizStatusPolling();
    disableQuizAntiCheat();

    const xmlDoc = document.implementation.createDocument(null, "BaiLam");
    const root = xmlDoc.documentElement;

    const idNode = xmlDoc.createElement("LuotLamBaiId");
    idNode.textContent = luotLamBaiId;
    root.appendChild(idNode);

    const answers = document.querySelectorAll('.quiz-answer-input');
    const sentQuestionIds = new Set();
    answers.forEach(input => {
        if (input.type === 'radio' && !input.checked) return;
        if (input.type === 'radio' || input.type === 'textarea') {
            const cauTraLoiNode = xmlDoc.createElement("CauTraLoi");
            cauTraLoiNode.setAttribute("cau_hoi_id", input.getAttribute("data-question-id"));
            cauTraLoiNode.textContent = input.value;
            root.appendChild(cauTraLoiNode);
            sentQuestionIds.add(input.getAttribute("data-question-id"));
        }
    });
    // Câu trắc nghiệm đã bị xóa đáp án: gửi câu trả lời rỗng để ghi đè đáp án đã lưu trước đó
    answers.forEach(input => {
        const qid = input.getAttribute("data-question-id");
        if (input.type === 'radio' && !sentQuestionIds.has(qid)) {
            const cauTraLoiNode = xmlDoc.createElement("CauTraLoi");
            cauTraLoiNode.setAttribute("cau_hoi_id", qid);
            cauTraLoiNode.textContent = '';
            root.appendChild(cauTraLoiNode);
            sentQuestionIds.add(qid);
        }
    });

    const serializer = new XMLSerializer();
    const xmlString = serializer.serializeToString(xmlDoc);

    fetch(`${API_BASE}quizzes.php?action=submit`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
            'Content-Type': 'application/xml'
        },
        body: xmlString
    })
    .then(response => response.text())
    .then(str => new window.DOMParser().parseFromString(str, "text/xml"))
    .then(data => {
        const status = data.getElementsByTagName("Status")[0]?.textContent;
        if (status === "Success") {
            const diemSo = data.getElementsByTagName("DiemSo")[0].textContent;
            showToast((isAuto ? 'Hết giờ, đã tự động nộp bài. ' : 'Đã nộp bài. ') + 'Điểm số: ' + Number(diemSo).toFixed(2), 'success');
            clearQuizOfflineData(luotLamBaiId);

            const thoiGianNode = data.getElementsByTagName("ThoiGianHienThiKetQua")[0];
            const thoiGianHienThi = thoiGianNode ? parseInt(thoiGianNode.textContent, 10) || 0 : 5;
            const ketQuaNodes = Array.from(data.getElementsByTagName("KetQuaCauHoi")[0]?.getElementsByTagName("CauHoi") || []);
            const ketQuaMap = {};
            ketQuaNodes.forEach(n => {
                ketQuaMap[n.getAttribute('id')] = { dung: n.getAttribute('dung') === '1', dapAnDung: n.getAttribute('dapAnDung') || '' };
            });

            closeModal('modal-quiz-taking');
            try {
                showQuizReviewModal(ketQuaMap, Number(diemSo), thoiGianHienThi);
            } catch (reviewErr) {
                // Bài ĐÃ nộp thành công; chỉ lỗi khi vẽ màn xem lại -> không được coi là mất mạng
                console.error('Lỗi hiển thị màn xem lại kết quả:', reviewErr);
                showToast('Bài đã được nộp nhưng không hiển thị được màn xem lại: ' + reviewErr.message, 'warning');
            }
        } else {
            const msg = data.getElementsByTagName("Message")[0];
            showToast(msg ? msg.textContent : 'Nộp bài thất bại.', 'error');
            closeModal('modal-quiz-taking');
        }
        loadQuizzesForSelectedSubject();
    })
    .catch(err => {
        localStorage.setItem(getQuizForceSubmitKey(luotLamBaiId), '1');
        showToast('Không có kết nối mạng, bài làm sẽ được tự động nộp khi có mạng trở lại.', 'warning');
    });
}

function lockQuizUI() {
    const inputs = document.querySelectorAll('.quiz-answer-input');
    inputs.forEach(input => input.disabled = true);
    const submitBtn = document.getElementById('quiz-submit-btn');
    if (submitBtn) submitBtn.disabled = true;
}

/* ---------- SV: ô xem lại kết quả (đúng/sai từng câu) sau khi nộp bài ----------
   GV cấu hình số giây hiển thị khi tạo bài kiểm tra (0 = vô hạn, chỉ tắt khi
   học sinh tự bấm đóng). */
let quizReviewTimer = null;

function showQuizReviewModal(ketQuaMap, diemSo, thoiGianGiay) {
    const scoreEl = document.getElementById('quiz-review-score');
    if (scoreEl) scoreEl.textContent = 'Điểm số: ' + (isNaN(diemSo) ? '-' : diemSo.toFixed(2));

    const content = document.getElementById('quiz-review-content');
    const blocks = Array.from(document.querySelectorAll('#quiz-questions-container .quiz-question-item'));

    if (!content) return;

    if (blocks.length === 0) {
        content.innerHTML = `<p class="text-lg text-slate-400 dark:text-slate-500">Không có dữ liệu để hiển thị.</p>`;
    } else {
        content.innerHTML = blocks.map((block, index) => {
            const cauHoiId = block.id.replace('quiz-question-block-', '');
            const ketQua = ketQuaMap[cauHoiId];
            const titleEl = block.querySelector('h4');
            const tieuDe = titleEl ? titleEl.textContent : ('Câu ' + (index + 1));
            const labels = Array.from(block.querySelectorAll('label'));

            // Câu tự luận: hiện câu hỏi + bài làm của mình, chờ giáo viên chấm
            if (labels.length === 0) {
                const ta = block.querySelector('textarea');
                const traLoi = ta ? ta.value.trim() : '';
                return `
                    <div class="rounded-xl border border-slate-200 dark:border-slate-600 p-6">
                        <p class="text-xl font-semibold text-slate-800 dark:text-slate-100 mb-4">${escapeHtml(tieuDe)}</p>
                        <p class="text-lg text-slate-600 dark:text-slate-300 whitespace-pre-wrap">${traLoi ? escapeHtml(traLoi) : '<span class="italic text-slate-400">Bạn không trả lời</span>'}</p>
                        <p class="text-base mt-3 text-slate-500 dark:text-slate-400"><i class="fa-regular fa-clock mr-1"></i>Chờ GV chấm</p>
                    </div>
                `;
            }

            const dapAnDung = ketQua ? ketQua.dapAnDung : '';
            let dapAnChon = '';
            const optionsData = labels.map(label => {
                const radio = label.querySelector('input[type="radio"]');
                if (radio && radio.checked) dapAnChon = radio.value;
                return { value: radio ? radio.value : '', text: label.textContent.trim() };
            });

            // Phải khai báo trước khi dùng trong optionsHtml (nếu khai báo sau sẽ báo lỗi
            // "Cannot access 'boTrong' before initialization" và màn xem lại không hiện).
            const boTrong = !!ketQua && !dapAnChon;

            const optionsHtml = optionsData.map(op => {
                const isCorrect = ketQua && op.value === dapAnDung;
                const isWrongChosen = ketQua && op.value === dapAnChon && op.value !== dapAnDung;
                let cls, icon, badge = '';
                if (isCorrect) {
                    // Đáp án đúng: xanh khi mình chọn đúng; nếu bỏ trống thì chỉ viền nét đứt để không giống "được tính đúng"
                    cls = boTrong
                        ? 'border-dashed border-emerald-500 text-emerald-600 dark:text-emerald-300'
                        : 'border-emerald-500 bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 font-semibold';
                    icon = '<i class="fa-solid fa-circle-check"></i>';
                    badge = op.value === dapAnChon ? 'Bạn chọn đúng' : (boTrong ? 'Đáp án đúng (bạn bỏ trống)' : 'Đáp án đúng');
                } else if (isWrongChosen) {
                    // Chỉ hiện màu đỏ ở đáp án mình chọn sai
                    cls = 'border-red-500 bg-red-500/15 text-red-600 dark:text-red-300 font-semibold';
                    icon = '<i class="fa-solid fa-circle-xmark"></i>';
                    badge = 'Bạn chọn sai';
                } else {
                    cls = 'border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-200';
                    icon = '<i class="fa-regular fa-circle"></i>';
                }
                return `
                    <div class="flex items-center gap-3 px-5 py-3 rounded-xl border text-lg ${cls}">
                        <span>${icon}</span>
                        <span class="flex-1">${escapeHtml(op.text)}</span>
                        ${badge ? `<span class="text-base font-medium whitespace-nowrap">${badge}</span>` : ''}
                    </div>
                `;
            }).join('');

            // Câu bỏ trống KHÔNG được chấm điểm và luôn tính là SAI (0 điểm).
            // Đáp án đúng chỉ hiện để tham khảo, không phải bạn đã chọn đúng.
            const note = boTrong
                ? '<p class="text-base mt-3 font-semibold text-red-600 dark:text-red-300"><i class="fa-solid fa-circle-xmark mr-1"></i>Bạn chưa chọn đáp án - câu này tính SAI (0 điểm).</p>'
                : '';
            const trangThaiCau = !ketQua ? '' : (boTrong
                ? '<span class="ml-3 px-3 py-0.5 rounded-full text-sm font-semibold bg-red-500/15 text-red-600 dark:text-red-300">Chưa làm - Sai</span>'
                : (ketQua.dung
                    ? '<span class="ml-3 px-3 py-0.5 rounded-full text-sm font-semibold bg-emerald-500/15 text-emerald-600 dark:text-emerald-300">Đúng</span>'
                    : '<span class="ml-3 px-3 py-0.5 rounded-full text-sm font-semibold bg-red-500/15 text-red-600 dark:text-red-300">Sai</span>'));

            return `
                <div class="rounded-xl border border-slate-200 dark:border-slate-600 p-6">
                    <p class="text-xl font-semibold text-slate-800 dark:text-slate-100 mb-4">${escapeHtml(tieuDe)}${trangThaiCau}</p>
                    <div class="space-y-3">${optionsHtml}</div>
                    ${note}
                </div>
            `;
        }).join('');
    }

    openModal('modal-quiz-review');
    startQuizReviewCountdown(thoiGianGiay);
}

function startQuizReviewCountdown(thoiGianGiay) {
    clearInterval(quizReviewTimer);
    quizReviewTimer = null;
    const countdownEl = document.getElementById('quiz-review-countdown');

    if (!thoiGianGiay || thoiGianGiay <= 0) {
        // Vô hạn: chỉ tắt khi học sinh tự bấm đóng.
        if (countdownEl) countdownEl.textContent = 'Bấm "Đóng" khi xem xong.';
        return;
    }

    let remaining = thoiGianGiay;
    if (countdownEl) countdownEl.textContent = `Tự đóng sau ${remaining}s...`;
    quizReviewTimer = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
            closeQuizReviewModal();
            return;
        }
        if (countdownEl) countdownEl.textContent = `Tự đóng sau ${remaining}s...`;
    }, 1000);
}

function closeQuizReviewModal() {
    clearInterval(quizReviewTimer);
    quizReviewTimer = null;
    closeModal('modal-quiz-review');
}

/* Xáo trộn thứ tự câu hỏi và thứ tự đáp án A/B/C/D riêng cho từng sinh viên.
   Dùng bộ sinh số ngẫu nhiên có "hạt giống" (seed) = id lượt làm bài của SV, nên:
   - mỗi SV có thứ tự khác nhau (SV này câu 1 thì SV khác có thể là câu 3, câu 11...);
   - cùng 1 SV tải lại trang/làm tiếp vẫn thấy đúng thứ tự cũ.
   Giá trị đáp án lưu/chấm điểm vẫn là chữ cái GỐC (A-D) nên không ảnh hưởng chấm điểm. */
function quizHashSeed(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function quizSeededRandom(seedStr) {
    let a = quizHashSeed(seedStr);
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function quizSeededShuffle(list, seedStr) {
    const arr = list.slice();
    const rand = quizSeededRandom(seedStr);
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
}

function renderQuizUI(baiKiemTraData) {
    const container = document.getElementById("quiz-questions-container");
    container.innerHTML = "";

    const dsCauHoi = baiKiemTraData.getElementsByTagName("DanhSachCauHoi")[0];
    const quizSeedBase = (document.getElementById("quiz-container").getAttribute("data-luot-lam-bai") || "0");
    const cauHoiList = quizSeededShuffle(Array.from(dsCauHoi.getElementsByTagName("CauHoi")), "q:" + quizSeedBase);
    const questionIds = [];

    cauHoiList.forEach((cauHoi, index) => {
        const cauHoiId = cauHoi.getAttribute("id");
        const loai = cauHoi.getAttribute("loai");
        const noiDung = cauHoi.getElementsByTagName("NoiDung")[0].textContent;
        const dapAnDaChonNode = cauHoi.getElementsByTagName("DapAnDaChon")[0];
        const dapAnDaChon = dapAnDaChonNode ? dapAnDaChonNode.textContent : "";

        questionIds.push(cauHoiId);

        const div = document.createElement("div");
        div.id = "quiz-question-block-" + cauHoiId;
        div.className = "quiz-question-item border border-slate-200 dark:border-slate-600 rounded-xl p-6";

        const title = document.createElement("h4");
        title.className = "text-xl font-semibold text-slate-800 dark:text-slate-100 mb-4";
        title.textContent = "Câu " + (index + 1) + ": " + noiDung;
        div.appendChild(title);

        if (loai === "trac_nghiem") {
            const dapanA = cauHoi.getElementsByTagName("DapAnA")[0].textContent;
            const dapanB = cauHoi.getElementsByTagName("DapAnB")[0].textContent;
            const dapanC = cauHoi.getElementsByTagName("DapAnC")[0].textContent;
            const dapanD = cauHoi.getElementsByTagName("DapAnD")[0].textContent;

            const ops = quizSeededShuffle([
                { val: "A", text: dapanA },
                { val: "B", text: dapanB },
                { val: "C", text: dapanC },
                { val: "D", text: dapanD }
            ], "a:" + quizSeedBase + ":" + cauHoiId);

            const optsWrap = document.createElement("div");
            optsWrap.className = "space-y-3";

            ops.forEach((op, opIndex) => {
                const label = document.createElement("label");
                label.className = "flex items-center gap-3 text-lg text-slate-700 dark:text-slate-200 cursor-pointer py-1";

                const radio = document.createElement("input");
                radio.type = "radio";
                radio.name = "question_" + cauHoiId;
                radio.value = op.val;
                radio.className = "quiz-answer-input w-5 h-5";
                radio.setAttribute("data-question-id", cauHoiId);
                if (dapAnDaChon === op.val) {
                    radio.checked = true;
                }

                label.appendChild(radio);
                label.appendChild(document.createTextNode(["A", "B", "C", "D"][opIndex] + ". " + op.text));
                optsWrap.appendChild(label);
            });
            div.appendChild(optsWrap);
        } else {
            const textarea = document.createElement("textarea");
            textarea.className = "quiz-answer-input w-full px-4 py-3 text-lg rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500";
            textarea.rows = 6;
            textarea.setAttribute("data-question-id", cauHoiId);
            if (dapAnDaChon) {
                textarea.value = dapAnDaChon;
            }
            div.appendChild(textarea);
        }
        container.appendChild(div);
    });

    renderQuizNavigator(questionIds);
}
