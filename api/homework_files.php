<?php
require __DIR__ . '/config.php';

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET' || $method === 'HEAD') {
    if (!isset($_GET['id'])) {
        http_response_code(400);
        echo json_encode(['error' => 'Thiếu id tệp.']);
        exit;
    }

    $stmt = $pdo->prepare('SELECT file_name, mime_type, file_data FROM homework_files WHERE id = ? LIMIT 1');
    $stmt->execute([$_GET['id']]);
    $file = $stmt->fetch();

    if (!$file) {
        http_response_code(404);
        echo json_encode(['error' => 'Không tìm thấy tệp.']);
        exit;
    }

    $asAttachment = isset($_GET['download']) && $_GET['download'] === '1';
    header('Content-Type: ' . ($file['mime_type'] ?: 'application/octet-stream'));
    header('Content-Length: ' . strlen($file['file_data']));
    header('Content-Disposition: ' . ($asAttachment ? 'attachment' : 'inline') . '; filename="' . str_replace('"', '', $file['file_name']) . '"');
    echo $file['file_data'];
    exit;
}

if ($method === 'POST') {
    // Xem giải thích chi tiết trong api/curriculum.php: khi tệp tải lên khiến
    // tổng dung lượng POST vượt post_max_size của PHP, $_POST và $_FILES đều bị
    // làm rỗng hoàn toàn nên cần báo đúng nguyên nhân thay vì lỗi "thiếu tệp".
    $contentLength = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($contentLength > 0 && empty($_POST) && empty($_FILES)) {
        $postMaxSize = ini_get('post_max_size');
        http_response_code(400);
        echo json_encode([
            'error' => 'Tệp quá lớn so với giới hạn post_max_size (' . $postMaxSize . ') hiện đang cấu hình trên máy chủ PHP '
                . '(tệp bạn chọn khoảng ' . round($contentLength / 1024 / 1024, 1) . 'MB). '
                . 'Vui lòng tăng post_max_size và upload_max_filesize trong php.ini lên tối thiểu 1100M rồi khởi động lại máy chủ, '
                . 'hoặc chọn tệp nhỏ hơn.',
        ]);
        exit;
    }

    $homeworkId = trim($_POST['homeworkId'] ?? '');
    $label = trim($_POST['label'] ?? '');

    if ($homeworkId === '' || !isset($_FILES['file'])) {
        http_response_code(400);
        echo json_encode(['error' => 'Thiếu homeworkId hoặc tệp tải lên.']);
        exit;
    }

    $stmtCheck = $pdo->prepare('SELECT id, subject_id AS subjectId, created_by AS createdBy FROM homeworks WHERE id = ? LIMIT 1');
    $stmtCheck->execute([$homeworkId]);
    $homework = $stmtCheck->fetch();
    if (!$homework) {
        http_response_code(404);
        echo json_encode(['error' => 'Không tìm thấy bài tập để đính kèm tệp.']);
        exit;
    }

    requireCanModifyHomework($homework['createdBy']);
    requireGvMon($pdo, $homework['subjectId']);

    $file = $_FILES['file'];
    if ($file['error'] !== UPLOAD_ERR_OK) {
        $uploadErrors = [
            UPLOAD_ERR_INI_SIZE => 'Tệp vượt quá giới hạn upload_max_filesize của PHP.',
            UPLOAD_ERR_FORM_SIZE => 'Tệp vượt quá giới hạn kích thước cho phép.',
            UPLOAD_ERR_PARTIAL => 'Tệp chỉ được tải lên một phần, vui lòng thử lại.',
            UPLOAD_ERR_NO_FILE => 'Chưa chọn tệp nào.',
        ];
        http_response_code(400);
        echo json_encode(['error' => $uploadErrors[$file['error']] ?? ('Tải tệp lên thất bại (mã lỗi ' . $file['error'] . ').')]);
        exit;
    }

    $maxSize = 1024 * 1024 * 1024;
    if ($file['size'] > $maxSize) {
        http_response_code(400);
        echo json_encode(['error' => 'Tệp quá lớn, tối đa 1GB.']);
        exit;
    }

    $data = file_get_contents($file['tmp_name']);
    if ($data === false) {
        http_response_code(500);
        echo json_encode(['error' => 'Không đọc được nội dung tệp tải lên.']);
        exit;
    }

    $id = genId('file');
    $mimeType = $file['type'] !== '' ? $file['type'] : 'application/octet-stream';

    $stmtOrder = $pdo->prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 FROM homework_files WHERE homework_id = ?');
    $stmtOrder->execute([$homeworkId]);
    $nextOrder = (int) $stmtOrder->fetchColumn();

    $stmt = $pdo->prepare('INSERT INTO homework_files (id, homework_id, label, file_name, mime_type, file_size, file_data, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    $stmt->execute([
        $id,
        $homeworkId,
        $label !== '' ? $label : null,
        $file['name'],
        $mimeType,
        $file['size'],
        $data,
        $nextOrder,
    ]);

    echo json_encode([
        'id' => $id,
        'label' => $label !== '' ? $label : null,
        'fileName' => $file['name'],
        'mimeType' => $mimeType,
        'fileSize' => (int) $file['size'],
    ]);
    exit;
}

if ($method === 'DELETE') {
    $id = $_GET['id'] ?? '';
    if ($id === '') {
        http_response_code(400);
        echo json_encode(['error' => 'Thiếu id tệp.']);
        exit;
    }

    $stmt = $pdo->prepare('SELECT hf.id, h.subject_id AS subjectId, h.created_by AS createdBy FROM homework_files hf JOIN homeworks h ON h.id = hf.homework_id WHERE hf.id = ? LIMIT 1');
    $stmt->execute([$id]);
    $file = $stmt->fetch();
    if (!$file) {
        http_response_code(404);
        echo json_encode(['error' => 'Không tìm thấy tệp.']);
        exit;
    }

    requireCanModifyHomework($file['createdBy']);
    requireGvMon($pdo, $file['subjectId']);

    $stmt = $pdo->prepare('DELETE FROM homework_files WHERE id = ?');
    $stmt->execute([$id]);

    echo json_encode(['success' => true]);
    exit;
}

http_response_code(405);
echo json_encode(['error' => 'Method không được hỗ trợ.']);
