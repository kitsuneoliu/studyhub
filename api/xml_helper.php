<?php
/* =====================================================================
   xml_helper.php: XML chạy NGẦM trong hệ thống (người dùng không thấy).

   1. LƯU TRỮ: mỗi khi sinh viên nộp bài, server tự ghi 1 file XML vào
      storage/bai_lam/quiz_<id>/luot_<id>.xml (bản lưu song song với MySQL).
   2. XSD: XML được kiểm tra bằng XML Schema (api/xsd/*.xsd) trước khi ghi.
      XML sai cấu trúc sẽ không được ghi, lỗi được ghi vào error_log.
   3. XPATH: thống kê bài kiểm tra (điểm TB/cao/thấp, tỷ lệ đạt, phân bố điểm,
      câu hỏi sai nhiều nhất) được tính bằng XPath trên các file XML đó.

   Mọi hàm ở đây đều KHÔNG ném lỗi ra ngoài khi lưu file: nếu XML hỏng thì
   chỉ ghi log, việc nộp bài của sinh viên vẫn thành công như bình thường.
   ===================================================================== */

/* ---------- Đường dẫn ---------- */

function xmlThuMucGoc(): string {
    return dirname(__DIR__) . '/storage/bai_lam';
}

/* Trả về thư mục chứa XML của 1 bài kiểm tra. $tao = true thì tạo nếu chưa có
   (và tự đặt .htaccess chặn truy cập trực tiếp từ trình duyệt). */
function xmlThuMucBaiKiemTra(int $quizId, bool $tao = false): ?string {
    $dir = xmlThuMucGoc() . '/quiz_' . $quizId;
    if (is_dir($dir)) {
        return $dir;
    }
    if (!$tao) {
        return null;
    }

    $goc = dirname(xmlThuMucGoc()); // .../storage
    if (!is_dir($goc) && !@mkdir($goc, 0775, true) && !is_dir($goc)) {
        error_log('xml_helper: không tạo được thư mục ' . $goc);
        return null;
    }

    // Chặn sinh viên mở thẳng file XML của người khác bằng URL
    $htaccess = $goc . '/.htaccess';
    if (!is_file($htaccess)) {
        @file_put_contents(
            $htaccess,
            "<IfModule mod_authz_core.c>\n    Require all denied\n</IfModule>\n" .
            "<IfModule !mod_authz_core.c>\n    Order allow,deny\n    Deny from all\n</IfModule>\n"
        );
    }

    if (!is_dir(xmlThuMucGoc()) && !@mkdir(xmlThuMucGoc(), 0775, true) && !is_dir(xmlThuMucGoc())) {
        error_log('xml_helper: không tạo được thư mục ' . xmlThuMucGoc());
        return null;
    }
    if (!@mkdir($dir, 0775, true) && !is_dir($dir)) {
        error_log('xml_helper: không tạo được thư mục ' . $dir);
        return null;
    }
    return $dir;
}

function xmlDuongDanBaiLam(int $quizId, int $luotId): string {
    return xmlThuMucGoc() . '/quiz_' . $quizId . '/luot_' . $luotId . '.xml';
}

/* Xóa toàn bộ XML của 1 bài kiểm tra (khi sửa đề hoặc xóa bài kiểm tra). */
function xmlXoaThuMucBaiKiemTra(int $quizId): void {
    $dir = xmlThuMucBaiKiemTra($quizId, false);
    if ($dir === null) {
        return;
    }
    foreach (glob($dir . '/luot_*.xml') ?: [] as $f) {
        @unlink($f);
    }
    @rmdir($dir);
}

/* Xóa XML của 1 lượt làm bài (khi GV reset / mở lại lượt làm bài). */
function xmlXoaBaiLam(int $quizId, int $luotId): void {
    $f = xmlDuongDanBaiLam($quizId, $luotId);
    if (is_file($f)) {
        @unlink($f);
    }
}

/* ---------- Tiện ích XML ---------- */

/* Bỏ ký tự không hợp lệ trong XML 1.0 (vd ký tự điều khiển trong câu trả lời). */
function xmlLamSach($value): string {
    $s = (string) $value;
    $clean = preg_replace('/[^\x{9}\x{A}\x{D}\x{20}-\x{D7FF}\x{E000}-\x{FFFD}\x{10000}-\x{10FFFF}]/u', '', $s);
    return $clean === null ? '' : $clean;
}

