<?php
require __DIR__ . '/config.php';
require_once __DIR__ . '/xml_helper.php'; // XML ngầm: lưu bài làm, XSD, XPath
header('Content-Type: text/xml; charset=UTF-8');

$action = $_GET['action'] ?? '';
$xml = new DOMDocument('1.0', 'UTF-8');
$xml->formatOutput = true;

$me = currentUser();
if ($me === null) {
    $root = $xml->createElement('Response');
    $root->appendChild($xml->createElement('Status', 'Error'));
    $root->appendChild($xml->createElement('Message', 'Unauthorized'));
    $xml->appendChild($root);
    echo $xml->saveXML();
    exit;
}

$username = $me['username'];
$role = $me['role']; // 'gv' (giảng viên) hoặc 'sv' (sinh viên)

function errorResponse(DOMDocument $xml, string $message) {
    $root = $xml->createElement('Response');
    $root->appendChild($xml->createElement('Status', 'Error'));
    $root->appendChild($xml->createElement('Message', htmlspecialchars($message)));
    $xml->appendChild($root);
    echo $xml->saveXML();
    exit;
}

function successResponse(DOMDocument $xml, array $extra = []) {
    $root = $xml->createElement('Response');
    $root->appendChild($xml->createElement('Status', 'Success'));
    foreach ($extra as $tag => $value) {
        $root->appendChild($xml->createElement($tag, htmlspecialchars((string) $value)));
    }
    $xml->appendChild($root);
    echo $xml->saveXML();
    exit;
}

function isBanned(PDO $pdo, int $quizId, string $username): bool {
    $stmt = $pdo->prepare('SELECT 1 FROM cam_thi WHERE bai_kiem_tra_id = ? AND hoc_sinh_id = ? LIMIT 1');
    $stmt->execute([$quizId, $username]);
    return (bool) $stmt->fetch();
}

function finalizeLuotLamBai(PDO $pdo, int $luotLamBaiId): float {
    $stmt = $pdo->prepare(
        'SELECT c.dapan_dung, c.loai_cau_hoi, c.diem, d.cau_tra_loi
         FROM chi_tiet_bai_lam d
         JOIN cau_hoi c ON c.id = d.cau_hoi_id
         WHERE d.luot_lam_bai_id = ?'
    );
    $stmt->execute([$luotLamBaiId]);

    $diemSo = 0;
    foreach ($stmt->fetchAll() as $row) {
        if ($row['loai_cau_hoi'] === 'trac_nghiem' && laCauTraLoiDung($row['cau_tra_loi'], $row['dapan_dung'])) {
            $diemSo += (float) $row['diem'];
        }
    }
    $diemSo = round($diemSo, 2);

    $thoiGianNop = date('Y-m-d H:i:s');
    $stmtUpdate = $pdo->prepare('UPDATE luot_lam_bai SET thoi_gian_nop = ?, diem_so = ?, trang_thai = ? WHERE id = ?');
    $stmtUpdate->execute([$thoiGianNop, $diemSo, 'da_nop', $luotLamBaiId]);

    // Ghi ngầm bản lưu XML của bài làm (kiểm tra XSD trước khi ghi).
    // Hàm này không ném lỗi: nếu XML hỏng thì chỉ ghi log, bài nộp vẫn thành công.
    xmlLuuBaiLam($pdo, $luotLamBaiId);

    return $diemSo;
}

/* Điểm TỰ CHẤM (chỉ câu trắc nghiệm) của 1 lượt làm bài, không ghi vào CSDL.
   Dùng khi giảng viên xóa điểm chấm tay để quay về điểm tự động. */
function tinhDiemTuDong(PDO $pdo, int $luotLamBaiId): float {
    $stmt = $pdo->prepare(
        'SELECT c.dapan_dung, c.loai_cau_hoi, c.diem, d.cau_tra_loi
         FROM chi_tiet_bai_lam d
         JOIN cau_hoi c ON c.id = d.cau_hoi_id
         WHERE d.luot_lam_bai_id = ?'
    );
    $stmt->execute([$luotLamBaiId]);
    $diemSo = 0;
    foreach ($stmt->fetchAll() as $row) {
        if ($row['loai_cau_hoi'] === 'trac_nghiem' && laCauTraLoiDung($row['cau_tra_loi'], $row['dapan_dung'])) {
            $diemSo += (float) $row['diem'];
        }
    }
    return round($diemSo, 2);
}

/* Danh sách đúng/sai từng câu trắc nghiệm của 1 lượt làm bài - dùng để hiển
   thị ô xem lại kết quả cho sinh viên ngay sau khi nộp bài. Câu tự luận
   không tự chấm được nên không đưa vào (GV chấm tay sau). */
function getKetQuaTungCauHoi(PDO $pdo, int $luotLamBaiId): array {
    $stmt = $pdo->prepare(
        'SELECT c.id AS cau_hoi_id, c.loai_cau_hoi, c.dapan_dung, d.cau_tra_loi
         FROM chi_tiet_bai_lam d
         JOIN cau_hoi c ON c.id = d.cau_hoi_id
         WHERE d.luot_lam_bai_id = ?'
    );
    $stmt->execute([$luotLamBaiId]);

    $ketQua = [];
    foreach ($stmt->fetchAll() as $row) {
        if ($row['loai_cau_hoi'] !== 'trac_nghiem') {
            continue;
        }
        $ketQua[] = [
            'cau_hoi_id' => (int) $row['cau_hoi_id'],
            'dung' => laCauTraLoiDung($row['cau_tra_loi'], $row['dapan_dung']) ? 1 : 0,
            'daLam' => trim((string) $row['cau_tra_loi']) !== '' ? 1 : 0,
            'dapan_dung' => (string) $row['dapan_dung'],
        ];
    }
    return $ketQua;
}

/* Số giây GV cấu hình để hiển thị ô xem lại kết quả cho 1 bài kiểm tra.
   0 = vô hạn (chỉ tắt khi sinh viên tự đóng). */
function getThoiGianHienThiKetQua(PDO $pdo, int $quizId): int {
    $stmt = $pdo->prepare('SELECT thoi_gian_hien_thi_ket_qua FROM bai_kiem_tra WHERE id = ? LIMIT 1');
    $stmt->execute([$quizId]);
    $val = $stmt->fetchColumn();
    return $val !== false ? (int) $val : 5;
}

/* =====================================================================
   list: Danh sách bài kiểm tra theo môn học.
   ===================================================================== */
/* =====================================================================
   GIẢNG VIÊN THEO MÔN: chỉ được thao tác trên bài kiểm tra thuộc môn mình phụ trách.
   (Giảng viên quản trị như ql1/ql2 và sinh viên không bị giới hạn ở đây.)
   ===================================================================== */
if ($role === 'gv' && gvPhamViMon($pdo) !== null) {
    $tuQuiz = function ($quizId) use ($pdo) {
        $st = $pdo->prepare('SELECT mon_hoc_id FROM bai_kiem_tra WHERE id = ? LIMIT 1');
        $st->execute([(int) $quizId]);
        $v = $st->fetchColumn();
        return $v === false ? null : (string) $v;
    };
    $tuLuot = function ($luotId) use ($pdo) {
        $st = $pdo->prepare('SELECT b.mon_hoc_id FROM luot_lam_bai l JOIN bai_kiem_tra b ON b.id = l.bai_kiem_tra_id WHERE l.id = ? LIMIT 1');
        $st->execute([(int) $luotId]);
        $v = $st->fetchColumn();
        return $v === false ? null : (string) $v;
    };

    $monKiemTra = null; // null = không tìm thấy -> để handler tự báo "không tìm thấy"
    if ($action === 'list') {
        $monKiemTra = trim($_GET['mon_hoc_id'] ?? '');
    } elseif ($action === 'create') {
        $dTam = new DOMDocument();
        $monKiemTra = '';
        if (@$dTam->loadXML(file_get_contents('php://input'))) {
            $n = $dTam->getElementsByTagName('MonHocId')->item(0);
            $monKiemTra = $n ? trim($n->nodeValue) : '';
        }
    } elseif ($action === 'edit_save') {
        $dTam = new DOMDocument();
        if (@$dTam->loadXML(file_get_contents('php://input'))) {
            $n = $dTam->getElementsByTagName('QuizId')->item(0);
            $monKiemTra = $n ? $tuQuiz($n->nodeValue) : null;
        }
    } elseif (in_array($action, ['chi_tiet', 'cham_diem', 'reset_attempt', 'reopen_attempt'], true)) {
        $monKiemTra = $tuLuot($_GET['luot_id'] ?? 0);
    } elseif (in_array($action, ['results', 'toggle_visibility', 'toggle_open', 'toggle_ban', 'edit_get', 'delete'], true)) {
        $monKiemTra = $tuQuiz($_GET['id'] ?? 0);
    }

    if ($monKiemTra !== null && !gvCoQuyenMon($pdo, $monKiemTra)) {
        errorResponse($xml, 'Bạn chỉ được thao tác trên bài kiểm tra của môn học mà bạn phụ trách.');
    }
}

