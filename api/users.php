<?php
require __DIR__ . '/config.php';

$method = $_SERVER['REQUEST_METHOD'];

function jsonError(int $code, string $message) {
    http_response_code($code);
    echo json_encode(['error' => $message]);
    exit;
}

function userRow(array $row): array {
    return [
        'username' => $row['username'],
        'role' => $row['role'],
        'hoTen' => $row['ho_ten'],
        'maSoSv' => $row['ma_so_sv'],
        'lopId' => $row['lop_id'] ?? null,
        'lop' => $row['lop_ten'] ?? null,
    ];
}

/* Giảng viên quản trị (ql1, ql2...): không bị giới hạn môn, được tạo/sửa/xóa tài khoản giảng viên. */
function laGvQuanTri(PDO $pdo): bool {
    return isGV() && gvPhamViMon($pdo) === null;
}

/* Đọc và kiểm tra danh sách môn gán cho giảng viên. Trả về mảng id môn (>= 1 môn, đều tồn tại). */
function docSubjectIds(PDO $pdo, array $data): array {
    $raw = $data['subjectIds'] ?? [];
    if (!is_array($raw)) {
        jsonError(400, 'Danh sách môn phụ trách không hợp lệ.');
    }
    $ids = [];
    foreach ($raw as $id) {
        $id = trim((string) $id);
        if ($id !== '' && !in_array($id, $ids, true)) {
            $ids[] = $id;
        }
    }
    if (count($ids) === 0) {
        jsonError(400, 'Hãy chọn ít nhất 1 môn học cho giảng viên.');
    }
    $stmt = $pdo->prepare('SELECT 1 FROM subjects WHERE id = ? LIMIT 1');
    foreach ($ids as $id) {
        $stmt->execute([$id]);
        if (!$stmt->fetch()) {
            jsonError(400, 'Có môn học không tồn tại (có thể vừa bị xóa). Hãy tải lại trang rồi chọn lại.');
        }
    }
    return $ids;
}

function ghiMonChoGiangVien(PDO $pdo, string $username, array $ids): void {
    $pdo->prepare('DELETE FROM giang_vien_mon WHERE username = ?')->execute([$username]);
    $ins = $pdo->prepare('INSERT INTO giang_vien_mon (username, subject_id) VALUES (?, ?)');
    foreach ($ids as $id) {
        $ins->execute([$username, $id]);
    }
}

/* Kiểm tra dữ liệu tài khoản sinh viên. Trả về chuỗi lỗi, hoặc null nếu hợp lệ. */
function validateHoTen(string $hoTen): ?string {
    if ($hoTen === '') {
        return 'Vui lòng nhập tên sinh viên.';
    }
    if (mb_strlen($hoTen, 'UTF-8') > 100) {
        return 'Tên sinh viên tối đa 100 ký tự.';
    }
    return null;
}

function validateMaSoSv(string $maSoSv): ?string {
    if ($maSoSv === '') {
        return 'Vui lòng nhập mã số sinh viên.';
    }
    if (!preg_match('/^[A-Za-z0-9._-]{1,30}$/', $maSoSv)) {
        return 'Mã số sinh viên chỉ gồm chữ, số, dấu . _ - (tối đa 30 ký tự).';
    }
    return null;
}