/* Tạo phần tử có nội dung văn bản (dùng createTextNode nên tự escape &, <, >). */
function xmlPhanTu(DOMDocument $doc, string $tag, $value): DOMElement {
    $el = $doc->createElement($tag);
    $el->appendChild($doc->createTextNode(xmlLamSach($value)));
    return $el;
}

function xmlSo(float $n, int $le = 2): string {
    return number_format($n, $le, '.', '');
}

function xmlNgayGio(?string $mysqlDatetime): string {
    $ts = $mysqlDatetime ? strtotime($mysqlDatetime) : false;
    if ($ts === false) {
        $ts = time();
    }
    return date('Y-m-d\TH:i:s', $ts);
}

/* Kiểm tra XML theo file XSD trong api/xsd/. Trả về mảng thông báo lỗi
   (rỗng = hợp lệ). */
function xmlKiemTraXsd(DOMDocument $doc, string $tenXsd): array {
    $xsdPath = __DIR__ . '/xsd/' . $tenXsd;
    if (!is_file($xsdPath)) {
        return ['Không tìm thấy file schema ' . $tenXsd];
    }

    $truoc = libxml_use_internal_errors(true);
    libxml_clear_errors();
    $loi = [];
    $ok = @$doc->schemaValidate($xsdPath);
    if (!$ok) {
        foreach (libxml_get_errors() as $e) {
            $loi[] = trim($e->message) . ' (dòng ' . $e->line . ')';
        }
        if (count($loi) === 0) {
            $loi[] = 'XML không hợp lệ theo ' . $tenXsd;
        }
    }
    libxml_clear_errors();
    libxml_use_internal_errors($truoc);
    return $loi;
}

/* Dùng cho XML mà quizzes.php trả về trực tiếp: kiểm tra bằng XSD và CHỈ ghi
   log nếu sai (không chặn phản hồi để tránh làm hỏng giao diện). */
function xmlKiemTraVaGhiLog(DOMDocument $doc, string $tenXsd, string $nguon): void {
    try {
        $loi = xmlKiemTraXsd($doc, $tenXsd);
        if (count($loi) > 0) {
            error_log('XSD ' . $tenXsd . ' (' . $nguon . ') không hợp lệ: ' . implode(' | ', array_slice($loi, 0, 5)));
        }
    } catch (Throwable $e) {
        error_log('xmlKiemTraVaGhiLog: ' . $e->getMessage());
    }
}

/* ---------- 1. Tạo + lưu XML bài làm ---------- */

/* Dựng DOMDocument <BaiLam> từ CSDL cho 1 lượt làm bài ĐÃ NỘP.
   Trả về null nếu lượt làm bài không tồn tại hoặc chưa nộp. */
