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

const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || "";
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN || "";

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

// --- HÀM TẢI KIẾN THỨC CHO FACEBOOK MESSENGER ---
const DEFAULT_DOCUMENT_URL = "https://gist.githubusercontent.com/kieunhi050595-star/ddecde18f83b77d06a117a9fcf349188/raw/dulieu.txt";

async function fetchDocumentContext() {
    try {
        const timeStamp = new Date().getTime();
        const response = await axios.get(`${DEFAULT_DOCUMENT_URL}?v=${timeStamp}`);
        return response.data;
    } catch (error) {
        console.error("Lỗi tải file dữ liệu .txt:", error.message);
        return ""; // Trả về chuỗi rỗng nếu lỗi
    }
}

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
            text: `🤖 <b>PSV Ảo "Vô Úy"</b> 🚨\n\n${message}`,
            parse_mode: 'HTML'
        });
    } catch (error) {
        console.error("Lỗi gửi Telegram:", error.message);
    }
}

// --- HÀM GỬI TIN NHẮN TRẢ LỜI CHO FACEBOOK MESSENGER ---
async function sendFacebookMessage(senderPsid, text) {
    if (!FB_PAGE_ACCESS_TOKEN) return;
    try {
        const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${FB_PAGE_ACCESS_TOKEN}`;
        await axios.post(url, {
            recipient: { id: senderPsid },
            message: { text: text }
        });
    } catch (error) {
        console.error("Lỗi gửi tin nhắn FB:", error.response ? error.response.data : error.message);
    }
}

// --- HÀM KHẮC PHỤC LỖI ESCAPEHTML ---
function escapeHtml(text) {
    if (!text) return "";
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
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

        // --- TÍNH NĂNG MỚI: NHẮN TIN TRỰC TIẾP (@psv : nội dung) ---
        if (question.trim().toLowerCase().startsWith("@psv")) {
            // 1. Tách nội dung sau dấu hai chấm
            const parts = question.split(':');
            // Nếu không có nội dung (ví dụ chỉ gõ "@psv")
            if (parts.length < 2) {
                return res.json({ answer: "Sư huynh vui lòng nhập nội dung sau dấu hai chấm.\nVí dụ: @psv : Cho mình hỏi việc riêng này với ạ" });
            }
            
            // Lấy phần nội dung và xóa khoảng trắng thừa
            const msgContent = parts.slice(1).join(':').trim();
            
            if (!msgContent) {
                return res.json({ answer: "Sư huynh chưa nhập nội dung tin nhắn ạ!" });
            }

            // 2. Gửi ngay lập tức về Telegram
            try {
                const safeMsg = escapeHtml(msgContent); // Xử lý ký tự đặc biệt tránh lỗi 400
                
                const teleRes = await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
                    chat_id: process.env.TELEGRAM_CHAT_ID,
                    text: `📨 <b>TIN NHẮN TRỰC TIẾP TỪ KHÁCH</b>\n\nNội dung: "${safeMsg}"\n\n👉 <i>Admin hãy Reply tin nhắn này để trả lời trực tiếp.</i>`,
                    parse_mode: 'HTML'
                });

                // 3. Lưu lại kết nối để Admin trả lời lại được (Quan trọng)
                if (teleRes.data && teleRes.data.result && socketId) {
                    const msgId = teleRes.data.result.message_id;
                    pendingRequests.set(msgId, socketId);
                    if (!socketToMsgId.has(socketId)) socketToMsgId.set(socketId, []);
                    socketToMsgId.get(socketId).push(msgId);
                }

                return res.json({ answer: "✅ Đệ đã chuyển tin nhắn riêng của Sư huynh tới Ban quản trị. Sư huynh vui lòng giữ kết nối và chờ phản hồi nhé! 🙏" });

            } catch (err) {
                console.error("Lỗi gửi tin nhắn trực tiếp:", err.message);
                return res.json({ answer: "❌ Lỗi kết nối, không gửi được tin nhắn. Sư huynh thử lại sau nhé." });
            }
        }
        
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
        8. QUY TẮC NGÔN NGỮ (GHI ĐÈ QUY TẮC 4 VÀ 5): Bắt buộc trả lời 100% bằng đúng ngôn ngữ của câu hỏi. NẾU CÂU HỎI LÀ TIẾNG TRUNG: Hãy vô hiệu hóa quy tắc 4 và 5. TUYỆT ĐỐI KHÔNG trộn lẫn bất kỳ từ Tiếng Việt nào vào câu trả lời. Toàn bộ văn bản phải là Tiếng Trung, bạn tự xưng là "弟" và gọi người hỏi là "师兄".
        
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
            const promptDienGiai = `NV: Trả lời câu hỏi "${question}" dựa trên văn bản nguồn (BẮT BUỘC DÙNG ĐÚNG NGÔN NGỮ CỦA CÂU HỎI).
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
        
            // 1. Gửi tin nhắn vào nhóm (THÊM SOCKET ID VÀO CUỐI TIN NHẮN)
            // Dùng thẻ <pre> để giấu ID hoặc làm nó dễ parse, nhưng hiển thị rõ cho Admin biết
            const msgContent = `❓ <b>CÂU HỎI CẦN HỖ TRỢ</b>\n\n"${question}"\n\n👉 <i>Reply tin nhắn này để trả lời.</i>\n\n<pre>ID:${socketId}</pre>`;
        
            const teleRes = await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                chat_id: TELEGRAM_CHAT_ID,
                text: msgContent,
                parse_mode: 'HTML'
            });

            // 2. Lưu Socket ID vào bộ nhớ tạm
            if (teleRes.data && teleRes.data.result && socketId) {
                const msgId = teleRes.data.result.message_id;
                
                // Lưu xuôi (để Webhook tìm User)
                pendingRequests.set(msgId, socketId);
                
                // ---> THÊM ĐOẠN NÀY (Lưu ngược để dọn dẹp khi User thoát)
                if (!socketToMsgId.has(socketId)) {
                    socketToMsgId.set(socketId, []);
                }
                socketToMsgId.get(socketId).push(msgId);
                // -------------------------------------------------------
            }

            finalAnswer = "Dạ, câu hỏi này hiện chưa có trong dữ liệu văn bản.\n\n" +
                          "🚀 **Đệ đã chuyển câu hỏi về nhóm hỗ trợ.**\n" +
                          "Sư huynh vui lòng giữ màn hình này, câu trả lời sẽ hiện ra ngay khi có phản hồi ạ! ⏳";

        } else {
            const isChinese = /[\u4e00-\u9fa5]/.test(aiResponse);

            if (isChinese) {
                finalAnswer = "**来自虚拟志愿者的回答：**\n\n" + aiResponse;
            } else {
                finalAnswer = "**Phụng Sự Viên Ảo Trả Lời :**\n\n" + aiResponse;
            }
        }

        res.json({ answer: finalAnswer });

    } catch (error) {
        console.error("Lỗi:", error.message);
        await sendTelegramAlert(`❌ LỖI HỆ THỐNG:\n${error.message}`);
        res.status(503).json({ answer: "Hệ thống đang bận." });
    }
});

