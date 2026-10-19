<?php
session_start();

ini_set('display_errors', '0');
ini_set('log_errors', '1');

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate');
header('Pragma: no-cache');

set_exception_handler(function ($e) {
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    error_log($e->getMessage());
    $message = 'Lỗi máy chủ, vui lòng thử lại sau.';
    if (stripos($e->getMessage(), 'max_allowed_packet') !== false) {
        $message = 'Tệp quá lớn so với giới hạn max_allowed_packet hiện đang cấu hình trên MySQL. Vui lòng mở file my.ini (hoặc my.cnf), tìm mục [mysqld], thêm hoặc sửa dòng max_allowed_packet=1024M rồi khởi động lại MySQL.';
    }
    echo json_encode(['error' => $message]);
    exit;
});

$DB_HOST = 'localhost';
$DB_NAME = 'studyhub';
$DB_USER = 'root';
$DB_PASS = '';

try {
    $pdo = new PDO(
        "mysql:host={$DB_HOST};dbname={$DB_NAME};charset=utf8mb4",
        $DB_USER,
        $DB_PASS,
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]
    );
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode([
        'error' => 'Không thể kết nối cơ sở dữ liệu: ' . $e->getMessage() . ' (Kiểm tra lại $DB_HOST/$DB_NAME/$DB_USER/$DB_PASS trong api/config.php, và đảm bảo MySQL đang chạy.)',
    ]);
    exit;
}

/* Tự thêm 2 cột ho_ten (tên hiển thị) và ma_so_sv (mã số sinh viên) vào bảng
   users nếu database cũ chưa có - không cần import lại schema.sql (file đó có
   lệnh DELETE FROM users nên chạy lại sẽ xóa sạch tài khoản). Chỉ kiểm tra 1
   lần cho mỗi phiên đăng nhập. */
function ensureUserColumns(PDO $pdo): void {
    if (!empty($_SESSION['_user_cols_ok'])) {
        return;
    }

    $cols = $pdo->query('SHOW COLUMNS FROM users')->fetchAll(PDO::FETCH_COLUMN);
    if (!in_array('ho_ten', $cols, true)) {
        $pdo->exec('ALTER TABLE users ADD COLUMN ho_ten VARCHAR(100) NULL AFTER password');
    }
    if (!in_array('ma_so_sv', $cols, true)) {
        $pdo->exec('ALTER TABLE users ADD COLUMN ma_so_sv VARCHAR(30) NULL AFTER ho_ten');
    }

    $stmt = $pdo->query("SHOW INDEX FROM users WHERE Key_name = 'uq_users_ma_so_sv'");
    if (!$stmt->fetch()) {
        $pdo->exec('ALTER TABLE users ADD UNIQUE KEY uq_users_ma_so_sv (ma_so_sv)');
    }

    $_SESSION['_user_cols_ok'] = true;
}

try {
    ensureUserColumns($pdo);
} catch (Throwable $e) {
    error_log('ensureUserColumns: ' . $e->getMessage());
}

/* Tự thêm cột diem_cham_tay vào luot_lam_bai nếu chưa có. Cột này NULL = điểm do
   hệ thống tự chấm; có giá trị = điểm do giảng viên chấm tay (không bị tính lại
   tự động khi sửa đề). */
function ensureLuotColumns(PDO $pdo): void {
    if (!empty($_SESSION['_luot_cols_ok'])) {
        return;
    }
    $cols = $pdo->query('SHOW COLUMNS FROM luot_lam_bai')->fetchAll(PDO::FETCH_COLUMN);
    if (!in_array('diem_cham_tay', $cols, true)) {
        $pdo->exec('ALTER TABLE luot_lam_bai ADD COLUMN diem_cham_tay DECIMAL(5,2) NULL AFTER diem_so');
    }
    $_SESSION['_luot_cols_ok'] = true;
}

try {
    ensureLuotColumns($pdo);
} catch (Throwable $e) {
    error_log('ensureLuotColumns: ' . $e->getMessage());
}

/* Tự thêm cột chong_gian_lan vào bai_kiem_tra nếu chưa có.
   1 = BẬT hệ thống chống gian lận (mặc định, như trước đây);
   0 = TẮT: sinh viên làm bài thoải mái, không bị cảnh báo/ghi nhận/tự nộp. */
