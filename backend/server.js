// server.js

const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Tăng giới hạn lên 50mb để nhận file text lớn
app.use(cors());
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: "OK", message: "Server is alive" });
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

app.post('/api/chat', async (req, res) => {
    if (!GEMINI_API_KEY) {
        return res.status(500).json({ error: 'Chưa cấu hình API Key.' });
    }

    try {
        const { question, context } = req.body;

        if (!question || !context) {
            return res.status(400).json({ error: 'Thiếu câu hỏi hoặc dữ liệu.' });
        }

        const model = "gemini-1.5-flash"; 
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

        // --- PROMPT "KHÓA CHẶT SUY DIỄN" ---
        // Prompt này ép AI hoạt động như một thuật toán so khớp, cấm tuyệt đối việc "hiểu thoáng".
        const prompt = `
        VAI TRÒ: Bạn là một cỗ máy trích xuất dữ liệu vô tri. Bạn KHÔNG phải là trợ lý ảo. Bạn KHÔNG có tri thức bên ngoài.

        DỮ LIỆU DUY NHẤT: Chỉ được sử dụng thông tin nằm trong phần "VĂN BẢN NGUỒN" bên dưới.

        NHIỆM VỤ: Tìm câu trả lời cho câu hỏi: "${question}"

        QUY TRÌNH XỬ LÝ NGHIÊM NGẶT (THỰC HIỆN TỪNG BƯỚC):
        1. Quét văn bản nguồn để tìm các từ khóa chính trong câu hỏi.
        2. Nếu tìm thấy đoạn văn chứa thông tin trả lời trực tiếp:
           - Trích xuất nguyên văn các ý đó.
           - Tổng hợp lại thành các gạch đầu dòng (*).
           - Giữ nguyên định dạng Markdown (in đậm, bảng biểu).
        
        3. KIỂM TRA ĐỘ KHỚP (QUAN TRỌNG NHẤT):
           - Nếu câu hỏi hỏi về A, nhưng văn bản chỉ có B (gần giống A): KHÔNG ĐƯỢC TỰ SUY LUẬN B là A. -> Trả về câu mẫu.
           - Nếu phải dùng kiến thức bên ngoài để trả lời -> Trả về câu mẫu.
           - Nếu không tìm thấy thông tin -> Trả về câu mẫu.

        CÂU TRẢ LỜI MẪU (BẮT BUỘC DÙNG KHI KHÔNG TÌM THẤY HOẶC KHÔNG CHẮC CHẮN):
        "Mời Sư huynh tra cứu thêm tại mục lục tổng quan : https://mucluc.pmtl.site"

        --- VĂN BẢN NGUỒN ---
        ${context}
        --- HẾT VĂN BẢN NGUỒN ---
        
        Câu trả lời của bạn:
        `;

        const safetySettings = [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        ];
        
        const payload = {
            contents: [{ parts: [{ text: prompt }] }],
            safetySettings: safetySettings,
            generationConfig: {
                // --- THIẾT LẬP "MÁY MÓC" ---
                // Temperature = 0.0: AI sẽ chọn câu trả lời có xác suất cao nhất, không sáng tạo dù chỉ 1%.
                temperature: 0.0, 
                topK: 1,  // Chỉ xét 1 phương án duy nhất.
                topP: 0.1, // Loại bỏ mọi từ vựng lạ.
                maxOutputTokens: 2048,
            }
        };

        const response = await axios.post(apiUrl, payload, {
            headers: { 'Content-Type': 'application/json' }
        });

        // Xử lý an toàn chống sập server (Optional Chaining)
        let aiResponse = "";
        const candidates = response.data?.candidates;
        if (candidates && candidates.length > 0) {
            aiResponse = candidates[0]?.content?.parts?.[0]?.text || "";
        }

        let finalAnswer = aiResponse.trim();
        
        // Kiểm tra kỹ lần cuối
        if (!finalAnswer || finalAnswer.length < 5 || finalAnswer.includes("mucluc.pmtl.site")) {
             finalAnswer = "Mời Sư huynh tra cứu thêm tại mục lục tổng quan : https://mucluc.pmtl.site";
        }

        res.json({ answer: finalAnswer });

    } catch (error) {
        console.error('Lỗi API:', error.response ? error.response.data : error.message);
        // Trả về câu mặc định khi có lỗi hệ thống, không để lộ lỗi kỹ thuật
        res.status(200).json({ answer: "Mời Sư huynh tra cứu thêm tại mục lục tổng quan : https://mucluc.pmtl.site" });
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
