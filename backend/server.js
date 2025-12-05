// server.js

// --- 1. Import các thư viện cần thiết ---
const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config(); // Tải các biến môi trường từ file .env

// --- 2. Khởi tạo ứng dụng Express ---
const app = express();
const PORT = process.env.PORT || 3001; // Sử dụng cổng do Render cung cấp hoặc 3001 khi chạy local

// --- 3. Cấu hình Middleware ---
// Kích hoạt CORS để cho phép frontend gọi tới
// Trong môi trường production, bạn nên chỉ định rõ domain của frontend
app.use(cors()); 
// Cho phép server đọc dữ liệu JSON từ request body
app.use(express.json({ limit: '10mb' }));

// --- ROUTE CHO HEALTH CHECK ---
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: "OK", message: "Server is up and running" });
});

// --- 4. Lấy API Key từ biến môi trường ---
// Đây là cách an toàn để quản lý API Key.
// Chúng ta sẽ thiết lập biến này trên Render sau.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// --- 5. Định nghĩa một Route (API Endpoint) ---
// Frontend sẽ gửi yêu cầu POST đến '/api/chat'
app.post('/api/chat', async (req, res) => {
    // Kiểm tra xem API key đã được cấu hình trên server chưa
    if (!GEMINI_API_KEY) {
        return res.status(500).json({ 
            error: 'GEMINI_API_KEY chưa được cấu hình trên server.' 
        });
    }

    try {
        // Lấy câu hỏi và context từ body của request mà frontend gửi lên
        const { question, context } = req.body;

        if (!question || !context) {
            return res.status(400).json({ 
                error: 'Vui lòng cung cấp đủ "question" và "context".' 
            });
        }

        const model = "gemini-2.5-flash-lite";
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

        // Tạo prompt giống hệt như trong file HTML của bạn
        const prompt = `Bạn là một "Phụng Sự Viên Ảo" của Pháp Môn Tâm Linh, một người trợ lý tận tâm, nhẹ nhàng, khiêm cung và đầy lòng trắc ẩn.. Nhiệm vụ của bạn là tìm câu trả lời cho câu hỏi của người dùng CHỈ từ trong VĂN BẢN NGUỒN được cung cấp.

        **QUY TẮC BẮT BUỘC PHẢI TUÂN THEO:**
        
        1.  **PHẠM VI TRẢ LỜI:** Chỉ được phép sử dụng thông tin có trong VĂN BẢN NGUỒN. TUYỆT ĐỐI KHÔNG được dùng kiến thức của riêng bạn hoặc thông tin từ bên ngoài.
        2.  **TRƯỜNG HỢP KHÔNG TÌM THẤY:** Nếu bạn đọc kỹ VĂN BẢN NGUỒN và không tìm thấy câu trả lời cho câu hỏi, bạn BẮT BUỘC phải trả lời bằng một câu duy nhất, chính xác là: "Mời Sư huynh tra cứu thêm tại mục lục tổng quan : https://mucluc.pmtl.site ." Không giải thích, không xin lỗi, không thêm bất cứ điều gì khác.
        3.  **TRÍCH DẪN TRỰC TIẾP:** Cố gắng trích dẫn câu trả lời càng gần với nguyên văn trong tài liệu càng tốt. Không suy diễn, không tóm tắt nếu không cần thiết.
        4.  **XỬ LÝ ĐƯỜNG DẪN (LINK):** Nếu câu trả lời có chứa một đường dẫn (URL), hãy đảm bảo bạn trả về đường dẫn đó dưới dạng văn bản thuần túy. TUYỆT ĐỐI KHÔNG bọc đường dẫn trong bất kỳ định dạng nào khác (ví dụ: không dùng Markdown như \`[text](link)\`).
        5.  **Phong cách:** Hãy trả lời một cách tự nhiên, mạch lạc, có chủ ngữ vị ngữ, giọng điệu ấm áp và tôn trọng (xưng "Đệ", gọi người dùng là "Sư huynh").
        
        --- VĂN BẢN NGUỒN ---
        ${context}
        --- KẾT THÚC VĂN BẢN NGUỒN ---
        
        Dựa vào các quy tắc và ví dụ trên, hãy trả lời câu hỏi sau:
        
        Câu hỏi của người dùng: ${question}
        
        Câu trả lời của bạn:`;

        const payload = {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.1,
                topK: 20,
                topP: 0.95,
                maxOutputTokens: 2048,
            }
        };

        // Gửi yêu cầu đến Google Gemini API bằng axios
        const response = await axios.post(apiUrl, payload, {
            headers: { 'Content-Type': 'application/json' }
        });

        // Trích xuất câu trả lời từ phản hồi của Google
        const answer = response.data.candidates[0]?.content?.parts[0]?.text || "Không nhận được câu trả lời hợp lệ từ AI.";
        
        // Gửi câu trả lời về lại cho frontend
        res.json({ answer });

    } catch (error) {
        console.error('Lỗi khi gọi Google Gemini API:', error.response ? error.response.data : error.message);
        res.status(500).json({ 
            error: 'Sư huynh chờ đệ một xíu nhé ! đệ đang hơi quá tải ạ 🙏' 
        });
    }
});

// --- 6. Khởi động máy chủ ---
app.listen(PORT, () => {
    console.log(`Server đang chạy tại http://localhost:${PORT}`);
});
