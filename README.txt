HƯỚNG DẪN CÀI ĐẶT (PHP + MySQL)
================================

Yêu cầu:
- PHP 7.4 trở lên (có bật extension pdo_mysql)
- MySQL hoặc MariaDB
- Máy chủ web hỗ trợ PHP (Apache/Nginx/LiteSpeed, hoặc XAMPP/Laragon khi chạy local)

BƯỚC 1 - Tạo database rỗng
----------------------------
Vào cPanel/DirectAdmin/phpMyAdmin của hosting, tự tạo 1 database rỗng
(ví dụ đặt tên "studyhub" - lưu ý nhiều hosting sẽ tự thêm tiền tố như
"tenuser_studyhub", cứ để hosting đặt tên tự động).
Khi tạo, chọn Collation là utf8mb4_unicode_ci (hoặc utf8mb4_general_ci)
để chữ tiếng Việt không bị lỗi font.

BƯỚC 2 - Import cấu trúc bảng
------------------------------
Mở phpMyAdmin, chọn ĐÚNG database vừa tạo ở Bước 1 (bấm vào tên database
đó ở cột bên trái trước), sau đó vào tab "Import" (hoặc "SQL") và chọn
file "schema.sql" đi kèm để chạy.
File này sẽ tự tạo 4 bảng (users, subjects, homeworks,
homework_files) và chèn sẵn dữ liệu mẫu: 3 tài khoản + 10 môn học +
3 bài tập.
Lưu ý: file này KHÔNG tự tạo database (vì đa số tài khoản MySQL trên
hosting không có quyền đó) - nếu quên chọn database trước khi import,
sẽ báo lỗi hoặc dữ liệu bị import nhầm chỗ.

Nếu tự chạy bằng dòng lệnh (VD trên máy cá nhân/VPS có quyền root):
    mysql -u root -p ten_database_ban_da_tao < schema.sql

BƯỚC 3 - Cấu hình kết nối
--------------------------
Mở file "api/config.php", sửa 4 dòng sau cho khớp với thông tin MySQL của bạn
(tên database phải TRÙNG với database đã tạo ở Bước 1):

    $DB_HOST = 'localhost';
    $DB_NAME = 'studyhub';
    $DB_USER = 'root';
    $DB_PASS = '';

BƯỚC 4 - Tải toàn bộ lên hosting
---------------------------------
Copy nguyên cấu trúc thư mục lên host (giữ nguyên đường dẫn tương đối):

    /index.html
    /script.js
    /style.css
    /api/config.php
    /api/login.php
    /api/logout.php
    /api/session.php
    /api/subjects.php
    /api/homeworks.php
    /api/upload.php
    /uploads/.htaccess
    /uploads/README.txt

Thư mục "uploads/" dùng để chứa các tệp bài tập (docx, html, css, pdf...)
người dùng tải lên - máy chủ PHP cần có QUYỀN GHI (write permission) vào
thư mục này. Trên hosting Linux thường cần chạy lệnh:
    chmod 755 uploads/
(nếu vẫn lỗi "Không thể lưu tệp trên máy chủ", thử chmod 775 hoặc 777).
Trên XAMPP/Laragon ở máy cá nhân thường không cần chỉnh gì thêm.

Mở index.html qua đường dẫn http/https (không mở trực tiếp bằng file://,
vì trình duyệt sẽ không gọi được các file PHP trong thư mục api/).

TÀI KHOẢN MẶC ĐỊNH
-------------------
    ql1 / 123123   -> Giảng viên
    ql2 / 123123   -> Giảng viên
    sv1 / 123123   -> Sinh viên (Nguyễn Văn An, MSSV 2200001)
    sv2 / 123123   -> Sinh viên (Trần Thị Bình, MSSV 2200002)