function xmlTaoBaiLam(PDO $pdo, int $luotId): ?DOMDocument {
    $stmt = $pdo->prepare(
        'SELECT l.id, l.hoc_sinh_id, l.bai_kiem_tra_id, l.trang_thai, l.diem_so,
                l.thoi_gian_bat_dau, l.thoi_gian_nop, b.tieu_de, u.ho_ten, u.ma_so_sv
         FROM luot_lam_bai l
         JOIN bai_kiem_tra b ON b.id = l.bai_kiem_tra_id
         LEFT JOIN users u ON u.username = l.hoc_sinh_id
         WHERE l.id = ? LIMIT 1'
    );
    $stmt->execute([$luotId]);
    $l = $stmt->fetch();
    if (!$l || $l['trang_thai'] !== 'da_nop') {
        return null;
    }
    $quizId = (int) $l['bai_kiem_tra_id'];

    ensureCheatLogTable($pdo);
    $stmtVp = $pdo->prepare('SELECT COUNT(*) FROM cheat_log WHERE luot_lam_bai_id = ?');
    $stmtVp->execute([$luotId]);
    $soViPham = (int) $stmtVp->fetchColumn();

    $stmtCh = $pdo->prepare(
        "SELECT id, dapan_dung, diem FROM cau_hoi
         WHERE bai_kiem_tra_id = ? AND loai_cau_hoi = 'trac_nghiem' ORDER BY id ASC"
    );
    $stmtCh->execute([$quizId]);
    $cauHoiList = $stmtCh->fetchAll();

    $stmtTl = $pdo->prepare('SELECT cau_hoi_id, cau_tra_loi FROM chi_tiet_bai_lam WHERE luot_lam_bai_id = ?');
    $stmtTl->execute([$luotId]);
    $traLoiMap = [];
    foreach ($stmtTl->fetchAll() as $t) {
        $traLoiMap[(int) $t['cau_hoi_id']] = (string) $t['cau_tra_loi'];
    }

    // Tổng điểm của cả bài (gồm cả câu tự luận do GV chấm tay)
    $stmtTongDiem = $pdo->prepare('SELECT COALESCE(SUM(diem), 0) FROM cau_hoi WHERE bai_kiem_tra_id = ?');
    $stmtTongDiem->execute([$quizId]);
    $tongDiem = (float) $stmtTongDiem->fetchColumn();

    $soDung = 0;
    $dsCau = [];
    foreach ($cauHoiList as $c) {
        $traLoi = $traLoiMap[(int) $c['id']] ?? '';
        $dapAnDung = (string) $c['dapan_dung'];
        $dung = laCauTraLoiDung($traLoi, $dapAnDung);
        if ($dung) {
            $soDung++;
        }
        $dsCau[] = ['id' => (int) $c['id'], 'traLoi' => $traLoi, 'dapAnDung' => $dapAnDung, 'dung' => $dung];
    }
    $tongCau = count($cauHoiList);

    $bd = $l['thoi_gian_bat_dau'] ? strtotime($l['thoi_gian_bat_dau']) : false;
    $nop = $l['thoi_gian_nop'] ? strtotime($l['thoi_gian_nop']) : false;
    $giay = ($bd !== false && $nop !== false) ? max(0, $nop - $bd) : 0;

    $doc = new DOMDocument('1.0', 'UTF-8');
    $doc->formatOutput = true;

    $root = $doc->createElement('BaiLam');
    $root->setAttribute('luotLamBaiId', (string) $luotId);
    $doc->appendChild($root);

    $sv = $doc->createElement('SinhVien');
    $sv->appendChild(xmlPhanTu($doc, 'TenDangNhap', $l['hoc_sinh_id']));
    $sv->appendChild(xmlPhanTu($doc, 'HoTen', ($l['ho_ten'] ?? '') !== '' ? $l['ho_ten'] : $l['hoc_sinh_id']));
    $sv->appendChild(xmlPhanTu($doc, 'MaSoSV', $l['ma_so_sv'] ?? ''));
    $root->appendChild($sv);

    $bkt = $doc->createElement('BaiKiemTra');
    $bkt->setAttribute('id', (string) $quizId);
    $bkt->appendChild(xmlPhanTu($doc, 'TieuDe', $l['tieu_de']));
    $bkt->appendChild(xmlPhanTu($doc, 'TongDiem', xmlSo($tongDiem)));
    $root->appendChild($bkt);

    $root->appendChild(xmlPhanTu($doc, 'ThoiGianBatDau', xmlNgayGio($l['thoi_gian_bat_dau'])));
    $root->appendChild(xmlPhanTu($doc, 'ThoiGianNop', xmlNgayGio($l['thoi_gian_nop'])));
    $root->appendChild(xmlPhanTu($doc, 'ThoiGianLamBaiGiay', (string) $giay));
    $root->appendChild(xmlPhanTu($doc, 'DiemSo', xmlSo((float) $l['diem_so'])));
    $root->appendChild(xmlPhanTu($doc, 'SoViPham', (string) $soViPham));
    $root->appendChild(xmlPhanTu($doc, 'TongSoCauTracNghiem', (string) $tongCau));
    $root->appendChild(xmlPhanTu($doc, 'SoCauDung', (string) $soDung));
    $root->appendChild(xmlPhanTu($doc, 'SoCauSai', (string) ($tongCau - $soDung)));

    $ds = $doc->createElement('DanhSachCauTraLoi');
    foreach ($dsCau as $c) {
        $el = $doc->createElement('CauTraLoi');
        $el->setAttribute('cauHoiId', (string) $c['id']);
        $el->setAttribute('traLoi', xmlLamSach($c['traLoi']));
        $el->setAttribute('dapAnDung', xmlLamSach($c['dapAnDung']));
        $el->setAttribute('dung', $c['dung'] ? 'true' : 'false');
        $ds->appendChild($el);
    }
    $root->appendChild($ds);

    return $doc;
}

