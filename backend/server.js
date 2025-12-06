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
// Tăng giới hạn bộ nhớ để nhận file text lớn
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

        const model = "gemini-2.5-flash"; 
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

        const prompt = `
        Bạn là một công cụ trích xuất dữ liệu chính xác tuyệt đối.
        
        NHIỆM VỤ: 
        Tìm kiếm trong VĂN BẢN NGUỒN các câu, gạch đầu dòng (*), hoặc hàng trong bảng (|...|) chứa câu trả lời cho câu hỏi: "${question}"
        
        QUY TẮC TRẢ LỜI (BẮT BUỘC):
        1. **CHỈ TRÍCH DẪN:** Chỉ Copy và Paste nguyên văn các dòng/đoạn chứa thông tin trả lời. 
           - KHÔNG tự viết lại câu.
           - KHÔNG thêm lời chào hỏi, mở bài, kết bài.
           - KHÔNG lấy cả một mục lớn nếu chỉ có 1 dòng bên trong là câu trả lời.
        
        2. **ĐỊNH DẠNG:** Giữ nguyên định dạng Markdown của văn bản gốc (in đậm **, gạch đầu dòng *, bảng |...|).
        
        3. **NHIỀU VỊ TRÍ:** Nếu câu trả lời nằm rải rác, hãy trích xuất tất cả và liệt kê ra.

        4. **KHÔNG TÌM THẤY:** Nếu tuyệt đối không có thông tin nào liên quan, hãy trả lời duy nhất câu: 
           "Mời Sư huynh tra cứu thêm tại mục lục tổng quan : https://mucluc.pmtl.site"

        --- VĂN BẢN NGUỒN ---
        ${context}
        --- HẾT VĂN BẢN NGUỒN ---
        
        Kết quả trích dẫn:
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
                temperature: 0.0,
                topK: 1,
                topP: 0.1,
                maxOutputTokens: 2048,
            }
        };

        const response = await axios.post(apiUrl, payload, {
            headers: { 'Content-Type': 'application/json' }
        });

        // --- KHU VỰC SỬA LỖI (QUAN TRỌNG NHẤT) ---
        // Sử dụng Optional Chaining (?.) để không bao giờ bị crash dù dữ liệu rỗng
        let aiResponse = "";
        
        const candidates = response.data?.candidates;
        if (candidates && candidates.length > 0) {
            // Thêm ?.[0] để đảm bảo nếu parts không tồn tại hoặc rỗng thì không lỗi
            aiResponse = candidates[0]?.content?.parts?.[0]?.text || "";
        }
        // ----------------------------------------

        let finalAnswer = aiResponse.trim();
        
        // Xử lý trường hợp rỗng hoặc lỗi
        if (!finalAnswer || finalAnswer.length < 2 || finalAnswer.includes("mucluc.pmtl.site")) {
             finalAnswer = "Mời Sư huynh tra cứu thêm tại mục lục tổng quan : https://mucluc.pmtl.site";
        }

        res.json({ answer: finalAnswer });

    } catch (error) {
        // Log lỗi chi tiết để debug nhưng không làm sập server
        console.error('Lỗi API:', error.response ? error.response.data : error.message);
        res.status(200).json({ answer: "Mời Sư huynh tra cứu thêm tại mục lục tổng quan : https://mucluc.pmtl.site" });
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