if ($action === 'list') {
    $monHocId = trim($_GET['mon_hoc_id'] ?? '');

    $stmtSoCauHoi = $pdo->prepare('SELECT COUNT(*) FROM cau_hoi WHERE bai_kiem_tra_id = ?');
    $stmtMyAttempt = $pdo->prepare('SELECT id, trang_thai, diem_so FROM luot_lam_bai WHERE bai_kiem_tra_id = ? AND hoc_sinh_id = ? LIMIT 1');
    $stmtSoLuotNop = $pdo->prepare("SELECT COUNT(*) FROM luot_lam_bai WHERE bai_kiem_tra_id = ? AND trang_thai = 'da_nop'");
    $stmtBanned = $pdo->prepare('SELECT 1 FROM cam_thi WHERE bai_kiem_tra_id = ? AND hoc_sinh_id = ? LIMIT 1');

    if ($role === 'sv') {
        // SV chỉ thấy các bài kiểm tra đang được GV bật "hiện đề".
        $stmt = $pdo->prepare('SELECT * FROM bai_kiem_tra WHERE mon_hoc_id = ? AND hien_thi = 1 ORDER BY created_at DESC, id DESC');
    } else {
        // GV thấy tất cả (kể cả đang ẩn) để còn quản lý.
        $stmt = $pdo->prepare('SELECT * FROM bai_kiem_tra WHERE mon_hoc_id = ? ORDER BY created_at DESC, id DESC');
    }
    $stmt->execute([$monHocId]);
    $quizzes = $stmt->fetchAll();

    $root = $xml->createElement('DanhSachBaiKiemTra');
    foreach ($quizzes as $row) {
        $bkt = $xml->createElement('BaiKiemTra');
        $bkt->setAttribute('id', (string) $row['id']);
        $bkt->appendChild($xml->createElement('TieuDe', htmlspecialchars($row['tieu_de'])));
        $bkt->appendChild($xml->createElement('MoTa', htmlspecialchars((string) $row['mo_ta'])));
        $bkt->appendChild($xml->createElement('ThoiGianLamBai', (string) $row['thoi_gian_lam_bai']));
        $bkt->appendChild($xml->createElement('ThoiGianHienThiKetQua', (string) (int) $row['thoi_gian_hien_thi_ket_qua']));
        $bkt->appendChild($xml->createElement('HienThi', (string) (int) $row['hien_thi']));
        $bkt->appendChild($xml->createElement('ChoPhepLamBai', (string) (int) $row['cho_phep_lam_bai']));
        $bkt->appendChild($xml->createElement('ChongGianLan', (string) (int) ($row['chong_gian_lan'] ?? 1)));

        $stmtSoCauHoi->execute([$row['id']]);
        $bkt->appendChild($xml->createElement('SoCauHoi', (string) $stmtSoCauHoi->fetchColumn()));

        if ($role === 'sv') {
            $stmtBanned->execute([$row['id'], $username]);
            $banned = (bool) $stmtBanned->fetch();
            $bkt->appendChild($xml->createElement('BiCam', $banned ? '1' : '0'));

            $stmtMyAttempt->execute([$row['id'], $username]);
            $attempt = $stmtMyAttempt->fetch();
            if ($attempt) {
                $bkt->appendChild($xml->createElement('TrangThaiLamBai', $attempt['trang_thai']));
                if ($attempt['trang_thai'] === 'da_nop') {
                    $bkt->appendChild($xml->createElement('DiemSo', (string) $attempt['diem_so']));
                }
            } else {
                $bkt->appendChild($xml->createElement('TrangThaiLamBai', 'chua_lam'));
            }
        } elseif ($role === 'gv') {
            $stmtSoLuotNop->execute([$row['id']]);
            $bkt->appendChild($xml->createElement('SoLuotNop', (string) $stmtSoLuotNop->fetchColumn()));
        }

        $root->appendChild($bkt);
    }
    $xml->appendChild($root);
    echo $xml->saveXML();
    exit;
}

/* =====================================================================
   trang_thai: Kiểm tra nhanh (SV) xem có bị cấm / bị đóng làm bài giữa
   chừng hay không - dùng để client tự động nộp bài ngay lập tức.
   ===================================================================== */
if ($action === 'trang_thai' && $role === 'sv') {
    $quizId = isset($_GET['id']) ? (int) $_GET['id'] : 0;

    $stmtQuiz = $pdo->prepare('SELECT hien_thi, cho_phep_lam_bai, chong_gian_lan FROM bai_kiem_tra WHERE id = ? LIMIT 1');
    $stmtQuiz->execute([$quizId]);
    $quiz = $stmtQuiz->fetch();

    if (!$quiz) {
        errorResponse($xml, 'Không tìm thấy bài kiểm tra.');
    }

    $banned = isBanned($pdo, $quizId, $username);

    $stmtAttempt = $pdo->prepare('SELECT trang_thai FROM luot_lam_bai WHERE bai_kiem_tra_id = ? AND hoc_sinh_id = ? LIMIT 1');
    $stmtAttempt->execute([$quizId, $username]);
    $attempt = $stmtAttempt->fetch();
    $daNop = $attempt && $attempt['trang_thai'] === 'da_nop';

    $root = $xml->createElement('TrangThaiLamBai');
    $root->appendChild($xml->createElement('BiCam', $banned ? '1' : '0'));
    $root->appendChild($xml->createElement('ChoPhepLamBai', (string) (int) $quiz['cho_phep_lam_bai']));
    $root->appendChild($xml->createElement('HienThi', (string) (int) $quiz['hien_thi']));
    $root->appendChild($xml->createElement('DaNop', $daNop ? '1' : '0'));
    $root->appendChild($xml->createElement('ChongGianLan', (string) (int) $quiz['chong_gian_lan']));
    $xml->appendChild($root);
    echo $xml->saveXML();
    exit;
}

/* =====================================================================
   get: SV bắt đầu / tiếp tục làm bài.
   ===================================================================== */