/* Tạo XML bài làm, kiểm tra XSD rồi ghi ra file. Trả về đường dẫn file hoặc
   null nếu thất bại (đã ghi log). Không bao giờ ném lỗi. */
function xmlLuuBaiLam(PDO $pdo, int $luotId): ?string {
    try {
        $doc = xmlTaoBaiLam($pdo, $luotId);
        if ($doc === null) {
            return null;
        }

        $loi = xmlKiemTraXsd($doc, 'bai_lam.xsd');
        if (count($loi) > 0) {
            error_log('xmlLuuBaiLam: XML lượt ' . $luotId . ' không hợp lệ, không ghi file: ' . implode(' | ', array_slice($loi, 0, 5)));
            return null;
        }

        $quizId = (int) $doc->getElementsByTagName('BaiKiemTra')->item(0)->getAttribute('id');
        $dir = xmlThuMucBaiKiemTra($quizId, true);
        if ($dir === null) {
            return null;
        }

        $file = $dir . '/luot_' . $luotId . '.xml';
        if ($doc->save($file) === false) {
            error_log('xmlLuuBaiLam: không ghi được file ' . $file);
            return null;
        }
        return $file;
    } catch (Throwable $e) {
        error_log('xmlLuuBaiLam: ' . $e->getMessage());
        return null;
    }
}

/* ---------- 2. Đồng bộ file XML với CSDL ---------- */

/* Đảm bảo thư mục XML của 1 bài kiểm tra khớp với các lượt ĐÃ NỘP trong CSDL:
   - lượt chưa có file (bài nộp từ trước khi có tính năng này) -> tạo file
   - file cũ lệch điểm/số vi phạm so với CSDL -> ghi lại
   - file của lượt đã bị xóa / mở lại -> xóa file
   Trả về danh sách đường dẫn file hợp lệ. */
function xmlDongBoBaiLam(PDO $pdo, int $quizId): array {
    ensureCheatLogTable($pdo);

    $stmt = $pdo->prepare(
        "SELECT l.id, l.diem_so,
                (SELECT COUNT(*) FROM cheat_log cl WHERE cl.luot_lam_bai_id = l.id) AS so_vi_pham
         FROM luot_lam_bai l
         WHERE l.bai_kiem_tra_id = ? AND l.trang_thai = 'da_nop'
         ORDER BY l.id ASC"
    );
    $stmt->execute([$quizId]);
    $rows = $stmt->fetchAll();

    $dsFile = [];
    $idHopLe = [];
    foreach ($rows as $r) {
        $luotId = (int) $r['id'];
        $idHopLe[$luotId] = true;
        $file = xmlDuongDanBaiLam($quizId, $luotId);

        $moi = false;
        if (is_file($file)) {
            $sx = @simplexml_load_file($file);
            $moi = $sx !== false
                && isset($sx->DiemSo, $sx->SoViPham)
                && abs((float) $sx->DiemSo - (float) $r['diem_so']) < 0.005
                && (int) $sx->SoViPham === (int) $r['so_vi_pham'];
        }
        if (!$moi) {
            $file = xmlLuuBaiLam($pdo, $luotId);
        }
        if ($file !== null && is_file($file)) {
            $dsFile[] = $file;
        }
    }

    $dir = xmlThuMucBaiKiemTra($quizId, false);
    if ($dir !== null) {
        foreach (glob($dir . '/luot_*.xml') ?: [] as $f) {
            if (preg_match('/luot_(\d+)\.xml$/', $f, $m) && !isset($idHopLe[(int) $m[1]])) {
                @unlink($f);
            }
        }
    }

    return $dsFile;
}

/* ---------- 3. Thống kê bằng XPath ---------- */

