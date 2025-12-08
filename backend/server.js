// server.js - Phiên bản "Trích Xuất Thông Minh" (Smart Extraction)

const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Giữ limit 50mb để nạp đủ context
app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.get('/api/health', (req, res) => {
    res.status(200).json({ status: "OK", message: "Server is up and running" });
});

const apiKeys = process.env.GEMINI_API_KEYS ? process.env.GEMINI_API_KEYS.split(',') : [];

// Hàm gọi API
async function callGeminiWithRetry(payload, keyIndex = 0) {
    if (keyIndex >= apiKeys.length) throw new Error("ALL_KEYS_EXHAUSTED");

    const currentKey = apiKeys[keyIndex];
    const model = "gemini-2.5-flash"; 
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${currentKey}`;

    try {
        const response = await axios.post(apiUrl, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 60000 
        });
        return response;
    } catch (error) {
        if (error.response && error.response.status === 429) {
            console.warn(`Key ${keyIndex} full, đổi key...`);
            return callGeminiWithRetry(payload, keyIndex + 1);
        }
        throw error;
    }
}

app.post('/api/chat', async (req, res) => {
    if (apiKeys.length === 0) return res.status(500).json({ error: 'Chưa cấu hình API Key.' });

    try {
        const { question, context } = req.body;
        if (!question || !context) return res.status(400).json({ error: 'Thiếu dữ liệu.' });

        // --- PROMPT "TRÍCH XUẤT THÔNG MINH" ---
        // Đây là trái tim của giải pháp: Yêu cầu AI lọc ý thay vì chép lại
        const prompt = `Bạn là trợ lý hỗ trợ tu tập, giúp tra cứu tài liệu nhanh chóng và chính xác.
        
        **NHIỆM VỤ:**
        Trả lời câu hỏi: "${question}" dựa trên VĂN BẢN NGUỒN.
        
        **QUY TẮC TRẢ LỜI (BẮT BUỘC):**
        1. **DẠNG GẠCH ĐẦU DÒNG:** Câu trả lời phải được trình bày dưới dạng danh sách các gạch đầu dòng (bullet points).
        2. **CÔ ĐỌNG & CHÍNH XÁC:** Chỉ chọn lọc những câu/đoạn chứa thông tin trực tiếp trả lời cho câu hỏi. Loại bỏ các lời dẫn nhập, các từ thừa, các đoạn văn mô tả không cần thiết.
        3. **KHÔNG SÁNG TÁC:** Sử dụng từ ngữ gốc của văn bản để đảm bảo tính chính xác của giáo lý. Không tự ý thêm thắt suy nghĩ cá nhân.
        4. **NẾU KHÔNG CÓ TIN:** Trả lời duy nhất: "Mời Sư huynh tra cứu thêm tại mục lục tổng quan : https://mucluc.pmtl.site ."
        5. **XƯNG HÔ:** Bắt đầu bằng "Thưa Sư huynh, theo tài liệu thì:".

        --- VĂN BẢN NGUỒN ---
        ${context}
        --- HẾT ---
        
        Câu trả lời (Gạch đầu dòng các ý chính):`;

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
                temperature: 0.1, // Để thấp để AI tập trung vào sự chính xác
                maxOutputTokens: 4096, // 4096 là quá đủ cho các gạch đầu dòng
            }
        };

        const response = await callGeminiWithRetry(payload, 0);

        // --- XỬ LÝ KẾT QUẢ ---
        let aiResponse = "";
        
        // Kiểm tra an toàn để không bao giờ crash
        if (!response.data || !response.data.candidates || response.data.candidates.length === 0) {
            aiResponse = "Không tìm thấy nội dung phù hợp hoặc Google chặn hiển thị.";
        } else {
            const candidate = response.data.candidates[0];
            const contentParts = candidate.content?.parts;

            // Ưu tiên lấy text
            if (contentParts && contentParts.length > 0 && contentParts[0].text) {
                aiResponse = contentParts[0].text;
            } else {
                // Xử lý các lý do chặn (Dù với gạch đầu dòng thì rất hiếm khi bị chặn Recitation nữa)
                const reason = candidate.finishReason;
                if (reason === "SAFETY") aiResponse = "Câu trả lời bị bộ lọc an toàn chặn.";
                else if (reason === "RECITATION") aiResponse = "Nội dung trích dẫn quá dài, Sư huynh vui lòng xem trực tiếp trong sách.";
                else aiResponse = "Không có phản hồi từ AI.";
            }
        }

        let finalAnswer = "";
        if (aiResponse.includes("mucluc.pmtl.site")) {
             finalAnswer = aiResponse;
        } else {
            // Thêm định dạng in đậm tiêu đề cho đẹp mắt
            finalAnswer = "**Phụng Sự Viên Ảo Trả Lời :**\n\n" + aiResponse + "\n\n_Nhắc nhở: Sư huynh kiểm tra lại tại: https://tkt.pmtl.site nhé 🙏_";
        }

        res.json({ answer: finalAnswer });

    } catch (error) {
        console.error('SERVER ERROR:', error.message);
        res.status(500).json({ answer: "Đệ đang gặp chút trục trặc. Sư huynh thử lại sau nhé." });
    }
});

app.listen(PORT, () => {
    console.log(`Server đang chạy tại http://localhost:${PORT}`);
});
