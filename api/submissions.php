<?php
/* =====================================================================
   submissions.php: SINH VIÊN NỘP BÀI TẬP, GIẢNG VIÊN XEM / TẢI BÀI NỘP.

   - POST ?action=sync   (SV)  : nhận 1 file XML bài nộp (xem xsd/bai_nop.xsd).
        Trình duyệt sinh viên tạo XML này; nếu lúc nộp KHÔNG có mạng, XML được giữ
        trên thiết bị và tự gửi lên đây khi có mạng lại. Server:
          1) kiểm tra XML bằng XSD,
          2) dùng XPath để đọc từng trường (sinh viên, bài tập, ghi chú, tệp...),
          3) lưu vào bảng bai_nop -> giảng viên thấy ngay trong mục bài tập của môn.
        Gửi lại cùng 1 clientId nhiều lần vẫn chỉ tạo 1 bài nộp (chống trùng).
   - GET                 : danh sách bài nộp. SV chỉ thấy bài của CHÍNH MÌNH,
                           GV thấy tất cả (lọc theo ?homework_id= / ?subject_id=).
   - GET ?id=<n>         : xem tệp (chỉ pdf/ảnh/txt mở trực tiếp), &download=1 để tải về.
                           SV chỉ mở được tệp của mình; GV mở được mọi tệp.
   ===================================================================== */
require __DIR__ . '/config.php';
require_once __DIR__ . '/xml_helper.php';

const NOP_MAX_BYTES = 10 * 1024 * 1024; // 10MB / tệp (XML base64 lớn hơn ~33%)

class NopLoi extends Exception {
    public $httpCode;
    public function __construct(string $message, int $httpCode = 400) {
        parent::__construct($message);
        $this->httpCode = $httpCode;
    }
}

function nopTraLoi(int $code, array $body): void {
    http_response_code($code);
    echo json_encode($body);
    exit;
}

/* Tự tạo bảng bai_nop nếu database cũ chưa có (không cần import lại schema.sql). */
function nopDamBaoBang(PDO $pdo): void {
    if (!empty($_SESSION['_bai_nop_ok'])) {
        return;
    }
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS bai_nop (
            id INT AUTO_INCREMENT PRIMARY KEY,
            client_id VARCHAR(64) NOT NULL,
            homework_id VARCHAR(50) NOT NULL,
            subject_id VARCHAR(50) NULL,
            sinh_vien VARCHAR(50) NOT NULL,
            ghi_chu TEXT NULL,
            file_name VARCHAR(255) NOT NULL,
            mime_type VARCHAR(150) NOT NULL DEFAULT \'application/octet-stream\',
            file_size INT UNSIGNED NOT NULL DEFAULT 0,
            file_data LONGBLOB NOT NULL,
            che_do ENUM(\'online\', \'offline\') NOT NULL DEFAULT \'online\',
            thoi_gian_nop DATETIME NOT NULL,
            thoi_gian_nhan DATETIME NOT NULL,
            UNIQUE KEY uq_bai_nop_client (sinh_vien, client_id),
            KEY idx_bai_nop_homework (homework_id),
            KEY idx_bai_nop_subject (subject_id),
            CONSTRAINT fk_bai_nop_homework
                FOREIGN KEY (homework_id) REFERENCES homeworks(id)
                ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT fk_bai_nop_subject
                FOREIGN KEY (subject_id) REFERENCES subjects(id)
                ON DELETE SET NULL ON UPDATE CASCADE,
            CONSTRAINT fk_bai_nop_sinh_vien
                FOREIGN KEY (sinh_vien) REFERENCES users(username)
                ON DELETE CASCADE ON UPDATE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
    );
    $_SESSION['_bai_nop_ok'] = true;
}

nopDamBaoBang($pdo);

/* Loại tệp -> kiểu MIME. Tính theo đuôi tệp trên SERVER (không tin MIME do trình duyệt gửi). */
function nopMimeTheoDuoi(string $fileName): string {
    $map = [
        'pdf' => 'application/pdf',
        'png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg',
        'gif' => 'image/gif', 'webp' => 'image/webp',
        'txt' => 'text/plain; charset=utf-8',
        'doc' => 'application/msword',
        'docx' => 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'xls' => 'application/vnd.ms-excel',
        'xlsx' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'ppt' => 'application/vnd.ms-powerpoint',
        'pptx' => 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'zip' => 'application/zip',
    ];
    $ext = strtolower(pathinfo($fileName, PATHINFO_EXTENSION));
    return $map[$ext] ?? 'application/octet-stream';
}

/* Chỉ các loại này được mở trực tiếp trên trình duyệt; mọi loại khác (html, svg, js...) luôn
   bị ép TẢI VỀ để bài nộp của sinh viên không thể chạy script trên trang của giảng viên. */
function nopChoPhepMoTrucTiep(string $fileName): bool {
    $ext = strtolower(pathinfo($fileName, PATHINFO_EXTENSION));
    return in_array($ext, ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'txt'], true);
}

