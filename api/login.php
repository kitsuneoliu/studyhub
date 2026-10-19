<?php
require __DIR__ . '/config.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method không được hỗ trợ.']);
    exit;
}

$data = readJsonBody();
$username = trim($data['username'] ?? '');
$password = (string) ($data['password'] ?? '');

if ($username === '' || $password === '') {
    http_response_code(400);
    echo json_encode(['success' => false, 'message' => 'Vui lòng nhập tài khoản và mật khẩu.']);
    exit;
}

$stmt = $pdo->prepare('SELECT username, password, role, ho_ten, ma_so_sv, gv_gioi_han FROM users WHERE username = ? LIMIT 1');
$stmt->execute([$username]);
$user = $stmt->fetch();

if (!$user || !hash_equals((string) $user['password'], $password)) {
    http_response_code(401);
    echo json_encode(['success' => false, 'message' => 'Sai tài khoản hoặc mật khẩu.']);
    exit;
}

session_regenerate_id(true);
$_SESSION['username'] = $user['username'];
$_SESSION['role'] = $user['role'];

echo json_encode([
    'success' => true,
    'username' => $user['username'],
    'role' => $user['role'],
    'displayName' => ($user['ho_ten'] !== null && $user['ho_ten'] !== '') ? $user['ho_ten'] : $user['username'],
    'maSoSv' => $user['ma_so_sv'],
    'gioiHanMon' => $user['role'] === 'gv' && (int) $user['gv_gioi_han'] === 1,
]);
