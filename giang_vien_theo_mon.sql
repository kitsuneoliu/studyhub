-- =============================================================================
-- GIẢNG VIÊN THEO MÔN HỌC
-- Cách chạy: phpMyAdmin -> chọn database studyhub -> tab SQL -> dán toàn bộ -> Thực hiện.
-- NÊN CHẠY 1 LẦN. File không xóa dữ liệu của sinh viên; bên dưới có 3 việc:
--   1) Gộp các môn bị trùng tên (giữ 1 môn, chuyển bài tập/bài kiểm tra/giáo trình/bài nộp về môn giữ lại).
--   2) Xóa môn: Tiếng Anh, Phân tích và thiết kế hệ thống thông tin, Toán lớp 1
--      (bài kiểm tra, giáo trình... thuộc 3 môn này bị xóa theo).
--   3) Tạo tài khoản giảng viên theo môn (mật khẩu 123123) và gán môn phụ trách:
--        mau    : python
--        oop    : OOP
--        lan    : Khai phá dữ liệu
--        toan   : XML, WEB
--        thuong : Công nghệ phần mềm, Cơ sở dữ liệu
--        doan   : ĐỒ ÁN
--      Các tài khoản theo môn tạo ở bản trước (python, khaiphadulieu, xml, web, congnghephanmem,
--      cosodulieu, tienganh, phantichvathietkehethongthongtin, toanlop1) được xóa; dữ liệu họ đã tạo
--      được chuyển sang tài khoản mới tương ứng.
--
-- ql1, ql2 là giảng viên quản trị: thấy mọi môn, tạo/sửa/xóa tài khoản giảng viên và sinh viên,
-- gán 1 hoặc nhiều môn cho mỗi giảng viên ngay trên giao diện (Tài khoản -> Quản lý giảng viên).
-- =============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS gv_gioi_han TINYINT(1) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS giang_vien_mon (
    username VARCHAR(50) NOT NULL,
    subject_id VARCHAR(50) NOT NULL,
    PRIMARY KEY (username, subject_id),
    CONSTRAINT fk_gvmon_user FOREIGN KEY (username) REFERENCES users(username)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_gvmon_subject FOREIGN KEY (subject_id) REFERENCES subjects(id)
        ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 1) GỘP MÔN BỊ TRÙNG TÊN: giữ môn có nhiều dữ liệu nhất (hòa thì giữ môn tạo trước)
-- ---------------------------------------------------------------------------
DROP TEMPORARY TABLE IF EXISTS tmp_mon_a;
DROP TEMPORARY TABLE IF EXISTS tmp_mon_b;
DROP TEMPORARY TABLE IF EXISTS tmp_gop_mon;

CREATE TEMPORARY TABLE tmp_mon_a AS
SELECT s.id, s.name, s.created_at,
       (SELECT COUNT(*) FROM homeworks h WHERE h.subject_id = s.id)
     + (SELECT COUNT(*) FROM bai_kiem_tra b WHERE b.mon_hoc_id = s.id)
     + (SELECT COUNT(*) FROM giao_trinh g WHERE g.subject_id = s.id) AS so_du_lieu
FROM subjects s;

CREATE TEMPORARY TABLE tmp_mon_b AS SELECT * FROM tmp_mon_a;

CREATE TEMPORARY TABLE tmp_gop_mon AS
SELECT a.id AS dup_id,
       (SELECT b.id FROM tmp_mon_b b WHERE b.name = a.name
         ORDER BY b.so_du_lieu DESC, b.created_at ASC, b.id ASC LIMIT 1) AS keep_id
FROM tmp_mon_a a;

DELETE FROM tmp_gop_mon WHERE dup_id = keep_id;

UPDATE homeworks h JOIN tmp_gop_mon m ON h.subject_id = m.dup_id SET h.subject_id = m.keep_id;
UPDATE bai_kiem_tra b JOIN tmp_gop_mon m ON b.mon_hoc_id = m.dup_id SET b.mon_hoc_id = m.keep_id;
UPDATE giao_trinh g JOIN tmp_gop_mon m ON g.subject_id = m.dup_id SET g.subject_id = m.keep_id;
UPDATE bai_nop n JOIN tmp_gop_mon m ON n.subject_id = m.dup_id SET n.subject_id = m.keep_id;
DELETE s FROM subjects s JOIN tmp_gop_mon m ON s.id = m.dup_id;

DROP TEMPORARY TABLE IF EXISTS tmp_gop_mon;
DROP TEMPORARY TABLE IF EXISTS tmp_mon_b;
DROP TEMPORARY TABLE IF EXISTS tmp_mon_a;

-- ---------------------------------------------------------------------------
-- 2) XÓA MÔN KHÔNG DÙNG NỮA
-- ---------------------------------------------------------------------------
DELETE FROM subjects WHERE name IN ('Tiếng Anh', 'Phân tích và thiết kế hệ thống thông tin', 'Toán lớp 1');

-- ---------------------------------------------------------------------------
-- 3) TÀI KHOẢN GIẢNG VIÊN THEO MÔN
-- ---------------------------------------------------------------------------
INSERT INTO users (username, password, ho_ten, ma_so_sv, role, gv_gioi_han) VALUES
    ('mau', '123123', 'GV mau', NULL, 'gv', 1),
    ('oop', '123123', 'GV OOP', NULL, 'gv', 1),
    ('lan', '123123', 'GV lan', NULL, 'gv', 1),
    ('toan', '123123', 'GV toan', NULL, 'gv', 1),
    ('thuong', '123123', 'GV thuong', NULL, 'gv', 1),
    ('doan', '123123', 'GV doan', NULL, 'gv', 1)
