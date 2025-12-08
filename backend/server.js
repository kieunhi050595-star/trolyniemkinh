// server.js - Phiên bản "Bất Tử" (Hỗ trợ đa Key & Tự sửa lỗi nhập liệu)

const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// --- 1. XỬ LÝ DANH SÁCH KEY THÔNG MINH ---
// Tự động xóa khoảng trắng thừa, loại bỏ key rỗng
const rawKeys = process.env.GEMINI_API_KEYS || "";
const apiKeys = rawKeys.split(',').map(key => key.trim()).filter(key => key.length > 0);

// Log ra màn hình để kiểm tra (Chỉ hiện 4 ký tự cuối để bảo mật)
if (apiKeys.length > 0) {
    console.log(`✅ Đã tìm thấy [${apiKeys.length}] API Keys sẵn sàng hoạt động.`);
    apiKeys.forEach((k, i) => console.log(`   - Key ${i}: ...${k.slice(-4)}`));
} else {
    console.error("❌ CẢNH BÁO: Không tìm thấy API Key nào! Vui lòng kiểm tra biến GEMINI_API_KEYS.");
}

app.get('/api/health', (req, res) => {
    res.status(200).json({ status: "OK", server: "Ready" });
});

// Hàm tạo độ trễ
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- 2. HÀM GỌI API (CƠ CHẾ XOAY VÒNG MẠNH MẼ) ---
async function callGeminiWithRetry(payload, keyIndex = 0, retryCount = 0) {
    // Nếu đã thử hết sạch Key
    if (keyIndex >= apiKeys.length) {
        // Nếu đây là lần thử đầu tiên của vòng, nghỉ 2s rồi thử lại từ Key 0 một lần nữa
        if (retryCount < 1) {
            console.log("🔁 Đã thử hết vòng Key, đang chờ hồi phục...");
            await sleep(2000);
            return callGeminiWithRetry(payload, 0, retryCount + 1);
        }
        throw new Error("ALL_KEYS_EXHAUSTED");
    }

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
        const status = error.response ? error.response.status : 0;
        
        // --- LOGIC QUAN TRỌNG: CHUYỂN KEY KHI GẶP LỖI ---
        // 429: Quá tải
        // 400: Key sai định dạng (do dấu cách, ký tự lạ...)
        // 403: Key không có quyền (hết hạn, sai project)
        // 503: Server Google bận
        if (status === 429 || status === 400 || status === 403 || status >= 500) {
            console.warn(`⚠️ Key ${keyIndex} lỗi (Mã: ${status}). Đang chuyển sang Key ${keyIndex + 1}...`);
            
            // Nếu là lỗi quá tải (429), nghỉ 1 xíu để tránh spam
            if (status === 429) await sleep(1000); 
            
            // Gọi đệ quy key tiếp theo
            return callGeminiWithRetry(payload, keyIndex + 1, retryCount);
        }
        
        // Các lỗi khác (ví dụ sai cú pháp JSON) thì throw luôn
        console.error(`Lỗi không thể cứu vãn (Key ${keyIndex}):`, error.message);
        throw error;
    }
}

app.post('/api/chat', async (req, res) => {
    if (apiKeys.length === 0) return res.status(500).json({ error: 'Server chưa cấu hình API Key.' });

    try {
        const { question, context } = req.body;
        if (!question || !context) return res.status(400).json({ error: 'Thiếu dữ liệu.' });

        // Prompt gạch đầu dòng (Smart Extraction)
        const prompt = `Bạn là một công cụ trích xuất thông tin chính xác tuyệt đối. Nhiệm vụ của bạn là trích xuất câu trả lời cho câu hỏi của người dùng CHỈ từ trong VĂN BẢN NGUỒN được cung cấp.

        **QUY TẮC BẮT BUỘC PHẢI TUÂN THEO TUYỆT ĐỐI (KHÔNG ĐƯỢC PHÉP SAI LỆCH):**
        1.  **NGUỒN DỮ LIỆU DUY NHẤT:** Chỉ được phép sử dụng thông tin có trong phần "VĂN BẢN NGUỒN". TUYỆT ĐỐI KHÔNG sử dụng kiến thức bên ngoài, không suy diễn, không thêm thắt thông tin.
        2.  **CHIA NHỎ:** Không viết thành đoạn văn. Hãy tách từng ý quan trọng thành các gạch đầu dòng riêng biệt.        
        3.  **XỬ LÝ KHI KHÔNG TÌM THẤY:** Nếu thông tin không có trong văn bản nguồn, BẮT BUỘC trả lời chính xác câu: "Mời Sư huynh tra cứu thêm tại mục lục tổng quan : https://mucluc.pmtl.site ." (Giữ nguyên dấu câu và khoảng trắng). Không giải thích thêm.
        4.  **XƯNG HÔ:** Bạn tự xưng là "đệ" và gọi người hỏi là "Sư huynh".
        5.  **CHUYỂN ĐỔI NGÔI KỂ:** Nếu văn bản gốc dùng các từ như "con", "các con", "trò", "đệ" để chỉ người nghe/người thực hiện, hãy chuyển đổi thành "Sư huynh" cho phù hợp ngữ cảnh đối thoại. Ví dụ: "Con hãy niệm..." -> "Sư huynh hãy niệm...".
        6.  **XỬ LÝ LINK:** Trả về URL dưới dạng văn bản thuần túy, KHÔNG dùng Markdown link (ví dụ: [tên](url)).
        7. **PHONG CÁCH TRẢ LỜI:** Trả lời NGẮN GỌN, SÚC TÍCH, đi thẳng vào vấn đề chính. Không trích dẫn dài dòng nếu không cần thiết.
        
        --- VĂN BẢN NGUỒN BẮT ĐẦU ---
        ${context}
        --- VĂN BẢN NGUỒN KẾT THÚC ---
        
        Câu hỏi của người dùng: ${question}
        
        Câu trả lời của bạn (Chính xác và tuân thủ mọi quy tắc trên):`;

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
                temperature: 0.1,
                maxOutputTokens: 4096, 
            }
        };

        const response = await callGeminiWithRetry(payload, 0);

        let aiResponse = "";
        if (!response.data || !response.data.candidates || response.data.candidates.length === 0) {
            aiResponse = "Không có dữ liệu trả về từ Google.";
        } else {
            const candidate = response.data.candidates[0];
            const contentParts = candidate.content?.parts;
            if (contentParts && contentParts.length > 0 && contentParts[0].text) {
                aiResponse = contentParts[0].text;
            } else {
                const reason = candidate.finishReason;
                aiResponse = (reason === "SAFETY") ? "Bị chặn bởi bộ lọc an toàn." : "Nội dung bị ẩn (Recitation).";
            }
        }

        let finalAnswer = "";
        if (aiResponse.includes("mucluc.pmtl.site")) {
             finalAnswer = aiResponse;
        } else {
            finalAnswer = "**Phụng Sự Viên Ảo Trả Lời :**\n\n" + aiResponse + "\n\n_Nhắc nhở: Sư huynh kiểm tra lại tại: https://tkt.pmtl.site nhé 🙏_";
        }

        res.json({ answer: finalAnswer });

    } catch (error) {
        let msg = "Lỗi hệ thống.";
        if (error.message === "ALL_KEYS_EXHAUSTED") {
            msg = "Hệ thống đang quá tải, tất cả các Key đều đang bận. Vui lòng thử lại sau 1-2 phút.";
        }
        console.error("Final Error Handler:", error.message);
        res.status(503).json({ answer: msg });
    }
});

app.listen(PORT, () => {
    console.log(`Server đang chạy tại http://localhost:${PORT}`);
});
