/* =====================================================================
   excel_import.js: đọc file Excel (.xlsx) chứa câu hỏi trắc nghiệm.

   Định dạng file:
     - Cột A: nội dung câu hỏi
     - Cột B, C, D, E: đáp án A, B, C, D
     - Đáp án được IN ĐẬM là đáp án đúng (mỗi câu đúng 1 đáp án in đậm)
     - Dòng CHỈ có cột A (B-E để trống) là câu TỰ LUẬN
     - Dòng tiêu đề đầu file (VD "Câu hỏi | Đáp án A | ...") có thì tự bỏ qua

   File .xlsx thực chất là file zip chứa các file XML. Thư viện SheetJS bản
   miễn phí không đọc được định dạng in đậm nên ở đây tự đọc XML:
     - xl/styles.xml        : font nào in đậm, ô nào dùng font nào
     - xl/sharedStrings.xml : chữ trong ô (kể cả ô chỉ in đậm MỘT PHẦN chữ)
     - xl/worksheets/*.xml  : giá trị + kiểu (style) của từng ô
   Cần thư viện JSZip (nạp trong index.html) để mở file zip.

   Hàm chính: parseQuizExcel(file) -> { questions, errors, soDong }
   ===================================================================== */

(function (global) {
    'use strict';

    var NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

    function parseXml(text) {
        var doc = new DOMParser().parseFromString(text, 'text/xml');
        if (doc.getElementsByTagName('parsererror').length > 0) {
            throw new Error('File Excel bị lỗi cấu trúc, không đọc được.');
        }
        return doc;
    }

    function childrenByName(el, name) {
        var out = [];
        if (!el) return out;
        for (var i = 0; i < el.children.length; i++) {
            if (el.children[i].localName === name) out.push(el.children[i]);
        }
        return out;
    }

    function firstChild(el, name) {
        return childrenByName(el, name)[0] || null;
    }

    // <b/>, <b val="1"/>, <b val="true"/> là in đậm; <b val="0"/>, <b val="false"/> là không
    function isBoldProps(propsEl) {
        var b = firstChild(propsEl, 'b');
        if (!b) return false;
        var v = b.getAttribute('val');
        return !(v === '0' || v === 'false');
    }

    async function readZipText(zip, path) {
        var entry = zip.file(path);
        return entry ? await entry.async('string') : null;
    }

    /* ---- xl/styles.xml: trả về mảng boldByStyleIndex[s] ---- */
    function parseStyles(xml) {
        var result = [];
        if (!xml) return result;
        var doc = parseXml(xml);

        var fontsEl = doc.getElementsByTagName('fonts')[0];
        var fontBold = childrenByName(fontsEl, 'font').map(function (f) { return isBoldProps(f); });

        var xfsEl = doc.getElementsByTagName('cellXfs')[0];
        childrenByName(xfsEl, 'xf').forEach(function (xf) {
            var fontId = parseInt(xf.getAttribute('fontId') || '0', 10);
            result.push(!!fontBold[fontId]);
        });
        return result;
    }

    /* ---- chữ của 1 phần tử <si> (shared string) hoặc <is> (inline string) ----
       Trả về { text, bold }. Nếu chữ có nhiều đoạn (rich text) thì coi là in đậm
       khi các đoạn in đậm chiếm từ 50% số ký tự (không tính khoảng trắng) trở lên. */
    function parseRichString(si) {
        var runs = childrenByName(si, 'r');
        if (runs.length === 0) {
            var plain = childrenByName(si, 't').map(function (t) { return t.textContent; }).join('');
            return { text: plain, rich: false, bold: false };
        }
        var text = '';
        var boldChars = 0;
        var totalChars = 0;
        runs.forEach(function (r) {
            var t = childrenByName(r, 't').map(function (x) { return x.textContent; }).join('');
            text += t;
            var n = t.replace(/\s+/g, '').length;
            totalChars += n;
            if (isBoldProps(firstChild(r, 'rPr'))) boldChars += n;
        });
        return { text: text, rich: true, bold: totalChars > 0 && boldChars / totalChars >= 0.5 };
    }

    function parseSharedStrings(xml) {
        if (!xml) return [];
        var doc = parseXml(xml);
        var sst = doc.getElementsByTagName('sst')[0];
        return childrenByName(sst, 'si').map(parseRichString);
    }

    /* ---- tìm file XML của sheet đầu tiên ---- */
    async function findFirstSheetPath(zip) {
        var fallback = 'xl/worksheets/sheet1.xml';
        try {
            var wbXml = await readZipText(zip, 'xl/workbook.xml');
            var relsXml = await readZipText(zip, 'xl/_rels/workbook.xml.rels');
            if (!wbXml || !relsXml) return fallback;

            var sheet = parseXml(wbXml).getElementsByTagName('sheet')[0];
            if (!sheet) return fallback;
            var rid = sheet.getAttributeNS(NS_R, 'id') || sheet.getAttribute('r:id');

            var rels = parseXml(relsXml).getElementsByTagName('Relationship');
            for (var i = 0; i < rels.length; i++) {
                if (rels[i].getAttribute('Id') === rid) {
                    var target = rels[i].getAttribute('Target') || '';
                    if (!target) return fallback;
                    return target.charAt(0) === '/' ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
                }
            }
        } catch (e) {
            // dùng đường dẫn mặc định
        }
        return fallback;
    }

    function colIndexFromRef(ref) {
        var m = /^([A-Z]+)/i.exec(ref || '');
        if (!m) return -1;
        var letters = m[1].toUpperCase();
        var n = 0;
        for (var i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
        return n - 1;
    }

    /* ---- đọc sheet: trả về mảng { rowNum, cells: [ {text,bold} x5 ] } (cột A-E) ---- */
    function parseSheet(xml, sst, styleBold) {
        var doc = parseXml(xml);
        var sheetData = doc.getElementsByTagName('sheetData')[0];
        var rows = [];
        var autoRow = 0;

        childrenByName(sheetData, 'row').forEach(function (rowEl) {
            autoRow++;
            var rowNum = parseInt(rowEl.getAttribute('r') || '', 10) || autoRow;
            autoRow = rowNum;
            var cells = [null, null, null, null, null];
            var autoCol = -1;

            childrenByName(rowEl, 'c').forEach(function (c) {
                autoCol++;
                var col = colIndexFromRef(c.getAttribute('r'));
                if (col < 0) col = autoCol;
                autoCol = col;
                if (col > 4) return;

                var t = c.getAttribute('t') || '';
                var vEl = firstChild(c, 'v');
                var v = vEl ? vEl.textContent : '';
                var text = '';
                var bold = false;
                var styled = true;

                if (t === 's') {
                    var item = sst[parseInt(v, 10)];
                    if (item) {
                        text = item.text;
                        if (item.rich) { bold = item.bold; styled = false; }
                    }
                } else if (t === 'inlineStr') {
                    var is = firstChild(c, 'is');
                    if (is) {
                        var inl = parseRichString(is);
                        text = inl.text;
                        if (inl.rich) { bold = inl.bold; styled = false; }
                    }
                } else if (t === 'b') {
                    text = v === '1' ? 'TRUE' : 'FALSE';
                } else if (t === 'e') {
                    text = '';
                } else {
                    text = v; // số hoặc chuỗi công thức (t="str")
                }

                if (styled) {
                    var s = parseInt(c.getAttribute('s') || '0', 10);
                    bold = !!styleBold[s];
                }

                text = String(text).replace(/\r\n?/g, '\n').trim();
                cells[col] = { text: text, bold: text !== '' && bold };
            });

            rows.push({ rowNum: rowNum, cells: cells });
        });

        rows.sort(function (a, b) { return a.rowNum - b.rowNum; });
        return rows;
    }

    /* ---- bỏ dấu tiếng Việt + chữ thường để so sánh tiêu đề ---- */
    function normalize(s) {
        return String(s || '')
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/đ/g, 'd').replace(/Đ/g, 'D')
            .toLowerCase().trim();
    }

    function cellText(row, i) {
        return row.cells[i] ? row.cells[i].text : '';
    }

    function countBold(row) {
        var n = 0;
        for (var i = 1; i <= 4; i++) if (row.cells[i] && row.cells[i].bold) n++;
        return n;
    }

    function isEmptyRow(row) {
        for (var i = 0; i <= 4; i++) if (cellText(row, i) !== '') return false;
        return true;
    }

    // Dòng tiêu đề: cột A bắt đầu bằng "STT / Câu hỏi / Question / Nội dung" và
    // không có đúng 1 ô in đậm ở B-E (tiêu đề hay in đậm cả dòng = 4 ô đậm).
    function looksLikeHeader(row) {
        if (countBold(row) === 1) return false;
        return /^(stt|cau hoi|question|noi dung)/.test(normalize(cellText(row, 0)));
    }

    var LETTERS = ['A', 'B', 'C', 'D'];

    /* Đọc file Excel -> { questions: [{dong,noiDung,dapA..dapD,dapDung}],
                           errors: [{dong,message}], soDong } */
    async function parseQuizExcel(file) {
        if (typeof JSZip === 'undefined') {
            throw new Error('Chưa tải được thư viện đọc Excel (cần Internet). Hãy tải lại trang rồi thử lại.');
        }

        var zip;
        try {
            zip = await JSZip.loadAsync(await file.arrayBuffer());
        } catch (e) {
            throw new Error('Không mở được file. Hãy dùng file Excel đuôi .xlsx (không phải .xls hoặc .csv).');
        }

        var sheetPath = await findFirstSheetPath(zip);
        var sheetXml = await readZipText(zip, sheetPath);
        if (!sheetXml) {
            throw new Error('Không tìm thấy trang tính trong file Excel.');
        }

        var styleBold = parseStyles(await readZipText(zip, 'xl/styles.xml'));
        var sst = parseSharedStrings(await readZipText(zip, 'xl/sharedStrings.xml'));
        var rows = parseSheet(sheetXml, sst, styleBold).filter(function (r) { return !isEmptyRow(r); });

        var questions = [];
        var errors = [];

        rows.forEach(function (row, idx) {
            if (idx === 0 && looksLikeHeader(row)) return;

            var problems = [];
            var noiDung = cellText(row, 0);

            // Dòng CHỈ có cột A (B-E trống hết) = câu TỰ LUẬN, không cần đáp án/in đậm.
            if (noiDung !== '' && cellText(row, 1) === '' && cellText(row, 2) === '' &&
                cellText(row, 3) === '' && cellText(row, 4) === '') {
                questions.push({
                    dong: row.rowNum, loai: 'tu_luan', noiDung: noiDung,
                    dapA: '', dapB: '', dapC: '', dapD: '', dapDung: 'A'
                });
                return;
            }

            if (noiDung === '') problems.push('thiếu nội dung câu hỏi (cột A)');

            var missing = [];
            for (var i = 0; i < 4; i++) {
                if (cellText(row, i + 1) === '') missing.push(LETTERS[i]);
            }
            if (missing.length > 0) problems.push('thiếu đáp án ' + missing.join(', '));

            var boldIdx = [];
            for (var j = 0; j < 4; j++) {
                if (row.cells[j + 1] && row.cells[j + 1].bold) boldIdx.push(j);
            }
            if (boldIdx.length === 0) {
                problems.push('chưa in đậm đáp án đúng');
            } else if (boldIdx.length > 1) {
                problems.push('có ' + boldIdx.length + ' đáp án in đậm (' + boldIdx.map(function (k) { return LETTERS[k]; }).join(', ') + '), chỉ được in đậm 1 đáp án đúng');
            }

            if (problems.length > 0) {
                errors.push({ dong: row.rowNum, message: problems.join('; ') });
                return;
            }

            questions.push({
                dong: row.rowNum,
                loai: 'trac_nghiem',
                noiDung: noiDung,
                dapA: cellText(row, 1),
                dapB: cellText(row, 2),
                dapC: cellText(row, 3),
                dapD: cellText(row, 4),
                dapDung: LETTERS[boldIdx[0]]
            });
        });

        return { questions: questions, errors: errors, soDong: questions.length + errors.length };
    }


    /* ---------------------------------------------------------------------
       Danh sách SINH VIÊN từ Excel (nút "Nạp từ Excel" ở bảng Tài khoản sinh viên).
       Cột A: mã số SV | B: tên sinh viên | C: lớp | D: user | E: mật khẩu
       Dòng tiêu đề (nếu có) tự bỏ qua. Trả về { students, errors, soDong }.
       --------------------------------------------------------------------- */
    function looksLikeStudentHeader(row) {
        var a = normalize(cellText(row, 0));
        var d = normalize(cellText(row, 3));
        return /^(stt|ma so|mssv|ma sv|ma sinh vien)/.test(a) || /^(user|ten dang nhap|tai khoan)/.test(d);
    }

    async function parseStudentExcel(file) {
        if (typeof JSZip === 'undefined') {
            throw new Error('Chưa tải được thư viện đọc Excel (cần Internet). Hãy tải lại trang rồi thử lại.');
        }
        var zip;
        try {
            zip = await JSZip.loadAsync(await file.arrayBuffer());
        } catch (e) {
            throw new Error('Không mở được file. Hãy dùng file Excel đuôi .xlsx (không phải .xls hoặc .csv).');
        }
        var sheetPath = await findFirstSheetPath(zip);
        var sheetXml = await readZipText(zip, sheetPath);
        if (!sheetXml) throw new Error('Không tìm thấy trang tính trong file Excel.');

        var styleBold = parseStyles(await readZipText(zip, 'xl/styles.xml'));
        var sst = parseSharedStrings(await readZipText(zip, 'xl/sharedStrings.xml'));
        var rows = parseSheet(sheetXml, sst, styleBold).filter(function (r) { return !isEmptyRow(r); });

        var students = [];
        var errors = [];
        var seenUser = {};
        var seenMssv = {};

        rows.forEach(function (row, idx) {
            if (idx === 0 && looksLikeStudentHeader(row)) return;

            var maSoSv = cellText(row, 0);
            var hoTen = cellText(row, 1);
            var lop = cellText(row, 2);
            var username = cellText(row, 3);
            var password = cellText(row, 4);
            var problems = [];

            if (maSoSv === '') problems.push('thiếu mã số sinh viên (cột A)');
            if (hoTen === '') problems.push('thiếu tên sinh viên (cột B)');
            if (username === '') problems.push('thiếu user (cột D)');
            else if (!/^[A-Za-z0-9._@-]{3,50}$/.test(username)) problems.push('user chỉ gồm chữ không dấu, số, . _ - @ (3-50 ký tự)');
            if (maSoSv !== '' && !/^[A-Za-z0-9._-]{1,30}$/.test(maSoSv)) problems.push('mã số sinh viên chỉ gồm chữ, số, . _ -');
            if (username !== '' && seenUser[username.toLowerCase()]) problems.push('user "' + username + '" bị trùng với dòng ' + seenUser[username.toLowerCase()]);
            if (maSoSv !== '' && seenMssv[maSoSv]) problems.push('mã số "' + maSoSv + '" bị trùng với dòng ' + seenMssv[maSoSv]);

            if (problems.length > 0) {
                errors.push({ dong: row.rowNum, message: problems.join('; ') });
                return;
            }
            seenUser[username.toLowerCase()] = row.rowNum;
            seenMssv[maSoSv] = row.rowNum;
            students.push({ dong: row.rowNum, maSoSv: maSoSv, hoTen: hoTen, lop: lop, username: username, password: password });
        });

        return { students: students, errors: errors, soDong: students.length + errors.length };
    }

    global.parseStudentExcel = parseStudentExcel;

    global.parseQuizExcel = parseQuizExcel;
})(window);