QUẢN LÝ TÀI KHOẢN SINH VIÊN
---------------------------
- Đăng nhập bằng tài khoản Giảng viên, bấm nút "Tài khoản SV" trên thanh menu.
- Giảng viên tạo tài khoản SINH VIÊN gồm: tên đăng nhập, tên sinh viên (hiển thị
  thay cho tên đăng nhập), mã số sinh viên, mật khẩu. Khi đăng nhập sinh viên chỉ
  nhập tên đăng nhập + mật khẩu.
- Giảng viên KHÔNG tạo/sửa được tài khoản giảng viên khác (tài khoản giảng viên
  chỉ thêm trực tiếp trong bảng "users" bằng phpMyAdmin, role = 'gv').
- Giảng viên sửa được tên, mã số sinh viên, mật khẩu của sinh viên (để trống ô
  mật khẩu = giữ nguyên mật khẩu cũ). Tên đăng nhập không đổi được.
- Hai cột mới ho_ten, ma_so_sv của bảng "users" được api/config.php tự thêm khi
  chạy lần đầu, nên database đang dùng KHÔNG cần import lại schema.sql.
  (Cẩn thận: schema.sql có lệnh DELETE FROM users - chỉ import khi cài mới.)

CHẤM ĐIỂM TAY
-------------
- Tab Kiểm tra -> "Xem kết quả": giảng viên bấm vào điểm của sinh viên (bài đã nộp),
  nhập điểm mới rồi Enter (hoặc dấu tick); Esc để hủy. Dùng để chấm câu tự luận.
- Điểm phải từ 0 đến tổng điểm của bài. Để trống rồi lưu = bỏ điểm chấm tay, quay
  về điểm tự chấm trắc nghiệm.
- Điểm chấm tay được giữ nguyên khi giảng viên sửa đề (không bị tính lại), được
  dùng trong thống kê và file Excel xuất ra. Bấm "Mở lại" bài thì điểm chấm tay bị xóa.
- Cột diem_cham_tay của bảng luot_lam_bai do api/config.php tự thêm khi chạy lần đầu.

NẠP CÂU HỎI BẰNG FILE EXCEL
---------------------------
- Khi "Tạo bài kiểm tra" hoặc "Sửa bài kiểm tra", giảng viên bấm "Nạp từ Excel"
  và chọn file .xlsx (có file mẫu: mau_cau_hoi.xlsx, bấm "Tải file mẫu").
- Cột A: câu hỏi. Cột B, C, D, E: đáp án A, B, C, D. Đáp án ĐÚNG được IN ĐẬM
  (mỗi câu in đậm đúng 1 đáp án). Dòng tiêu đề (nếu có) tự được bỏ qua.
- Chỉ đọc trang tính (sheet) đầu tiên. Dòng nào lỗi (thiếu đáp án, không in đậm,
  in đậm nhiều hơn 1 đáp án...) bị bỏ qua và được liệt kê rõ số dòng + lý do.
- Câu hỏi nạp vào hiện trong form để giảng viên xem lại trước khi bấm lưu.
- Cần Internet để tải thư viện JSZip (cdnjs). File đọc bằng excel_import.js.

NỘP BÀI TẬP (HOẠT ĐỘNG CẢ KHI MẤT MẠNG)
---------------------------------------
Cách dùng
- Giảng viên đăng bài tập theo môn học như bình thường (tab "Bài tập").
- Sinh viên: bấm "Nộp bài" ở bài tập (hoặc vào tab "Nộp bài"), chọn tệp + ghi chú (không bắt buộc)
  rồi bấm Nộp. Nộp xong sẽ hiện thông báo "Nộp bài thành công!". Bài tập sinh viên tự tạo
  cho riêng mình thì không nộp được (chỉ nộp được bài tập do giảng viên giao).
- Giảng viên: mở tab "Nộp bài" (hoặc bấm "Bài nộp" ở 1 bài tập), lọc theo môn / bài tập, thấy tên +
  MSSV sinh viên, tệp, ghi chú, thời gian nộp; bấm "Xem" (pdf/ảnh/txt) hoặc "Tải về".