if ($action === 'get' && $role === 'sv') {    $quizId = isset($_GET['id']) ? (int) $_GET['id'] : 0;

    $stmtQuiz = $pdo->prepare('SELECT * FROM bai_kiem_tra WHERE id = ? LIMIT 1');
    $stmtQuiz->execute([$quizId]);
    $quiz = $stmtQuiz->fetch();

    if (!$quiz) {
        errorResponse($xml, 'Không tìm thấy bài kiểm tra.');
    }
    if (isBanned($pdo, $quizId, $username)) {
        errorResponse($xml, 'Bạn đã bị cấm thi bài kiểm tra này.');
    }
    if ((int) $quiz['hien_thi'] !== 1) {
        errorResponse($xml, 'Bài kiểm tra hiện không hiển thị.');
    }
    if ((int) $quiz['cho_phep_lam_bai'] !== 1) {
        errorResponse($xml, 'Giáo viên chưa mở cho phép làm bài này.');
    }

    $stmtCheck = $pdo->prepare('SELECT id, thoi_gian_bat_dau, trang_thai FROM luot_lam_bai WHERE bai_kiem_tra_id = ? AND hoc_sinh_id = ? LIMIT 1');
    $stmtCheck->execute([$quizId, $username]);
    $luotLamBai = $stmtCheck->fetch();

    if ($luotLamBai && $luotLamBai['trang_thai'] === 'da_nop') {
        errorResponse($xml, 'Bạn đã nộp bài kiểm tra này rồi.');
    }

    if (!$luotLamBai) {
        $startTime = date('Y-m-d H:i:s');
        $stmtInsert = $pdo->prepare('INSERT INTO luot_lam_bai (bai_kiem_tra_id, hoc_sinh_id, thoi_gian_bat_dau, trang_thai) VALUES (?, ?, ?, ?)');
        $stmtInsert->execute([$quizId, $username, $startTime, 'dang_lam']);
        $luotLamBaiId = (int) $pdo->lastInsertId();
    } else {
        $luotLamBaiId = (int) $luotLamBai['id'];
        $startTime = $luotLamBai['thoi_gian_bat_dau'];
    }

    // Tính thời gian còn lại HOÀN TOÀN ở phía server để tránh lệch múi giờ
    // / đồng hồ giữa trình duyệt và server (nguyên nhân gây tự nộp bài ngay
    // cả khi thời gian chưa hết).
    $daTroiQuaGiay = time() - strtotime($startTime);
    $tongThoiGianGiay = ((int) $quiz['thoi_gian_lam_bai']) * 60;
    $conLaiGiay = max(0, $tongThoiGianGiay - $daTroiQuaGiay);

    if ($conLaiGiay <= 0) {
        // Hết giờ ngay từ trước khi vào -> đánh dấu nộp bài trắng, không cho làm tiếp.
        $stmtAuto = $pdo->prepare("UPDATE luot_lam_bai SET thoi_gian_nop = ?, diem_so = COALESCE(diem_so, 0), trang_thai = 'da_nop' WHERE id = ? AND trang_thai = 'dang_lam'");
        $stmtAuto->execute([date('Y-m-d H:i:s'), $luotLamBaiId]);
        errorResponse($xml, 'Đã hết thời gian làm bài kiểm tra này.');
    }

    $root = $xml->createElement('BaiKiemTra');
    $root->setAttribute('id', (string) $quiz['id']);
    $root->appendChild($xml->createElement('TieuDe', htmlspecialchars($quiz['tieu_de'])));

    $thoiGianNode = $xml->createElement('ThoiGianLamBai', (string) $quiz['thoi_gian_lam_bai']);
    $thoiGianNode->setAttribute('unit', 'minutes');
    $root->appendChild($thoiGianNode);

    $root->appendChild($xml->createElement('ThoiGianConLai', (string) $conLaiGiay));
    $root->appendChild($xml->createElement('ThoiGianHienThiKetQua', (string) (int) $quiz['thoi_gian_hien_thi_ket_qua']));
    $root->appendChild($xml->createElement('MonHocId', htmlspecialchars($quiz['mon_hoc_id'])));
    $root->appendChild($xml->createElement('ChongGianLan', (string) (int) ($quiz['chong_gian_lan'] ?? 1)));
    $root->appendChild($xml->createElement('LuotLamBaiId', (string) $luotLamBaiId));

    $dsCauHoi = $xml->createElement('DanhSachCauHoi');
    $stmtCauHoi = $pdo->prepare('SELECT * FROM cau_hoi WHERE bai_kiem_tra_id = ?');
    $stmtCauHoi->execute([$quizId]);

    // Nạp lại các câu trả lời đã lưu trước đó (nếu có) - áp dụng khi sinh
    // viên tải lại trang giữa chừng, hoặc khi GV "Mở lại" một lượt đã nộp
    // mà vẫn giữ nguyên đáp án cũ.
    $stmtTraLoiCu = $pdo->prepare('SELECT cau_hoi_id, cau_tra_loi FROM chi_tiet_bai_lam WHERE luot_lam_bai_id = ?');
    $stmtTraLoiCu->execute([$luotLamBaiId]);
    $traLoiCuMap = [];
    foreach ($stmtTraLoiCu->fetchAll() as $tl) {
        $traLoiCuMap[(int) $tl['cau_hoi_id']] = $tl['cau_tra_loi'];
    }

    while ($cauHoi = $stmtCauHoi->fetch()) {
        $ch = $xml->createElement('CauHoi');
        $ch->setAttribute('id', (string) $cauHoi['id']);
        $ch->setAttribute('loai', $cauHoi['loai_cau_hoi']);
        $ch->appendChild($xml->createElement('NoiDung', htmlspecialchars($cauHoi['noi_dung'])));

        if ($cauHoi['loai_cau_hoi'] === 'trac_nghiem') {
            $ch->appendChild($xml->createElement('DapAnA', htmlspecialchars((string) $cauHoi['dapan_a'])));
            $ch->appendChild($xml->createElement('DapAnB', htmlspecialchars((string) $cauHoi['dapan_b'])));
            $ch->appendChild($xml->createElement('DapAnC', htmlspecialchars((string) $cauHoi['dapan_c'])));
            $ch->appendChild($xml->createElement('DapAnD', htmlspecialchars((string) $cauHoi['dapan_d'])));
        }
        $ch->appendChild($xml->createElement('Diem', (string) $cauHoi['diem']));

        if (isset($traLoiCuMap[(int) $cauHoi['id']]) && $traLoiCuMap[(int) $cauHoi['id']] !== '') {
            $ch->appendChild($xml->createElement('DapAnDaChon', htmlspecialchars($traLoiCuMap[(int) $cauHoi['id']])));
        }

        $dsCauHoi->appendChild($ch);
    }
    $root->appendChild($dsCauHoi);
    $xml->appendChild($root);
    echo $xml->saveXML();
    exit;
}

/* =====================================================================
   submit: SV nộp bài (thủ công hoặc tự động khi hết giờ / bị cấm).
   ===================================================================== */
if ($action === 'submit' && $role === 'sv') {
    $inputXml = file_get_contents('php://input');
    $doc = new DOMDocument();
    $doc->loadXML($inputXml);

    $luotLamBaiIdNode = $doc->getElementsByTagName('LuotLamBaiId')->item(0);
    $luotLamBaiId = $luotLamBaiIdNode ? (int) $luotLamBaiIdNode->nodeValue : 0;

    $stmtLuot = $pdo->prepare('SELECT bai_kiem_tra_id FROM luot_lam_bai WHERE id = ? AND hoc_sinh_id = ? LIMIT 1');
    $stmtLuot->execute([$luotLamBaiId, $username]);
    $luotData = $stmtLuot->fetch();

    if ($luotData) {
        $cauTraLoiList = $doc->getElementsByTagName('CauTraLoi');

        $stmtDeleteOne = $pdo->prepare('DELETE FROM chi_tiet_bai_lam WHERE luot_lam_bai_id = ? AND cau_hoi_id = ?');
        $stmtInsertCTL = $pdo->prepare('INSERT INTO chi_tiet_bai_lam (luot_lam_bai_id, cau_hoi_id, cau_tra_loi) VALUES (?, ?, ?)');

        foreach ($cauTraLoiList as $ctl) {
            $cauHoiId = (int) $ctl->getAttribute('cau_hoi_id');
            $dapAn = $ctl->nodeValue;

            $stmtDeleteOne->execute([$luotLamBaiId, $cauHoiId]);
            $stmtInsertCTL->execute([$luotLamBaiId, $cauHoiId, $dapAn]);
        }

        $diemSo = finalizeLuotLamBai($pdo, $luotLamBaiId);
        $thoiGianHienThi = getThoiGianHienThiKetQua($pdo, (int) $luotData['bai_kiem_tra_id']);
        $ketQuaTungCau = getKetQuaTungCauHoi($pdo, $luotLamBaiId);

        $root = $xml->createElement('Response');
        $root->appendChild($xml->createElement('Status', 'Success'));
        $root->appendChild($xml->createElement('DiemSo', htmlspecialchars((string) $diemSo)));
        $root->appendChild($xml->createElement('ThoiGianHienThiKetQua', (string) $thoiGianHienThi));

        $dsKetQua = $xml->createElement('KetQuaCauHoi');
        foreach ($ketQuaTungCau as $kq) {
            $chNode = $xml->createElement('CauHoi');
            $chNode->setAttribute('id', (string) $kq['cau_hoi_id']);
            $chNode->setAttribute('dung', (string) $kq['dung']);
            $chNode->setAttribute('daLam', (string) $kq['daLam']);
            $chNode->setAttribute('dapAnDung', (string) $kq['dapan_dung']);
            $dsKetQua->appendChild($chNode);
        }
        $root->appendChild($dsKetQua);
        $xml->appendChild($root);
        echo $xml->saveXML();
        exit;
    }

    errorResponse($xml, 'Không tìm thấy lượt làm bài hợp lệ.');
}