/* Dựng XML <ThongKe> của 1 bài kiểm tra. Mọi con số đều được tính bằng XPath
   trên tập XML bài làm (không tính bằng SQL). Trả về null nếu không có bài. */
function xmlTaoThongKe(PDO $pdo, int $quizId): ?DOMDocument {
    $stmtQuiz = $pdo->prepare('SELECT id, tieu_de FROM bai_kiem_tra WHERE id = ? LIMIT 1');
    $stmtQuiz->execute([$quizId]);
    $quiz = $stmtQuiz->fetch();
    if (!$quiz) {
        return null;
    }

    // Tổng điểm của cả bài (điểm có thể gồm phần GV chấm tay cho câu tự luận)
    $stmtTong = $pdo->prepare('SELECT COALESCE(SUM(diem), 0) FROM cau_hoi WHERE bai_kiem_tra_id = ?');
    $stmtTong->execute([$quizId]);
    $tongDiem = (float) $stmtTong->fetchColumn();

    // Gộp tất cả file XML bài làm vào 1 cây <TapBaiLam> để truy vấn XPath
    $tap = new DOMDocument('1.0', 'UTF-8');
    $tapRoot = $tap->createElement('TapBaiLam');
    $tap->appendChild($tapRoot);
    foreach (xmlDongBoBaiLam($pdo, $quizId) as $file) {
        $d = new DOMDocument();
        if (@$d->load($file) && $d->documentElement) {
            $tapRoot->appendChild($tap->importNode($d->documentElement, true));
        }
    }
    $xp = new DOMXPath($tap);

    $soBai = (int) $xp->evaluate('count(/TapBaiLam/BaiLam)');
    $diemTb = $diemMax = $diemMin = 0.0;
    $soDat = 0;
    $tgTb = 0.0;
    $tongVp = (int) $xp->evaluate('sum(/TapBaiLam/BaiLam/SoViPham)');
    $phanBo = [];
    $topSai = [];

    // Đạt = đạt từ 50% tổng điểm của bài trở lên
    $nguongDat = $tongDiem * 0.5;

    if ($soBai > 0) {
        $diemTb = (float) $xp->evaluate('sum(/TapBaiLam/BaiLam/DiemSo) div count(/TapBaiLam/BaiLam)');
        // XPath 1.0 không có max()/min(): chọn bài không có bài nào điểm cao hơn / thấp hơn
        $diemMax = (float) $xp->evaluate('number(/TapBaiLam/BaiLam[not(DiemSo < /TapBaiLam/BaiLam/DiemSo)][1]/DiemSo)');
        $diemMin = (float) $xp->evaluate('number(/TapBaiLam/BaiLam[not(DiemSo > /TapBaiLam/BaiLam/DiemSo)][1]/DiemSo)');
        $soDat = (int) $xp->evaluate(sprintf('count(/TapBaiLam/BaiLam[DiemSo >= %.4F])', $nguongDat - 0.0001));
        $tgTb = (float) $xp->evaluate('sum(/TapBaiLam/BaiLam/ThoiGianLamBaiGiay) div count(/TapBaiLam/BaiLam)');

        // Phân bố điểm: 5 khoảng bằng nhau từ 0 đến tổng điểm
        for ($i = 0; $i < 5; $i++) {
            $tu = $tongDiem * $i / 5;
            $den = $tongDiem * ($i + 1) / 5;
            if ($i < 4) {
                $expr = sprintf('count(/TapBaiLam/BaiLam[DiemSo >= %.4F and DiemSo < %.4F])', $tu - 0.0001, $den - 0.0001);
            } else {
                $expr = sprintf('count(/TapBaiLam/BaiLam[DiemSo >= %.4F])', $tu - 0.0001);
            }
            $phanBo[] = ['tu' => $tu, 'den' => $den, 'soLuong' => (int) $xp->evaluate($expr)];
        }

        // Câu hỏi bị sai nhiều nhất
        $ids = [];
        foreach ($xp->query('/TapBaiLam/BaiLam/DanhSachCauTraLoi/CauTraLoi/@cauHoiId') as $attr) {
            $ids[(int) $attr->value] = true;
        }
        $thongKeCau = [];
        foreach (array_keys($ids) as $cid) {
            $lam = (int) $xp->evaluate(sprintf('count(/TapBaiLam/BaiLam/DanhSachCauTraLoi/CauTraLoi[@cauHoiId = "%d"])', $cid));
            $sai = (int) $xp->evaluate(sprintf('count(/TapBaiLam/BaiLam/DanhSachCauTraLoi/CauTraLoi[@cauHoiId = "%d" and @dung = "false"])', $cid));
            if ($sai > 0) {
                $thongKeCau[] = ['id' => $cid, 'sai' => $sai, 'lam' => $lam];
            }
        }
        usort($thongKeCau, function ($a, $b) {
            return $b['sai'] <=> $a['sai'] ?: $a['id'] <=> $b['id'];
        });
        $topSai = array_slice($thongKeCau, 0, 5);
    }

    // Lấy nội dung các câu hỏi trong top
    $noiDung = [];
    if (count($topSai) > 0) {
        $in = implode(',', array_fill(0, count($topSai), '?'));
        $stmtNd = $pdo->prepare("SELECT id, noi_dung FROM cau_hoi WHERE id IN ($in)");
        $stmtNd->execute(array_column($topSai, 'id'));
        foreach ($stmtNd->fetchAll() as $r) {
            $noiDung[(int) $r['id']] = (string) $r['noi_dung'];
        }
    }

    // Dựng XML kết quả thống kê
    $doc = new DOMDocument('1.0', 'UTF-8');
    $doc->formatOutput = true;
    $root = $doc->createElement('ThongKe');
    $root->setAttribute('quizId', (string) $quizId);
    $doc->appendChild($root);

    $root->appendChild(xmlPhanTu($doc, 'TieuDe', $quiz['tieu_de']));
    $root->appendChild(xmlPhanTu($doc, 'TongDiem', xmlSo($tongDiem)));
    $root->appendChild(xmlPhanTu($doc, 'SoBaiNop', (string) $soBai));
    $root->appendChild(xmlPhanTu($doc, 'DiemTrungBinh', xmlSo($diemTb)));
    $root->appendChild(xmlPhanTu($doc, 'DiemCaoNhat', xmlSo($diemMax)));
    $root->appendChild(xmlPhanTu($doc, 'DiemThapNhat', xmlSo($diemMin)));
    $root->appendChild(xmlPhanTu($doc, 'SoBaiDat', (string) $soDat));
    $root->appendChild(xmlPhanTu($doc, 'TyLeDat', xmlSo($soBai > 0 ? $soDat / $soBai * 100 : 0, 1)));
    $root->appendChild(xmlPhanTu($doc, 'ThoiGianTrungBinhGiay', (string) (int) round($tgTb)));
    $root->appendChild(xmlPhanTu($doc, 'TongSoViPham', (string) $tongVp));

    $pb = $doc->createElement('PhanBoDiem');
    foreach ($phanBo as $k) {
        $el = $doc->createElement('PhanKhoang');
        $el->setAttribute('tu', xmlSo($k['tu']));
        $el->setAttribute('den', xmlSo($k['den']));
        $el->setAttribute('soLuong', (string) $k['soLuong']);
        $pb->appendChild($el);
    }
    $root->appendChild($pb);

    $ds = $doc->createElement('CauHoiSaiNhieuNhat');
    foreach ($topSai as $c) {
        $el = $doc->createElement('CauHoi');
        $el->setAttribute('id', (string) $c['id']);
        $el->setAttribute('soLanSai', (string) $c['sai']);
        $el->setAttribute('soLanLam', (string) $c['lam']);
        $el->setAttribute('tyLeSai', xmlSo($c['lam'] > 0 ? $c['sai'] / $c['lam'] * 100 : 0, 1));
        $nd = $noiDung[$c['id']] ?? '';
        if (mb_strlen($nd, 'UTF-8') > 200) {
            $nd = mb_substr($nd, 0, 200, 'UTF-8') . '...';
        }
        $el->appendChild(xmlPhanTu($doc, 'NoiDung', $nd));
        $ds->appendChild($el);
    }
    $root->appendChild($ds);

    return $doc;
}
