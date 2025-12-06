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
app.use(express.json({ limit: '10mb' })); // Tăng giới hạn để nhận file text lớn

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

        // KHUYẾN NGHỊ: Dùng gemini-1.5-flash để cân bằng giữa tốc độ và khả năng hiểu ngữ cảnh lớn
        const model = "gemini-2.5-flash-lite"; 
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

        // --- PROMPT "TRÍCH XUẤT NGUYÊN VĂN" ---
        const prompt = `Bạn là một cỗ máy trích xuất dữ liệu chính xác.
        
        NHIỆM VỤ: Tìm kiếm câu trả lời cho câu hỏi trong VĂN BẢN NGUỒN và trích xuất NGUYÊN VĂN đoạn đó ra.

        QUY TẮC TUYỆT ĐỐI (KHÔNG ĐƯỢC VI PHẠM):
        1.  **SAO CHÉP Y HỆT:** Câu trả lời phải là các câu/đoạn văn được copy y hệt từ VĂN BẢN NGUỒN. Không được viết lại (paraphrase), không được tóm tắt, không được thêm từ ngữ hoa mỹ.
        2.  **KHÔNG BIẾT THÌ NÓI KHÔNG BIẾT:** Nếu không tìm thấy thông tin khớp trong văn bản, BẮT BUỘC trả lời duy nhất câu: "Mời Sư huynh tra cứu thêm tại mục lục tổng quan : https://mucluc.pmtl.site".
        3.  **KHÔNG SÁNG TẠO:** Tuyệt đối không thêm kiến thức bên ngoài.
        4.  **XƯNG HÔ:** Bắt đầu câu trả lời bằng "Thưa Sư huynh, đệ xin phép gửi câu trả lời ạ 🙏:".
        5.  **GIỮ NGUYÊN LINK:** Nếu đoạn trích có chứa Link, phải giữ nguyên link đó.

        --- VĂN BẢN NGUỒN BẮT ĐẦU ---
        ${context}
        --- VĂN BẢN NGUỒN KẾT THÚC ---
        
        Câu hỏi: "${question}"
        
        Đoạn trích dẫn nguyên văn (hoặc thông báo không tìm thấy):`;

        // Cấu hình Safety để tránh chặn nhầm các từ ngữ tôn giáo
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
                // ĐÂY LÀ CHÌA KHÓA CỦA SỰ CHÍNH XÁC
                temperature: 0.0,       // Không sáng tạo, chỉ chọn phương án chắc chắn nhất
                topK: 1,                // Chỉ chọn 1 từ có xác suất cao nhất
                topP: 0.1,              // Giới hạn phạm vi lựa chọn từ
                maxOutputTokens: 2048,
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
        let finalAnswer = "";
        if (aiResponse.includes("mucluc.pmtl.site") || aiResponse.trim() === "") {
             finalAnswer = "Mời Sư huynh tra cứu thêm tại mục lục tổng quan : https://mucluc.pmtl.site";
        } else {
             // Chỉ hiển thị nội dung trích xuất, không thêm khung rườm rà
             finalAnswer = aiResponse;
        }

        res.json({ answer: finalAnswer });

    } catch (error) {
        console.error('Lỗi API:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Hệ thống đang bận, Sư huynh thử lại sau nhé.' });
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
