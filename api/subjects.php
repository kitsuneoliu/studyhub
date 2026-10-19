<?php
require __DIR__ . '/config.php';

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $params = [];
    $loc = gvLocMon($pdo, 'id', $params); // giảng viên theo môn chỉ thấy môn mình phụ trách
    $stmt = $pdo->prepare('SELECT id, name, color, cho_phep_nop_bai FROM subjects WHERE 1 = 1' . $loc . ' ORDER BY created_at ASC, id ASC');
    $stmt->execute($params);
    $rows = $stmt->fetchAll();
    foreach ($rows as &$r) {
        $r['choPhepNopBai'] = (int) $r['cho_phep_nop_bai'] === 1;
        unset($r['cho_phep_nop_bai']);
    }
    unset($r);
    echo json_encode($rows);
    exit;
}

if ($method === 'POST') {
    requireGV();
    if (gvPhamViMon($pdo) !== null) {
        http_response_code(403);
        echo json_encode(['error' => 'Giảng viên theo môn không được tạo môn học mới.']);
        exit;
    }

    $data = readJsonBody();
    $name = trim($data['name'] ?? '');
    $color = trim($data['color'] ?? '') ?: 'bg-slate-400';

    if ($name === '') {
        http_response_code(400);
        echo json_encode(['error' => 'Tên môn học không được để trống.']);
        exit;
    }

    $id = genId('sub');
    $stmt = $pdo->prepare('INSERT INTO subjects (id, name, color) VALUES (?, ?, ?)');
    $stmt->execute([$id, $name, $color]);

    echo json_encode(['id' => $id, 'name' => $name, 'color' => $color, 'choPhepNopBai' => true]);
    exit;
}

if ($method === 'PUT') {
    requireGV();

    $id = $_GET['id'] ?? '';
    requireGvMon($pdo, $id);
    if ($id === '') {
        http_response_code(400);
        echo json_encode(['error' => 'Thiếu id môn học.']);
        exit;
    }

    $stmt = $pdo->prepare('SELECT id, name, color, cho_phep_nop_bai FROM subjects WHERE id = ? LIMIT 1');
    $stmt->execute([$id]);
    $existing = $stmt->fetch();
    if (!$existing) {
        http_response_code(404);
        echo json_encode(['error' => 'Không tìm thấy môn học.']);
        exit;
    }

    $data = readJsonBody();
    $name = array_key_exists('name', $data) ? trim($data['name']) : $existing['name'];
    $color = array_key_exists('color', $data) ? trim($data['color']) : $existing['color'];

    if ($name === '') {
        http_response_code(400);
        echo json_encode(['error' => 'Tên môn học không được để trống.']);
        exit;
    }

    $choPhep = array_key_exists('choPhepNopBai', $data) ? ($data['choPhepNopBai'] ? 1 : 0) : (int) $existing['cho_phep_nop_bai'];

    $stmt = $pdo->prepare('UPDATE subjects SET name = ?, color = ?, cho_phep_nop_bai = ? WHERE id = ?');
    $stmt->execute([$name, $color ?: 'bg-slate-400', $choPhep, $id]);

    echo json_encode(['id' => $id, 'name' => $name, 'color' => $color ?: 'bg-slate-400', 'choPhepNopBai' => $choPhep === 1]);
    exit;
}

if ($method === 'DELETE') {
    requireGV();
    if (gvPhamViMon($pdo) !== null) {
        http_response_code(403);
        echo json_encode(['error' => 'Giảng viên theo môn không được xóa môn học.']);
        exit;
    }

    $id = $_GET['id'] ?? '';
    if ($id === '') {
        http_response_code(400);
        echo json_encode(['error' => 'Thiếu id môn học.']);
        exit;
    }

    $stmt = $pdo->prepare('DELETE FROM subjects WHERE id = ?');
    $stmt->execute([$id]);

    echo json_encode(['success' => true]);
    exit;
}

http_response_code(405);
echo json_encode(['error' => 'Method không được hỗ trợ.']);
