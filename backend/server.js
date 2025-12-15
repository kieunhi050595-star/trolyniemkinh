// server.js - Phiên bản: Tự động chuyển câu hỏi khó về Telegram

const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// --- 1. XỬ LÝ DANH SÁCH KEY ---
const rawKeys = process.env.GEMINI_API_KEYS || "";
const apiKeys = rawKeys.split(',').map(key => key.trim()).filter(key => key.length > 0);

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || ""; 
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

if (apiKeys.length > 0) {
    console.log(`✅ Đã tìm thấy [${apiKeys.length}] API Keys.`);
} else {
    console.error("❌ CẢNH BÁO: Chưa cấu hình API Key!");
}

app.get('/api/health', (req, res) => {
    res.status(200).json({ status: "OK", server: "Ready" });
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- HÀM GỬI CẢNH BÁO TELEGRAM (Dùng chung) ---
async function sendTelegramAlert(message) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return; 
    
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: `🤖 <b>PSV ẢO - VÔ ÚY</b> 🚨\n\n${message}`,
            parse_mode: 'HTML'
        });
    } catch (error) {
        console.error("Lỗi gửi Telegram:", error.message);
    }
}

// --- 2. HÀM GỌI API GEMINI (Có báo lỗi Telegram) ---
async function callGeminiWithRetry(payload, keyIndex = 0, retryCount = 0) {
    if (keyIndex >= apiKeys.length) {
        if (retryCount < 1) {
            console.log("🔁 Hết vòng Key, chờ 2s thử lại...");
            await sleep(2000);
            return callGeminiWithRetry(payload, 0, retryCount + 1);
        }
        const msg = "🆘 HẾT SẠCH API KEY! Hệ thống không thể phản hồi.";
        console.error(msg);
        await sendTelegramAlert(msg);
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
        if (status === 429 || status === 400 || status === 403 || status >= 500) {
            console.warn(`⚠️ Key ${keyIndex} lỗi (Mã: ${status}). Đổi Key...`);
            if (status === 429) await sleep(1000); 
            return callGeminiWithRetry(payload, keyIndex + 1, retryCount);
        }
        throw error;
    }
}