/* Tính lại điểm các lượt ĐÃ NỘP của 1 bài kiểm tra theo đáp án đúng hiện tại.
   Chỉ ĐỌC câu trả lời của sinh viên (chi_tiet_bai_lam) và cập nhật diem_so -
   tuyệt đối không sửa câu trả lời của sinh viên. */
function recomputeDiemSoDaNop(PDO $pdo, int $quizId): void {
    // Bài GV đã chấm tay (diem_cham_tay có giá trị) giữ nguyên điểm, không tính lại tự động
    $stmtLuot = $pdo->prepare("SELECT id FROM luot_lam_bai WHERE bai_kiem_tra_id = ? AND trang_thai = 'da_nop' AND diem_cham_tay IS NULL");
    $stmtLuot->execute([$quizId]);
    $luotIds = $stmtLuot->fetchAll(PDO::FETCH_COLUMN);

    $stmtChiTiet = $pdo->prepare(
        'SELECT c.dapan_dung, c.loai_cau_hoi, c.diem, d.cau_tra_loi
         FROM chi_tiet_bai_lam d
         JOIN cau_hoi c ON c.id = d.cau_hoi_id
         WHERE d.luot_lam_bai_id = ?'
    );
    $stmtUpdate = $pdo->prepare('UPDATE luot_lam_bai SET diem_so = ? WHERE id = ?');

    foreach ($luotIds as $luotId) {
        $stmtChiTiet->execute([$luotId]);
        $diemSo = 0;
        foreach ($stmtChiTiet->fetchAll() as $row) {
            if ($row['loai_cau_hoi'] === 'trac_nghiem' && laCauTraLoiDung($row['cau_tra_loi'], $row['dapan_dung'])) {
                $diemSo += (float) $row['diem'];
            }
        }
        $stmtUpdate->execute([round($diemSo, 2), $luotId]);
    }
}

/* =====================================================================
   create: GV tạo bài kiểm tra mới (mặc định hiện + mở làm bài ngay).
   ===================================================================== */