function nopLamSachTenTep(string $name): string {
    $name = str_replace(['\\', '/'], '_', $name);
    $name = preg_replace('/[\x00-\x1F\x7F"]/u', '', $name) ?? '';
    $name = trim($name);
    if ($name === '' || $name === '.' || $name === '..') {
        return '';
    }
    if (function_exists('mb_substr')) {
        return mb_substr($name, 0, 200, 'UTF-8');
    }
    return substr($name, 0, 200);
}

/* ---------------------------------------------------------------------
   LƯU BÀI NỘP RA FILE .XML: storage/bai_nop/<ma_bai_tap>/bai_nop_<id>.xml
   (kiểm tra bằng api/xsd/bai_nop_luu.xsd; không chứa nội dung tệp).
   --------------------------------------------------------------------- */
function nopDuongDanXml(string $homeworkId, int $id): string {
    $an = preg_replace('/[^A-Za-z0-9_\-]/', '_', $homeworkId);
    return dirname(__DIR__) . '/storage/bai_nop/' . $an . '/bai_nop_' . $id . '.xml';
}

function nopTaoXmlLuu(PDO $pdo, int $id): ?DOMDocument {
    $stmt = $pdo->prepare(
        'SELECT n.id, n.client_id, n.homework_id, n.subject_id, n.sinh_vien, n.ghi_chu, n.file_name, n.mime_type,
                n.file_size, n.che_do, n.thoi_gian_nop, n.thoi_gian_nhan, u.ho_ten, u.ma_so_sv, s.name AS subject_name
         FROM bai_nop n
         LEFT JOIN users u ON u.username = n.sinh_vien
         LEFT JOIN subjects s ON s.id = n.subject_id
         WHERE n.id = ? LIMIT 1'
    );
    $stmt->execute([$id]);
    $r = $stmt->fetch();
    if (!$r) {
        return null;
    }
    $doc = new DOMDocument('1.0', 'UTF-8');
    $doc->formatOutput = true;
    $root = $doc->createElement('BaiNopDaLuu');
    $root->setAttribute('id', (string) $r['id']);
    $root->setAttribute('clientId', (string) $r['client_id']);
    $root->setAttribute('cheDo', (string) $r['che_do']);
    $doc->appendChild($root);

    $sv = $doc->createElement('SinhVien');
    $sv->appendChild(xmlPhanTu($doc, 'TenDangNhap', $r['sinh_vien']));
    $sv->appendChild(xmlPhanTu($doc, 'HoTen', $r['ho_ten'] ?? ''));
    $sv->appendChild(xmlPhanTu($doc, 'MaSoSV', $r['ma_so_sv'] ?? ''));
    $root->appendChild($sv);

    $mh = xmlPhanTu($doc, 'MonHoc', $r['subject_name'] ?? '');
    $mh->setAttribute('id', (string) ($r['subject_id'] ?? ''));
    $root->appendChild($mh);
    $bt = $doc->createElement('BaiTap');
    $bt->setAttribute('id', (string) $r['homework_id']);
    $root->appendChild($bt);

    $root->appendChild(xmlPhanTu($doc, 'GhiChu', $r['ghi_chu'] ?? ''));
    $root->appendChild(xmlPhanTu($doc, 'ThoiGianNop', $r['thoi_gian_nop']));
    $root->appendChild(xmlPhanTu($doc, 'ThoiGianNhan', $r['thoi_gian_nhan']));
    $tep = $doc->createElement('Tep');
    $tep->setAttribute('ten', (string) $r['file_name']);
    $tep->setAttribute('loai', (string) $r['mime_type']);
    $tep->setAttribute('kichThuoc', (string) (int) $r['file_size']);
    $root->appendChild($tep);
    return $doc;
}