- Sinh viên KHÔNG xem/sửa/tải được bài của nhau (server lọc theo tài khoản đăng nhập; mở thẳng
  URL bài của người khác cũng bị từ chối). Mỗi sinh viên chỉ thấy bài của chính mình.

Khi mất mạng
- Trình duyệt vẫn cho nộp bài: bài được đóng gói thành file XML (cấu trúc: api/xsd/bai_nop.xsd,
  tệp mã hóa base64 bên trong) và LƯU TRÊN THIẾT BỊ (IndexedDB), hiện ở mục "Đang chờ đồng bộ".
- Khi có mạng lại, bài tự động được gửi lên chạy nền (sự kiện "online", mở lại trang, tự thử lại mỗi
  30 giây, và Background Sync của Service Worker trên Chrome/Edge/Android). Có thông báo khi nộp xong.
- Server (api/submissions.php): kiểm tra XML bằng XSD -> dùng XPath (DOMXPath) đọc các trường
  (/BaiNop/SinhVien/TenDangNhap, /BaiNop/BaiTap/@id, /BaiNop/GhiChu, /BaiNop/Tep ...) -> lưu vào bảng
  bai_nop -> giảng viên thấy ngay. Mỗi bài có mã clientId riêng nên gửi lại nhiều lần vẫn chỉ nộp 1 lần.
- Chỉ dùng XPath (PHP không có engine XQuery); phần "XQuery" được thay bằng XPath.
- Bài bị server từ chối hẳn (vd: giảng viên đã xóa bài tập) sẽ hiện lỗi rõ ràng kèm nút Thử lại/Xóa.
  Hết phiên đăng nhập: bài vẫn được giữ, đăng nhập lại là tự nộp. Bài chờ gắn với tài khoản đã soạn nó.

