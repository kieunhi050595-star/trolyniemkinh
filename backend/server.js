// server.js

// --- 1. Import các thư viện cần thiết ---
const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

// --- 2. Khởi tạo ứng dụng Express ---
const app = express();
const PORT = process.env.PORT || 3001;

// --- 3. Cấu hình Middleware ---
app.use(cors());
// Tăng giới hạn lên 50mb để đảm bảo load hết file text dài
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// --- ROUTE HEALTH CHECK ---
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: "OK", message: "Server is alive" });
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// --- 5. Định nghĩa Route Chat ---
app.post('/api/chat', async (req, res) => {
    if (!GEMINI_API_KEY) {
        return res.status(500).json({ error: 'Chưa cấu hình API Key.' });
    }

    try {
        const { question, context } = req.body;

        if (!question || !context) {
            return res.status(400).json({ error: 'Thiếu câu hỏi hoặc dữ liệu.' });
        }

        // --- QUAN TRỌNG: Dùng gemini-1.5-flash để xử lý văn bản dài chính xác nhất ---
        const model = "gemini-1.5-flash"; 
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

        // --- PROMPT "TRÍCH XUẤT CẤU TRÚC" (Đã tối ưu cho yêu cầu của bạn) ---
        const prompt = `
        Nhiệm vụ: Bạn là công cụ tìm kiếm chính xác tuyệt đối trong văn bản Pháp Môn Tâm Linh.
        
        Người dùng hỏi: "${question}"

        Hãy tìm trong VĂN BẢN NGUỒN bên dưới đoạn thông tin trả lời cho câu hỏi trên.

        QUY TẮC TRẢ LỜI (BẮT BUỘC TUÂN THỦ):
        1. **ĐỊNH DẠNG:** Phải trích xuất **nguyên văn cả Tiêu Đề (Heading)** chứa thông tin đó và **các dòng nội dung bên dưới**.
           - Ví dụ tiêu đề thường bắt đầu bằng "###", "**", hoặc số thứ tự.
           - Giữ nguyên các ký tự định dạng Markdown như dấu sao (*), dấu gạch đầu dòng (-), in đậm (**text**).
        
        2. **KHÔNG SÁNG TẠO:** Chỉ Copy và Paste y hệt từ văn bản nguồn. Không được viết lại câu, không được tóm tắt.
        
        3. **CHÍNH XÁC:** Chỉ trích xuất đoạn liên quan nhất. Nếu đoạn đó nằm trong mục "2.3", hãy lấy cả dòng "2.3..." và nội dung bên dưới nó.

        4. **TRƯỜNG HỢP KHÔNG TÌM THẤY:** Nếu không có thông tin khớp, chỉ trả lời duy nhất câu: 
           "Mời Sư huynh tra cứu thêm tại mục lục tổng quan : https://mucluc.pmtl.site"

        --- VĂN BẢN NGUỒN ---
        ${context}
        --- HẾT VĂN BẢN NGUỒN ---
        
        Câu trả lời (Định dạng Markdown):
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
                temperature: 0.0, // Nhiệt độ 0 để đảm bảo không bịa đặt
                topK: 1,
                topP: 0.1,
                maxOutputTokens: 4096, // Tăng token để câu trả lời không bị cắt cụt
            }
        };

        const response = await axios.post(apiUrl, payload, {
            headers: { 'Content-Type': 'application/json' }
        });

        let aiResponse = "";
        if (response.data.candidates && response.data.candidates.length > 0) {
            aiResponse = response.data.candidates[0].content?.parts[0]?.text || "";
        }

        // Xử lý kết quả trả về
        let finalAnswer = aiResponse.trim();
        
        if (!finalAnswer || finalAnswer.includes("mucluc.pmtl.site")) {
             finalAnswer = "Mời Sư huynh tra cứu thêm tại mục lục tổng quan : https://mucluc.pmtl.site";
        }

        res.json({ answer: finalAnswer });

    } catch (error) {
        console.error('Lỗi API:', error.response ? error.response.data : error.message);
        // Fallback nhẹ nhàng
        res.status(500).json({ error: 'Đệ đang bận xíu, Sư huynh hỏi lại sau nhé.' });
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
