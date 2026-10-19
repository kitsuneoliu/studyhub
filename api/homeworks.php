<?php
require __DIR__ . '/config.php';

$method = $_SERVER['REQUEST_METHOD'];

function fetchFiles(PDO $pdo, string $homeworkId): array {
    $stmt = $pdo->prepare('SELECT id, label, file_name AS fileName, mime_type AS mimeType, file_size AS fileSize FROM homework_files WHERE homework_id = ? ORDER BY sort_order ASC, id ASC');
    $stmt->execute([$homeworkId]);
    $rows = $stmt->fetchAll();
    foreach ($rows as &$row) {
        $row['fileSize'] = $row['fileSize'] !== null ? (int) $row['fileSize'] : 0;
    }
    unset($row);
    return $rows;
}

function fetchHomework(PDO $pdo, string $id) {
    $stmt = $pdo->prepare(
        'SELECT h.id, h.subject_id AS subjectId, h.title, h.description, h.status, h.link,
                h.text_content AS textContent, h.created_by AS createdBy, u.role AS createdByRole, u.ho_ten AS createdByName
         FROM homeworks h
         LEFT JOIN users u ON u.username = h.created_by
         WHERE h.id = ? LIMIT 1'
    );
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    if (!$row) {
        return null;
    }
    $row['files'] = fetchFiles($pdo, $id);
    return $row;
}

if ($method === 'GET') {
    $user = currentUser();

    if ($user !== null && $user['role'] === 'sv') {
        // SV thấy: bài tập của chính mình + bài tập do GV giao.
        // Không thấy bài tập do SV KHÁC tạo.
        $stmt = $pdo->prepare(
            "SELECT h.id, h.subject_id AS subjectId, h.title, h.description, h.status, h.link,
                    h.text_content AS textContent, h.created_by AS createdBy, u.role AS createdByRole, u.ho_ten AS createdByName
             FROM homeworks h
             LEFT JOIN users u ON u.username = h.created_by
             WHERE h.created_by = ? OR u.role = 'gv' OR h.created_by IS NULL
             ORDER BY h.created_at ASC, h.id ASC"
        );
        $stmt->execute([$user['username']]);
        $rows = $stmt->fetchAll();
    } elseif ($user !== null && $user['role'] === 'gv') {
        // GV thấy tất cả bài tập, không phân biệt ai tạo - kèm vai trò người đăng
        // để GV nhận biết ngay bài nào do sinh viên tự đăng.
        $params = [];
        $loc = gvLocMon($pdo, 'h.subject_id', $params); // giảng viên theo môn chỉ thấy bài tập của môn mình
        $stmt = $pdo->prepare(
            "SELECT h.id, h.subject_id AS subjectId, h.title, h.description, h.status, h.link,
                    h.text_content AS textContent, h.created_by AS createdBy, u.role AS createdByRole, u.ho_ten AS createdByName
             FROM homeworks h
             LEFT JOIN users u ON u.username = h.created_by
             WHERE 1 = 1" . $loc . "
             ORDER BY h.created_at ASC, h.id ASC"
        );
        $stmt->execute($params);
        $rows = $stmt->fetchAll();
    } else {
        // Khách (chưa đăng nhập): CHỈ thấy bài tập do GV đưa ra, không thấy bài SV tự tạo
        $rows = $pdo->query(
            "SELECT h.id, h.subject_id AS subjectId, h.title, h.description, h.status, h.link,
                    h.text_content AS textContent, h.created_by AS createdBy, u.role AS createdByRole, u.ho_ten AS createdByName
             FROM homeworks h
             JOIN users u ON u.username = h.created_by
             WHERE u.role = 'gv'
             ORDER BY h.created_at ASC, h.id ASC"
        )->fetchAll();
    }

    foreach ($rows as &$row) {
        $row['files'] = fetchFiles($pdo, $row['id']);
    }
    unset($row);
    echo json_encode($rows);
    exit;
}