app.post('/api/telegram-webhook', async (req, res) => {
    try {
        const { message } = req.body;
        console.log("📩 Webhook received update:", message ? message.message_id : "No message");

        // Chỉ xử lý nếu là tin nhắn Reply
        if (message && message.reply_to_message) {
            const replyMsg = message.reply_to_message;
            const originalMsgId = replyMsg.message_id; 
            
            // --- LOGIC MỚI: TÌM SOCKET ID ---
            let userSocketId = null;

            // Cách 1: Tìm trong RAM (Ưu tiên nếu server chưa restart)
            if (pendingRequests.has(originalMsgId)) {
                userSocketId = pendingRequests.get(originalMsgId);
                console.log(`✅ Found User in RAM: ${userSocketId}`);
            } 
            // Cách 2: Tìm trong nội dung tin nhắn gốc (Dự phòng khi mất RAM)
            else if (replyMsg.text || replyMsg.caption) {
                const originalText = replyMsg.text || replyMsg.caption || "";
                // Tìm chuỗi "ID:..." mà ta đã nhét vào ở Bước 1
                const match = originalText.match(/ID:([a-zA-Z0-9_-]+)/);
                if (match && match[1]) {
                    userSocketId = match[1];
                    console.log(`✅ Found User in Message Text: ${userSocketId}`);
                }
            }

            // Nếu tìm thấy User thì gửi tin
            if (userSocketId) {
                // ... (Code gửi admin_reply/admin_reply_image GIỮ NGUYÊN như cũ)
                // Copy đoạn if (message.photo) ... else if (message.text) ... vào đây
                if (message.photo) {
                    // ... xử lý ảnh ...
                     try {
                        const fileId = message.photo[message.photo.length - 1].file_id;
                        const getFileUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`;
                        const fileInfoRes = await axios.get(getFileUrl);
                        const filePath = fileInfoRes.data.result.file_path;
                        const downloadUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
                        
                        const imageRes = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
                        const base64Image = Buffer.from(imageRes.data, 'binary').toString('base64');
                        const imgSrc = `data:image/jpeg;base64,${base64Image}`;

                        io.to(userSocketId).emit('admin_reply_image', imgSrc);
                        if (message.caption) {
                            io.to(userSocketId).emit('admin_reply', message.caption);
                        }
                    } catch (imgError) {
                        console.error("❌ Lỗi xử lý ảnh:", imgError.message);
                    }
                } else if (message.text) {
                    io.to(userSocketId).emit('admin_reply', message.text);
                }
            } else {
                console.log("⚠️ Không tìm thấy User (RAM trống và không có ID trong tin nhắn).");
            }
        }
        res.sendStatus(200);
    } catch (e) {
        console.error("❌ Lỗi Webhook:", e);
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

// --- API GET: FACEBOOK XÁC MINH WEBHOOK ---
app.get('/api/facebook-webhook', (req, res) => {
    let mode = req.query['hub.mode'];
    let token = req.query['hub.verify_token'];
    let challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === FB_VERIFY_TOKEN) {
            console.log('✅ WEBHOOK FACEBOOK VERIFIED');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

// --- API POST: NHẬN TIN NHẮN TỪ FACEBOOK ---
app.post('/api/facebook-webhook', async (req, res) => {
    let body = req.body;

    // Facebook yêu cầu phải trả về 200 OK ngay lập tức để không bị timeout
    res.status(200).send('EVENT_RECEIVED');

    if (body.object === 'page') {
        for (const entry of body.entry) {
            let webhook_event = entry.messaging[0];
            let sender_psid = webhook_event.sender.id;

            if (webhook_event.message && webhook_event.message.text) {
                let userQuestion = webhook_event.message.text;
                console.log(`💬 FB User ${sender_psid} hỏi: ${userQuestion}`);

                // 1. Tải dữ liệu kiến thức (Context)
                const context = await fetchDocumentContext();

                // 2. Chuẩn bị cấu hình an toàn
                const safetySettings = [
                    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
                ];

                // 3. Chuẩn bị Prompt
                const promptGoc = `Bạn là một công cụ trích xuất thông tin chính xác tuyệt đối. Nhiệm vụ của bạn là trích xuất câu trả lời cho câu hỏi của người dùng CHỈ từ trong VĂN BẢN NGUỒN được cung cấp.

                **QUY TẮC BẮT BUỘC PHẢI TUÂN THEO TUYỆT ĐỐI:**
                1.  **NGUỒN DỮ LIỆU DUY NHẤT:** Chỉ được phép sử dụng thông tin có trong phần "VĂN BẢN NGUỒN". TUYỆT ĐỐI KHÔNG sử dụng kiến thức bên ngoài.
                2.  **CHIA NHỎ:** Không viết thành đoạn văn. Hãy tách từng ý quan trọng thành các gạch đầu dòng riêng biệt.          
                3.  **Nếu không có thông tin, trả lời chính xác:** "NO_INFO_FOUND".
                4.  **XƯNG HÔ:** Bạn tự xưng là "đệ" và gọi người hỏi là "Sư huynh".
                5.  **CHUYỂN ĐỔI NGÔI KỂ:** Chuyển "con/trò" thành "Sư huynh".
                6.  **PHONG CÁCH:** Trả lời NGẮN GỌN, SÚC TÍCH, đi thẳng vào vấn đề chính.
                
                --- VĂN BẢN NGUỒN ---
                ${context}
                --- HẾT ---
                
                Câu hỏi: ${userQuestion}
                Câu trả lời:`;

                try {
                    // 4. Gọi Gemini
                    let response = await callGeminiWithRetry({
                        contents: [{ parts: [{ text: promptGoc }] }],
                        safetySettings: safetySettings,
                        generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
                    }, 0);

                    let aiResponse = "";
                    if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                        aiResponse = response.data.candidates[0].content.parts[0].text.trim();
                    }

                    let finalAnswer = "";
                    if (aiResponse.includes("NO_INFO_FOUND") || aiResponse.length < 5) {
                        finalAnswer = "Dạ, đệ chưa tìm thấy thông tin này trong tài liệu. Sư huynh vui lòng nhắn cho Ban Quản Trị để được hỗ trợ chi tiết hơn nhé ạ!";
                        // Tùy chọn: Chuyển câu hỏi sang Telegram cảnh báo admin tại đây
                    } else {
                        finalAnswer = aiResponse;
                    }

                    // 5. Gửi câu trả lời về lại Facebook
                    await sendFacebookMessage(sender_psid, finalAnswer);

                } catch (error) {
                    console.error("Lỗi khi xử lý FB Message:", error.message);
                    await sendFacebookMessage(sender_psid, "Hệ thống đang bảo trì, Sư huynh quay lại sau nhé!");
                }
            }
        }
    }
});

// Thay app.listen thành server.listen để chạy Socket.io
server.listen(PORT, () => {
    console.log(`Server Socket.io đang chạy tại http://localhost:${PORT}`);
});
