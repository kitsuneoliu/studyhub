<?php
/* =====================================================================
   export_results.php: GV lấy dữ liệu kết quả của 1 bài kiểm tra để xuất
   file Excel (file .xlsx được tạo ở trình duyệt, xem exportQuizResultsExcel
   trong script.js).

   Mỗi dòng = 1 sinh viên ĐÃ NỘP bài, gồm: mã số SV, tên SV, điểm, số câu
   đúng, số câu sai, thời gian làm bài (giây), tổng số lần vi phạm.

   - Số câu đúng/sai chỉ tính câu TRẮC NGHIỆM (câu tự luận không tự chấm
     được). Câu bỏ trống tính là sai.
   - Số lần vi phạm = số dòng trong bảng cheat_log của lượt làm bài đó.
   ===================================================================== */
require __DIR__ . '/config.php';

requireGV();

$quizId = isset($_GET['id']) ? (int) $_GET['id'] : 0;

$stmtQuiz = $pdo->prepare('SELECT id, tieu_de, mon_hoc_id FROM bai_kiem_tra WHERE id = ? LIMIT 1');
$stmtQuiz->execute([$quizId]);
$quiz = $stmtQuiz->fetch();

if (!$quiz) {
    http_response_code(404);
    echo json_encode(['error' => 'Không tìm thấy bài kiểm tra.']);
    exit;
}

requireGvMon($pdo, $quiz['mon_hoc_id']);

// Đảm bảo bảng cheat_log tồn tại (DB cũ có thể chưa có) để đếm vi phạm không lỗi.
ensureCheatLogTable($pdo);

// Tổng số câu trắc nghiệm của đề.
$stmtTong = $pdo->prepare("SELECT COUNT(*) FROM cau_hoi WHERE bai_kiem_tra_id = ? AND loai_cau_hoi = 'trac_nghiem'");
$stmtTong->execute([$quizId]);
$tongTracNghiem = (int) $stmtTong->fetchColumn();

// Các lượt làm bài đã nộp + thông tin sinh viên + số lần vi phạm.
$stmtLuot = $pdo->prepare(
    "SELECT l.id, l.hoc_sinh_id, l.diem_so, l.thoi_gian_bat_dau, l.thoi_gian_nop,
            u.ho_ten, u.ma_so_sv,
            (SELECT COUNT(*) FROM cheat_log cl WHERE cl.luot_lam_bai_id = l.id) AS so_vi_pham
     FROM luot_lam_bai l
     LEFT JOIN users u ON u.username = l.hoc_sinh_id
     WHERE l.bai_kiem_tra_id = ? AND l.trang_thai = 'da_nop'
     ORDER BY u.ma_so_sv ASC, l.hoc_sinh_id ASC"
);
$stmtLuot->execute([$quizId]);
$luotList = $stmtLuot->fetchAll();

// Đếm số câu trắc nghiệm đúng của từng lượt (so sánh y hệt cách chấm điểm
// trong finalizeLuotLamBai: so sánh chuỗi chính xác với đáp án đúng).
$stmtDapAn = $pdo->prepare(
    "SELECT d.luot_lam_bai_id, d.cau_tra_loi, c.dapan_dung
     FROM chi_tiet_bai_lam d
     JOIN cau_hoi c ON c.id = d.cau_hoi_id
     JOIN luot_lam_bai l ON l.id = d.luot_lam_bai_id
     WHERE l.bai_kiem_tra_id = ? AND l.trang_thai = 'da_nop' AND c.loai_cau_hoi = 'trac_nghiem'"
);
$stmtDapAn->execute([$quizId]);

$soDungTheoLuot = [];
foreach ($stmtDapAn->fetchAll() as $r) {
    $luotId = (int) $r['luot_lam_bai_id'];
    if (!isset($soDungTheoLuot[$luotId])) {
        $soDungTheoLuot[$luotId] = 0;
    }
    if (laCauTraLoiDung($r['cau_tra_loi'], $r['dapan_dung'])) {
        $soDungTheoLuot[$luotId]++;
    }
}

$rows = [];
foreach ($luotList as $l) {
    $luotId = (int) $l['id'];
    $soDung = $soDungTheoLuot[$luotId] ?? 0;

    $thoiGianGiay = null;
    if (!empty($l['thoi_gian_bat_dau']) && !empty($l['thoi_gian_nop'])) {
        $bd = strtotime($l['thoi_gian_bat_dau']);
        $nop = strtotime($l['thoi_gian_nop']);
        if ($bd !== false && $nop !== false) {
            $thoiGianGiay = max(0, $nop - $bd);
        }
    }

    $rows[] = [
        'maSoSv' => (string) ($l['ma_so_sv'] ?? ''),
        'hoTen' => (($l['ho_ten'] ?? '') !== '') ? $l['ho_ten'] : $l['hoc_sinh_id'],
        'username' => $l['hoc_sinh_id'],
        'diem' => $l['diem_so'] !== null ? (float) $l['diem_so'] : 0,
        'soDung' => $soDung,
        'soSai' => max(0, $tongTracNghiem - $soDung),
        'thoiGianGiay' => $thoiGianGiay,
        'soViPham' => (int) $l['so_vi_pham'],
    ];
}

echo json_encode([
    'quiz' => ['id' => (int) $quiz['id'], 'title' => $quiz['tieu_de']],
    'tongTracNghiem' => $tongTracNghiem,
    'rows' => $rows,
], JSON_UNESCAPED_UNICODE);
