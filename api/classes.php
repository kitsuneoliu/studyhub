<?php
require __DIR__ . '/config.php';

/* Lớp học. Mọi giảng viên (kể cả tài khoản quản lý ql1, ql2) đều:
     GET                       : xem danh sách lớp (kèm số sinh viên)
     POST   {ten}              : tạo lớp mới
     PUT    ?id=..  {ten}      : đổi tên lớp
     DELETE ?id=..             : xóa lớp (sinh viên trong lớp thành "chưa xếp lớp")
     POST   ?action=assign {lopId, usernames:[...]} : gắn đúng danh sách sinh viên vào lớp
            (sinh viên đang ở lớp mà không có trong danh sách sẽ được bỏ khỏi lớp)
     POST   ?action=assign_one {lopId, username}    : gắn 1 sinh viên vào lớp (lopId rỗng = bỏ lớp) */
requireGV();
$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';

function loiLop(int $code, string $msg) {
    http_response_code($code);
    echo json_encode(['error' => $msg]);
    exit;
}

function validateTenLop(string $ten): ?string {
    if ($ten === '') return 'Vui lòng nhập tên lớp.';
    if (mb_strlen($ten, 'UTF-8') > 100) return 'Tên lớp tối đa 100 ký tự.';
    return null;
}

function danhSachLop(PDO $pdo): array {
    $rows = $pdo->query(
        "SELECT l.id, l.ten, COUNT(u.username) AS soSinhVien
         FROM lop_hoc l
         LEFT JOIN users u ON u.lop_id = l.id AND u.role = 'sv'
         GROUP BY l.id, l.ten
         ORDER BY l.ten ASC"
    )->fetchAll();
    foreach ($rows as &$r) {
        $r['soSinhVien'] = (int) $r['soSinhVien'];
    }
    unset($r);
    return $rows;
}

/* Mã lớp mới dạng lop-N (tối đa 20 ký tự), N = số lớn nhất hiện có + 1. */
function taoMaLopMoi(PDO $pdo): string {
    $max = 0;
    foreach ($pdo->query("SELECT id FROM lop_hoc")->fetchAll(PDO::FETCH_COLUMN) as $id) {
        if (preg_match('/^lop-(\d+)$/', (string) $id, $m)) {
            $max = max($max, (int) $m[1]);
        }
    }
    return 'lop-' . ($max + 1);
}

if ($method === 'GET') {
    echo json_encode(danhSachLop($pdo));
    exit;
}

if ($method === 'POST' && $action === 'assign') {
    $data = readJsonBody();
    $lopId = kiemTraLopId($pdo, $data['lopId'] ?? '');
    if ($lopId === null) loiLop(400, 'Vui lòng chọn lớp.');
    $ds = $data['usernames'] ?? [];
    if (!is_array($ds)) loiLop(400, 'Danh sách sinh viên không hợp lệ.');
    $ds = array_values(array_unique(array_map('strval', $ds)));

    $pdo->beginTransaction();
    try {
        // bỏ khỏi lớp những sinh viên không còn được chọn
        $stmtHienTai = $pdo->prepare("SELECT username FROM users WHERE role = 'sv' AND lop_id = ?");
        $stmtHienTai->execute([$lopId]);
        $stGo = $pdo->prepare("UPDATE users SET lop_id = NULL WHERE username = ? AND role = 'sv'");
        foreach ($stmtHienTai->fetchAll(PDO::FETCH_COLUMN) as $u) {
            if (!in_array($u, $ds, true)) $stGo->execute([$u]);
        }
        // gắn các sinh viên được chọn (mỗi sinh viên chỉ thuộc 1 lớp nên tự chuyển khỏi lớp cũ)
        $stGan = $pdo->prepare("UPDATE users SET lop_id = ? WHERE username = ? AND role = 'sv'");
        foreach ($ds as $u) {
            $stGan->execute([$lopId, $u]);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
    echo json_encode(['success' => true, 'lop' => danhSachLop($pdo)]);
    exit;
}

if ($method === 'POST' && $action === 'assign_one') {
    $data = readJsonBody();
    $lopId = kiemTraLopId($pdo, $data['lopId'] ?? '');
    $u = trim((string) ($data['username'] ?? ''));
    $st = $pdo->prepare("UPDATE users SET lop_id = ? WHERE username = ? AND role = 'sv'");
    $st->execute([$lopId, $u]);
    echo json_encode(['success' => true]);
    exit;
}

if ($method === 'POST') {
    $data = readJsonBody();
    $ten = trim((string) ($data['ten'] ?? ''));
    if (($err = validateTenLop($ten)) !== null) loiLop(400, $err);

    $st = $pdo->prepare('SELECT 1 FROM lop_hoc WHERE ten = ? LIMIT 1');
    $st->execute([$ten]);
    if ($st->fetch()) loiLop(409, 'Tên lớp đã tồn tại.');

    $id = taoMaLopMoi($pdo);
    $pdo->prepare('INSERT INTO lop_hoc (id, ten) VALUES (?, ?)')->execute([$id, $ten]);
    echo json_encode(['id' => $id, 'ten' => $ten, 'soSinhVien' => 0]);
    exit;
}

if ($method === 'PUT') {
    $id = trim((string) ($_GET['id'] ?? ''));
    $data = readJsonBody();
    $ten = trim((string) ($data['ten'] ?? ''));
    if ($id === '') loiLop(400, 'Thiếu mã lớp.');
    if (($err = validateTenLop($ten)) !== null) loiLop(400, $err);
    kiemTraLopId($pdo, $id);

    $st = $pdo->prepare('SELECT 1 FROM lop_hoc WHERE ten = ? AND id <> ? LIMIT 1');
    $st->execute([$ten, $id]);
    if ($st->fetch()) loiLop(409, 'Tên lớp đã tồn tại.');

    $pdo->prepare('UPDATE lop_hoc SET ten = ? WHERE id = ?')->execute([$ten, $id]);
    echo json_encode(['id' => $id, 'ten' => $ten]);
    exit;
}

if ($method === 'DELETE') {
    $id = trim((string) ($_GET['id'] ?? ''));
    if ($id === '') loiLop(400, 'Thiếu mã lớp.');
    kiemTraLopId($pdo, $id);
    $pdo->beginTransaction();
    try {
        $pdo->prepare('UPDATE users SET lop_id = NULL WHERE lop_id = ?')->execute([$id]);
        $pdo->prepare('DELETE FROM lop_hoc WHERE id = ?')->execute([$id]);
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
    echo json_encode(['success' => true]);
    exit;
}

loiLop(405, 'Method không được hỗ trợ.');