// --- API CHAT CHÍNH ---
app.post('/api/chat', async (req, res) => {
    if (apiKeys.length === 0) return res.status(500).json({ error: 'Chưa cấu hình API Key.' });

    try {
        const { question, context } = req.body;
        if (!question || !context) return res.status(400).json({ error: 'Thiếu dữ liệu.' });

        const safetySettings = [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        ];

        // =================================================================================
        // BƯỚC 1: PROMPT GỐC (ĐÃ SỬA LOGIC "NO_INFO_FOUND")
        // =================================================================================
        const promptGoc = `Bạn là một công cụ trích xuất thông tin chính xác tuyệt đối. Nhiệm vụ của bạn là trích xuất câu trả lời cho câu hỏi của người dùng CHỈ từ trong VĂN BẢN NGUỒN được cung cấp.

        **QUY TẮC BẮT BUỘC PHẢI TUÂN THEO TUYỆT ĐỐI:**
        1.  **NGUỒN DỮ LIỆU DUY NHẤT:** Chỉ được phép sử dụng thông tin có trong phần "VĂN BẢN NGUỒN". TUYỆT ĐỐI KHÔNG sử dụng kiến thức bên ngoài.
        2.  **CHIA NHỎ:** Không viết thành đoạn văn. Hãy tách từng ý quan trọng thành các gạch đầu dòng riêng biệt.          
        3.  **XỬ LÝ KHI KHÔNG TÌM THẤY (QUAN TRỌNG):** Nếu thông tin không có trong văn bản nguồn, BẮT BUỘC trả lời chính xác cụm từ: "NO_INFO_FOUND" (Không thêm bớt).
        4.  **XƯNG HÔ:** Bạn tự xưng là "đệ" và gọi người hỏi là "Sư huynh".
        5.  **CHUYỂN ĐỔI NGÔI KỂ:** Chuyển "con/trò" thành "Sư huynh".
        6.  **XỬ LÝ LINK:** Trả về URL thuần túy, KHÔNG dùng Markdown link.
        7.  **PHONG CÁCH:** Trả lời NGẮN GỌN, SÚC TÍCH, đi thẳng vào vấn đề chính.
        
        --- VĂN BẢN NGUỒN BẮT ĐẦU ---
        ${context}
        --- VĂN BẢN NGUỒN KẾT THÚC ---
        
        Câu hỏi: ${question}
        Câu trả lời:`;

        console.log("--> Đang thử Prompt Gốc...");
        let response = await callGeminiWithRetry({
            contents: [{ parts: [{ text: promptGoc }] }],
            safetySettings: safetySettings,
            generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
        }, 0);

        let aiResponse = "";
        let finishReason = "";

        if (response.data && response.data.candidates && response.data.candidates.length > 0) {
            const candidate = response.data.candidates[0];
            finishReason = candidate.finishReason;
            if (candidate.content?.parts?.[0]?.text) {
                aiResponse = candidate.content.parts[0].text.trim();
            }
        }

        // =================================================================================
        // BƯỚC 2: CHIẾN THUẬT CỨU NGUY (Nếu bị chặn bản quyền)
        // =================================================================================
        if (finishReason === "RECITATION" || !aiResponse) {
            console.log("⚠️ Prompt Gốc bị chặn. Kích hoạt Chiến thuật Diễn Giải...");

            const promptDienGiai = `Bạn là trợ lý hỗ trợ tu tập.
            NV: Trả lời câu hỏi: "${question}" dựa trên VĂN BẢN NGUỒN.
            
            VẤN ĐỀ: Việc trích dẫn nguyên văn đang bị lỗi hệ thống.
            
            GIẢI PHÁP:
            1. Tìm ý chính trong văn bản.
            2. Nếu KHÔNG CÓ thông tin, trả lời: "NO_INFO_FOUND".
            3. Nếu CÓ, hãy diễn đạt lại ý đó, bắt đầu bằng: "Do hạn chế về bản quyền trích dẫn, đệ xin tóm lược các ý chính như sau:".

            --- VĂN BẢN NGUỒN ---
            ${context}
            --- HẾT ---`;

            response = await callGeminiWithRetry({
                contents: [{ parts: [{ text: promptDienGiai }] }],
                safetySettings: safetySettings,
                generationConfig: { temperature: 0.3, maxOutputTokens: 4096 }
            }, 0);

            if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                aiResponse = response.data.candidates[0].content.parts[0].text.trim();
            } else {
                aiResponse = "NO_INFO_FOUND"; // Coi như không tìm thấy nếu lỗi hẳn
            }
        }

        // =================================================================================
        // BƯỚC 3: XỬ LÝ KẾT QUẢ CUỐI CÙNG & GỬI TELEGRAM
        // =================================================================================
        
        let finalAnswer = "";

        // Kiểm tra xem AI có tìm được thông tin không
        // Nếu AI trả về "NO_INFO_FOUND" hoặc câu báo lỗi cũ
        if (aiResponse.includes("NO_INFO_FOUND") || aiResponse.includes("mucluc.pmtl.site") || aiResponse.length < 5) {
            
            console.log("⚠️ Không tìm thấy câu trả lời -> Đang chuyển về Telegram...");

            // 1. Gửi tin nhắn báo động về nhóm Telegram
            await sendTelegramAlert(
                `❓ <b>CÂU HỎI CẦN HỖ TRỢ (Từ Chatbot Txt)</b>\n\n` +
                `User hỏi: "${question}"\n\n` +
                `👉 <i>Admin vui lòng kiểm tra và hỗ trợ Sư huynh này nhé!</i>`
            );

            // 2. Trả lời cho người dùng trên Web
            finalAnswer = "Dạ, câu hỏi này hiện chưa có trong dữ liệu văn bản mà đệ đang nắm giữ.\n\n" +
                          "🚀 **Đệ đã chuyển câu hỏi của Sư huynh về nhóm hỗ trợ trên Telegram.**\n" +
                          "Các Phụng Sự Viên sẽ xem và cập nhật dữ liệu sớm nhất có thể. Sư huynh hoan hỷ chờ trong giây lát hoặc đặt câu hỏi khác nhé! 🙏";

        } else {
            // Trường hợp CÓ câu trả lời
            finalAnswer = "**Phụng Sự Viên Ảo Trả Lời :**\n\n" + aiResponse + "\n\n_Nhắc nhở: Sư huynh kiểm tra lại tại: https://tkt.pmtl.site nhé 🙏_";
        }

        res.json({ answer: finalAnswer });

    } catch (error) {
        let msg = "Lỗi hệ thống.";
        if (error.message === "ALL_KEYS_EXHAUSTED") {
            msg = "Hệ thống đang quá tải. Vui lòng thử lại sau 1-2 phút.";
        }
        console.error("Final Error Handler:", error.message);
        await sendTelegramAlert(`❌ LỖI HỆ THỐNG:\n${error.message}`);
        res.status(503).json({ answer: msg });
    }
});

// --- API TEST TELEGRAM ---
app.get('/api/test-telegram', async (req, res) => {
    try {
        await sendTelegramAlert("🚀 <b>Test kết nối thành công!</b>\nChatbot Txt đã sẵn sàng.");
        res.json({ success: true, message: "Đã gửi tin nhắn test." });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server đang chạy tại http://localhost:${PORT}`);
});
