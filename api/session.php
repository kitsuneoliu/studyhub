<?php
require __DIR__ . '/config.php';

$user = currentUser();

if ($user) {
    $stmt = $pdo->prepare('SELECT ho_ten, ma_so_sv, gv_gioi_han FROM users WHERE username = ? LIMIT 1');
    $stmt->execute([$user['username']]);
    $info = $stmt->fetch() ?: ['ho_ten' => null, 'ma_so_sv' => null, 'gv_gioi_han' => 0];

    echo json_encode([
        'loggedIn' => true,
        'username' => $user['username'],
        'role' => $user['role'],
        'displayName' => ($info['ho_ten'] !== null && $info['ho_ten'] !== '') ? $info['ho_ten'] : $user['username'],
        'maSoSv' => $info['ma_so_sv'],
        'gioiHanMon' => $user['role'] === 'gv' && (int) $info['gv_gioi_han'] === 1,
    ]);
} else {
    echo json_encode(['loggedIn' => false]);
}
