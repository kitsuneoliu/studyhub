<?php
require __DIR__ . '/config.php';

$method = $_SERVER['REQUEST_METHOD'];

function isValidCurriculumUrl(string $url): bool {
    return (bool) filter_var($url, FILTER_VALIDATE_URL) && preg_match('#^https?://#i', $url) === 1;
}

/* =====================================================================
   GET: xem danh sách giáo trình (không kèm nội dung file, quá nặng), hoặc
   tải/xem 1 file cụ thể qua ?action=download&id=...
   ===================================================================== */
if ($method === 'GET' || $method === 'HEAD') {
    $action = $_GET['action'] ?? '';

    if ($action === 'download') {
        $id = (int) ($_GET['id'] ?? 0);
        $stmt = $pdo->prepare("SELECT file_name, mime_type, file_data FROM giao_trinh WHERE id = ? AND loai = 'file' LIMIT 1");
        $stmt->execute([$id]);
        $file = $stmt->fetch();

        if (!$file || $file['file_data'] === null) {
            http_response_code(404);
            echo json_encode(['error' => 'Không tìm thấy tệp giáo trình.']);
            exit;
        }

        $asAttachment = isset($_GET['download']) && $_GET['download'] === '1';
        header('Content-Type: ' . ($file['mime_type'] ?: 'application/octet-stream'));
        header('Content-Length: ' . strlen($file['file_data']));
        header('Content-Disposition: ' . ($asAttachment ? 'attachment' : 'inline') . '; filename="' . str_replace('"', '', $file['file_name']) . '"');
        echo $file['file_data'];
        exit;
    }

    // Bất kỳ ai (kể cả khách chưa đăng nhập) đều xem được danh sách giáo
    // trình, giống cách môn học đang được hiển thị công khai. KHÔNG select
    // file_data ở đây vì có thể rất nặng - chỉ tải khi bấm xem/tải riêng.
    $subjectId = trim($_GET['subject_id'] ?? '');
    $columns = 'id, subject_id AS subjectId, tieu_de AS tieuDe, mo_ta AS moTa, loai,
                duong_dan AS duongDan, file_name AS fileName, mime_type AS mimeType,
                file_size AS fileSize, created_by AS createdBy, created_at AS createdAt';

    $params = [];
    $where = '1 = 1';
    if ($subjectId !== '') {
        $where .= ' AND subject_id = ?';
        $params[] = $subjectId;
    }
    $where .= gvLocMon($pdo, 'subject_id', $params); // giảng viên theo môn chỉ thấy giáo trình môn mình
    $stmt = $pdo->prepare("SELECT $columns FROM giao_trinh WHERE $where ORDER BY created_at DESC, id DESC");
    $stmt->execute($params);
    echo json_encode($stmt->fetchAll());
    exit;
}

/* =====================================================================
   POST: thêm giáo trình mới bằng link (JSON: subjectId, tieuDe, moTa, duongDan).
   Tính năng tải file trực tiếp lên giáo trình đã được gỡ bỏ.
   ===================================================================== */
if ($method === 'POST') {
    requireGV();
    $me = currentUser();

    $data = readJsonBody();
    $subjectId = trim($data['subjectId'] ?? '');
    $tieuDe = trim($data['tieuDe'] ?? '');
    $moTa = trim($data['moTa'] ?? '');
    $duongDan = trim($data['duongDan'] ?? '');

    if ($subjectId === '' || $tieuDe === '' || $duongDan === '') {
        http_response_code(400);
        echo json_encode(['error' => 'Vui lòng chọn môn học, nhập tiêu đề và đường dẫn tài liệu.']);
        exit;
    }
    if (!isValidCurriculumUrl($duongDan)) {
        http_response_code(400);
        echo json_encode(['error' => 'Đường dẫn không hợp lệ. Vui lòng nhập link đầy đủ, bắt đầu bằng http:// hoặc https:// (VD: link Google Drive, link trang web...).']);
        exit;
    }

    requireGvMon($pdo, $subjectId);

    $stmtCheck = $pdo->prepare('SELECT id FROM subjects WHERE id = ? LIMIT 1');
    $stmtCheck->execute([$subjectId]);
    if (!$stmtCheck->fetch()) {
        http_response_code(404);
        echo json_encode(['error' => 'Không tìm thấy môn học đã chọn.']);
        exit;
    }

    $stmt = $pdo->prepare("INSERT INTO giao_trinh (subject_id, tieu_de, mo_ta, loai, duong_dan, created_by) VALUES (?, ?, ?, 'link', ?, ?)");
    $stmt->execute([$subjectId, $tieuDe, $moTa, $duongDan, $me['username']]);
    $newId = (int) $pdo->lastInsertId();

    echo json_encode([
        'id' => $newId,
        'subjectId' => $subjectId,
        'tieuDe' => $tieuDe,
        'moTa' => $moTa,
        'loai' => 'link',
        'duongDan' => $duongDan,
        'createdBy' => $me['username'],
    ]);
    exit;
}

