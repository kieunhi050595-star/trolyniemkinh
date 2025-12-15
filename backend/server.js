// server.js - Phiên bản Chatbot Txt + Real-time Telegram Support

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const http = require('http'); // Thêm module http
const { Server } = require("socket.io"); // Thêm Socket.io
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// --- CẤU HÌNH SOCKET.IO ---
const server = http.createServer(app); // Bọc app trong server http
const io = new Server(server, {
    cors: { origin: "*" }
});

// Biến lưu trữ tạm: [ID Tin nhắn Telegram] -> [Socket ID người dùng]
const pendingRequests = new Map();
const socketToMsgId = new Map();

io.on('connection', (socket) => {
    console.log('👤 User Connected:', socket.id);

    socket.on('disconnect', () => {
        console.log('User Disconnected:', socket.id);
        
        // Dọn dẹp bộ nhớ khi user thoát (Chỉ chạy khi biến socketToMsgId đã được khai báo)
        if (socketToMsgId.has(socket.id)) {
            const msgIds = socketToMsgId.get(socket.id);
            // Xóa các request đang treo của user này
            msgIds.forEach(id => pendingRequests.delete(id));
            // Xóa user khỏi danh sách quản lý
            socketToMsgId.delete(socket.id);
        }
    });
});

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

// --- HÀM GỬI CẢNH BÁO TELEGRAM ---
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

// --- 2. HÀM GỌI API GEMINI ---
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
        // NHẬN THÊM socketId TỪ CLIENT
        const { question, context, socketId } = req.body;
        if (!question || !context) return res.status(400).json({ error: 'Thiếu dữ liệu.' });

        const safetySettings = [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        ];

        // --- BƯỚC 1: PROMPT GỐC ---
        const promptGoc = `Bạn là một công cụ trích xuất thông tin chính xác tuyệt đối. Nhiệm vụ của bạn là trích xuất câu trả lời cho câu hỏi của người dùng CHỈ từ trong VĂN BẢN NGUỒN được cung cấp.

        **QUY TẮC BẮT BUỘC PHẢI TUÂN THEO TUYỆT ĐỐI:**
        1.  **NGUỒN DỮ LIỆU DUY NHẤT:** Chỉ được phép sử dụng thông tin có trong phần "VĂN BẢN NGUỒN". TUYỆT ĐỐI KHÔNG sử dụng kiến thức bên ngoài.
        2.  **CHIA NHỎ:** Không viết thành đoạn văn. Hãy tách từng ý quan trọng thành các gạch đầu dòng riêng biệt.          
        3.  **Nếu không có thông tin, trả lời chính xác:** "NO_INFO_FOUND".
        4.  **XƯNG HÔ:** Bạn tự xưng là "đệ" và gọi người hỏi là "Sư huynh".
        5.  **CHUYỂN ĐỔI NGÔI KỂ:** Chuyển "con/trò" thành "Sư huynh".
        6.  **XỬ LÝ LINK:** Trả về URL thuần túy, KHÔNG dùng Markdown link.
        7.  **PHONG CÁCH:** Trả lời NGẮN GỌN, SÚC TÍCH, đi thẳng vào vấn đề chính.
        
        --- VĂN BẢN NGUỒN ---
        ${context}
        --- HẾT ---
        
        Câu hỏi: ${question}
        Câu trả lời:`;

        let response = await callGeminiWithRetry({
            contents: [{ parts: [{ text: promptGoc }] }],
            safetySettings: safetySettings,
            generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
        }, 0);

        let aiResponse = "";
        let finishReason = "";

        if (response.data?.candidates?.[0]) {
            finishReason = response.data.candidates[0].finishReason;
            if (response.data.candidates[0].content?.parts?.[0]?.text) {
                aiResponse = response.data.candidates[0].content.parts[0].text.trim();
            }
        }

        // --- BƯỚC 2: CỨU NGUY (RECITATION) ---
        if (finishReason === "RECITATION" || !aiResponse) {
            console.log("⚠️ Bị chặn bản quyền. Dùng Prompt diễn giải...");
            const promptDienGiai = `NV: Trả lời câu hỏi "${question}" dựa trên văn bản nguồn.
            Nếu KHÔNG CÓ thông tin, trả lời "NO_INFO_FOUND".
            Nếu CÓ, hãy diễn đạt lại ý chính (không trích nguyên văn).
            --- VĂN BẢN NGUỒN ---
            ${context}`;

            response = await callGeminiWithRetry({
                contents: [{ parts: [{ text: promptDienGiai }] }],
                safetySettings: safetySettings,
                generationConfig: { temperature: 0.3, maxOutputTokens: 4096 }
            }, 0);

            if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                aiResponse = response.data.candidates[0].content.parts[0].text.trim();
            } else {
                aiResponse = "NO_INFO_FOUND";
            }
        }

        // --- BƯỚC 3: XỬ LÝ KẾT QUẢ & GỬI TELEGRAM ---
        let finalAnswer = "";

        if (aiResponse.includes("NO_INFO_FOUND") || aiResponse.length < 5) {
            console.log("⚠️ Không tìm thấy -> Chuyển Telegram...");

            // 1. Gửi tin nhắn vào nhóm (Lưu lại msgId để chờ reply)
            const teleRes = await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                chat_id: TELEGRAM_CHAT_ID,
                text: `❓ <b>CÂU HỎI CẦN HỖ TRỢ</b>\n\n"${question}"\n\n👉 <i>Reply tin nhắn này để trả lời.</i>`,
                parse_mode: 'HTML'
            });

            // 2. Lưu Socket ID vào bộ nhớ tạm
            if (teleRes.data && teleRes.data.result && socketId) {
                const msgId = teleRes.data.result.message_id;
                pendingRequests.set(msgId, socketId);
                
                // --- THÊM ĐOẠN NÀY ĐỂ DỌN DẸP ---
                if (!socketToMsgId.has(socketId)) {
                    socketToMsgId.set(socketId, []);
                }
                socketToMsgId.get(socketId).push(msgId);
                // -------------------------------
            }

            finalAnswer = "Dạ, câu hỏi này hiện chưa có trong dữ liệu văn bản.\n\n" +
                          "🚀 **Đệ đã chuyển câu hỏi về nhóm hỗ trợ.**\n" +
                          "Sư huynh vui lòng giữ màn hình này, câu trả lời sẽ hiện ra ngay khi có phản hồi ạ! ⏳";

        } else {
            finalAnswer = "**Phụng Sự Viên Ảo Trả Lời :**\n\n" + aiResponse;
        }

        res.json({ answer: finalAnswer });

    } catch (error) {
        console.error("Lỗi:", error.message);
        await sendTelegramAlert(`❌ LỖI HỆ THỐNG:\n${error.message}`);
        res.status(503).json({ answer: "Hệ thống đang bận." });
    }
});

