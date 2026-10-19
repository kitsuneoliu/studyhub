<?php
require __DIR__ . '/config.php';

/* Nạp nhanh danh sách sinh viên từ file Excel (đã được trình duyệt đọc thành JSON).
   POST {students: [{maSoSv, hoTen, lop, username, password}, ...]}
   - Lớp chưa có thì tự tạo.
   - Tên đăng nhập chưa có -> tạo tài khoản sinh viên mới.
   - Tên đăng nhập đã là sinh viên -> cập nhật tên, mã số, lớp (và mật khẩu nếu file có điền).
   - Dòng lỗi (sai định dạng, trùng mã số SV với người khác, trùng tên với giảng viên...) bị bỏ qua và báo lại. */
requireGV();
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'Method không được hỗ trợ.']);
    exit;
}

$data = readJsonBody();
$list = $data['students'] ?? null;
if (!is_array($list) || count($list) === 0) {
    http_response_code(400);
    echo json_encode(['error' => 'Không có sinh viên nào để nạp.']);
    exit;
}
if (count($list) > 2000) {
    http_response_code(400);
    echo json_encode(['error' => 'Mỗi lần chỉ nạp tối đa 2000 sinh viên.']);
    exit;
}

// Cache tên lớp -> id (không phân biệt hoa/thường)
$lopTheoTen = [];
$maxLop = 0;
foreach ($pdo->query('SELECT id, ten FROM lop_hoc')->fetchAll() as $l) {
    $lopTheoTen[mb_strtolower($l['ten'], 'UTF-8')] = $l['id'];
    if (preg_match('/^lop-(\d+)$/', (string) $l['id'], $m)) {
        $maxLop = max($maxLop, (int) $m[1]);
    }
}

$stUser = $pdo->prepare('SELECT username, role FROM users WHERE username = ? LIMIT 1');
$stMssv = $pdo->prepare('SELECT username FROM users WHERE ma_so_sv = ? LIMIT 1');
$stInsLop = $pdo->prepare('INSERT INTO lop_hoc (id, ten) VALUES (?, ?)');
$stInsUser = $pdo->prepare("INSERT INTO users (username, password, role, ho_ten, ma_so_sv, lop_id) VALUES (?, ?, 'sv', ?, ?, ?)");

$taoMoi = 0; $capNhat = 0; $lopMoi = [];
$loi = [];

foreach ($list as $i => $sv) {
    $dong = isset($sv['dong']) ? (int) $sv['dong'] : $i + 1;
    $maSoSv = trim((string) ($sv['maSoSv'] ?? ''));
    $hoTen = trim((string) ($sv['hoTen'] ?? ''));
    $lop = trim((string) ($sv['lop'] ?? ''));
    $username = trim((string) ($sv['username'] ?? ''));
    $password = (string) ($sv['password'] ?? '');

    $ghiLoi = function (string $m) use (&$loi, $dong) { $loi[] = ['dong' => $dong, 'message' => $m]; };

    if (!preg_match('/^[A-Za-z0-9._@-]{3,50}$/', $username)) { $ghiLoi('user sinh viên không hợp lệ (chữ không dấu, số, . _ - @, 3-50 ký tự)'); continue; }
    if ($hoTen === '' || mb_strlen($hoTen, 'UTF-8') > 100) { $ghiLoi('tên sinh viên trống hoặc quá 100 ký tự'); continue; }
    if (!preg_match('/^[A-Za-z0-9._-]{1,30}$/', $maSoSv)) { $ghiLoi('mã số sinh viên không hợp lệ'); continue; }
    if (strlen($password) > 255) { $ghiLoi('mật khẩu quá dài'); continue; }
    if ($lop !== '' && mb_strlen($lop, 'UTF-8') > 100) { $ghiLoi('tên lớp quá 100 ký tự'); continue; }

    $stUser->execute([$username]);
    $cu = $stUser->fetch();
    if ($cu && $cu['role'] !== 'sv') { $ghiLoi('user "' . $username . '" đã là tài khoản giảng viên/quản lý'); continue; }
    if (!$cu && $password === '') { $ghiLoi('thiếu mật khẩu cho tài khoản mới'); continue; }

    $stMssv->execute([$maSoSv]);
    $chu = $stMssv->fetchColumn();
    if ($chu !== false && $chu !== $username) { $ghiLoi('mã số ' . $maSoSv . ' đã thuộc tài khoản khác (' . $chu . ')'); continue; }

    try {
        // Tạo lớp mới (nếu chưa có) trước, ngoài transaction, để bộ nhớ đệm tên lớp luôn khớp CSDL.
        $lopId = null;
        if ($lop !== '') {
            $key = mb_strtolower($lop, 'UTF-8');
            if (!isset($lopTheoTen[$key])) {
                $maxLop++;
                $idMoi = 'lop-' . $maxLop;
                $stInsLop->execute([$idMoi, $lop]);
                $lopTheoTen[$key] = $idMoi;
                $lopMoi[] = $lop;
            }
            $lopId = $lopTheoTen[$key];
        }

        $pdo->beginTransaction();

        if ($cu) {
            $sets = 'ho_ten = ?, ma_so_sv = ?, lop_id = ?';
            $params = [$hoTen, $maSoSv, $lopId];
            if ($password !== '') { $sets .= ', password = ?'; $params[] = $password; }
            $params[] = $username;
            $pdo->prepare("UPDATE users SET $sets WHERE username = ?")->execute($params);
            $capNhat++;
        } else {
            $stInsUser->execute([$username, $password, $hoTen, $maSoSv, $lopId]);
            $taoMoi++;
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        error_log('import_students: ' . $e->getMessage());
        $ghiLoi('không lưu được (lỗi cơ sở dữ liệu)');
    }
}

echo json_encode([
    'success' => true,
    'taoMoi' => $taoMoi,
    'capNhat' => $capNhat,
    'lopMoi' => $lopMoi,
    'loi' => $loi,
]);
