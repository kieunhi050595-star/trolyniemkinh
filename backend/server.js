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
app.use(express.json({ limit: '10mb' }));

// --- ROUTE CHO HEALTH CHECK ---
app.get('/api/health', (req, res) => {
    res.status(200).json({ status: "OK", message: "Server is up and running" });
});

// --- 4. Lấy danh sách API Key (NÂNG CẤP) ---
// Tách chuỗi key từ biến môi trường thành mảng.
// Ví dụ: "Key1,Key2,Key3" -> ["Key1", "Key2", "Key3"]
const apiKeys = process.env.GEMINI_API_KEYS ? process.env.GEMINI_API_KEYS.split(',') : [];

if (apiKeys.length === 0) {
    console.error("CẢNH BÁO: Chưa cấu hình biến GEMINI_API_KEYS (nhiều key) trong .env hoặc Render.");
}

// --- HÀM GỌI API THÔNG MINH (LOGIC XOAY VÒNG KEY) ---
// Hàm này sẽ đệ quy: Nếu key hiện tại lỗi 429 -> gọi lại chính nó với key tiếp theo
async function callGeminiWithRetry(payload, keyIndex = 0) {
    // Nếu đã thử hết sạch key trong danh sách
    if (keyIndex >= apiKeys.length) {
        throw new Error("ALL_KEYS_EXHAUSTED"); // Mã lỗi riêng để nhận biết
    }

    const currentKey = apiKeys[keyIndex];
    const model = "gemini-2.5-flash"; // Model Sư huynh đang dùng
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${currentKey}`;

    try {
        // console.log(`Đang thử dùng Key số ${keyIndex + 1}...`); // Bật dòng này nếu muốn xem log server
        const response = await axios.post(apiUrl, payload, {
            headers: { 'Content-Type': 'application/json' }
        });
        return response; // Thành công -> Trả về kết quả ngay

    } catch (error) {
        // Kiểm tra xem có phải lỗi 429 (Too Many Requests) không
        if (error.response && error.response.status === 429) {
            console.warn(`⚠️ Key số ${keyIndex + 1} bị quá tải (429). Đang đổi sang Key số ${keyIndex + 2}...`);
            // GỌI LẠI CHÍNH HÀM NÀY với index của key tiếp theo
            return callGeminiWithRetry(payload, keyIndex + 1);
        } else {
            // Nếu là lỗi khác (ví dụ: Sai cú pháp, nội dung cấm...) thì báo lỗi luôn, không thử lại.
            throw error;
        }
    }
}

// --- 5. Route API Chat ---
app.post('/api/chat', async (req, res) => {
    // Kiểm tra danh sách key
    if (apiKeys.length === 0) {
        return res.status(500).json({
            error: 'Server chưa cấu hình GEMINI_API_KEYS.'
        });
    }

    try {
        const { question, context } = req.body;

        if (!question || !context) {
            return res.status(400).json({
                error: 'Vui lòng cung cấp đủ "question" và "context".'
            });
        }

        // Tạo prompt (Giữ nguyên như cũ của Sư huynh)
        const prompt = `Bạn là một công cụ trích xuất thông tin chính xác tuyệt đối. Nhiệm vụ của bạn là trích xuất câu trả lời cho câu hỏi của người dùng CHỈ từ trong VĂN BẢN NGUỒN được cung cấp.

        **QUY TẮC BẮT BUỘC PHẢI TUÂN THEO TUYỆT ĐỐI (KHÔNG ĐƯỢC PHÉP SAI LỆCH):**
        1.  **NGUỒN DỮ LIỆU DUY NHẤT:** Chỉ được phép sử dụng thông tin có trong phần "VĂN BẢN NGUỒN". TUYỆT ĐỐI KHÔNG sử dụng kiến thức bên ngoài, không suy diễn, không thêm thắt thông tin.
        2.  **TRÍCH DẪN CHÍNH XÁC:** Câu trả lời phải bám sát câu chữ trong văn bản gốc. Không viết lại (paraphrase) nếu không cần thiết.
        3.  **XỬ LÝ KHI KHÔNG TÌM THẤY:** Nếu thông tin không có trong văn bản nguồn, BẮT BUỘC trả lời chính xác câu: "Mời Sư huynh tra cứu thêm tại mục lục tổng quan : https://mucluc.pmtl.site ." (Giữ nguyên dấu câu và khoảng trắng). Không giải thích thêm.
        4.  **XƯNG HÔ:** Bạn tự xưng là "đệ" và gọi người hỏi là "Sư huynh".
        5.  **CHUYỂN ĐỔI NGÔI KỂ:** Nếu văn bản gốc dùng các từ như "con", "các con", "trò", "đệ" để chỉ người nghe/người thực hiện, hãy chuyển đổi thành "Sư huynh" cho phù hợp ngữ cảnh đối thoại. Ví dụ: "Con hãy niệm..." -> "Sư huynh hãy niệm...".
        6.  **XỬ LÝ LINK:** Trả về URL dưới dạng văn bản thuần túy, KHÔNG dùng Markdown link (ví dụ: [tên](url)).

        --- VĂN BẢN NGUỒN BẮT ĐẦU ---
        ${context}
        --- VĂN BẢN NGUỒN KẾT THÚC ---
        
        Câu hỏi của người dùng: ${question}
        
        Câu trả lời của bạn (Chính xác và tuân thủ mọi quy tắc trên):`;

        // Cấu hình Safety
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
                temperature: 0,
                topK: 1,
                topP: 0,
                maxOutputTokens: 2048,
            }
        };

        // --- GỌI API VỚI CƠ CHẾ XOAY VÒNG KEY ---
        // Bắt đầu thử từ key đầu tiên (index 0)
        const response = await callGeminiWithRetry(payload, 0);

        // --- XỬ LÝ KẾT QUẢ TRẢ VỀ ---
        let aiResponse = "";
        if (response.data.candidates && response.data.candidates.length > 0) {
            aiResponse = response.data.candidates[0].content?.parts[0]?.text || "";
        } else {
            console.log("API Response rỗng:", JSON.stringify(response.data));
            aiResponse = "Hiện tại đệ chưa thể xử lý câu hỏi này do vấn đề kỹ thuật...";
        }

        // --- ĐỊNH DẠNG CÂU TRẢ LỜI ---
        const openFrame = "**Phụng Sự Viên Ảo Trả Lời :**\n\n";
        const closeFrame = "\n\n_Nhắc nhở: AI có thể mắc sai sót. Sư huynh nhớ kiểm tra lại tại: https://tkt.pmtl.site nhé 🙏_";
      
        let finalAnswer = "";

        if (aiResponse.includes("mucluc.pmtl.site") || aiResponse.trim() === "") {
             if (aiResponse.trim() === "") {
                 finalAnswer = "Mời Sư huynh tra cứu thêm tại mục lục tổng quan : https://mucluc.pmtl.site .";
             } else {
                 finalAnswer = aiResponse;
             }
        } else {
            finalAnswer = openFrame + aiResponse + closeFrame;
        }

        res.json({ answer: finalAnswer });

    } catch (error) {
        // Log lỗi chi tiết ra console server để debug
        console.error('Lỗi API:', error.message);

        // Phân loại lỗi để trả về frontend
        if (error.message === "ALL_KEYS_EXHAUSTED") {
            res.status(503).json({
                error: 'Đệ đang quá tải (Tất cả các kết nối đều bận). Sư huynh vui lòng thử lại sau 1 phút ạ 🙏.'
            });
        } else {
            res.status(500).json({
                error: 'Sư huynh chờ đệ một xíu nhé ! đệ đang gặp chút trục trặc kỹ thuật ạ 🙏.'
            });
        }
    }
});

// --- 6. Khởi động máy chủ ---
app.listen(PORT, () => {
    console.log(`Server đang chạy tại http://localhost:${PORT}`);
});