/* Ghi file XML của bài nộp $id. Trả về đường dẫn, hoặc null nếu lỗi (không làm hỏng việc nộp bài). */
function nopLuuXml(PDO $pdo, int $id): ?string {
    try {
        $doc = nopTaoXmlLuu($pdo, $id);
        if ($doc === null) {
            return null;
        }
        $loi = xmlKiemTraXsd($doc, 'bai_nop_luu.xsd');
        if (count($loi) > 0) {
            error_log('submissions.php: XML lưu không hợp lệ: ' . implode(' | ', array_slice($loi, 0, 3)));
            return null;
        }
        $homeworkId = (string) $doc->getElementsByTagName('BaiTap')->item(0)->getAttribute('id');
        $path = nopDuongDanXml($homeworkId, $id);
        $dir = dirname($path);
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            error_log('submissions.php: không tạo được thư mục ' . $dir);
            return null;
        }
        $htaccess = dirname($dir) . '/../.htaccess';
        if (!is_file($htaccess)) {
            @file_put_contents($htaccess, "<IfModule mod_authz_core.c>\n    Require all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\n    Order allow,deny\n    Deny from all\n</IfModule>\n");
        }
        return $doc->save($path) !== false ? $path : null;
    } catch (Throwable $e) {
        error_log('submissions.php: nopLuuXml: ' . $e->getMessage());
        return null;
    }
}

/* ---------------------------------------------------------------------
   XỬ LÝ 1 FILE XML BÀI NỘP: XSD -> XPath -> lưu DB.
   Ném NopLoi nếu có lỗi; trả về mảng kết quả nếu thành công.
   --------------------------------------------------------------------- */