if ($action === 'create' && $role === 'gv') {
    $inputXml = file_get_contents('php://input');
    $doc = new DOMDocument();
    $doc->loadXML($inputXml);

    $tieuDeNode = $doc->getElementsByTagName('TieuDe')->item(0);
    $moTaNode = $doc->getElementsByTagName('MoTa')->item(0);
    $monHocIdNode = $doc->getElementsByTagName('MonHocId')->item(0);
    $thoiGianNode = $doc->getElementsByTagName('ThoiGianLamBai')->item(0);
    $thoiGianKetQuaNode = $doc->getElementsByTagName('ThoiGianHienThiKetQua')->item(0);
    $chongGianLanNode = $doc->getElementsByTagName('ChongGianLan')->item(0);
    $chongGianLan = ($chongGianLanNode && trim($chongGianLanNode->nodeValue) === '0') ? 0 : 1;

    $tieuDe = $tieuDeNode ? $tieuDeNode->nodeValue : '';
    $moTa = $moTaNode ? $moTaNode->nodeValue : '';
    $monHocId = $monHocIdNode ? $monHocIdNode->nodeValue : '';
    $thoiGian = $thoiGianNode ? (int) $thoiGianNode->nodeValue : 45;
    // Số giây hiển thị ô xem lại kết quả sau khi nộp bài. 0 = vô hạn (chỉ
    // tắt khi sinh viên tự đóng). Âm thì ép về 0 cho an toàn.
    $thoiGianKetQua = $thoiGianKetQuaNode ? (int) $thoiGianKetQuaNode->nodeValue : 5;
    if ($thoiGianKetQua < 0) {
        $thoiGianKetQua = 0;
    }

    if ($tieuDe === '' || $monHocId === '') {
        errorResponse($xml, 'Thiếu tiêu đề hoặc môn học.');
    }

    $cauHoiList = $doc->getElementsByTagName('CauHoi');
    $tongDiem = 0;
    foreach ($cauHoiList as $ch) {
        $diemNode = $ch->getElementsByTagName('Diem')->item(0);
        $tongDiem += $diemNode ? (float) $diemNode->nodeValue : 1;
    }
    if ($cauHoiList->length > 0 && ($tongDiem <= 0 || $tongDiem > 10)) {
        errorResponse($xml, 'Tổng điểm các câu hỏi phải lớn hơn 0 và không vượt quá 10.');
    }

    $stmtInsert = $pdo->prepare('INSERT INTO bai_kiem_tra (mon_hoc_id, tieu_de, mo_ta, thoi_gian_lam_bai, thoi_gian_hien_thi_ket_qua, nguoi_tao_id, trang_thai, hien_thi, cho_phep_lam_bai, chong_gian_lan) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?)');
    $stmtInsert->execute([$monHocId, $tieuDe, $moTa, $thoiGian > 0 ? $thoiGian : 45, $thoiGianKetQua, $username, 'dang_mo', $chongGianLan]);
    $quizId = (int) $pdo->lastInsertId();

    $stmtInsertTracNghiem = $pdo->prepare('INSERT INTO cau_hoi (bai_kiem_tra_id, noi_dung, loai_cau_hoi, dapan_a, dapan_b, dapan_c, dapan_d, dapan_dung, diem) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    $stmtInsertTuLuan = $pdo->prepare('INSERT INTO cau_hoi (bai_kiem_tra_id, noi_dung, loai_cau_hoi, diem) VALUES (?, ?, ?, ?)');

    foreach ($cauHoiList as $ch) {
        $loai = $ch->getAttribute('loai');
        $noiDungNode = $ch->getElementsByTagName('NoiDung')->item(0);
        $noiDung = $noiDungNode ? $noiDungNode->nodeValue : '';
        $diemNode = $ch->getElementsByTagName('Diem')->item(0);
        $diem = $diemNode ? (float) $diemNode->nodeValue : 1;

        if ($loai === 'trac_nghiem') {
            $daANode = $ch->getElementsByTagName('DapAnA')->item(0);
            $daBNode = $ch->getElementsByTagName('DapAnB')->item(0);
            $daCNode = $ch->getElementsByTagName('DapAnC')->item(0);
            $daDNode = $ch->getElementsByTagName('DapAnD')->item(0);
            $daDungNode = $ch->getElementsByTagName('DapAnDung')->item(0);

            $stmtInsertTracNghiem->execute([
                $quizId,
                $noiDung,
                $loai,
                $daANode ? $daANode->nodeValue : '',
                $daBNode ? $daBNode->nodeValue : '',
                $daCNode ? $daCNode->nodeValue : '',
                $daDNode ? $daDNode->nodeValue : '',
                $daDungNode ? $daDungNode->nodeValue : '',
                $diem,
            ]);
        } else {
            $stmtInsertTuLuan->execute([$quizId, $noiDung, $loai, $diem]);
        }
    }

    successResponse($xml, ['QuizId' => $quizId]);
}

/* =====================================================================
   results: GV xem danh sách sinh viên đã làm bài + trạng thái/điểm.
   ===================================================================== */
if ($action === 'results' && $role === 'gv') {
    $quizId = isset($_GET['id']) ? (int) $_GET['id'] : 0;

    $stmtQuiz = $pdo->prepare('SELECT id, tieu_de FROM bai_kiem_tra WHERE id = ? LIMIT 1');
    $stmtQuiz->execute([$quizId]);
    $quiz = $stmtQuiz->fetch();

    if (!$quiz) {
        errorResponse($xml, 'Không tìm thấy bài kiểm tra.');
    }

    $stmt = $pdo->prepare(
        'SELECT l.id, l.hoc_sinh_id, l.trang_thai, l.diem_so, l.diem_cham_tay, l.thoi_gian_bat_dau, l.thoi_gian_nop,
                u.ho_ten, u.ma_so_sv
         FROM luot_lam_bai l
         LEFT JOIN users u ON u.username = l.hoc_sinh_id
         WHERE l.bai_kiem_tra_id = ? ORDER BY l.thoi_gian_bat_dau ASC'
    );
    $stmt->execute([$quizId]);

    $stmtBanned = $pdo->prepare('SELECT 1 FROM cam_thi WHERE bai_kiem_tra_id = ? AND hoc_sinh_id = ? LIMIT 1');

    $root = $xml->createElement('KetQuaBaiKiemTra');
    $root->setAttribute('id', (string) $quiz['id']);
    $root->appendChild($xml->createElement('TieuDe', htmlspecialchars($quiz['tieu_de'])));

    // Tổng điểm của bài (dùng làm điểm tối đa khi GV chấm tay)
    $stmtTongDiem = $pdo->prepare('SELECT COALESCE(SUM(diem), 0) FROM cau_hoi WHERE bai_kiem_tra_id = ?');
    $stmtTongDiem->execute([$quizId]);
    $tongDiemBai = (float) $stmtTongDiem->fetchColumn();
    if ($tongDiemBai <= 0) {
        $tongDiemBai = 10;
    }
    $root->appendChild($xml->createElement('TongDiem', number_format($tongDiemBai, 2, '.', '')));

    $dsLuot = $xml->createElement('DanhSachLuotLamBai');
    while ($row = $stmt->fetch()) {
        $stmtBanned->execute([$quizId, $row['hoc_sinh_id']]);
        $banned = (bool) $stmtBanned->fetch();

        $luot = $xml->createElement('LuotLamBai');
        $luot->setAttribute('id', (string) $row['id']);
        $luot->appendChild($xml->createElement('HocSinh', htmlspecialchars($row['hoc_sinh_id'])));
        $luot->appendChild($xml->createElement('HoTen', htmlspecialchars((string) ($row['ho_ten'] ?? ''))));
        $luot->appendChild($xml->createElement('MaSoSV', htmlspecialchars((string) ($row['ma_so_sv'] ?? ''))));
        $luot->appendChild($xml->createElement('TrangThai', $row['trang_thai']));
        $luot->appendChild($xml->createElement('DiemSo', $row['diem_so'] !== null ? (string) $row['diem_so'] : ''));
        $luot->appendChild($xml->createElement('ChamTay', $row['diem_cham_tay'] !== null ? '1' : '0'));
        $luot->appendChild($xml->createElement('ThoiGianNop', (string) ($row['thoi_gian_nop'] ?? '')));
        $luot->appendChild($xml->createElement('BiCam', $banned ? '1' : '0'));
        $dsLuot->appendChild($luot);
    }
    $root->appendChild($dsLuot);
    $xml->appendChild($root);
    xmlKiemTraVaGhiLog($xml, 'ket_qua.xsd', 'quizzes.php?action=results');
    echo $xml->saveXML();
    exit;
}

/* =====================================================================
   chi_tiet: GV xem chi tiết 1 lượt làm bài (câu nào chọn đáp án nào,
   đúng/sai, tổng điểm).
   ===================================================================== */
if ($action === 'chi_tiet' && $role === 'gv') {
    $luotId = isset($_GET['luot_id']) ? (int) $_GET['luot_id'] : 0;

    $stmtLuot = $pdo->prepare(
        'SELECT l.id, l.hoc_sinh_id, l.trang_thai, l.diem_so, l.bai_kiem_tra_id, b.tieu_de,
                u.ho_ten, u.ma_so_sv
         FROM luot_lam_bai l
         JOIN bai_kiem_tra b ON b.id = l.bai_kiem_tra_id
         LEFT JOIN users u ON u.username = l.hoc_sinh_id
         WHERE l.id = ? LIMIT 1'
    );
    $stmtLuot->execute([$luotId]);
    $luot = $stmtLuot->fetch();

    if (!$luot) {
        errorResponse($xml, 'Không tìm thấy lượt làm bài.');
    }

    $stmtCauHoi = $pdo->prepare('SELECT * FROM cau_hoi WHERE bai_kiem_tra_id = ?');
    $stmtCauHoi->execute([$luot['bai_kiem_tra_id']]);
    $cauHoiList = $stmtCauHoi->fetchAll();

    $stmtTraLoi = $pdo->prepare('SELECT cau_hoi_id, cau_tra_loi FROM chi_tiet_bai_lam WHERE luot_lam_bai_id = ?');
    $stmtTraLoi->execute([$luotId]);
    $traLoiMap = [];
    foreach ($stmtTraLoi->fetchAll() as $tl) {
        $traLoiMap[(int) $tl['cau_hoi_id']] = $tl['cau_tra_loi'];
    }

    $root = $xml->createElement('ChiTietBaiLam');
    $root->setAttribute('id', (string) $luot['id']);
    $root->appendChild($xml->createElement('TieuDeBaiKiemTra', htmlspecialchars($luot['tieu_de'])));
    $root->appendChild($xml->createElement('HocSinh', htmlspecialchars($luot['hoc_sinh_id'])));
    $root->appendChild($xml->createElement('HoTen', htmlspecialchars((string) ($luot['ho_ten'] ?? ''))));
    $root->appendChild($xml->createElement('MaSoSV', htmlspecialchars((string) ($luot['ma_so_sv'] ?? ''))));
    $root->appendChild($xml->createElement('TrangThai', $luot['trang_thai']));
    $root->appendChild($xml->createElement('DiemSo', $luot['diem_so'] !== null ? (string) $luot['diem_so'] : ''));

    $dsCauHoi = $xml->createElement('DanhSachCauHoi');
    foreach ($cauHoiList as $cauHoi) {
        $ch = $xml->createElement('CauHoi');
        $ch->setAttribute('id', (string) $cauHoi['id']);
        $ch->setAttribute('loai', $cauHoi['loai_cau_hoi']);
        $ch->appendChild($xml->createElement('NoiDung', htmlspecialchars($cauHoi['noi_dung'])));

        $svAnswer = $traLoiMap[(int) $cauHoi['id']] ?? '';
        $ch->appendChild($xml->createElement('DapAnSinhVien', htmlspecialchars((string) $svAnswer)));

        if ($cauHoi['loai_cau_hoi'] === 'trac_nghiem') {
            $ch->appendChild($xml->createElement('DapAnA', htmlspecialchars((string) $cauHoi['dapan_a'])));
            $ch->appendChild($xml->createElement('DapAnB', htmlspecialchars((string) $cauHoi['dapan_b'])));
            $ch->appendChild($xml->createElement('DapAnC', htmlspecialchars((string) $cauHoi['dapan_c'])));
            $ch->appendChild($xml->createElement('DapAnD', htmlspecialchars((string) $cauHoi['dapan_d'])));
            $ch->appendChild($xml->createElement('DapAnDung', htmlspecialchars((string) $cauHoi['dapan_dung'])));
            $dung = laCauTraLoiDung($svAnswer, $cauHoi['dapan_dung']) ? '1' : '0';
            $ch->appendChild($xml->createElement('Dung', $dung));
        }
        $dsCauHoi->appendChild($ch);
    }
    $root->appendChild($dsCauHoi);
    $xml->appendChild($root);
    xmlKiemTraVaGhiLog($xml, 'chi_tiet.xsd', 'quizzes.php?action=chi_tiet');
    echo $xml->saveXML();
    exit;
}

/* =====================================================================
   cham_diem: GV chấm điểm tay cho 1 lượt làm bài ĐÃ NỘP (VD chấm câu tự luận)
   ngay trong bảng kết quả. POST ?luot_id=..&diem=..
   - diem là số từ 0 đến tổng điểm của bài.
   - diem để trống = bỏ điểm chấm tay, quay về điểm tự chấm trắc nghiệm.
   Điểm chấm tay được giữ nguyên khi GV sửa đề (không bị tính lại tự động).
   ===================================================================== */
if ($action === 'cham_diem' && $role === 'gv') {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        errorResponse($xml, 'Yêu cầu không hợp lệ.');
    }

    $luotId = isset($_GET['luot_id']) ? (int) $_GET['luot_id'] : 0;
    $diemRaw = isset($_GET['diem']) ? trim((string) $_GET['diem']) : '';

    $stmt = $pdo->prepare('SELECT id, bai_kiem_tra_id, trang_thai FROM luot_lam_bai WHERE id = ? LIMIT 1');
    $stmt->execute([$luotId]);
    $luotCham = $stmt->fetch();
    if (!$luotCham) {
        errorResponse($xml, 'Không tìm thấy lượt làm bài.');
    }
    if ($luotCham['trang_thai'] !== 'da_nop') {
        errorResponse($xml, 'Chỉ chấm điểm được cho bài đã nộp.');
    }

    $stmtTong = $pdo->prepare('SELECT COALESCE(SUM(diem), 0) FROM cau_hoi WHERE bai_kiem_tra_id = ?');
    $stmtTong->execute([$luotCham['bai_kiem_tra_id']]);
    $tongDiem = (float) $stmtTong->fetchColumn();
    if ($tongDiem <= 0) {
        $tongDiem = 10;
    }

    if ($diemRaw === '') {
        $diem = tinhDiemTuDong($pdo, $luotId);
        $stmtUp = $pdo->prepare('UPDATE luot_lam_bai SET diem_so = ?, diem_cham_tay = NULL WHERE id = ?');
        $stmtUp->execute([$diem, $luotId]);
        $chamTay = '0';
    } else {
        $diemRaw = str_replace(',', '.', $diemRaw);
        if (!is_numeric($diemRaw)) {
            errorResponse($xml, 'Điểm không hợp lệ, vui lòng nhập một số.');
        }
        $diem = round((float) $diemRaw, 2);
        if ($diem < 0 || $diem > $tongDiem + 0.0001) {
            errorResponse($xml, 'Điểm phải từ 0 đến ' . rtrim(rtrim(number_format($tongDiem, 2, '.', ''), '0'), '.') . '.');
        }
        $stmtUp = $pdo->prepare('UPDATE luot_lam_bai SET diem_so = ?, diem_cham_tay = ? WHERE id = ?');
        $stmtUp->execute([$diem, $diem, $luotId]);
        $chamTay = '1';
    }

    xmlLuuBaiLam($pdo, $luotId); // cập nhật bản lưu XML với điểm mới

    successResponse($xml, ['DiemSo' => number_format($diem, 2, '.', ''), 'ChamTay' => $chamTay]);
}