// --- API WEBHOOK: NHẬN TIN NHẮN TỪ TELEGRAM (QUAN TRỌNG) ---
app.post(`/api/telegram-webhook/${TELEGRAM_TOKEN}`, async (req, res) => {
    try {
        const { message } = req.body;
        
        // Kiểm tra xem có phải là Reply không
        if (message && message.reply_to_message) {
            const originalMsgId = message.reply_to_message.message_id; // ID câu hỏi gốc
            const adminReply = message.text; // Câu trả lời của bạn

            // Kiểm tra trong bộ nhớ tạm xem có ai đang chờ câu này không
            if (pendingRequests.has(originalMsgId)) {
                const userSocketId = pendingRequests.get(originalMsgId);
                
                // BẮN TIN NHẮN VỀ WEB QUA SOCKET
                io.to(userSocketId).emit('admin_reply', adminReply);
                
                // ⚠️ QUAN TRỌNG: KHÔNG XÓA DÒNG NÀY NỮA
                // pendingRequests.delete(originalMsgId); // <--- Đã comment lại để chat được nhiều câu
                
                console.log(`✅ Đã chuyển câu trả lời (tiếp theo) tới Socket: ${userSocketId}`);
            }
        }
        res.sendStatus(200);
    } catch (e) {
        console.error("Lỗi Webhook:", e);
        res.sendStatus(500);
    }
});

// --- Test Telegram ---
app.get('/api/test-telegram', async (req, res) => {
    try {
        await sendTelegramAlert("🚀 <b>Test kết nối thành công!</b>");
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// Thay app.listen thành server.listen để chạy Socket.io
server.listen(PORT, () => {
    console.log(`Server Socket.io đang chạy tại http://localhost:${PORT}`);
});
