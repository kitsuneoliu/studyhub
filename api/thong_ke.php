<?php
/* =====================================================================
   thong_ke.php?id=<quizId>: GV lấy thống kê 1 bài kiểm tra dưới dạng XML.

   Các con số (điểm trung bình/cao nhất/thấp nhất, tỷ lệ đạt, phân bố điểm,
   câu hỏi sai nhiều nhất...) được tính bằng XPath trên các file XML bài làm
   mà hệ thống tự lưu ngầm khi sinh viên nộp bài (xem xml_helper.php). XML
   kết quả được kiểm tra bằng thong_ke.xsd trước khi trả về.
   ===================================================================== */
require __DIR__ . '/config.php';
require_once __DIR__ . '/xml_helper.php';
header('Content-Type: text/xml; charset=UTF-8');

function thongKeLoi(string $message) {
    $xml = new DOMDocument('1.0', 'UTF-8');
    $root = $xml->createElement('Response');
    $root->appendChild($xml->createElement('Status', 'Error'));
    $root->appendChild(xmlPhanTu($xml, 'Message', $message));
    $xml->appendChild($root);
    echo $xml->saveXML();
    exit;
}

if (!isGV()) {
    thongKeLoi('Chỉ Giảng viên mới được xem thống kê.');
}

$quizId = isset($_GET['id']) ? (int) $_GET['id'] : 0;
if ($quizId <= 0) {
    thongKeLoi('Thiếu mã bài kiểm tra.');
}

$stmtMon = $pdo->prepare('SELECT mon_hoc_id FROM bai_kiem_tra WHERE id = ? LIMIT 1');
$stmtMon->execute([$quizId]);
$monCuaBai = $stmtMon->fetchColumn();
if ($monCuaBai !== false && !gvCoQuyenMon($pdo, $monCuaBai)) {
    thongKeLoi('Bạn chỉ được xem thống kê của môn học mà bạn phụ trách.');
}

$doc = xmlTaoThongKe($pdo, $quizId);
if ($doc === null) {
    thongKeLoi('Không tìm thấy bài kiểm tra.');
}

$loi = xmlKiemTraXsd($doc, 'thong_ke.xsd');
if (count($loi) > 0) {
    error_log('thong_ke.php: XML thống kê không hợp lệ: ' . implode(' | ', array_slice($loi, 0, 5)));
    thongKeLoi('Không tạo được thống kê (dữ liệu XML không hợp lệ).');
}

echo $doc->saveXML();