function ensureQuizColumns(PDO $pdo): void {
    if (!empty($_SESSION['_quiz_cols_ok'])) {
        return;
    }
    $cols = $pdo->query('SHOW COLUMNS FROM bai_kiem_tra')->fetchAll(PDO::FETCH_COLUMN);
    if (!in_array('chong_gian_lan', $cols, true)) {
        $pdo->exec('ALTER TABLE bai_kiem_tra ADD COLUMN chong_gian_lan TINYINT(1) NOT NULL DEFAULT 1');
    }
    $_SESSION['_quiz_cols_ok'] = true;
}

try {
    ensureQuizColumns($pdo);
} catch (Throwable $e) {
    error_log('ensureQuizColumns: ' . $e->getMessage());
}

/* Câu trắc nghiệm chỉ tính ĐÚNG khi sinh viên CÓ chọn đáp án và trùng đáp án đúng.
   Bỏ trống (rỗng/NULL) luôn là SAI, kể cả khi đáp án đúng trong CSDL bị trống. */
function laCauTraLoiDung($traLoi, $dapAnDung): bool {
    $traLoi = trim((string) $traLoi);
    $dapAnDung = trim((string) $dapAnDung);
    return $traLoi !== '' && $dapAnDung !== '' && $traLoi === $dapAnDung;
}

/* Đổi tên 2 tài khoản quản lý mẫu cũ gv1, gv2 thành ql1, ql2 (giữ nguyên mật khẩu và mọi dữ liệu liên quan).
   Chỉ chạy khi gv1/gv2 còn tồn tại và ql1/ql2 chưa có. Vai trò vẫn là 'gv' bên trong hệ thống. */
function ensureQuanLyAccounts(PDO $pdo): void {
    if (!empty($_SESSION['_ql_rename_ok'])) {
        return;
    }
    $map = ['gv1' => 'ql1', 'gv2' => 'ql2'];
    $stCu = $pdo->prepare("SELECT 1 FROM users WHERE username = ? AND role = 'gv' LIMIT 1");
    $stMoi = $pdo->prepare('SELECT 1 FROM users WHERE username = ? LIMIT 1');
    $cotLienQuan = [['bai_kiem_tra', 'nguoi_tao_id'], ['giao_trinh', 'created_by'], ['homeworks', 'created_by']];

    foreach ($map as $cu => $moi) {
        $stCu->execute([$cu]);
        $stMoi->execute([$moi]);
        if (!$stCu->fetch() || $stMoi->fetch()) {
            continue;
        }
        $pdo->exec('SET FOREIGN_KEY_CHECKS = 0');
        try {
            $pdo->prepare('UPDATE users SET username = ? WHERE username = ?')->execute([$moi, $cu]);
            foreach ($cotLienQuan as [$bang, $cot]) {
                try {
                    $pdo->prepare("UPDATE `$bang` SET `$cot` = ? WHERE `$cot` = ?")->execute([$moi, $cu]);
                } catch (Throwable $e) {
                    // bảng chưa tồn tại: bỏ qua
                }
            }
            try {
                $pdo->prepare('UPDATE giang_vien_mon SET username = ? WHERE username = ?')->execute([$moi, $cu]);
            } catch (Throwable $e) {
            }
        } finally {
            $pdo->exec('SET FOREIGN_KEY_CHECKS = 1');
        }
    }
    $_SESSION['_ql_rename_ok'] = true;
}

try {
    ensureQuanLyAccounts($pdo);
} catch (Throwable $e) {
    error_log('ensureQuanLyAccounts: ' . $e->getMessage());
}

/* Tự thêm cột cho_phep_nop_bai vào bảng subjects nếu chưa có.
   1 = sinh viên được nộp bài tập của môn này (mặc định), 0 = giảng viên đã đóng nộp bài. */
function ensureSubjectColumns(PDO $pdo): void {
    if (!empty($_SESSION['_subject_cols_ok'])) {
        return;
    }
    $cols = $pdo->query('SHOW COLUMNS FROM subjects')->fetchAll(PDO::FETCH_COLUMN);
    if (!in_array('cho_phep_nop_bai', $cols, true)) {
        $pdo->exec('ALTER TABLE subjects ADD COLUMN cho_phep_nop_bai TINYINT(1) NOT NULL DEFAULT 1');
    }
    $_SESSION['_subject_cols_ok'] = true;
}