/* =====================================================================
   toggle_visibility: GV bật/tắt hiển thị đề cho sinh viên.
   ===================================================================== */
if ($action === 'toggle_visibility' && $role === 'gv') {
    $quizId = isset($_GET['id']) ? (int) $_GET['id'] : 0;

    $stmt = $pdo->prepare('SELECT hien_thi FROM bai_kiem_tra WHERE id = ? LIMIT 1');
    $stmt->execute([$quizId]);
    $row = $stmt->fetch();
    if (!$row) {
        errorResponse($xml, 'Không tìm thấy bài kiểm tra.');
    }

    $newValue = $row['hien_thi'] ? 0 : 1;
    $stmtUpdate = $pdo->prepare('UPDATE bai_kiem_tra SET hien_thi = ? WHERE id = ?');
    $stmtUpdate->execute([$newValue, $quizId]);

    successResponse($xml, ['HienThi' => $newValue]);
}

/* =====================================================================
   toggle_open: GV bật/tắt cho phép sinh viên bắt đầu/xem trước làm bài.
   ===================================================================== */
if ($action === 'toggle_open' && $role === 'gv') {
    $quizId = isset($_GET['id']) ? (int) $_GET['id'] : 0;

    $stmt = $pdo->prepare('SELECT cho_phep_lam_bai FROM bai_kiem_tra WHERE id = ? LIMIT 1');
    $stmt->execute([$quizId]);
    $row = $stmt->fetch();
    if (!$row) {
        errorResponse($xml, 'Không tìm thấy bài kiểm tra.');
    }

    $newValue = $row['cho_phep_lam_bai'] ? 0 : 1;
    $stmtUpdate = $pdo->prepare('UPDATE bai_kiem_tra SET cho_phep_lam_bai = ? WHERE id = ?');
    $stmtUpdate->execute([$newValue, $quizId]);

    successResponse($xml, ['ChoPhepLamBai' => $newValue]);
}

/* =====================================================================
   reset_attempt: GV xóa hẳn 1 lượt làm bài (kể cả các câu đã trả lời) để
   sinh viên làm lại HOÀN TOÀN từ đầu, không giữ lại gì.
   ===================================================================== */
if ($action === 'reset_attempt' && $role === 'gv') {
    $luotId = isset($_GET['luot_id']) ? (int) $_GET['luot_id'] : 0;

    $stmt = $pdo->prepare('SELECT id, bai_kiem_tra_id FROM luot_lam_bai WHERE id = ? LIMIT 1');
    $stmt->execute([$luotId]);
    $luotReset = $stmt->fetch();
    if (!$luotReset) {
        errorResponse($xml, 'Không tìm thấy lượt làm bài.');
    }

    $stmtDelete = $pdo->prepare('DELETE FROM luot_lam_bai WHERE id = ?');
    $stmtDelete->execute([$luotId]);
    xmlXoaBaiLam((int) $luotReset['bai_kiem_tra_id'], $luotId);

    successResponse($xml);
}

/* =====================================================================
   reopen_attempt: dùng khi sinh viên LỠ nộp bài (VD: bấm nhầm, bị tự động
   nộp do lỗi mạng/hết giờ oan...). GV "mở lại" lượt làm bài đã nộp về
   trạng thái đang làm, VẪN GIỮ NGUYÊN các câu trả lời đã lưu trước đó
   (khác với reset_attempt là xóa sạch làm lại từ đầu). Đồng hồ đếm giờ
   được tính lại từ đầu (đủ thời gian làm bài quy định) để công bằng, vì
   thời gian của lượt cũ có thể đã gần hết hoặc đã hết khi bị nộp oan.
   ===================================================================== */
if ($action === 'reopen_attempt' && $role === 'gv') {
    $luotId = isset($_GET['luot_id']) ? (int) $_GET['luot_id'] : 0;

    $stmt = $pdo->prepare('SELECT id, trang_thai, bai_kiem_tra_id FROM luot_lam_bai WHERE id = ? LIMIT 1');
    $stmt->execute([$luotId]);
    $luot = $stmt->fetch();

    if (!$luot) {
        errorResponse($xml, 'Không tìm thấy lượt làm bài.');
    }
    if ($luot['trang_thai'] !== 'da_nop') {
        errorResponse($xml, 'Chỉ có thể mở lại lượt làm bài đã nộp.');
    }

    $stmtUpdate = $pdo->prepare(
        "UPDATE luot_lam_bai
         SET trang_thai = 'dang_lam', thoi_gian_bat_dau = ?, thoi_gian_nop = NULL, diem_so = NULL, diem_cham_tay = NULL
         WHERE id = ?"
    );
    $stmtUpdate->execute([date('Y-m-d H:i:s'), $luotId]);
    xmlXoaBaiLam((int) $luot['bai_kiem_tra_id'], $luotId);

    // Nếu sinh viên vừa bị cấm thi bài này, mở lại bài làm không tự động
    // bỏ cấm - GV cần bỏ cấm riêng (bằng nút Cấm thi/Bỏ cấm) nếu muốn.
    successResponse($xml);
}

/* =====================================================================
   toggle_ban: GV cấm/bỏ cấm 1 sinh viên thi MỘT bài kiểm tra cụ thể.
   Nếu sinh viên đang làm bài dở dang (dang_lam), lập tức đánh dấu đã nộp
   (điểm 0 nếu chưa có dữ liệu trả lời nào ghi nhận) để họ không thể vào
   làm tiếp; nếu trình duyệt của sinh viên vẫn đang mở và kịp gửi câu trả
   lời hiện tại lên trước khi bị khóa hẳn, điểm sẽ được cập nhật lại đúng.
   ===================================================================== */