if ($method === 'POST') {
    requireLogin();

    $data = readJsonBody();
    $title = trim($data['title'] ?? '');
    $subjectId = trim($data['subjectId'] ?? '');
    $description = trim($data['description'] ?? '');
    $link = trim($data['link'] ?? '');
    $textContent = (string) ($data['textContent'] ?? '');

    if ($subjectId === '') {
        http_response_code(400);
        echo json_encode(['error' => 'Vui lòng chọn môn học.']);
        exit;
    }

    requireGvMon($pdo, $subjectId);

    $id = genId('hw');
    $creator = currentUser()['username'];

    $stmt = $pdo->prepare('INSERT INTO homeworks (id, subject_id, title, description, status, link, text_content, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    $stmt->execute([$id, $subjectId, $title, $description, 'pending', $link !== '' ? $link : null, $textContent !== '' ? $textContent : null, $creator]);

    echo json_encode(fetchHomework($pdo, $id));
    exit;
}

if ($method === 'PUT') {
    $id = $_GET['id'] ?? '';
    if ($id === '') {
        http_response_code(400);
        echo json_encode(['error' => 'Thiếu id bài tập.']);
        exit;
    }

    $existing = fetchHomework($pdo, $id);
    if (!$existing) {
        http_response_code(404);
        echo json_encode(['error' => 'Không tìm thấy bài tập.']);
        exit;
    }

    requireCanModifyHomework($existing['createdBy']);
    requireGvMon($pdo, $existing['subjectId']);

    $data = readJsonBody();

    if (array_key_exists('status', $data) && !array_key_exists('title', $data)) {
        $status = $data['status'];
        if (!in_array($status, ['pending', 'in_progress', 'completed'], true)) {
            http_response_code(400);
            echo json_encode(['error' => 'Trạng thái không hợp lệ.']);
            exit;
        }
        $stmt = $pdo->prepare('UPDATE homeworks SET status = ? WHERE id = ?');
        $stmt->execute([$status, $id]);
        echo json_encode(fetchHomework($pdo, $id));
        exit;
    }

    if (array_key_exists('subjectId', $data) && count($data) === 1) {
        $subjectId = trim($data['subjectId'] ?? '');
        requireGvMon($pdo, $subjectId);
        $stmt = $pdo->prepare('UPDATE homeworks SET subject_id = ? WHERE id = ?');
        $stmt->execute([$subjectId !== '' ? $subjectId : null, $id]);
        echo json_encode(fetchHomework($pdo, $id));
        exit;
    }

    $title = array_key_exists('title', $data) ? trim($data['title']) : $existing['title'];
    $subjectId = array_key_exists('subjectId', $data) ? trim($data['subjectId']) : $existing['subjectId'];
    $description = array_key_exists('description', $data) ? trim($data['description']) : $existing['description'];
    $link = array_key_exists('link', $data) ? trim($data['link']) : $existing['link'];
    $textContent = array_key_exists('textContent', $data) ? (string) $data['textContent'] : ($existing['textContent'] ?? '');

    if ($subjectId === '') {
        http_response_code(400);
        echo json_encode(['error' => 'Vui lòng chọn môn học.']);
        exit;
    }

    requireGvMon($pdo, $subjectId);
    $stmt = $pdo->prepare('UPDATE homeworks SET subject_id = ?, title = ?, description = ?, link = ?, text_content = ? WHERE id = ?');
    $stmt->execute([$subjectId, $title, $description, $link !== '' ? $link : null, $textContent !== '' ? $textContent : null, $id]);

    echo json_encode(fetchHomework($pdo, $id));
    exit;
}

if ($method === 'DELETE') {
    $id = $_GET['id'] ?? '';
    if ($id === '') {
        http_response_code(400);
        echo json_encode(['error' => 'Thiếu id bài tập.']);
        exit;
    }

    $existing = fetchHomework($pdo, $id);
    if (!$existing) {
        http_response_code(404);
        echo json_encode(['error' => 'Không tìm thấy bài tập.']);
        exit;
    }

    requireCanModifyHomework($existing['createdBy']);
    requireGvMon($pdo, $existing['subjectId']);

    $stmt = $pdo->prepare('DELETE FROM homeworks WHERE id = ?');
    $stmt->execute([$id]);

    echo json_encode(['success' => true]);
    exit;
}

http_response_code(405);
echo json_encode(['error' => 'Method không được hỗ trợ.']);
