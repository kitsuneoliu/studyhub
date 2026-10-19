<?php
require __DIR__ . '/api/config.php';
header('Content-Type: text/html; charset=utf-8');

$me = currentUser();
if ($me === null || $me['role'] !== 'gv') {
    http_response_code(403);
    echo 'Bạn không có quyền truy cập trang này.';
    exit;
}

$quizId = isset($_GET['bai_kiem_tra_id']) ? (int) $_GET['bai_kiem_tra_id'] : 0;

$sql = 'SELECT cl.id, cl.hoc_sinh_id, cl.loai_vi_pham, cl.thoi_gian_bat_dau, cl.thoi_gian_ket_thuc, cl.tong_thoi_gian_vang_mat,
               b.tieu_de, u.ho_ten, u.ma_so_sv
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
$sql .= gvLocMon($pdo, 'b.mon_hoc_id', $params); // giảng viên theo môn chỉ thấy bài kiểm tra môn mình
$sql .= ' ORDER BY cl.created_at DESC';

$stmt = $pdo->prepare($sql);
$stmt->execute($params);
$rows = $stmt->fetchAll();

$paramsQuizzes = [];
$locQuizzes = gvLocMon($pdo, 'mon_hoc_id', $paramsQuizzes);
$stmtQuizzes = $pdo->prepare('SELECT id, tieu_de FROM bai_kiem_tra WHERE 1 = 1' . $locQuizzes . ' ORDER BY created_at DESC');
$stmtQuizzes->execute($paramsQuizzes);
$quizzes = $stmtQuizzes->fetchAll();

function formatThoiGianVangMat($giay) {
    $phut = intdiv($giay, 60);
    $conLai = $giay % 60;
    return sprintf('%02d:%02d', $phut, $conLai);
}
?>
<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<title>Giám sát gian lận</title>
<link rel="stylesheet" href="style.css">
<style>
body { background: #0f172a; color: #e2e8f0; font-family: sans-serif; padding: 24px; }
table { width: 100%; border-collapse: collapse; margin-top: 16px; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #334155; font-size: 14px; }
th { color: #94a3b8; font-weight: 600; }
select { background: #1e293b; color: #e2e8f0; border: 1px solid #334155; border-radius: 8px; padding: 6px 10px; }
.badge { display: inline-block; padding: 2px 10px; border-radius: 999px; background: #7f1d1d; color: #fecaca; font-size: 12px; }
</style>
</head>
<body>
<h2>Giám sát gian lận</h2>
<form method="get">
<label>Lọc theo bài kiểm tra</label>
<select name="bai_kiem_tra_id" onchange="this.form.submit()">
<option value="0">Tất cả bài kiểm tra</option>
<?php foreach ($quizzes as $q) { ?>
<option value="<?php echo (int) $q['id']; ?>" <?php echo $quizId === (int) $q['id'] ? 'selected' : ''; ?>><?php echo htmlspecialchars($q['tieu_de']); ?></option>
<?php } ?>
</select>
</form>
<table>
<thead>
<tr>
<th>Mã số SV</th>
<th>Tên sinh viên</th>
<th>Bài kiểm tra</th>
<th>Loại vi phạm</th>
<th>Thời điểm bắt đầu</th>
<th>Thời điểm kết thúc</th>
<th>Tổng thời gian vắng mặt</th>
</tr>
</thead>
<tbody>
<?php if (count($rows) === 0) { ?>
<tr><td colspan="7">Chưa có vi phạm nào được ghi nhận.</td></tr>
<?php } ?>
<?php foreach ($rows as $row) { ?>
<tr>
<td><?php echo htmlspecialchars((string) ($row['ma_so_sv'] ?? '')); ?></td>
<td><?php echo htmlspecialchars(($row['ho_ten'] ?? '') !== '' ? $row['ho_ten'] : $row['hoc_sinh_id']); ?></td>
<td><?php echo htmlspecialchars($row['tieu_de']); ?></td>
<td><span class="badge"><?php echo htmlspecialchars($row['loai_vi_pham']); ?></span></td>
<td><?php echo htmlspecialchars($row['thoi_gian_bat_dau']); ?></td>
<td><?php echo htmlspecialchars($row['thoi_gian_ket_thuc']); ?></td>
<td><?php echo formatThoiGianVangMat((int) $row['tong_thoi_gian_vang_mat']); ?></td>
</tr>
<?php } ?>
</tbody>
</table>
</body>
</html>
