// server.js

const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

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

        const model = "gemini-2.5-flash"; 
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

        // --- PROMPT "TỔNG HỢP & TRUNG THỰC TUYỆT ĐỐI" ---
        const prompt = `
        Vai trò: Bạn là trợ lý tra cứu thông tin Pháp Môn Tâm Linh.
        
        Nhiệm vụ: Trả lời câu hỏi: "${question}" dựa trên VĂN BẢN NGUỒN.

        QUY TẮC BẤT DI BẤT DỊCH (KHÔNG ĐƯỢC PHẠM):
        1. **CHỈ DÙNG DỮ LIỆU ĐƯỢC CUNG CẤP:** Tuyệt đối KHÔNG sử dụng kiến thức bên ngoài của bạn. Nếu thông tin không có trong văn bản bên dưới, coi như bạn không biết.
        
        2. **TRÍCH DẪN & TỔNG HỢP:** - Tìm kiếm TẤT CẢ các đoạn trong văn bản có liên quan đến câu hỏi (dù nằm rải rác).
           - Trích dẫn lại các ý đó một cách ngắn gọn, súc tích.
           - Giữ nguyên các định dạng quan trọng (in đậm, gạch đầu dòng).

        3. **TRƯỜNG HỢP KHÔNG CÓ THÔNG TIN:** - Nếu không tìm thấy thông tin trong văn bản, BẮT BUỘC trả lời chính xác câu sau:
           "Mời Sư huynh tra cứu thêm tại mục lục tổng quan : https://mucluc.pmtl.site"

        --- VĂN BẢN NGUỒN BẮT ĐẦU ---
        ${context}
        --- VĂN BẢN NGUỒN KẾT THÚC ---
        
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
                // 0.3 là mức hoàn hảo: Đủ thông minh để hiểu câu hỏi, nhưng quá thấp để bịa chuyện.
                temperature: 0.3, 
                topK: 40,
                topP: 0.95,
                maxOutputTokens: 4096,
            }
        };

        const response = await axios.post(apiUrl, payload, {
            headers: { 'Content-Type': 'application/json' }
        });

        // Xử lý an toàn chống sập server (Dùng Optional Chaining ?.)
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
        res.status(200).json({ answer: "Mời Sư huynh tra cứu thêm tại mục lục tổng quan : https://mucluc.pmtl.site" });
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
