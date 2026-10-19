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