Yêu cầu / giới hạn
- Để mở được trang khi mất mạng, cần mở trang khi có mạng ÍT NHẤT 1 LẦN và chạy qua HTTPS hoặc
  localhost (yêu cầu của Service Worker; http://ip-lan thường không được). File sw.js phải nằm cùng
  thư mục với index.html.
- Tối đa 10MB / tệp. XML base64 lớn hơn ~33% nên cần post_max_size trong php.ini >= 14M
  (file .htaccess/.user.ini đi kèm đã đặt 1100M; nếu host bỏ qua thì tự tăng).
- Bảng bai_nop được api/submissions.php tự tạo khi chạy lần đầu (cũng có trong schema.sql), nên DB đang
  dùng KHÔNG cần import lại schema.sql.
- Các tệp mới: api/submissions.php, api/xsd/bai_nop.xsd, nop_bai.js, sw.js.

CHỌN MÔN CHO PHÉP NỘP BÀI TẬP
-----------------------------
- Giảng viên: ở trang "Môn học", mỗi thẻ môn có công tắc "Cho phép sinh viên nộp bài tập".
  Tắt = sinh viên không nộp được bài tập của môn đó (nút Nộp bài bị thay bằng "Đóng nộp bài",
  server cũng từ chối nếu gọi thẳng API, kể cả bài nộp offline đồng bộ sau).
- Cột subjects.cho_phep_nop_bai do api/config.php tự thêm khi chạy lần đầu (mặc định 1 = cho phép),
  không cần import lại schema.sql.

CHỐNG GIAN LẬN KHI LÀM BÀI KIỂM TRA
-----------------------------------
- Đưa chuột ra ngoài trang: ghi vi phạm NGAY (không chờ 5 giây).
- Ra ngoài (chuột/chuyển tab/cửa sổ) quá 5 giây: bài tự động được nộp, không còn giới hạn 3 lần.
- Chuyển tab/cửa sổ dưới 5 giây: chỉ cảnh báo, chưa tính vi phạm.

GIẢNG VIÊN THEO MÔN HỌC
-----------------------
- Chạy 1 lần file giang_vien_theo_mon.sql trong phpMyAdmin (database studyhub). File gộp các môn trùng tên,
  xóa 3 môn (Tiếng Anh, Phân tích và thiết kế hệ thống thông tin, Toán lớp 1) và tạo tài khoản giảng viên,
  mật khẩu chung 123123:
      mau (python) | oop (OOP) | lan (Khai phá dữ liệu) | toan (XML, WEB)
      thuong (Công nghệ phần mềm, Cơ sở dữ liệu) | doan (ĐỒ ÁN)
- Giảng viên của môn nào chỉ thấy/thao tác bài tập, bài kiểm tra, giáo trình, bài nộp, giám sát gian lận,
  thống kê và danh sách môn của môn đó (server kiểm tra ở mọi API, không chỉ ẩn trên giao diện).
  Giảng viên theo môn tạo/sửa/xóa được tài khoản SINH VIÊN nhưng không tạo/xóa được môn học hay giảng viên.
- ql1, ql2 là giảng viên quản trị: thấy mọi môn; tạo/sửa/xóa tài khoản giảng viên và sinh viên.
  Vào "Tài khoản" -> "Quản lý giảng viên" để thêm giảng viên, đổi mật khẩu, và tick 1 hoặc nhiều môn
  mà giảng viên đó phụ trách (đổi được bất cứ lúc nào, có hiệu lực ngay).
- Xóa 1 giảng viên: bài kiểm tra, giáo trình, bài tập họ đã tạo được chuyển sang tài khoản quản trị đang xóa.

LỚP HỌC VÀ 10 SINH VIÊN MẪU
---------------------------
- Chạy file sinh_vien_lop_hoc.sql: tạo 5 lớp (22CNTT1..22CNTT5) và 10 sinh viên sv3..sv12 (mật khẩu 123123),
  mỗi lớp 2 sinh viên, mỗi sinh viên chỉ 1 lớp. Danh sách đầy đủ: danh_sach_sinh_vien.txt.
- Trong "Tài khoản SV" có thêm cột Lớp và ô chọn lớp khi thêm/sửa sinh viên.

CHO PHÉP SINH VIÊN NỘP BÀI TẬP
------------------------------
- Giảng viên vào tab "Bài tập": chọn môn mình dạy ở bộ lọc môn và bật/tắt "Cho phép sinh viên nộp bài tập" của môn đó.
- Sinh viên vào tab "Bài tập": chọn môn ở bộ lọc, bấm "Nộp bài" ở bài tập muốn nộp (môn đóng sẽ hiện "Đóng nộp bài").
- Tab "Môn học" chỉ ql1, ql2 (quản trị), sinh viên và khách xem được; giảng viên theo môn không thấy tab này.

BÀI TẬP NỘP ĐƯỢC LƯU THÀNH FILE .XML
------------------------------------
- Mỗi bài tập sinh viên nộp thành công được server ghi thêm 1 file XML (thông tin sinh viên, môn, bài tập,
  ghi chú, thời gian nộp/nhận, tên-loại-kích thước tệp; KHÔNG chứa nội dung tệp):
      storage/bai_nop/<ma_bai_tap>/bai_nop_<id>.xml
  Cấu trúc kiểm tra bằng api/xsd/bai_nop_luu.xsd. Thư mục storage/ cần quyền ghi.
- File nằm ở thư mục storage/ trên server (giao diện không còn nút tải XML).

XML CHẠY NGẦM (người dùng không thấy)
-------------------------------------
- Khi sinh viên nộp bài, server tự ghi 1 file XML bài làm vào
  storage/bai_lam/quiz_<id>/luot_<id>.xml (bản lưu song song với MySQL).
- Mỗi file XML được kiểm tra bằng XSD (api/xsd/bai_lam.xsd) trước khi ghi; XML
  sai cấu trúc không được ghi, lỗi nằm trong error_log của PHP/Apache.
  Các XML kết quả/chi tiết của quizzes.php cũng được kiểm tra (ket_qua.xsd,
  chi_tiet.xsd - chỉ ghi log nếu sai, không chặn phản hồi).
- Khung thống kê trong "Xem kết quả" (điểm TB/cao/thấp, tỷ lệ đạt, phân bố điểm,
  câu hỏi sai nhiều nhất) do api/thong_ke.php tính bằng XPath trên các file XML
  đó và trả về XML (thong_ke.xsd).
- Cần thư mục storage/ có quyền ghi (XAMPP mặc định đã ghi được) và PHP bật
  extension dom + simplexml + libxml (mặc định đã bật). storage/.htaccess chặn
  truy cập trực tiếp file XML từ trình duyệt.
- Bài đã nộp từ trước khi có tính năng này sẽ tự được tạo file XML lần đầu mở thống kê.

XUẤT KẾT QUẢ RA EXCEL
---------------------
Tab "Kiểm tra" -> "Xem kết quả" -> nút "Xuất Excel". File .xlsx gồm: mã số SV,
tên SV, điểm, số câu đúng, số câu sai, thời gian làm bài (phút/giây), số lần vi
phạm của các sinh viên đã nộp bài. Cần có Internet để tải thư viện SheetJS (cdnjs).

Có thể đổi mật khẩu/thêm tài khoản trực tiếp trong bảng "users" (phpMyAdmin
hoặc lệnh SQL). Mật khẩu hiện lưu dạng chữ thường (plaintext) để đơn giản khi
tự quản lý; nếu triển khai cho nhiều người dùng thật, nên đổi sang lưu mật
khẩu đã băm bằng password_hash() và so sánh bằng password_verify() trong
api/login.php.

GHI CHÚ
-------
- Toàn bộ dữ liệu (tài khoản, môn học, bài tập, link, tệp đính kèm) đều
  được lưu trong MySQL - không dùng file XML hay lưu file ra ổ đĩa nữa.
- Khi xóa 1 môn học, các bài tập thuộc môn đó KHÔNG bị xóa mà tự chuyển
  sang "Chưa phân môn" (nhờ ràng buộc khóa ngoại ON DELETE SET NULL).
- Khi xóa 1 bài tập, các tệp đính kèm của nó cũng tự động bị xóa theo
  trong database (ON DELETE CASCADE) - không để lại rác.
- Tệp đính kèm (.docx, .html, .css, .pdf, ảnh...) được lưu TRỰC TIẾP vào
  cột file_data (LONGBLOB) trong bảng homework_files - không giới hạn
  định dạng, tối đa 20MB/tệp. Muốn đổi giới hạn dung lượng, sửa biến
  $maxSize trong api/homework_files.php.
- Nếu tải tệp lớn bị lỗi, kiểm tra thêm 2 giới hạn của chính PHP (không
  liên quan tới code) trong file php.ini: upload_max_filesize và
  post_max_size - mặc định nhiều máy chủ chỉ để 2MB, cần tăng lên (ví dụ
  20M) rồi khởi động lại Apache/PHP-FPM thì tệp lớn mới tải lên được.
- Máy chủ PHP có kiểm tra quyền (session) ở mọi thao tác Thêm/Sửa/Xóa,
  không chỉ dựa vào giao diện - nên vẫn an toàn kể cả khi ai đó gọi thẳng
  vào các file trong api/ mà không qua giao diện.


CẬP NHẬT MỚI
-------------
- Tài khoản quản lý mẫu đổi tên: gv1 -> ql1, gv2 -> ql2 (mật khẩu vẫn 123123). Database cũ tự được đổi tên khi đăng nhập/gọi API lần đầu.
- Tài khoản sinh viên mẫu: sv1 ... sv10, mật khẩu chung 123123.
- Tài khoản sinh viên > "Quản lý lớp": tạo / đổi tên / xóa lớp và gắn sinh viên vào lớp.
- Tài khoản sinh viên > "Nạp từ Excel": nạp nhanh danh sách bằng baitap/sinhvien.xlsx
  (A: mã số SV, B: tên, C: lớp, D: user, E: mật khẩu). Lớp chưa có sẽ tự tạo.
- Tạo/sửa bài kiểm tra có nút "Bật chống gian lận" (tắt = sinh viên làm bài không bị giám sát).