ON DUPLICATE KEY UPDATE ho_ten = COALESCE(ho_ten, VALUES(ho_ten)), role = 'gv', gv_gioi_han = 1;

-- Chuyển dữ liệu do tài khoản theo môn CŨ tạo sang tài khoản mới (tránh bị xóa theo khi xóa tài khoản cũ).
UPDATE bai_kiem_tra SET nguoi_tao_id = 'mau' WHERE nguoi_tao_id IN (SELECT username FROM users WHERE username = 'python' AND role = 'gv' AND gv_gioi_han = 1);
UPDATE giao_trinh SET created_by = 'mau' WHERE created_by IN (SELECT username FROM users WHERE username = 'python' AND role = 'gv' AND gv_gioi_han = 1);
UPDATE homeworks SET created_by = 'mau' WHERE created_by IN (SELECT username FROM users WHERE username = 'python' AND role = 'gv' AND gv_gioi_han = 1);
UPDATE bai_kiem_tra SET nguoi_tao_id = 'lan' WHERE nguoi_tao_id IN (SELECT username FROM users WHERE username = 'khaiphadulieu' AND role = 'gv' AND gv_gioi_han = 1);
UPDATE giao_trinh SET created_by = 'lan' WHERE created_by IN (SELECT username FROM users WHERE username = 'khaiphadulieu' AND role = 'gv' AND gv_gioi_han = 1);
UPDATE homeworks SET created_by = 'lan' WHERE created_by IN (SELECT username FROM users WHERE username = 'khaiphadulieu' AND role = 'gv' AND gv_gioi_han = 1);
UPDATE bai_kiem_tra SET nguoi_tao_id = 'toan' WHERE nguoi_tao_id IN (SELECT username FROM users WHERE username = 'xml' AND role = 'gv' AND gv_gioi_han = 1);
UPDATE giao_trinh SET created_by = 'toan' WHERE created_by IN (SELECT username FROM users WHERE username = 'xml' AND role = 'gv' AND gv_gioi_han = 1);
UPDATE homeworks SET created_by = 'toan' WHERE created_by IN (SELECT username FROM users WHERE username = 'xml' AND role = 'gv' AND gv_gioi_han = 1);
UPDATE bai_kiem_tra SET nguoi_tao_id = 'toan' WHERE nguoi_tao_id IN (SELECT username FROM users WHERE username = 'web' AND role = 'gv' AND gv_gioi_han = 1);
UPDATE giao_trinh SET created_by = 'toan' WHERE created_by IN (SELECT username FROM users WHERE username = 'web' AND role = 'gv' AND gv_gioi_han = 1);
UPDATE homeworks SET created_by = 'toan' WHERE created_by IN (SELECT username FROM users WHERE username = 'web' AND role = 'gv' AND gv_gioi_han = 1);
UPDATE bai_kiem_tra SET nguoi_tao_id = 'thuong' WHERE nguoi_tao_id IN (SELECT username FROM users WHERE username = 'congnghephanmem' AND role = 'gv' AND gv_gioi_han = 1);
UPDATE giao_trinh SET created_by = 'thuong' WHERE created_by IN (SELECT username FROM users WHERE username = 'congnghephanmem' AND role = 'gv' AND gv_gioi_han = 1);
UPDATE homeworks SET created_by = 'thuong' WHERE created_by IN (SELECT username FROM users WHERE username = 'congnghephanmem' AND role = 'gv' AND gv_gioi_han = 1);
UPDATE bai_kiem_tra SET nguoi_tao_id = 'thuong' WHERE nguoi_tao_id IN (SELECT username FROM users WHERE username = 'cosodulieu' AND role = 'gv' AND gv_gioi_han = 1);
UPDATE giao_trinh SET created_by = 'thuong' WHERE created_by IN (SELECT username FROM users WHERE username = 'cosodulieu' AND role = 'gv' AND gv_gioi_han = 1);
UPDATE homeworks SET created_by = 'thuong' WHERE created_by IN (SELECT username FROM users WHERE username = 'cosodulieu' AND role = 'gv' AND gv_gioi_han = 1);

-- Xóa tài khoản giảng viên theo môn cũ (chỉ xóa đúng tài khoản giảng viên theo môn).
DELETE FROM users WHERE username IN ('python', 'khaiphadulieu', 'xml', 'web', 'congnghephanmem', 'cosodulieu', 'tienganh', 'phantichvathietkehethongthongtin', 'toanlop1') AND role = 'gv' AND gv_gioi_han = 1;

-- Gán môn phụ trách theo TÊN môn (không phân biệt hoa/thường, dấu).
INSERT IGNORE INTO giang_vien_mon (username, subject_id)
SELECT m.username, s.id
FROM (
    SELECT 'mau' AS username, 'python' AS ten_mon
    UNION ALL SELECT 'oop' AS username, 'OOP' AS ten_mon
    UNION ALL SELECT 'lan' AS username, 'Khai phá dữ liệu' AS ten_mon
    UNION ALL SELECT 'toan' AS username, 'XML' AS ten_mon
    UNION ALL SELECT 'toan' AS username, 'WEB' AS ten_mon
    UNION ALL SELECT 'thuong' AS username, 'Công nghệ phần mềm' AS ten_mon
    UNION ALL SELECT 'thuong' AS username, 'Cơ sở dữ liệu' AS ten_mon
    UNION ALL SELECT 'doan' AS username, 'ĐỒ ÁN' AS ten_mon
) m
JOIN subjects s ON s.name = m.ten_mon COLLATE utf8mb4_unicode_ci;

-- Kiểm tra kết quả: mỗi giảng viên phụ trách những môn nào.
-- SELECT g.username, s.name FROM giang_vien_mon g JOIN subjects s ON s.id = g.subject_id ORDER BY g.username, s.name;