if ($method === 'GET') {
    $me = currentUser();
    if ($me === null) {
        jsonError(401, 'Bạn cần đăng nhập.');
    }

    if ($me['role'] === 'gv') {
        // Giảng viên quản trị thấy cả giảng viên + sinh viên (kèm các môn mỗi giảng viên phụ trách).
        // Giảng viên theo môn chỉ thấy danh sách sinh viên. Không bao giờ trả mật khẩu.
        $locRole = laGvQuanTri($pdo) ? '' : " WHERE u.role = 'sv'";
        $rows = $pdo->query(
            'SELECT u.username, u.role, u.ho_ten, u.ma_so_sv, u.gv_gioi_han, u.lop_id, l.ten AS lop_ten
             FROM users u LEFT JOIN lop_hoc l ON l.id = u.lop_id' . $locRole . '
             ORDER BY u.role ASC, u.ma_so_sv ASC, u.username ASC'
        )->fetchAll();

        $monCua = [];
        if (laGvQuanTri($pdo)) {
            foreach ($pdo->query('SELECT username, subject_id FROM giang_vien_mon')->fetchAll() as $m) {
                $monCua[$m['username']][] = $m['subject_id'];
            }
        }
        $out = [];
        foreach ($rows as $row) {
            $item = userRow($row);
            if ($row['role'] === 'gv') {
                $item['gioiHanMon'] = (int) $row['gv_gioi_han'] === 1;
                $item['subjectIds'] = $monCua[$row['username']] ?? [];
            }
            $out[] = $item;
        }
        echo json_encode($out);
    } else {
        // SV chỉ thấy chính tài khoản của mình
        $stmt = $pdo->prepare('SELECT username, role, ho_ten, ma_so_sv FROM users WHERE username = ? LIMIT 1');
        $stmt->execute([$me['username']]);
        $row = $stmt->fetch();
        echo json_encode($row ? [userRow($row)] : []);
    }
    exit;
}