try {
    ensureSubjectColumns($pdo);
} catch (Throwable $e) {
    error_log('ensureSubjectColumns: ' . $e->getMessage());
}

/* ---------------------------------------------------------------------
   GIẢNG VIÊN THEO MÔN
   - users.gv_gioi_han = 1: giảng viên CHỈ làm việc với các môn được gán trong bảng giang_vien_mon.
   - users.gv_gioi_han = 0 (mặc định, ví dụ ql1/ql2): giảng viên quản trị, thấy mọi môn.
   Sinh viên không bị ảnh hưởng.
   --------------------------------------------------------------------- */
function ensureGvScope(PDO $pdo): void {
    if (!empty($_SESSION['_gv_scope_ok'])) {
        return;
    }
    $cols = $pdo->query('SHOW COLUMNS FROM users')->fetchAll(PDO::FETCH_COLUMN);
    if (!in_array('gv_gioi_han', $cols, true)) {
        $pdo->exec('ALTER TABLE users ADD COLUMN gv_gioi_han TINYINT(1) NOT NULL DEFAULT 0');
    }
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS giang_vien_mon (
            username VARCHAR(50) NOT NULL,
            subject_id VARCHAR(50) NOT NULL,
            PRIMARY KEY (username, subject_id),
            CONSTRAINT fk_gvmon_user FOREIGN KEY (username) REFERENCES users(username)
                ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT fk_gvmon_subject FOREIGN KEY (subject_id) REFERENCES subjects(id)
                ON DELETE CASCADE ON UPDATE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
    );
    $_SESSION['_gv_scope_ok'] = true;
}

try {
    ensureGvScope($pdo);
} catch (Throwable $e) {
    error_log('ensureGvScope: ' . $e->getMessage());
}

/* Trả về null nếu KHÔNG bị giới hạn (sinh viên, khách, giảng viên quản trị);
   trả về mảng id môn nếu là giảng viên theo môn (có thể rỗng = chưa được gán môn nào). */
function gvPhamViMon(PDO $pdo): ?array {
    static $cache = false;
    if ($cache !== false) {
        return $cache;
    }
    $u = currentUser();
    if ($u === null || $u['role'] !== 'gv') {
        return $cache = null;
    }
    try {
        $stmt = $pdo->prepare('SELECT gv_gioi_han FROM users WHERE username = ? LIMIT 1');
        $stmt->execute([$u['username']]);
        $row = $stmt->fetch();
        if (!$row || (int) $row['gv_gioi_han'] !== 1) {
            return $cache = null;
        }
        $stmt = $pdo->prepare('SELECT subject_id FROM giang_vien_mon WHERE username = ?');
        $stmt->execute([$u['username']]);
        return $cache = array_map('strval', $stmt->fetchAll(PDO::FETCH_COLUMN));
    } catch (Throwable $e) {
        error_log('gvPhamViMon: ' . $e->getMessage());
        return $cache = [];  // lỗi thì chặn (an toàn), không mở rộng quyền
    }
}

function gvCoQuyenMon(PDO $pdo, $monId): bool {
    $pv = gvPhamViMon($pdo);
    if ($pv === null) {
        return true;
    }
    return $monId !== null && $monId !== '' && in_array((string) $monId, $pv, true);
}

/* Chuỗi SQL ' AND <cột> IN (...)' giới hạn theo môn của giảng viên; rỗng nếu không bị giới hạn. */
function gvLocMon(PDO $pdo, string $cot, array &$params): string {
    $pv = gvPhamViMon($pdo);
    if ($pv === null) {
        return '';
    }
    if (count($pv) === 0) {
        return ' AND 1 = 0';
    }
    foreach ($pv as $id) {
        $params[] = $id;
    }
    return ' AND ' . $cot . ' IN (' . implode(',', array_fill(0, count($pv), '?')) . ')';
}

function requireGvMon(PDO $pdo, $monId): void {
    if (!gvCoQuyenMon($pdo, $monId)) {
        http_response_code(403);
        echo json_encode(['error' => 'Bạn chỉ được thao tác trên môn học mà bạn phụ trách.']);
        exit;
    }
}