if ($action === 'toggle_ban' && $role === 'gv') {
    $quizId = isset($_GET['id']) ? (int) $_GET['id'] : 0;
    $hocSinh = trim($_GET['hoc_sinh'] ?? '');

    if ($quizId <= 0 || $hocSinh === '') {
        errorResponse($xml, 'Thiếu thông tin bài kiểm tra hoặc sinh viên.');
    }

    $stmtCheck = $pdo->prepare('SELECT 1 FROM cam_thi WHERE bai_kiem_tra_id = ? AND hoc_sinh_id = ? LIMIT 1');
    $stmtCheck->execute([$quizId, $hocSinh]);
    $daBiCam = (bool) $stmtCheck->fetch();

    if ($daBiCam) {
        $stmtUnban = $pdo->prepare('DELETE FROM cam_thi WHERE bai_kiem_tra_id = ? AND hoc_sinh_id = ?');
        $stmtUnban->execute([$quizId, $hocSinh]);
        successResponse($xml, ['BiCam' => 0]);
    }

    $stmtBan = $pdo->prepare('INSERT INTO cam_thi (bai_kiem_tra_id, hoc_sinh_id) VALUES (?, ?)');
    $stmtBan->execute([$quizId, $hocSinh]);

    // Ép nộp bài ngay nếu đang làm dở.
    $stmtForce = $pdo->prepare("UPDATE luot_lam_bai SET thoi_gian_nop = ?, diem_so = COALESCE(diem_so, 0), trang_thai = 'da_nop' WHERE bai_kiem_tra_id = ? AND hoc_sinh_id = ? AND trang_thai = 'dang_lam'");
    $stmtForce->execute([date('Y-m-d H:i:s'), $quizId, $hocSinh]);

    successResponse($xml, ['BiCam' => 1]);
}

/* =====================================================================
   delete: GV xóa toàn bộ bài kiểm tra (cascade câu hỏi/lượt làm bài).
   ===================================================================== */
/* =====================================================================
   edit_get: GV lấy nội dung bài kiểm tra (kèm đáp án đúng) để chỉnh sửa.
   ===================================================================== */
if ($action === 'edit_get' && $role === 'gv') {
    $quizId = isset($_GET['id']) ? (int) $_GET['id'] : 0;

    $stmtQuiz = $pdo->prepare('SELECT id, tieu_de, mo_ta, thoi_gian_lam_bai, thoi_gian_hien_thi_ket_qua, chong_gian_lan FROM bai_kiem_tra WHERE id = ? LIMIT 1');
    $stmtQuiz->execute([$quizId]);
    $quiz = $stmtQuiz->fetch();
    if (!$quiz) {
        errorResponse($xml, 'Không tìm thấy bài kiểm tra.');
    }

    $stmtCauHoi = $pdo->prepare('SELECT * FROM cau_hoi WHERE bai_kiem_tra_id = ? ORDER BY id ASC');
    $stmtCauHoi->execute([$quizId]);

    $root = $xml->createElement('BaiKiemTraSua');
    $root->setAttribute('id', (string) $quiz['id']);
    $root->appendChild($xml->createElement('TieuDe', htmlspecialchars((string) $quiz['tieu_de'])));
    $root->appendChild($xml->createElement('MoTa', htmlspecialchars((string) $quiz['mo_ta'])));
    $root->appendChild($xml->createElement('ThoiGianLamBai', (string) (int) $quiz['thoi_gian_lam_bai']));
    $root->appendChild($xml->createElement('ThoiGianHienThiKetQua', (string) (int) $quiz['thoi_gian_hien_thi_ket_qua']));
    $root->appendChild($xml->createElement('ChongGianLan', (string) (int) $quiz['chong_gian_lan']));

    $ds = $xml->createElement('DanhSachCauHoi');
    foreach ($stmtCauHoi->fetchAll() as $ch) {
        $node = $xml->createElement('CauHoi');
        $node->setAttribute('id', (string) $ch['id']);
        $node->setAttribute('loai', $ch['loai_cau_hoi']);
        $node->appendChild($xml->createElement('NoiDung', htmlspecialchars((string) $ch['noi_dung'])));
        if ($ch['loai_cau_hoi'] === 'trac_nghiem') {
            $node->appendChild($xml->createElement('DapAnA', htmlspecialchars((string) $ch['dapan_a'])));
            $node->appendChild($xml->createElement('DapAnB', htmlspecialchars((string) $ch['dapan_b'])));
            $node->appendChild($xml->createElement('DapAnC', htmlspecialchars((string) $ch['dapan_c'])));
            $node->appendChild($xml->createElement('DapAnD', htmlspecialchars((string) $ch['dapan_d'])));
            $node->appendChild($xml->createElement('DapAnDung', htmlspecialchars((string) $ch['dapan_dung'])));
        }
        $ds->appendChild($node);
    }
    $root->appendChild($ds);
    $xml->appendChild($root);
    echo $xml->saveXML();
    exit;
}

/* =====================================================================
   edit_save: GV sửa tiêu đề/mô tả/thời gian và NỘI DUNG câu hỏi + 4 đáp án
   + đáp án đúng của các câu ĐÃ CÓ. Chỉ UPDATE bảng bai_kiem_tra và cau_hoi;
   KHÔNG đụng tới chi_tiet_bai_lam nên bài làm của sinh viên giữ nguyên.
   Cho phép THÊM câu hỏi mới (CauHoi không có id, có thuộc tính loai); khi đó
   điểm được chia lại đều (tổng 10). Không xóa/đổi loại câu hỏi cũ (tránh mất bài làm của SV).
   ===================================================================== */
