<?php
require __DIR__ . '/config.php';

$method = $_SERVER['REQUEST_METHOD'];
$me = currentUser();

if ($me === null) {
    http_response_code(401);
    echo json_encode(['error' => 'Unauthorized']);
    exit;
}

$username = $me['username'];
$role = $me['role'];

try {
    ensureCheatLogTable($pdo);
} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['error' => 'Không thể khởi tạo bảng nhật ký gian lận. Vui lòng chạy lại file schema.sql trên database.']);
    exit;
}

if ($method === 'POST' && $role === 'sv') {
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) {
        $body = [];
    }

    $items = isset($body['items']) && is_array($body['items']) ? $body['items'] : [$body];

    // Chỉ ghi nhận khi bài kiểm tra đang BẬT chống gian lận
    $stmtCheck = $pdo->prepare('SELECT l.id FROM luot_lam_bai l JOIN bai_kiem_tra b ON b.id = l.bai_kiem_tra_id WHERE l.id = ? AND l.hoc_sinh_id = ? AND b.chong_gian_lan = 1 LIMIT 1');
    $stmtInsert = $pdo->prepare(
        'INSERT INTO cheat_log (luot_lam_bai_id, hoc_sinh_id, loai_vi_pham, thoi_gian_bat_dau, thoi_gian_ket_thuc, tong_thoi_gian_vang_mat)
         VALUES (?, ?, ?, ?, ?, ?)'
    );

    $inserted = 0;
    foreach ($items as $item) {
        $luotLamBaiId = isset($item['luotLamBaiId']) ? (int) $item['luotLamBaiId'] : 0;
        $loaiViPham = isset($item['loaiViPham']) ? trim((string) $item['loaiViPham']) : '';
        $batDauMs = isset($item['thoiGianBatDau']) ? (int) $item['thoiGianBatDau'] : 0;
        $ketThucMs = isset($item['thoiGianKetThuc']) ? (int) $item['thoiGianKetThuc'] : 0;
        $tongGiay = isset($item['tongThoiGianVangMat']) ? (int) $item['tongThoiGianVangMat'] : 0;

        if ($luotLamBaiId <= 0 || $loaiViPham === '' || $batDauMs <= 0 || $ketThucMs <= 0) {
            continue;
        }

        $stmtCheck->execute([$luotLamBaiId, $username]);
        if (!$stmtCheck->fetch()) {
            continue;
        }

        $stmtInsert->execute([
            $luotLamBaiId,
            $username,
            $loaiViPham,
            date('Y-m-d H:i:s', (int) ($batDauMs / 1000)),
            date('Y-m-d H:i:s', (int) ($ketThucMs / 1000)),
            $tongGiay,
        ]);
        $inserted++;
    }

    echo json_encode(['success' => true, 'inserted' => $inserted]);
    exit;
}

if ($method === 'GET' && $role === 'gv') {
    $quizId = isset($_GET['bai_kiem_tra_id']) ? (int) $_GET['bai_kiem_tra_id'] : 0;

    $sql = 'SELECT cl.id, cl.hoc_sinh_id, cl.loai_vi_pham, cl.thoi_gian_bat_dau, cl.thoi_gian_ket_thuc, cl.tong_thoi_gian_vang_mat,
                   l.bai_kiem_tra_id, b.tieu_de, u.ho_ten, u.ma_so_sv
            FROM cheat_log cl
            JOIN luot_lam_bai l ON l.id = cl.luot_lam_bai_id
            JOIN bai_kiem_tra b ON b.id = l.bai_kiem_tra_id
            LEFT JOIN users u ON u.username = cl.hoc_sinh_id
            WHERE 1 = 1';
    $params = [];
    if ($quizId > 0) {
        $sql .= ' AND l.bai_kiem_tra_id = ?';
        $params[] = $quizId;
    }
    $sql .= gvLocMon($pdo, 'b.mon_hoc_id', $params); // chỉ thấy vi phạm của bài kiểm tra thuộc môn mình
    $sql .= ' ORDER BY cl.created_at DESC';

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);

    echo json_encode(['items' => $stmt->fetchAll()]);
    exit;
}

http_response_code(403);
echo json_encode(['error' => 'Không có quyền thực hiện thao tác này.']);