/* ---------------------------------------------------------------------
   LỚP HỌC: bảng lop_hoc + cột users.lop_id (mỗi sinh viên chỉ thuộc tối đa 1 lớp, 1 lớp có nhiều sinh viên).
   --------------------------------------------------------------------- */
function ensureLopHoc(PDO $pdo): void {
    if (!empty($_SESSION['_lop_hoc_ok'])) {
        return;
    }
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS lop_hoc (
            id VARCHAR(20) NOT NULL PRIMARY KEY,
            ten VARCHAR(100) NOT NULL,
            UNIQUE KEY uq_lop_ten (ten)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
    );
    $cols = $pdo->query('SHOW COLUMNS FROM users')->fetchAll(PDO::FETCH_COLUMN);
    if (!in_array('lop_id', $cols, true)) {
        $pdo->exec('ALTER TABLE users ADD COLUMN lop_id VARCHAR(20) NULL');
    }
    $_SESSION['_lop_hoc_ok'] = true;
}

try {
    ensureLopHoc($pdo);
} catch (Throwable $e) {
    error_log('ensureLopHoc: ' . $e->getMessage());
}

/* Trả về mã lớp hợp lệ (hoặc null nếu để trống). Lớp không tồn tại -> báo lỗi 400. */
function kiemTraLopId(PDO $pdo, $lopId): ?string {
    $lopId = trim((string) $lopId);
    if ($lopId === '') {
        return null;
    }
    $st = $pdo->prepare('SELECT 1 FROM lop_hoc WHERE id = ? LIMIT 1');
    $st->execute([$lopId]);
    if (!$st->fetch()) {
        http_response_code(400);
        echo json_encode(['error' => 'Lớp học không tồn tại.']);
        exit;
    }
    return $lopId;
}

function currentUser() {
    if (!isset($_SESSION['username']) || !isset($_SESSION['role'])) {
        return null;
    }
    return ['username' => $_SESSION['username'], 'role' => $_SESSION['role']];
}

function isGV() {
    $u = currentUser();
    return $u !== null && $u['role'] === 'gv';
}

function isSV() {
    $u = currentUser();
    return $u !== null && $u['role'] === 'sv';
}

function requireLogin() {
    if (currentUser() === null) {
        http_response_code(401);
        echo json_encode(['error' => 'Bạn cần đăng nhập để thực hiện thao tác này.']);
        exit;
    }
}

function requireGV() {
    if (!isGV()) {
        http_response_code(403);
        echo json_encode(['error' => 'Chỉ Giảng viên (GV) mới có quyền thực hiện thao tác này.']);
        exit;
    }
}

// GV được sửa/xóa MỌI bài tập. SV chỉ được sửa/xóa bài tập do chính mình tạo.
function canModifyHomework($createdBy) {
    $u = currentUser();
    if ($u === null) return false;
    if ($u['role'] === 'gv') return true;
    return $u['role'] === 'sv' && $createdBy !== null && $createdBy === $u['username'];
}

function requireCanModifyHomework($createdBy) {
    if (!canModifyHomework($createdBy)) {
        http_response_code(403);
        echo json_encode(['error' => 'Bạn không có quyền sửa/xóa bài tập này (chỉ được thao tác trên bài tập do chính mình tạo, trừ khi là GV).']);
        exit;
    }
}

function readJsonBody() {
    $raw = file_get_contents('php://input');
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function genId($prefix) {
    return $prefix . '-' . bin2hex(random_bytes(6)) . '-' . time();
}

function ensureCheatLogTable(PDO $pdo): void {
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS cheat_log (
            id INT AUTO_INCREMENT PRIMARY KEY,
            luot_lam_bai_id INT NOT NULL,
            hoc_sinh_id VARCHAR(50) NOT NULL,
            loai_vi_pham VARCHAR(50) NOT NULL,
            thoi_gian_bat_dau DATETIME NOT NULL,
            thoi_gian_ket_thuc DATETIME NOT NULL,
            tong_thoi_gian_vang_mat INT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT fk_cheatlog_luot
                FOREIGN KEY (luot_lam_bai_id) REFERENCES luot_lam_bai(id)
                ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT fk_cheatlog_hocsinh
                FOREIGN KEY (hoc_sinh_id) REFERENCES users(username)
                ON DELETE CASCADE ON UPDATE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
    );
}