if ($action === 'edit_save' && $role === 'gv') {
    $doc = new DOMDocument();
    if (!@$doc->loadXML(file_get_contents('php://input'))) {
        errorResponse($xml, 'Dữ liệu gửi lên không hợp lệ.');
    }
    $val = function (string $tag) use ($doc) {
        $n = $doc->getElementsByTagName($tag)->item(0);
        return $n ? $n->nodeValue : '';
    };

    $quizId = (int) $val('QuizId');
    $tieuDe = trim($val('TieuDe'));
    $moTa = $val('MoTa');
    $thoiGian = (int) $val('ThoiGianLamBai');
    $thoiGianKetQua = max(0, (int) $val('ThoiGianHienThiKetQua'));
    $chongGianLan = trim($val('ChongGianLan')) === '0' ? 0 : 1;

    $stmtQuiz = $pdo->prepare('SELECT id FROM bai_kiem_tra WHERE id = ? LIMIT 1');
    $stmtQuiz->execute([$quizId]);
    if (!$stmtQuiz->fetch()) {
        errorResponse($xml, 'Không tìm thấy bài kiểm tra.');
    }
    if ($tieuDe === '') {
        errorResponse($xml, 'Tiêu đề không được để trống.');
    }

    // Các câu hỏi hiện có của bài (id => loại) - chỉ cho sửa những câu này
    $stmtCauHoi = $pdo->prepare('SELECT id, loai_cau_hoi FROM cau_hoi WHERE bai_kiem_tra_id = ?');
    $stmtCauHoi->execute([$quizId]);
    $loaiMap = [];
    foreach ($stmtCauHoi->fetchAll() as $row) {
        $loaiMap[(int) $row['id']] = $row['loai_cau_hoi'];
    }

    $updates = [];
    $inserts = [];
    foreach ($doc->getElementsByTagName('CauHoi') as $ch) {
        $cid = (int) $ch->getAttribute('id');
        $laCauMoi = !$ch->hasAttribute('id') || $ch->getAttribute('id') === '';
        $get = function (string $tag) use ($ch) {
            $n = $ch->getElementsByTagName($tag)->item(0);
            return $n ? $n->nodeValue : '';
        };
        $noiDung = trim($get('NoiDung'));
        if ($noiDung === '') {
            errorResponse($xml, 'Nội dung câu hỏi không được để trống.');
        }

        if ($laCauMoi) {
            // Câu hỏi MỚI thêm vào đề
            $loaiMoi = $ch->getAttribute('loai');
            if ($loaiMoi === 'trac_nghiem') {
                $a = trim($get('DapAnA')); $b = trim($get('DapAnB'));
                $c = trim($get('DapAnC')); $d = trim($get('DapAnD'));
                $dung = trim($get('DapAnDung'));
                if ($a === '' || $b === '' || $c === '' || $d === '') {
                    errorResponse($xml, 'Vui lòng nhập đầy đủ 4 đáp án cho các câu trắc nghiệm.');
                }
                if (!in_array($dung, ['A', 'B', 'C', 'D'], true)) {
                    errorResponse($xml, 'Đáp án đúng phải là A, B, C hoặc D.');
                }
                $inserts[] = ['trac_nghiem', $noiDung, $a, $b, $c, $d, $dung];
            } elseif ($loaiMoi === 'tu_luan') {
                $inserts[] = ['tu_luan', $noiDung];
            } else {
                errorResponse($xml, 'Loại câu hỏi không hợp lệ.');
            }
            continue;
        }

        if (!isset($loaiMap[$cid])) {
            errorResponse($xml, 'Câu hỏi không thuộc bài kiểm tra này.');
        }
        if ($loaiMap[$cid] === 'trac_nghiem') {
            $a = trim($get('DapAnA')); $b = trim($get('DapAnB'));
            $c = trim($get('DapAnC')); $d = trim($get('DapAnD'));
            $dung = trim($get('DapAnDung'));
            if ($a === '' || $b === '' || $c === '' || $d === '') {
                errorResponse($xml, 'Vui lòng nhập đầy đủ 4 đáp án cho các câu trắc nghiệm.');
            }
            if (!in_array($dung, ['A', 'B', 'C', 'D'], true)) {
                errorResponse($xml, 'Đáp án đúng phải là A, B, C hoặc D.');
            }
            $updates[] = ['trac_nghiem', $cid, $noiDung, $a, $b, $c, $d, $dung];
        } else {
            $updates[] = ['tu_luan', $cid, $noiDung];
        }
    }

    $pdo->beginTransaction();
    try {
        $stmtUpdQuiz = $pdo->prepare('UPDATE bai_kiem_tra SET tieu_de = ?, mo_ta = ?, thoi_gian_lam_bai = ?, thoi_gian_hien_thi_ket_qua = ?, chong_gian_lan = ? WHERE id = ?');
        $stmtUpdQuiz->execute([$tieuDe, $moTa, $thoiGian > 0 ? $thoiGian : 45, $thoiGianKetQua, $chongGianLan, $quizId]);

        $stmtTN = $pdo->prepare('UPDATE cau_hoi SET noi_dung = ?, dapan_a = ?, dapan_b = ?, dapan_c = ?, dapan_d = ?, dapan_dung = ? WHERE id = ? AND bai_kiem_tra_id = ?');
        $stmtTL = $pdo->prepare('UPDATE cau_hoi SET noi_dung = ? WHERE id = ? AND bai_kiem_tra_id = ?');
        foreach ($updates as $u) {
            if ($u[0] === 'trac_nghiem') {
                $stmtTN->execute([$u[2], $u[3], $u[4], $u[5], $u[6], $u[7], $u[1], $quizId]);
            } else {
                $stmtTL->execute([$u[2], $u[1], $quizId]);
            }
        }

        // Thêm các câu hỏi mới (nếu có)
        if (count($inserts) > 0) {
            $stmtInsTN = $pdo->prepare('INSERT INTO cau_hoi (bai_kiem_tra_id, noi_dung, loai_cau_hoi, dapan_a, dapan_b, dapan_c, dapan_d, dapan_dung, diem) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)');
            $stmtInsTL = $pdo->prepare('INSERT INTO cau_hoi (bai_kiem_tra_id, noi_dung, loai_cau_hoi, diem) VALUES (?, ?, ?, 1)');
            foreach ($inserts as $ins) {
                if ($ins[0] === 'trac_nghiem') {
                    $stmtInsTN->execute([$quizId, $ins[1], 'trac_nghiem', $ins[2], $ins[3], $ins[4], $ins[5], $ins[6]]);
                } else {
                    $stmtInsTL->execute([$quizId, $ins[1], 'tu_luan']);
                }
            }

            // Tổng bài luôn là 10 điểm, chia đều cho tất cả câu hỏi (giống lúc tạo bài).
            // Tính theo "xu" (10.00đ = 1000 xu), phần dư dồn vào các câu cuối.
            $stmtIds = $pdo->prepare('SELECT id FROM cau_hoi WHERE bai_kiem_tra_id = ? ORDER BY id ASC');
            $stmtIds->execute([$quizId]);
            $allIds = $stmtIds->fetchAll(PDO::FETCH_COLUMN);
            $n = count($allIds);
            if ($n > 0) {
                $base = intdiv(1000, $n);
                $du = 1000 - $base * $n;
                $stmtDiem = $pdo->prepare('UPDATE cau_hoi SET diem = ? WHERE id = ?');
                foreach ($allIds as $i => $cidAll) {
                    $xu = $base + ($i >= $n - $du ? 1 : 0);
                    $stmtDiem->execute([$xu / 100, $cidAll]);
                }
            }
        }

        // Đáp án đúng/điểm có thể đã đổi -> chấm lại điểm các bài đã nộp (câu trả lời SV giữ nguyên)
        recomputeDiemSoDaNop($pdo, $quizId);
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        errorResponse($xml, 'Không thể lưu thay đổi: ' . $e->getMessage());
    }

    // Đề/đáp án có thể đã đổi -> bỏ các XML bài làm cũ, sẽ tự tạo lại khi cần thống kê
    xmlXoaThuMucBaiKiemTra($quizId);

    successResponse($xml);
}

if ($action === 'delete' && $role === 'gv' && $_SERVER['REQUEST_METHOD'] === 'DELETE') {
    $quizId = isset($_GET['id']) ? (int) $_GET['id'] : 0;

    $stmt = $pdo->prepare('DELETE FROM bai_kiem_tra WHERE id = ?');
    $stmt->execute([$quizId]);
    xmlXoaThuMucBaiKiemTra($quizId);

    successResponse($xml);
}

if ($action === 'sync_offline' && $role === 'sv') {
    header('Content-Type: application/json; charset=utf-8');
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) {
        $body = [];
    }
    $luotLamBaiId = isset($body['luotLamBaiId']) ? (int) $body['luotLamBaiId'] : 0;
    $answers = isset($body['answers']) && is_array($body['answers']) ? $body['answers'] : [];
    $forceSubmit = !empty($body['forceSubmit']);

    $stmtLuot = $pdo->prepare('SELECT id, trang_thai, bai_kiem_tra_id FROM luot_lam_bai WHERE id = ? AND hoc_sinh_id = ? LIMIT 1');
    $stmtLuot->execute([$luotLamBaiId, $username]);
    $luot = $stmtLuot->fetch();

    if (!$luot) {
        echo json_encode(['error' => 'Không tìm thấy lượt làm bài hợp lệ.']);
        exit;
    }
    if ($luot['trang_thai'] === 'da_nop') {
        echo json_encode(['success' => true, 'daNop' => true]);
        exit;
    }

    $stmtDeleteOne = $pdo->prepare('DELETE FROM chi_tiet_bai_lam WHERE luot_lam_bai_id = ? AND cau_hoi_id = ?');
    $stmtInsertCTL = $pdo->prepare('INSERT INTO chi_tiet_bai_lam (luot_lam_bai_id, cau_hoi_id, cau_tra_loi) VALUES (?, ?, ?)');

    foreach ($answers as $item) {
        $cauHoiId = isset($item['cauHoiId']) ? (int) $item['cauHoiId'] : 0;
        $dapAn = isset($item['dapAn']) ? (string) $item['dapAn'] : '';
        if ($cauHoiId <= 0) {
            continue;
        }
        $stmtDeleteOne->execute([$luotLamBaiId, $cauHoiId]);
        $stmtInsertCTL->execute([$luotLamBaiId, $cauHoiId, $dapAn]);
    }

    if ($forceSubmit) {
        $diemSo = finalizeLuotLamBai($pdo, $luotLamBaiId);
        $thoiGianHienThi = getThoiGianHienThiKetQua($pdo, (int) $luot['bai_kiem_tra_id']);
        $ketQuaTungCau = getKetQuaTungCauHoi($pdo, $luotLamBaiId);
        echo json_encode([
            'success' => true,
            'daNop' => true,
            'diemSo' => $diemSo,
            'thoiGianHienThiKetQua' => $thoiGianHienThi,
            'ketQuaCauHoi' => $ketQuaTungCau,
        ]);
        exit;
    }

    echo json_encode(['success' => true, 'daNop' => false]);
    exit;
}

errorResponse($xml, 'Hành động không hợp lệ hoặc bạn không có quyền thực hiện.');