function nopXuLyXml(PDO $pdo, string $raw, string $nguoiNop): array {
    // Chặn DOCTYPE/ENTITY: không cho XML tự khai báo thực thể (XXE / billion laughs).
    if (stripos($raw, '<!DOCTYPE') !== false || stripos($raw, '<!ENTITY') !== false) {
        throw new NopLoi('XML không được chứa DOCTYPE/ENTITY.', 400);
    }

    $truoc = libxml_use_internal_errors(true);
    libxml_clear_errors();
    try {
        $doc = new DOMDocument('1.0', 'UTF-8');
        // LIBXML_PARSEHUGE: nội dung base64 của tệp có thể vượt giới hạn 10MB/nút mặc định của libxml.
        $ok = $doc->loadXML($raw, LIBXML_NONET | LIBXML_PARSEHUGE);
        if (!$ok) {
            $e = libxml_get_last_error();
            throw new NopLoi('XML không đúng cú pháp' . ($e ? ': ' . trim($e->message) : '.'), 400);
        }
    } finally {
        libxml_clear_errors();
        libxml_use_internal_errors($truoc);
    }

    $loi = xmlKiemTraXsd($doc, 'bai_nop.xsd');
    if (count($loi) > 0) {
        error_log('submissions.php: XML bài nộp không hợp lệ: ' . implode(' | ', array_slice($loi, 0, 3)));
        throw new NopLoi('XML bài nộp không hợp lệ: ' . $loi[0], 400);
    }

    /* ----- XPath: đọc từng trường của bài nộp ----- */
    $xp = new DOMXPath($doc);
    $clientId   = trim((string) $xp->evaluate('string(/BaiNop/@clientId)'));
    $cheDo      = (string) $xp->evaluate('string(/BaiNop/@cheDo)');
    $tenDangNhap = trim((string) $xp->evaluate('string(/BaiNop/SinhVien/TenDangNhap)'));
    $baiTapId   = trim((string) $xp->evaluate('string(/BaiNop/BaiTap/@id)'));
    $ghiChu     = trim((string) $xp->evaluate('string(/BaiNop/GhiChu)'));
    $thoiGianNop = trim((string) $xp->evaluate('string(/BaiNop/ThoiGianNop)'));
    $tenTep     = nopLamSachTenTep((string) $xp->evaluate('string(/BaiNop/Tep/@ten)'));
    $kichThuocKhaiBao = (int) $xp->evaluate('number(/BaiNop/Tep/@kichThuoc)');
    $base64     = (string) $xp->evaluate('string(/BaiNop/Tep)');

    // Sinh viên đang đăng nhập phải đúng là người ghi trong XML: không nộp hộ / nộp giả mạo người khác.
    if ($tenDangNhap !== $nguoiNop) {
        throw new NopLoi('Bài nộp này thuộc về tài khoản "' . $tenDangNhap . '", không phải tài khoản đang đăng nhập.', 403);
    }
    if ($tenTep === '') {
        throw new NopLoi('Tên tệp không hợp lệ.', 400);
    }

    // Chống nộp trùng: cùng sinh viên + cùng clientId thì trả lại bài đã nộp.
    $stmt = $pdo->prepare('SELECT id FROM bai_nop WHERE sinh_vien = ? AND client_id = ? LIMIT 1');
    $stmt->execute([$nguoiNop, $clientId]);
    $daCo = $stmt->fetchColumn();
    if ($daCo !== false) {
        return ['success' => true, 'duplicate' => true, 'id' => (int) $daCo, 'message' => 'Bài này đã được nộp trước đó.'];
    }

    // Bài tập phải tồn tại và do GIẢNG VIÊN giao (sinh viên không nộp vào bài tự tạo).
    $stmt = $pdo->prepare(
        'SELECT h.id, h.title, h.subject_id, s.name AS subject_name, s.cho_phep_nop_bai
         FROM homeworks h JOIN users u ON u.username = h.created_by
         LEFT JOIN subjects s ON s.id = h.subject_id
         WHERE h.id = ? AND u.role = \'gv\' LIMIT 1'
    );
    $stmt->execute([$baiTapId]);
    $baiTap = $stmt->fetch();
    if (!$baiTap) {
        throw new NopLoi('Không tìm thấy bài tập này (có thể giảng viên đã xóa). Bài nộp không được nhận.', 404);
    }

    // Giảng viên chưa mở nộp bài cho môn này.
    if ($baiTap['subject_id'] !== null && (int) $baiTap['cho_phep_nop_bai'] !== 1) {
        throw new NopLoi('Giảng viên đã đóng nộp bài tập của môn "' . $baiTap['subject_name'] . '". Bài nộp không được nhận.', 403);
    }

    /* ----- Giải mã tệp ----- */
    $base64 = preg_replace('/\s+/', '', $base64) ?? '';
    $duLieu = base64_decode($base64, true);
    unset($base64);
    if ($duLieu === false) {
        throw new NopLoi('Nội dung tệp (base64) bị hỏng.', 400);
    }
    $kichThuoc = strlen($duLieu);
    if ($kichThuoc === 0) {
        throw new NopLoi('Tệp rỗng.', 400);
    }
    if ($kichThuoc > NOP_MAX_BYTES) {
        throw new NopLoi('Tệp quá lớn, tối đa ' . (NOP_MAX_BYTES / 1024 / 1024) . 'MB.', 413);
    }
    if ($kichThuocKhaiBao !== $kichThuoc) {
        throw new NopLoi('Tệp bị lỗi khi truyền (kích thước không khớp), vui lòng nộp lại.', 400);
    }

    /* ----- Thời gian: giờ sinh viên bấm nộp (không được ở tương lai) ----- */
    $now = new DateTime('now');
    try {
        $tn = new DateTime($thoiGianNop);
        if ($tn > $now) {
            $tn = clone $now;
        }
        $tn->setTimezone($now->getTimezone());
    } catch (Exception $e) {
        $tn = clone $now;
    }

    try {
        $stmt = $pdo->prepare(
            'INSERT INTO bai_nop
                (client_id, homework_id, subject_id, sinh_vien, ghi_chu, file_name, mime_type, file_size, file_data, che_do, thoi_gian_nop, thoi_gian_nhan)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([
            $clientId,
            $baiTap['id'],
            $baiTap['subject_id'],
            $nguoiNop,
            $ghiChu !== '' ? $ghiChu : null,
            $tenTep,
            nopMimeTheoDuoi($tenTep),
            $kichThuoc,
            $duLieu,
            $cheDo === 'offline' ? 'offline' : 'online',
            $tn->format('Y-m-d H:i:s'),
            $now->format('Y-m-d H:i:s'),
        ]);
    } catch (PDOException $e) {
        // 2 yêu cầu cùng clientId đến cùng lúc: yêu cầu sau vi phạm UNIQUE -> coi như đã nộp.
        if (isset($e->errorInfo[1]) && (int) $e->errorInfo[1] === 1062) {
            $stmt = $pdo->prepare('SELECT id FROM bai_nop WHERE sinh_vien = ? AND client_id = ? LIMIT 1');
            $stmt->execute([$nguoiNop, $clientId]);
            return ['success' => true, 'duplicate' => true, 'id' => (int) $stmt->fetchColumn(), 'message' => 'Bài này đã được nộp trước đó.'];
        }
        throw $e;
    }

    $idMoi = (int) $pdo->lastInsertId();
    nopLuuXml($pdo, $idMoi); // lưu thêm 1 bản .xml trong storage/bai_nop/

    return [
        'success' => true,
        'duplicate' => false,
        'id' => $idMoi,
        'homeworkTitle' => $baiTap['title'],
        'fileName' => $tenTep,
        'receivedAt' => $now->format('Y-m-d H:i:s'),
        'message' => 'Nộp bài thành công.',
    ];
}

$method = $_SERVER['REQUEST_METHOD'];

/* ---------------------- POST: nhận XML bài nộp ---------------------- */
if ($method === 'POST') {
    requireLogin();
    if (!isSV()) {
        nopTraLoi(403, ['error' => 'Chỉ sinh viên mới nộp được bài tập.']);
    }
    if (($_GET['action'] ?? '') !== 'sync') {
        nopTraLoi(400, ['error' => 'Thiếu action=sync.']);
    }

    $contentLength = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
    $raw = file_get_contents('php://input');
    if ($raw === false || $raw === '') {
        if ($contentLength > 0) {
            nopTraLoi(413, ['error' => 'Bài nộp quá lớn so với giới hạn post_max_size (' . ini_get('post_max_size') . ') của máy chủ PHP. Hãy chọn tệp nhỏ hơn hoặc tăng post_max_size trong php.ini.']);
        }
        nopTraLoi(400, ['error' => 'Không nhận được dữ liệu XML.']);
    }

    try {
        $ketQua = nopXuLyXml($pdo, $raw, currentUser()['username']);
    } catch (NopLoi $e) {
        nopTraLoi($e->httpCode, ['error' => $e->getMessage()]);
    }
    nopTraLoi(200, $ketQua);
}

/* ---------------------- GET: xem/tải tệp hoặc liệt kê ---------------------- */
if ($method === 'GET' || $method === 'HEAD') {
    requireLogin();
    $user = currentUser();

    // Tải file XML của 1 bài nộp: ?id=<id>&xml=1 (giảng viên, hoặc chính sinh viên đã nộp)
    if (isset($_GET['id']) && isset($_GET['xml'])) {
        $id = (int) $_GET['id'];
        $stmt = $pdo->prepare('SELECT sinh_vien, homework_id, subject_id FROM bai_nop WHERE id = ? LIMIT 1');
        $stmt->execute([$id]);
        $b = $stmt->fetch();
        if (!$b || ($user['role'] === 'sv' && $b['sinh_vien'] !== $user['username']) || !gvCoQuyenMon($pdo, $b['subject_id'])) {
            nopTraLoi(404, ['error' => 'Không tìm thấy bài nộp.']);
        }
        $path = nopDuongDanXml((string) $b['homework_id'], $id);
        if (!is_file($path)) {
            nopLuuXml($pdo, $id); // bài nộp cũ chưa có file XML -> tạo lúc này
        }
        if (!is_file($path)) {
            nopTraLoi(500, ['error' => 'Không tạo được file XML (kiểm tra quyền ghi thư mục storage/).']);
        }
        header('Content-Type: application/xml; charset=utf-8');
        header('Content-Length: ' . filesize($path));
        header('Content-Disposition: attachment; filename="bai_nop_' . $id . '.xml"');
        header('X-Content-Type-Options: nosniff');
        header('Cache-Control: private, no-store');
        if ($method !== 'HEAD') {
            readfile($path);
        }
        exit;
    }

    if (isset($_GET['id'])) {
        $stmt = $pdo->prepare('SELECT sinh_vien, subject_id, file_name, file_data FROM bai_nop WHERE id = ? LIMIT 1');
        $stmt->execute([(int) $_GET['id']]);
        $f = $stmt->fetch();
        // SV mở bài của người khác: trả 404 (không tiết lộ bài đó có tồn tại hay không).
        if (!$f || ($user['role'] === 'sv' && $f['sinh_vien'] !== $user['username']) || !gvCoQuyenMon($pdo, $f['subject_id'])) {
            nopTraLoi(404, ['error' => 'Không tìm thấy bài nộp.']);
        }

        $ten = $f['file_name'];
        $taiVe = (isset($_GET['download']) && $_GET['download'] === '1') || !nopChoPhepMoTrucTiep($ten);
        $mime = nopChoPhepMoTrucTiep($ten) ? nopMimeTheoDuoi($ten) : 'application/octet-stream';
        $asciiName = preg_replace('/[^A-Za-z0-9._-]/', '_', $ten);

        header('Content-Type: ' . $mime);
        header('Content-Length: ' . strlen($f['file_data']));
        header('Content-Disposition: ' . ($taiVe ? 'attachment' : 'inline')
            . '; filename="' . $asciiName . '"; filename*=UTF-8\'\'' . rawurlencode($ten));
        header('X-Content-Type-Options: nosniff');
        header('Cache-Control: private, no-store');
        if ($method !== 'HEAD') {
            echo $f['file_data'];
        }
        exit;
    }

    $sql = 'SELECT n.id, n.homework_id AS homeworkId, h.title AS homeworkTitle,
                   n.subject_id AS subjectId, s.name AS subjectName,
                   n.sinh_vien AS student, u.ho_ten AS studentName, u.ma_so_sv AS maSoSv,
                   n.ghi_chu AS note, n.file_name AS fileName, n.mime_type AS mimeType,
                   n.file_size AS fileSize, n.che_do AS mode,
                   n.thoi_gian_nop AS submittedAt, n.thoi_gian_nhan AS receivedAt
            FROM bai_nop n
            JOIN homeworks h ON h.id = n.homework_id
            LEFT JOIN subjects s ON s.id = n.subject_id
            LEFT JOIN users u ON u.username = n.sinh_vien
            WHERE 1 = 1';
    $params = [];

    if ($user['role'] === 'sv') {
        $sql .= ' AND n.sinh_vien = ?';
        $params[] = $user['username'];
    }
    if (!empty($_GET['homework_id'])) {
        $sql .= ' AND n.homework_id = ?';
        $params[] = (string) $_GET['homework_id'];
    }
    if (!empty($_GET['subject_id'])) {
        $sql .= ' AND n.subject_id = ?';
        $params[] = (string) $_GET['subject_id'];
    }
    $sql .= gvLocMon($pdo, 'n.subject_id', $params); // giảng viên theo môn chỉ thấy bài nộp môn mình
    $sql .= ' ORDER BY n.thoi_gian_nop DESC, n.id DESC';

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $rows = $stmt->fetchAll();
    foreach ($rows as &$r) {
        $r['id'] = (int) $r['id'];
        $r['fileSize'] = (int) $r['fileSize'];
    }
    unset($r);
    echo json_encode($rows);
    exit;
}

nopTraLoi(405, ['error' => 'Method không được hỗ trợ.']);
