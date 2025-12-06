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
        const prompt = `Bạn là một công cụ trích xuất thông tin chính xác. Nhiệm vụ của bạn là tìm câu trả lời cho câu hỏi của người dùng CHỈ từ trong VĂN BẢN NGUỒN được cung cấp.

        **QUY TẮC BẮT BUỘC PHẢI TUÂN THEO TUYỆT ĐỐI:**
        1.  TUYỆT ĐỐI KHÔNG sử dụng kiến thức bên ngoài (out-of-context knowledge) dù bạn biết câu trả lời.
        2.  Nếu bạn đọc kỹ VĂN BẢN NGUỒN và không tìm thấy câu trả lời cho câu hỏi, BẮT BUỘC phải trả lời bằng một câu duy nhất, chính xác là: "Mời Sư huynh tra cứu thêm tại mục lục tổng quan : https://mucluc.pmtl.site ." Không giải thích, không xin lỗi, không thêm bất cứ điều gì khác.
        3.  trích dẫn câu trả lời chính xác văn bản gốc. TUYỆT ĐỐI KHÔNG bịa đặt thông tin không có trong văn bản.
        4.  **XỬ LÝ ĐƯỜNG DẪN (LINK):** Nếu câu trả lời có chứa một đường dẫn (URL), hãy đảm bảo bạn trả về đường dẫn đó dưới dạng văn bản thuần túy. TUYỆT ĐỐI KHÔNG bọc đường dẫn trong bất kỳ định dạng nào khác (ví dụ: không dùng Markdown như \`[text](link)\`).
        5.  Bạn (AI) tự xưng là: "đệ". Gọi người hỏi là: "Sư huynh". TUYỆT ĐỐI KHÔNG gọi người dùng là "đệ", "con", hay "bạn".
        6.  Nếu trong VĂN BẢN NGUỒN có các từ chỉ người nghe như "con", "các con", "trò", "đệ" (ví dụ: "Đệ phải sám hối...", "Con hãy niệm chú..."), bạn TUYỆT ĐỐI phải đổi các từ đó thành "Sư huynh". Ví dụ nguồn: "Đệ cần tịnh tâm" -> Câu trả lời của bạn: "Sư huynh cần tịnh tâm".
        
        --- VĂN BẢN NGUỒN ---
        ${context}
        --- KẾT THÚC VĂN BẢN NGUỒN ---
        
        Dựa vào các quy tắc và ví dụ trên, hãy trả lời câu hỏi sau:
        
        Câu hỏi của người dùng: ${question}
        
        Câu trả lời của bạn:`;

		// --- ĐOẠN MỚI ĐƯỢC THÊM VÀO ---
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
                topK: 0,
                topP: 0,
                maxOutputTokens: 2048,
            }
        };

        // Gửi yêu cầu đến Google Gemini API bằng axios
        const response = await axios.post(apiUrl, payload, {
            headers: { 'Content-Type': 'application/json' }
        });

		// --- ĐOẠN ĐÃ SỬA ---
		let aiResponse = "";
		
		// Kiểm tra xem có dữ liệu 'candidates' không trước khi gọi [0]
		if (response.data.candidates && response.data.candidates.length > 0) {
		    aiResponse = response.data.candidates[0].content?.parts[0]?.text || "";
		} else {
		    // Nếu không có, in lỗi ra console thay vì sập server
		    console.log("API Response không có candidates:", JSON.stringify(response.data));
		    aiResponse = "Hiện tại đệ chưa thể xử lý câu hỏi này do vấn đề kỹ thuật...";
		}

        const openFrame = "Đệ xin trả lời câu hỏi của Sư Huynh dựa trên nguồn dữ liệu hiện tại đệ có như sau ạ 🙏\n\n";
        const closeFrame = "\n\nTrên đây là toàn bộ nội dung đệ tìm được , rất mong những thông tin này hữu ích với Sư huynh , nếu cần trợ giúp gì thêm Sư huynh hãy đặt câu hỏi ! đệ xin dược tiếp tục hỗ trợ ạ 🙏";

        let finalAnswer = "";

        // Kiểm tra xem câu trả lời có chứa link mục lục (dấu hiệu không tìm thấy) hay không
        if (aiResponse.includes("mucluc.pmtl.site")) {
            // Nếu không tìm thấy -> Giữ nguyên câu trả lời ngắn gọn của AI
            finalAnswer = aiResponse;
        } else {
            // Nếu tìm thấy -> Đóng khung trang trọng
            finalAnswer = openFrame + aiResponse + closeFrame;
        }

        res.json({ answer: finalAnswer });

    } catch (error) {
        console.error('Lỗi khi gọi Google Gemini API:', error.response ? error.response.data : error.message);
        res.status(500).json({ 
            error: 'Sư huynh chờ đệ một xíu nhé ! đệ đang hơi quá tải ạ 🙏.' 
        });
    }
});

// --- 6. Khởi động máy chủ ---
app.listen(PORT, () => {
    console.log(`Server đang chạy tại http://localhost:${PORT}`);
});