/* =====================================================================
   PUT: chỉ sửa thông tin (tiêu đề/mô tả/link) - KHÔNG hỗ trợ đổi tệp đã tải
   lên; nếu muốn đổi tệp, GV xóa rồi thêm mới.
   ===================================================================== */
if ($method === 'PUT') {
    requireGV();

    $id = (int) ($_GET['id'] ?? 0);
    if ($id <= 0) {
        http_response_code(400);
        echo json_encode(['error' => 'Thiếu id tài liệu giáo trình.']);
        exit;
    }

    $stmtExisting = $pdo->prepare('SELECT * FROM giao_trinh WHERE id = ? LIMIT 1');
    $stmtExisting->execute([$id]);
    $existing = $stmtExisting->fetch();
    if (!$existing) {
        http_response_code(404);
        echo json_encode(['error' => 'Không tìm thấy tài liệu giáo trình.']);
        exit;
    }
    requireGvMon($pdo, $existing['subject_id']);

    $data = readJsonBody();
    $tieuDe = array_key_exists('tieuDe', $data) ? trim($data['tieuDe']) : $existing['tieu_de'];
    $moTa = array_key_exists('moTa', $data) ? trim($data['moTa']) : $existing['mo_ta'];

    if ($tieuDe === '') {
        http_response_code(400);
        echo json_encode(['error' => 'Tiêu đề không được để trống.']);
        exit;
    }

    $duongDanMoi = $existing['duong_dan'];
    if ($existing['loai'] === 'link') {
        $duongDanMoi = array_key_exists('duongDan', $data) ? trim($data['duongDan']) : $existing['duong_dan'];
        if ($duongDanMoi === '' || !isValidCurriculumUrl($duongDanMoi)) {
            http_response_code(400);
            echo json_encode(['error' => 'Đường dẫn không hợp lệ. Vui lòng nhập link đầy đủ, bắt đầu bằng http:// hoặc https://.']);
            exit;
        }
        $stmt = $pdo->prepare('UPDATE giao_trinh SET tieu_de = ?, mo_ta = ?, duong_dan = ? WHERE id = ?');
        $stmt->execute([$tieuDe, $moTa, $duongDanMoi, $id]);
    } else {
        $stmt = $pdo->prepare('UPDATE giao_trinh SET tieu_de = ?, mo_ta = ? WHERE id = ?');
        $stmt->execute([$tieuDe, $moTa, $id]);
    }

    echo json_encode([
        'id' => $id,
        'subjectId' => $existing['subject_id'],
        'tieuDe' => $tieuDe,
        'moTa' => $moTa,
        'loai' => $existing['loai'],
        'duongDan' => $duongDanMoi,
        'fileName' => $existing['file_name'],
        'mimeType' => $existing['mime_type'],
        'fileSize' => $existing['file_size'] !== null ? (int) $existing['file_size'] : null,
        'createdBy' => $existing['created_by'],
    ]);
    exit;
}

if ($method === 'DELETE') {
    requireGV();

    $id = (int) ($_GET['id'] ?? 0);
    if ($id <= 0) {
        http_response_code(400);
        echo json_encode(['error' => 'Thiếu id tài liệu giáo trình.']);
        exit;
    }

    $stmtMon = $pdo->prepare('SELECT subject_id FROM giao_trinh WHERE id = ? LIMIT 1');
    $stmtMon->execute([$id]);
    $monCuaTaiLieu = $stmtMon->fetchColumn();
    if ($monCuaTaiLieu !== false) {
        requireGvMon($pdo, $monCuaTaiLieu);
    }

    $stmt = $pdo->prepare('DELETE FROM giao_trinh WHERE id = ?');
    $stmt->execute([$id]);

    echo json_encode(['success' => true]);
    exit;
}

http_response_code(405);
echo json_encode(['error' => 'Method không được hỗ trợ.']);
