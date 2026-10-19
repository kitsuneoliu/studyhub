<?php
// Công cụ chẩn đoán phân quyền theo môn. Mở khi đã đăng nhập bằng tài khoản giảng viên:
//   http://localhost/<thư mục dự án>/api/kiem_tra_phan_quyen.php
// Cho biết: tài khoản hiện tại có bị giới hạn môn không, các môn nào, và các file API trên server
// đã có bản mới (có kiểm tra phạm vi môn) hay vẫn là bản cũ.
require __DIR__ . '/config.php';
requireGV();

$u = currentUser();
$pv = gvPhamViMon($pdo);

$tenMon = [];
if ($pv) {
    $in = implode(',', array_fill(0, count($pv), '?'));
    $st = $pdo->prepare("SELECT id, name FROM subjects WHERE id IN ($in)");
    $st->execute($pv);
    $tenMon = $st->fetchAll();
}

$filesCanCo = [
    'subjects.php' => 'gvLocMon', 'homeworks.php' => 'gvLocMon', 'curriculum.php' => 'gvLocMon',
    'submissions.php' => 'gvLocMon', 'cheat_log.php' => 'gvLocMon', 'quizzes.php' => 'gvPhamViMon',
    'export_results.php' => 'requireGvMon', 'thong_ke.php' => 'gvCoQuyenMon', 'users.php' => 'laGvQuanTri',
    'homework_files.php' => 'requireGvMon',
];
$apiFiles = [];
foreach ($filesCanCo as $file => $marker) {
    $code = @file_get_contents(__DIR__ . '/' . $file);
    $apiFiles[$file] = $code !== false && strpos($code, $marker) !== false ? 'MỚI (có phân quyền theo môn)' : 'CŨ hoặc thiếu - hãy chép đè lại file này';
}
$soMonThayDuoc = (int) $pdo->query('SELECT COUNT(*) FROM subjects')->fetchColumn();

echo json_encode([
    'taiKhoan' => $u['username'],
    'biGioiHanTheoMon' => $pv !== null,
    'monDuocPhepXem' => $pv === null ? 'tất cả (giảng viên quản trị)' : $tenMon,
    'tongSoMonTrongCSDL' => $soMonThayDuoc,
    'trangThaiFileApi' => $apiFiles,
], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