if ($method === 'POST') {
    // Mọi GV tạo được tài khoản sinh viên. Chỉ giảng viên quản trị (ql1, ql2...) mới tạo được tài khoản giảng viên.
    requireGV();

    $data = readJsonBody();
    $username = trim($data['username'] ?? '');
    $password = (string) ($data['password'] ?? '');
    $hoTen = trim((string) ($data['hoTen'] ?? ''));
    $maSoSv = trim((string) ($data['maSoSv'] ?? ''));

    $roleMoi = isset($data['role']) ? trim((string) $data['role']) : 'sv';
    if ($roleMoi !== 'sv' && $roleMoi !== 'gv') {
        jsonError(400, 'Vai trò không hợp lệ.');
    }
    if ($roleMoi === 'gv' && !laGvQuanTri($pdo)) {
        jsonError(403, 'Chỉ giảng viên quản trị mới được tạo tài khoản giảng viên.');
    }

    if ($username === '' || $password === '') {
        jsonError(400, 'Vui lòng nhập tên đăng nhập và mật khẩu.');
    }
    if (!preg_match('/^[A-Za-z0-9._@-]{3,50}$/', $username)) {
        jsonError(400, 'Tên đăng nhập chỉ gồm chữ không dấu, số, dấu . _ - @ (3-50 ký tự, không có khoảng trắng).');
    }
    if (strlen($password) > 255) {
        jsonError(400, 'Mật khẩu quá dài.');
    }
    if (($err = validateHoTen($hoTen)) !== null) {
        jsonError(400, $roleMoi === 'gv' ? 'Vui lòng nhập tên giảng viên.' : $err);
    }
    if ($roleMoi === 'sv' && ($err = validateMaSoSv($maSoSv)) !== null) {
        jsonError(400, $err);
    }

    $stmt = $pdo->prepare('SELECT 1 FROM users WHERE username = ? LIMIT 1');
    $stmt->execute([$username]);
    if ($stmt->fetch()) {
        jsonError(409, 'Tên đăng nhập đã tồn tại.');
    }

    if ($roleMoi === 'gv') {
        $subjectIds = docSubjectIds($pdo, $data);
        $pdo->beginTransaction();
        try {
            $stmt = $pdo->prepare("INSERT INTO users (username, password, role, ho_ten, ma_so_sv, gv_gioi_han) VALUES (?, ?, 'gv', ?, NULL, 1)");
            $stmt->execute([$username, $password, $hoTen]);
            ghiMonChoGiangVien($pdo, $username, $subjectIds);
            $pdo->commit();
        } catch (Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
        echo json_encode(['username' => $username, 'role' => 'gv', 'hoTen' => $hoTen, 'maSoSv' => null, 'gioiHanMon' => true, 'subjectIds' => $subjectIds]);
        exit;
    }

    $stmt = $pdo->prepare('SELECT 1 FROM users WHERE ma_so_sv = ? LIMIT 1');
    $stmt->execute([$maSoSv]);
    if ($stmt->fetch()) {
        jsonError(409, 'Mã số sinh viên đã tồn tại.');
    }

    $lopId = kiemTraLopId($pdo, $data['lopId'] ?? '');
    $stmt = $pdo->prepare("INSERT INTO users (username, password, role, ho_ten, ma_so_sv, lop_id) VALUES (?, ?, 'sv', ?, ?, ?)");
    $stmt->execute([$username, $password, $hoTen, $maSoSv, $lopId]);

    echo json_encode(['username' => $username, 'role' => 'sv', 'hoTen' => $hoTen, 'maSoSv' => $maSoSv, 'lopId' => $lopId]);
    exit;
}

if ($method === 'PUT') {
    $me = currentUser();
    $target = $_GET['username'] ?? '';

    if ($me === null) {
        jsonError(401, 'Bạn cần đăng nhập.');
    }
    if ($target === '') {
        jsonError(400, 'Thiếu thông tin.');
    }

    $stmt = $pdo->prepare('SELECT username, role, ho_ten, ma_so_sv, gv_gioi_han FROM users WHERE username = ? LIMIT 1');
    $stmt->execute([$target]);
    $targetUser = $stmt->fetch();
    if (!$targetUser) {
        jsonError(404, 'Không tìm thấy tài khoản.');
    }

    $isSelf = $me['username'] === $targetUser['username'];

    // GV: sửa được thông tin + mật khẩu của tài khoản SINH VIÊN.
    // Mọi người: tự đổi được mật khẩu của chính mình.
    // Không ai được đổi vai trò (role) qua API này - tránh nâng quyền SV lên GV.
    // Giảng viên quản trị còn sửa được tài khoản giảng viên theo môn (tên, mật khẩu, các môn phụ trách).
    $laGvTheoMon = $targetUser['role'] === 'gv' && (int) $targetUser['gv_gioi_han'] === 1;
    $canEditProfile = $me['role'] === 'gv' && ($targetUser['role'] !== 'gv' || ($laGvTheoMon && laGvQuanTri($pdo)));
    $canEditPassword = $canEditProfile || $isSelf;

    if (!$canEditPassword) {
        jsonError(403, $me['role'] === 'gv'
            ? 'Giảng viên không được sửa tài khoản giảng viên khác.'
            : 'Bạn không có quyền sửa tài khoản này.');
    }

    $data = readJsonBody();
    $sets = [];
    $params = [];

    if ($canEditProfile && array_key_exists('hoTen', $data)) {
        // Để trống = bỏ tên (hiển thị lại bằng tên đăng nhập). Tài khoản cũ chưa có tên vẫn lưu được.
        $hoTen = trim((string) $data['hoTen']);
        if ($hoTen !== '' && mb_strlen($hoTen, 'UTF-8') > 100) {
            jsonError(400, 'Tên sinh viên tối đa 100 ký tự.');
        }
        $sets[] = 'ho_ten = ?';
        $params[] = $hoTen === '' ? null : $hoTen;
    }

    if ($canEditProfile && $targetUser['role'] !== 'gv' && array_key_exists('lopId', $data)) {
        $sets[] = 'lop_id = ?';
        $params[] = kiemTraLopId($pdo, $data['lopId']);
    }

    if ($canEditProfile && $targetUser['role'] !== 'gv' && array_key_exists('maSoSv', $data)) {
        $maSoSv = trim((string) $data['maSoSv']);
        if ($maSoSv !== '') {
            if (($err = validateMaSoSv($maSoSv)) !== null) {
                jsonError(400, $err);
            }
            $stmt = $pdo->prepare('SELECT 1 FROM users WHERE ma_so_sv = ? AND username <> ? LIMIT 1');
            $stmt->execute([$maSoSv, $target]);
            if ($stmt->fetch()) {
                jsonError(409, 'Mã số sinh viên đã được dùng cho tài khoản khác.');
            }
        }
        $sets[] = 'ma_so_sv = ?';
        $params[] = $maSoSv === '' ? null : $maSoSv;
    }

    if (array_key_exists('password', $data) && (string) $data['password'] !== '') {
        $newPassword = (string) $data['password'];
        if (strlen($newPassword) > 255) {
            jsonError(400, 'Mật khẩu quá dài.');
        }
        $sets[] = 'password = ?';
        $params[] = $newPassword;
    }

    $capNhatMon = $canEditProfile && $laGvTheoMon && array_key_exists('subjectIds', $data);
    $subjectIdsMoi = $capNhatMon ? docSubjectIds($pdo, $data) : null;

    if (count($sets) === 0 && !$capNhatMon) {
        jsonError(400, 'Không có thông tin nào để cập nhật.');
    }

    $pdo->beginTransaction();
    try {
        if (count($sets) > 0) {
            $params[] = $target;
            $stmt = $pdo->prepare('UPDATE users SET ' . implode(', ', $sets) . ' WHERE username = ?');
            $stmt->execute($params);
        }
        if ($capNhatMon) {
            ghiMonChoGiangVien($pdo, $target, $subjectIdsMoi);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }

    $stmt = $pdo->prepare('SELECT u.username, u.role, u.ho_ten, u.ma_so_sv, u.lop_id, l.ten AS lop_ten FROM users u LEFT JOIN lop_hoc l ON l.id = u.lop_id WHERE u.username = ? LIMIT 1');
    $stmt->execute([$target]);
    $kq = userRow($stmt->fetch());
    if ($laGvTheoMon) {
        $kq['gioiHanMon'] = true;
        $st = $pdo->prepare('SELECT subject_id FROM giang_vien_mon WHERE username = ?');
        $st->execute([$target]);
        $kq['subjectIds'] = $st->fetchAll(PDO::FETCH_COLUMN);
    }
    echo json_encode($kq);
    exit;
}

if ($method === 'DELETE') {
    $me = currentUser();
    $target = $_GET['username'] ?? '';

    if ($me === null || $target === '') {
        http_response_code(400);
        echo json_encode(['error' => 'Thiếu thông tin.']);
        exit;
    }

    $stmt = $pdo->prepare('SELECT username, role, gv_gioi_han FROM users WHERE username = ? LIMIT 1');
    $stmt->execute([$target]);
    $targetUser = $stmt->fetch();
    if (!$targetUser) {
        http_response_code(404);
        echo json_encode(['error' => 'Không tìm thấy tài khoản.']);
        exit;
    }

    $isSelf = $me['username'] === $target;
    $allowed = false;

    if ($me['role'] === 'gv') {
        // GV không được xóa tài khoản GV khác (kể cả chính mình, để tránh mất quyền quản trị hệ thống)
        $allowed = $targetUser['role'] === 'sv'
            || ($targetUser['role'] === 'gv' && (int) $targetUser['gv_gioi_han'] === 1 && laGvQuanTri($pdo) && !$isSelf);
    } elseif ($me['role'] === 'sv' && $isSelf) {
        $allowed = true;
    }

    if (!$allowed) {
        http_response_code(403);
        echo json_encode(['error' => 'Bạn không có quyền xóa tài khoản này.']);
        exit;
    }

    // Xóa giảng viên theo môn: chuyển bài kiểm tra, giáo trình, bài tập họ đã tạo sang tài khoản quản trị đang
    // thao tác, để dữ liệu không bị mất theo (các khóa ngoại sẽ tự xóa bài kiểm tra/giáo trình của người bị xóa).
    if ($targetUser['role'] === 'gv') {
        $admin = $me['username'];
        $pdo->prepare('UPDATE bai_kiem_tra SET nguoi_tao_id = ? WHERE nguoi_tao_id = ?')->execute([$admin, $target]);
        $pdo->prepare('UPDATE giao_trinh SET created_by = ? WHERE created_by = ?')->execute([$admin, $target]);
        $pdo->prepare('UPDATE homeworks SET created_by = ? WHERE created_by = ?')->execute([$admin, $target]);
    }

    // Gỡ liên kết bài tập đã tạo bởi tài khoản này (không xóa bài tập, chỉ bỏ người tạo -
    // giống cách môn học bị xóa thì bài tập chuyển sang "Chưa phân môn")
    $pdo->prepare('UPDATE homeworks SET created_by = NULL WHERE created_by = ?')->execute([$target]);

    $stmt = $pdo->prepare('DELETE FROM users WHERE username = ?');
    $stmt->execute([$target]);

    if ($isSelf) {
        session_unset();
        session_destroy();
    }

    echo json_encode(['success' => true, 'loggedOut' => $isSelf]);
    exit;
}

http_response_code(405);
echo json_encode(['error' => 'Method không được hỗ trợ.']);
