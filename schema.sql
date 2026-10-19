-- LƯU Ý: Trước khi chạy file này, hãy tự tạo 1 database rỗng trước
-- (qua cPanel/DirectAdmin/phpMyAdmin), rồi chọn (Import/chạy SQL) NGAY
-- TRONG database đó. File này không tự tạo database vì hầu hết tài
-- khoản MySQL trên hosting không có quyền CREATE DATABASE.
-- Khi tạo database, nhớ chọn Collation là utf8mb4_unicode_ci (hoặc
-- utf8mb4_general_ci) để chữ tiếng Việt không bị lỗi font.

-- username: tên đăng nhập (chỉ dùng để đăng nhập). ho_ten: tên sinh viên hiển
-- thị thay cho username. ma_so_sv: mã số sinh viên (không trùng nhau).
CREATE TABLE IF NOT EXISTS users (
    username VARCHAR(50) NOT NULL PRIMARY KEY,
    password VARCHAR(255) NOT NULL,
    ho_ten VARCHAR(100) NULL,
    ma_so_sv VARCHAR(30) NULL,
    role ENUM('gv', 'sv') NOT NULL DEFAULT 'sv',
    UNIQUE KEY uq_users_ma_so_sv (ma_so_sv)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Nâng cấp bảng users đã có từ trước (thêm tên hiển thị + mã số sinh viên).
-- LƯU Ý: api/config.php cũng tự làm việc này khi chạy, nên với database ĐÃ CÓ
-- DỮ LIỆU bạn KHÔNG cần import lại file này (xem cảnh báo DELETE FROM users bên dưới).
ALTER TABLE users ADD COLUMN IF NOT EXISTS ho_ten VARCHAR(100) NULL AFTER password;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ma_so_sv VARCHAR(30) NULL AFTER ho_ten;
ALTER TABLE users ADD UNIQUE KEY IF NOT EXISTS uq_users_ma_so_sv (ma_so_sv);

-- !!! CẢNH BÁO: lệnh DELETE FROM users bên dưới XÓA SẠCH mọi tài khoản (kể cả
-- tài khoản sinh viên do giảng viên tạo trên giao diện). Chỉ import file này khi
-- CÀI MỚI. Nếu database đang có dữ liệu thật, đừng import lại file này.
-- Nâng cấp an toàn cho DB đã tạo từ hệ phân quyền cũ (full/edit/delete):
-- nới lỏng kiểu cột, XÓA HẾT tài khoản cũ (theo yêu cầu chuyển hẳn sang hệ
-- GV/SV), rồi khóa lại đúng ENUM gv/sv. An toàn khi chạy lại nhiều lần.
ALTER TABLE users MODIFY COLUMN role VARCHAR(20) NOT NULL DEFAULT 'sv';
DELETE FROM users;
ALTER TABLE users MODIFY COLUMN role ENUM('gv', 'sv') NOT NULL DEFAULT 'sv';

CREATE TABLE IF NOT EXISTS subjects (
    id VARCHAR(50) NOT NULL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    color VARCHAR(50) NOT NULL DEFAULT 'bg-slate-400',
    cho_phep_nop_bai TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 1 = sinh viên được nộp bài tập của môn này, 0 = giảng viên đã đóng nộp bài.
ALTER TABLE subjects ADD COLUMN IF NOT EXISTS cho_phep_nop_bai TINYINT(1) NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS homeworks (
    id VARCHAR(50) NOT NULL PRIMARY KEY,
    subject_id VARCHAR(50) NULL,
    title VARCHAR(500) NOT NULL,
    description TEXT NULL,
    status ENUM('pending', 'in_progress', 'completed') NOT NULL DEFAULT 'pending',
    link VARCHAR(1000) NULL,
    text_content LONGTEXT NULL,
    created_by VARCHAR(50) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_homeworks_subject
        FOREIGN KEY (subject_id) REFERENCES subjects(id)
        ON DELETE SET NULL
        ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Nếu bảng homeworks đã tồn tại từ trước, thêm các cột còn thiếu mà không
-- ảnh hưởng dữ liệu cũ. An toàn khi chạy lại nhiều lần.
ALTER TABLE homeworks ADD COLUMN IF NOT EXISTS text_content LONGTEXT NULL AFTER link;
ALTER TABLE homeworks ADD COLUMN IF NOT EXISTS created_by VARCHAR(50) NULL AFTER text_content;

-- Bảng lưu file đính kèm cho bài tập (VD: .docx, .html, .css, .pdf...)
-- Nội dung file được lưu TRỰC TIẾP trong cột file_data (LONGBLOB) của MySQL,
-- không lưu ra ổ đĩa/thư mục riêng.
DROP TABLE IF EXISTS homework_code_blocks;
DROP TABLE IF EXISTS homework_files;

CREATE TABLE IF NOT EXISTS homework_files (
    id VARCHAR(50) NOT NULL PRIMARY KEY,
    homework_id VARCHAR(50) NOT NULL,
    label VARCHAR(255) NULL,
    file_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(150) NOT NULL DEFAULT 'application/octet-stream',
    file_size INT UNSIGNED NOT NULL DEFAULT 0,
    file_data LONGBLOB NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_files_homework
        FOREIGN KEY (homework_id) REFERENCES homeworks(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tài khoản demo: 2 Giảng viên (ql1, ql2) và 2 Sinh viên (sv1, sv2)
INSERT INTO users (username, password, ho_ten, ma_so_sv, role) VALUES
    ('ql1', '123123', NULL, NULL, 'gv'),
    ('ql2', '123123', NULL, NULL, 'gv'),
    ('sv1', '123123', 'Nguyễn Văn An', '2200001', 'sv'),
    ('sv2', '123123', 'Trần Thị Bình', '2200002', 'sv')
ON DUPLICATE KEY UPDATE password = VALUES(password), ho_ten = VALUES(ho_ten), ma_so_sv = VALUES(ma_so_sv), role = VALUES(role);

INSERT INTO subjects (id, name, color) VALUES
    ('sub-1', 'OOP', 'bg-blue-500'),
    ('sub-2', 'Tiếng Anh', 'bg-pink-500'),
    ('sub-3', 'Khai phá dữ liệu', 'bg-green-500'),
    ('sub-4', 'XML', 'bg-purple-500'),
    ('sub-5', 'WEB', 'bg-amber-500'),
    ('sub-6', 'ĐỒ ÁN', 'bg-emerald-500')
ON DUPLICATE KEY UPDATE name = VALUES(name), color = VALUES(color);

INSERT INTO homeworks (id, subject_id, title, description, status, link, created_by) VALUES
    ('hw-1', 'sub-1', 'Làm 10 bài tập Đại Số', 'Trong sách giáo khoa trang 12', 'pending', NULL, 'ql1'),
    ('hw-2', 'sub-2', 'Soạn bài Chí Phèo', 'Chuẩn bị luận điểm phân tích nhân vật', 'in_progress', NULL, 'ql1'),
    ('hw-3', 'sub-3', 'Dịch đoạn văn Unit 3', '', 'completed', NULL, 'sv1')
ON DUPLICATE KEY UPDATE title = VALUES(title), description = VALUES(description);

-- LƯU Ý: mon_hoc_id / nguoi_tao_id / hoc_sinh_id dùng VARCHAR(50) để khớp với
-- subjects.id và users.username (là chuỗi, VD 'sub-1', 'ql1') thay vì INT.
-- hien_thi: 1 = sinh viên thấy đề trong danh sách, 0 = ẩn hoàn toàn với sinh viên.
-- cho_phep_lam_bai: 1 = sinh viên có thể xem trước/bắt đầu làm bài, 0 = không được vào làm.
CREATE TABLE IF NOT EXISTS bai_kiem_tra (
    id INT AUTO_INCREMENT PRIMARY KEY,
    mon_hoc_id VARCHAR(50) NOT NULL,
    tieu_de VARCHAR(255) NOT NULL,
    mo_ta TEXT,
    thoi_gian_lam_bai INT DEFAULT 45,
    trang_thai ENUM('chua_bat_dau', 'dang_mo', 'da_dong') DEFAULT 'chua_bat_dau',
    hien_thi TINYINT(1) NOT NULL DEFAULT 1,
    cho_phep_lam_bai TINYINT(1) NOT NULL DEFAULT 1,
    nguoi_tao_id VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_bkt_mon_hoc
        FOREIGN KEY (mon_hoc_id) REFERENCES subjects(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    CONSTRAINT fk_bkt_nguoi_tao
        FOREIGN KEY (nguoi_tao_id) REFERENCES users(username)
        ON DELETE CASCADE
        ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Nâng cấp an toàn cho bảng bai_kiem_tra đã tồn tại từ trước (thêm cột nếu thiếu).
ALTER TABLE bai_kiem_tra ADD COLUMN IF NOT EXISTS hien_thi TINYINT(1) NOT NULL DEFAULT 1 AFTER trang_thai;
ALTER TABLE bai_kiem_tra ADD COLUMN IF NOT EXISTS cho_phep_lam_bai TINYINT(1) NOT NULL DEFAULT 1 AFTER hien_thi;
-- 1 = bật chống gian lận (mặc định), 0 = tắt (sinh viên làm bài không bị cảnh báo/ghi nhận)
ALTER TABLE bai_kiem_tra ADD COLUMN IF NOT EXISTS chong_gian_lan TINYINT(1) NOT NULL DEFAULT 1 AFTER cho_phep_lam_bai;

-- Số giây hiển thị ô xem lại kết quả (đúng/sai từng câu) ngay sau khi sinh
-- viên nộp bài. 0 = hiển thị VÔ HẠN, chỉ tắt khi sinh viên tự bấm đóng.
-- Mặc định 5 giây. GV chỉnh được riêng cho từng bài kiểm tra.
ALTER TABLE bai_kiem_tra ADD COLUMN IF NOT EXISTS thoi_gian_hien_thi_ket_qua INT NOT NULL DEFAULT 5 AFTER thoi_gian_lam_bai;

CREATE TABLE IF NOT EXISTS cau_hoi (
    id INT AUTO_INCREMENT PRIMARY KEY,
    bai_kiem_tra_id INT NOT NULL,
    noi_dung TEXT NOT NULL,
    loai_cau_hoi ENUM('trac_nghiem', 'tu_luan') DEFAULT 'trac_nghiem',
    dapan_a VARCHAR(255),
    dapan_b VARCHAR(255),
    dapan_c VARCHAR(255),
    dapan_d VARCHAR(255),
    dapan_dung CHAR(1),
    diem DECIMAL(4,2) NOT NULL DEFAULT 1,
    CONSTRAINT fk_cauhoi_bkt
        FOREIGN KEY (bai_kiem_tra_id) REFERENCES bai_kiem_tra(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE cau_hoi ADD COLUMN IF NOT EXISTS diem DECIMAL(4,2) NOT NULL DEFAULT 1 AFTER dapan_dung;

CREATE TABLE IF NOT EXISTS luot_lam_bai (
    id INT AUTO_INCREMENT PRIMARY KEY,
    bai_kiem_tra_id INT NOT NULL,
    hoc_sinh_id VARCHAR(50) NOT NULL,
    thoi_gian_bat_dau DATETIME NOT NULL,
    thoi_gian_nop DATETIME,
    diem_so DECIMAL(5,2),
    diem_cham_tay DECIMAL(5,2) NULL, -- NULL = điểm tự chấm; có giá trị = giảng viên chấm tay
    trang_thai ENUM('dang_lam', 'da_nop') DEFAULT 'dang_lam',
    CONSTRAINT fk_luot_bkt
        FOREIGN KEY (bai_kiem_tra_id) REFERENCES bai_kiem_tra(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    CONSTRAINT fk_luot_hoc_sinh
        FOREIGN KEY (hoc_sinh_id) REFERENCES users(username)
        ON DELETE CASCADE
        ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Nâng cấp bảng luot_lam_bai đã có từ trước (cột điểm chấm tay; api/config.php cũng tự thêm).
ALTER TABLE luot_lam_bai ADD COLUMN IF NOT EXISTS diem_cham_tay DECIMAL(5,2) NULL AFTER diem_so;

CREATE TABLE IF NOT EXISTS chi_tiet_bai_lam (
    id INT AUTO_INCREMENT PRIMARY KEY,
    luot_lam_bai_id INT NOT NULL,
    cau_hoi_id INT NOT NULL,
    cau_tra_loi TEXT,
    CONSTRAINT fk_chitiet_luot
        FOREIGN KEY (luot_lam_bai_id) REFERENCES luot_lam_bai(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    CONSTRAINT fk_chitiet_cauhoi
        FOREIGN KEY (cau_hoi_id) REFERENCES cau_hoi(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Danh sách sinh viên bị cấm thi MỘT bài kiểm tra cụ thể (không ảnh hưởng
-- sinh viên khác, và không ảnh hưởng các bài kiểm tra khác của sinh viên đó).
CREATE TABLE IF NOT EXISTS cam_thi (
    id INT AUTO_INCREMENT PRIMARY KEY,
    bai_kiem_tra_id INT NOT NULL,
    hoc_sinh_id VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_cam_thi (bai_kiem_tra_id, hoc_sinh_id),
    CONSTRAINT fk_cam_bkt
        FOREIGN KEY (bai_kiem_tra_id) REFERENCES bai_kiem_tra(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    CONSTRAINT fk_cam_hocsinh
        FOREIGN KEY (hoc_sinh_id) REFERENCES users(username)
        ON DELETE CASCADE
        ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS cheat_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    luot_lam_bai_id INT NOT NULL,
    hoc_sinh_id VARCHAR(50) NOT NULL,
    loai_vi_pham VARCHAR(50) NOT NULL,
    thoi_gian_bat_dau DATETIME NOT NULL,
    thoi_gian_ket_thuc DATETIME NOT NULL,
    tong_thoi_gian_vang_mat INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_cheatlog_luot
        FOREIGN KEY (luot_lam_bai_id) REFERENCES luot_lam_bai(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    CONSTRAINT fk_cheatlog_hocsinh
        FOREIGN KEY (hoc_sinh_id) REFERENCES users(username)
        ON DELETE CASCADE
        ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- Giáo trình / tài liệu môn học: GV thêm link Google Drive/trang web HOẶC tải
-- trực tiếp file (PDF, Word, PowerPoint, Excel, ZIP...) lên; SV chỉ được xem
-- danh sách và bấm vào để mở link hoặc tải file đó.
CREATE TABLE IF NOT EXISTS giao_trinh (
    id INT AUTO_INCREMENT PRIMARY KEY,
    subject_id VARCHAR(50) NOT NULL,
    tieu_de VARCHAR(255) NOT NULL,
    mo_ta TEXT,
    loai ENUM('link', 'file') NOT NULL DEFAULT 'link',
    duong_dan VARCHAR(1000) NULL,
    file_name VARCHAR(255) NULL,
    mime_type VARCHAR(150) NULL,
    file_size INT NULL,
    file_data LONGBLOB NULL,
    created_by VARCHAR(50) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_giaotrinh_subject
        FOREIGN KEY (subject_id) REFERENCES subjects(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    CONSTRAINT fk_giaotrinh_creator
        FOREIGN KEY (created_by) REFERENCES users(username)
        ON DELETE CASCADE
        ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Với database đã tạo bảng giao_trinh từ trước (khi chỉ hỗ trợ link), thêm
-- các cột còn thiếu để hỗ trợ tải file lên, và nới lỏng duong_dan (chỉ bắt
-- buộc khi loai='link', còn loai='file' thì không cần).
ALTER TABLE giao_trinh ADD COLUMN IF NOT EXISTS loai ENUM('link', 'file') NOT NULL DEFAULT 'link' AFTER mo_ta;
ALTER TABLE giao_trinh ADD COLUMN IF NOT EXISTS file_name VARCHAR(255) NULL AFTER duong_dan;
ALTER TABLE giao_trinh ADD COLUMN IF NOT EXISTS mime_type VARCHAR(150) NULL AFTER file_name;
ALTER TABLE giao_trinh ADD COLUMN IF NOT EXISTS file_size INT NULL AFTER mime_type;
ALTER TABLE giao_trinh ADD COLUMN IF NOT EXISTS file_data LONGBLOB NULL AFTER file_size;
ALTER TABLE giao_trinh MODIFY COLUMN duong_dan VARCHAR(1000) NULL;

-- =============================================================================
-- DỌN DẸP: xóa hết các bài kiểm tra mẫu/cũ, thay bằng 1 bài toán đơn giản
-- cho học sinh lớp 1. Xóa bai_kiem_tra sẽ tự kéo theo xóa cau_hoi,
-- luot_lam_bai, chi_tiet_bai_lam, cam_thi, cheat_log liên quan (ON DELETE
-- CASCADE) - an toàn khi chạy lại nhiều lần.
-- =============================================================================
DELETE FROM bai_kiem_tra;

INSERT INTO subjects (id, name, color) VALUES
    ('sub-toan-l1', 'Toán lớp 1', 'bg-orange-500')
ON DUPLICATE KEY UPDATE name = VALUES(name), color = VALUES(color);

INSERT INTO bai_kiem_tra
    (mon_hoc_id, tieu_de, mo_ta, thoi_gian_lam_bai, thoi_gian_hien_thi_ket_qua, trang_thai, hien_thi, cho_phep_lam_bai, nguoi_tao_id)
VALUES
    ('sub-toan-l1', 'Bài toán cộng trừ lớp 1', 'Bài kiểm tra đơn giản: phép cộng trong phạm vi 10.', 10, 5, 'dang_mo', 1, 1, 'ql1');

SET @bai_toan_l1_id = (SELECT id FROM bai_kiem_tra WHERE tieu_de = 'Bài toán cộng trừ lớp 1' AND mon_hoc_id = 'sub-toan-l1' ORDER BY id DESC LIMIT 1);

INSERT INTO cau_hoi (bai_kiem_tra_id, noi_dung, loai_cau_hoi, dapan_a, dapan_b, dapan_c, dapan_d, dapan_dung, diem)
VALUES
    (@bai_toan_l1_id, '2 + 3 = ?', 'trac_nghiem', '4', '5', '6', '7', 'B', 10);


-- =============================================================================
-- BÀI NỘP: sinh viên nộp tệp + ghi chú cho 1 bài tập (do giảng viên giao).
-- Mọi bài nộp được trình duyệt đóng gói thành XML (api/xsd/bai_nop.xsd). Khi không có mạng,
-- XML nằm trên thiết bị sinh viên và tự gửi lên khi có mạng lại; server đọc XML bằng XPath
-- rồi lưu vào bảng này. api/submissions.php cũng tự tạo bảng nếu thiếu (không cần import lại).
-- client_id + sinh_vien là duy nhất: gửi lại cùng 1 bài (mạng chập chờn) không bị nộp trùng.
-- che_do: 'online' = nộp lúc có mạng; 'offline' = soạn lúc mất mạng, đồng bộ sau.
-- =============================================================================
CREATE TABLE IF NOT EXISTS bai_nop (
    id INT AUTO_INCREMENT PRIMARY KEY,
    client_id VARCHAR(64) NOT NULL,
    homework_id VARCHAR(50) NOT NULL,
    subject_id VARCHAR(50) NULL,
    sinh_vien VARCHAR(50) NOT NULL,
    ghi_chu TEXT NULL,
    file_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(150) NOT NULL DEFAULT 'application/octet-stream',
    file_size INT UNSIGNED NOT NULL DEFAULT 0,
    file_data LONGBLOB NOT NULL,
    che_do ENUM('online', 'offline') NOT NULL DEFAULT 'online',
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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

-- =============================================================================
-- 5 LỚP HỌC + 10 SINH VIÊN (mật khẩu chung 123123)
-- Mỗi sinh viên chỉ thuộc 1 lớp (cột users.lop_id); mỗi lớp có 2 sinh viên.
-- Chạy trong phpMyAdmin (database studyhub). An toàn khi chạy lại, không xóa dữ liệu.
-- Danh sách đầy đủ xem file danh_sach_sinh_vien.txt.
-- =============================================================================

CREATE TABLE IF NOT EXISTS lop_hoc (
    id VARCHAR(20) NOT NULL PRIMARY KEY,
    ten VARCHAR(100) NOT NULL,
    UNIQUE KEY uq_lop_ten (ten)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE users ADD COLUMN IF NOT EXISTS lop_id VARCHAR(20) NULL;

INSERT INTO lop_hoc (id, ten) VALUES
    ('lop-1', '22CNTT1'),
    ('lop-2', '22CNTT2'),
    ('lop-3', '22CNTT3'),
    ('lop-4', '22CNTT4'),
    ('lop-5', '22CNTT5')
ON DUPLICATE KEY UPDATE ten = VALUES(ten);

INSERT INTO users (username, password, ho_ten, ma_so_sv, role, lop_id) VALUES
    ('sv3', '123123', 'Lê Hoàng Nam', '2200003', 'sv', 'lop-1'),
    ('sv4', '123123', 'Phạm Thị Lan Anh', '2200004', 'sv', 'lop-1'),
    ('sv5', '123123', 'Võ Quốc Bảo', '2200005', 'sv', 'lop-2'),
    ('sv6', '123123', 'Đặng Thu Hà', '2200006', 'sv', 'lop-2'),
    ('sv7', '123123', 'Bùi Minh Khoa', '2200007', 'sv', 'lop-3'),
    ('sv8', '123123', 'Hoàng Ngọc Mai', '2200008', 'sv', 'lop-3'),
    ('sv9', '123123', 'Huỳnh Gia Huy', '2200009', 'sv', 'lop-4'),
    ('sv10', '123123', 'Ngô Thanh Thảo', '2200010', 'sv', 'lop-4'),
    ('sv11', '123123', 'Dương Tuấn Kiệt', '2200011', 'sv', 'lop-5'),
    ('sv12', '123123', 'Trịnh Bảo Ngọc', '2200012', 'sv', 'lop-5')
ON DUPLICATE KEY UPDATE password = VALUES(password), ho_ten = VALUES(ho_ten), ma_so_sv = VALUES(ma_so_sv), role = 'sv', lop_id = VALUES(lop_id);
