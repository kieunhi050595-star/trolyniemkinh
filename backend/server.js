// server.js - Phiên bản Chatbot Txt + Real-time Telegram Support + Google Sheets Log

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const http = require('http'); 
const { Server } = require("socket.io"); 
const cron = require('node-cron'); 
const { google } = require('googleapis'); // Thư viện Google
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// --- CẤU HÌNH GOOGLE SHEETS ---
const SPREADSHEET_ID = process.env.MODEL_SPREADSHEET_ID;
let sheetsClient = null;

// Hàm khởi tạo kết nối Google Sheets
async function initGoogleSheets() {
    try {
        // Xử lý Private Key trên Render: Thường bị lỗi thay thế \n thành chuỗi ký tự '\n'
        let privateKey = process.env.GOOGLE_PRIVATE_KEY || "";
        privateKey = privateKey.replace(/\\n/g, '\n');

        const auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
                private_key: privateKey,
            },
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        const authClient = await auth.getClient();
        sheetsClient = google.sheets({ version: 'v4', auth: authClient });
        console.log("✅ Đã kết nối Google Sheets thành công!");
    } catch (error) {
        console.error("❌ Lỗi kết nối Google Sheets:", error.message);
        sendTelegramAlert(`🚨 <b>LỖI KẾT NỐI GOOGLE SHEETS</b>\n\nChi tiết: ${error.message}`);
    }
}
initGoogleSheets();

// Hàm Ghi Log lên Sheets
async function logToGoogleSheets(ip, question, answer, dailyOrder) {
    if (!sheetsClient || !SPREADSHEET_ID) return;
    try {
        const timeNow = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
        const request = {
            spreadsheetId: SPREADSHEET_ID,
            range: 'phungsuvienao!A:E', // Tên tab là phungsuvienao
            valueInputOption: 'USER_ENTERED',
            insertDataOption: 'INSERT_ROWS',
            resource: {
                values: [[timeNow, ip, question, answer, dailyOrder]],
            },
        };
        await sheetsClient.spreadsheets.values.append(request);
    } catch (error) {
        console.error("❌ Lỗi ghi log Google Sheets:", error.message);
        // Không gửi cảnh báo Telegram liên tục nếu lỗi ghi sheet để tránh spam
    }
}

// --- CẤU HÌNH SOCKET.IO ---
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const pendingRequests = new Map();
const socketToMsgId = new Map();

// --- BỘ DỌN RÁC CHỐNG TRÀN RAM ---
setInterval(() => {
    const now = Date.now();
    const MAX_AGE = 24 * 60 * 60 * 1000; 
    let deletedCount = 0;

    for (const [msgId, data] of pendingRequests.entries()) {
        if (now - data.timestamp > MAX_AGE) {
            pendingRequests.delete(msgId);
            deletedCount++;
        }
    }
    
    if (deletedCount > 0) {
        console.log(`🧹 Đã dọn dẹp ${deletedCount} tin nhắn treo quá 24h để giải phóng RAM.`);
    }
}, 60 * 60 * 1000);

const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || "";
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN || "";

io.on('connection', (socket) => {
    console.log('👤 User Connected:', socket.id);

    // Lấy IP & Ghi lại thông tin (Không báo Telegram ngay lập tức nữa)
    let rawIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    const userIp = rawIp.split(',')[0].trim(); 
    
    // Gắn userIp vào socket object để lúc Chat còn biết ai đang hỏi
    socket.userIp = userIp; 
    trackNewUser(userIp); 

    socket.on('disconnect', () => {
        console.log('User Disconnected:', socket.id);
        if (socketToMsgId.has(socket.id)) {
            const msgIds = socketToMsgId.get(socket.id);
            msgIds.forEach(id => pendingRequests.delete(id));
            socketToMsgId.delete(socket.id);
        }
    });
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// --- CƠ CHẾ CACHE DỮ LIỆU TẠI SERVER ---
const DEFAULT_DOCUMENT_URL = "https://gist.githubusercontent.com/kieunhi050595-star/ddecde18f83b77d06a117a9fcf349188/raw/dulieu.txt";

let globalContextCache = ""; 
let lastFetchTime = 0;
const CACHE_TTL = 10 * 60 * 1000; 
let isFetching = false; 

async function getDocumentContext() {
    const now = Date.now();
    if (globalContextCache && ((now - lastFetchTime < CACHE_TTL) || isFetching)) {
        return globalContextCache;
    }

    isFetching = true; 
    try {
        console.log("🔄 Đang cập nhật dữ liệu mới từ GitHub...");
        const response = await axios.get(`${DEFAULT_DOCUMENT_URL}?v=${now}`);
        globalContextCache = response.data;
        lastFetchTime = now;
        console.log("✅ Cập nhật dữ liệu thành công!");
    } catch (error) {
        console.error("❌ Lỗi tải file dữ liệu .txt:", error.message);
    } finally {
        isFetching = false; 
    }
    return globalContextCache;
}

getDocumentContext();

app.get('/api/get-version', async (req, res) => {
    const context = await getDocumentContext();
    const firstLine = context.split('\n')[0] || "Mới nhất";
    res.json({ version: firstLine });
});

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
            text: `🤖 <b>Phụng Sự Viên Ảo</b> 🚨\n\n${message}`,
            parse_mode: 'HTML'
        });
    } catch (error) {
        console.error("Lỗi gửi Telegram:", error.message);
    }
}

// --- TÍNH NĂNG THỐNG KÊ TRUY CẬP HẰNG NGÀY ---
// Đổi Set thành Map để lưu theo dõi [userId] -> [Thứ tự khách trong ngày]
const dailyUsers = new Map(); 

function trackNewUser(userId) {
    if (!userId) return null;
    if (!dailyUsers.has(userId)) {
        // Gán số thứ tự cho người dùng mới này
        const orderNumber = dailyUsers.size + 1;
        dailyUsers.set(userId, orderNumber);
        return orderNumber;
    }
    // Trả về số thứ tự cũ nếu đã truy cập
    return dailyUsers.get(userId);
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
            timeout: 90000 
        });
        return response;
    } catch (error) {
        const status = error.response ? error.response.status : 0;
        const isTimeout = error.code === 'ECONNABORTED' || error.message.includes('timeout');
    
        if (isTimeout || status === 429 || status === 400 || status === 403 || status >= 500) {
            const errorReason = isTimeout ? 'Timeout' : `Mã ${status}`;
            console.warn(`⚠️ Key ${keyIndex} gặp vấn đề (${errorReason}). Đổi Key...`);
            
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
        const { question, socketId } = req.body;
        if (!question) return res.status(400).json({ error: 'Thiếu câu hỏi.' });

        // Tìm IP của khách từ socketId (lấy từ objects lưu sẵn)
        let clientIp = "Unknown IP";
        if (io.sockets.sockets.get(socketId)) {
            clientIp = io.sockets.sockets.get(socketId).userIp || "Unknown IP";
        }
        const dailyOrder = trackNewUser(clientIp) || "N/A";

        if (question.length > 1000) {
            return res.json({ answer: "Dạ, câu hỏi của Sư huynh dài quá, Sư huynh tóm tắt lại cho đệ dễ hiểu nhé!" });
        }

        const context = await getDocumentContext();

        // --- NHẮN TIN TRỰC TIẾP (@psv : nội dung) ---
        if (question.trim().toLowerCase().startsWith("@psv")) {
            const parts = question.split(':');
            if (parts.length < 2) {
                return res.json({ answer: "Sư huynh vui lòng nhập nội dung sau dấu hai chấm.\nVí dụ: @psv : Cho mình hỏi việc riêng này với ạ" });
            }
            
            const msgContent = parts.slice(1).join(':').trim();
            
            if (!msgContent) {
                return res.json({ answer: "Sư huynh chưa nhập nội dung tin nhắn ạ!" });
            }

            try {
                const safeMsg = escapeHtml(msgContent); 
                
                const teleRes = await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
                    chat_id: process.env.TELEGRAM_CHAT_ID,
                    text: `📨 <b>TIN NHẮN TRỰC TIẾP TỪ KHÁCH [IP: ${clientIp}]</b>\n\nNội dung: "${safeMsg}"\n\n👉 <i>Admin hãy Reply tin nhắn này để trả lời trực tiếp.</i>`,
                    parse_mode: 'HTML'
                });

                if (teleRes.data && teleRes.data.result && socketId) {
                    const msgId = teleRes.data.result.message_id;
                    
                    pendingRequests.set(msgId, { 
                        socketId: socketId, 
                        timestamp: Date.now() 
                    });
                    
                    if (!socketToMsgId.has(socketId)) socketToMsgId.set(socketId, []);
                    socketToMsgId.get(socketId).push(msgId);
                }

                // Ghi log lên sheets
                logToGoogleSheets(clientIp, question, "Chuyển tiếp cho Ban Quản Trị", dailyOrder);
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

        const isChinese = /[\u4e00-\u9fa5]/.test(question);
        let promptGoc = "";
        let promptDienGiai = "";

        if (isChinese) {
            promptGoc = `你是一个绝对准确的信息提取工具。你的任务是仅从提供的“源文本”中提取用户问题的答案。

            **必须严格遵守的规则：**
            1. **唯一数据源：** 仅允许使用“源文本”中的信息。绝对不可使用外部知识。
            2. **分点说明：** 不要写成长篇大段。请将每个要点分成单独的要点符号。
            3. **如果找不到信息，请准确回答：** "NO_INFO_FOUND"。
            4. **称呼：** 你自称 "弟" (đệ)，称呼提问者为 "师兄" (Sư huynh)。
            5. **格式：** 保持简明扼要，直奔主题，直接返回纯 URL 链接。
            6. **语言强制：** 必须使用 100% 中文回答。绝对不要在答案中混入任何越南语。
            7. **关于 NNN：** 指导填写 NNN 时，只能提供英文格式 (例如: Karmic creditor of...)。绝对不要建议使用越南文写 "Thổ Địa", "Oan gia trái chủ", "Vong nhi" 等词。

            --- 源文本 ---
            ${context}
            --- 结束 ---
            
            问题: ${question}
            答案:`;

            promptDienGiai = `任务: 根据源文本回答问题 "${question}"（必须使用 100% 中文）。
            如果没有相关信息，请回答 "NO_INFO_FOUND"。如果有，请重新表述主要观点（不要照抄原文）。
            --- 源文本 ---
            ${context}`;

        } else {
            promptGoc = `Bạn là một công cụ trích xuất thông tin chính xác tuyệt đối. Nhiệm vụ của bạn là trích xuất câu trả lời cho câu hỏi của người dùng CHỈ từ trong VĂN BẢN NGUỒN được cung cấp.

            **QUY TẮC BẮT BUỘC PHẢI TUÂN THEO TUYỆT ĐỐI:**
            1. **NGUỒN DỮ LIỆU DUY NHẤT:** Chỉ được phép sử dụng thông tin có trong phần "VĂN BẢN NGUỒN". TUYỆT ĐỐI KHÔNG sử dụng kiến thức bên ngoài.
            2. **CHIA NHỎ:** Không viết thành đoạn văn. Hãy tách từng ý quan trọng thành các gạch đầu dòng riêng biệt.         
            3. **Nếu không có thông tin, trả lời chính xác:** "NO_INFO_FOUND".
            4. **XƯNG HÔ:** Bạn tự xưng là "đệ" và gọi người hỏi là "Sư huynh".
            5. **CHUYỂN ĐỔI NGÔI KỂ:** Chuyển "con/trò" thành "Sư huynh".
            6. **XỬ LÝ LINK:** Trả về URL thuần túy, KHÔNG dùng Markdown link.
            7. **PHONG CÁCH:** Trả lời NGẮN GỌN, SÚC TÍCH, đi thẳng vào vấn đề chính.
            8. **NGÔN NGỮ:** Bắt buộc trả lời 100% bằng Tiếng Việt. Không pha trộn bất kỳ ngôn ngữ nào khác.
            9. **QUY TẮC ĐIỀN NNN:** Khi hướng dẫn viết thông tin lên "Ngôi Nhà Nhỏ" (NNN), BẮT BUỘC chỉ cung cấp cú pháp tiếng Anh (VD: Karmic creditor of...). TUYỆT ĐỐI KHÔNG xúi giục hay đưa ra lựa chọn viết các từ tiếng Việt như "Thổ Địa", "Oan gia trái chủ", "Vong nhi" lên giấy.        
            
            --- VĂN BẢN NGUỒN ---
            ${context}
            --- HẾT ---
            
            Câu hỏi: ${question}
            Câu trả lời:`;

            promptDienGiai = `NV: Trả lời câu hỏi "${question}" dựa trên văn bản nguồn (BẮT BUỘC DÙNG 100% TIẾNG VIỆT).
            Nếu KHÔNG CÓ thông tin, trả lời "NO_INFO_FOUND". Nếu CÓ, hãy diễn đạt lại ý chính (không trích nguyên văn).
            --- VĂN BẢN NGUỒN ---
            ${context}`;
        }

        let response = await callGeminiWithRetry({
            contents: [{ parts: [{ text: promptGoc }] }],
            safetySettings: safetySettings,
            generationConfig: { temperature: 0.1, maxOutputTokens: 8192 } 
        }, 0);

        let aiResponse = "";
        let finishReason = "";

        if (response.data?.candidates?.[0]) {
            finishReason = response.data.candidates[0].finishReason;
            if (response.data.candidates[0].content?.parts?.[0]?.text) {
                aiResponse = response.data.candidates[0].content.parts[0].text.trim();
            }
        }

        if (finishReason === "MAX_TOKENS") {
            console.log("⚠️ Cảnh báo: Trả lời quá dài bị cắt ngang (MAX_TOKENS).");
            if (isChinese) {
                 aiResponse += "\n\n*(抱歉，因为内容太长，我先暂停在这里。师兄可以针对每个具体部分详细提问！)*";
            } else {
                 aiResponse += "\n\n*(Dạ, do nội dung quá dài nên đệ xin phép tạm dừng ở đây. Sư huynh vui lòng đặt câu hỏi chi tiết hơn vào từng phần cụ thể nhé ạ!)*";
            }
        } 
        else if ((finishReason === "RECITATION" || finishReason === "SAFETY" || !aiResponse) && finishReason !== "STOP") {
            console.log(`⚠️ Bị chặn (Lỗi: ${finishReason}). Dùng Prompt cứu nguy siêu ngặt...`);
            
            if (isChinese) {
                promptDienGiai = `任务: 根据源文本回答问题 "${question}"（必须使用 100% 中文）。
                绝对规则：只能使用源文本中的信息。绝对不可使用外部知识，绝不能捏造信息。简明扼要地总结以避免版权错误。
                --- 源文本 ---
                ${context}`;
            } else {
                promptDienGiai = `NV: Trả lời câu hỏi "${question}" dựa trên văn bản nguồn (BẮT BUỘC DÙNG 100% TIẾNG VIỆT).
                QUY TẮC TUYỆT ĐỐI: CHỈ được dùng thông tin trong văn bản nguồn. TUYỆT ĐỐI KHÔNG sử dụng kiến thức bên ngoài, KHÔNG tự bịa thêm thông tin. Viết tóm tắt ngắn gọn lại để tránh lỗi bản quyền.
                --- VĂN BẢN NGUỒN ---
                ${context}`;
            }

            response = await callGeminiWithRetry({
                contents: [{ parts: [{ text: promptDienGiai }] }],
                safetySettings: safetySettings,
                generationConfig: { temperature: 0.1, maxOutputTokens: 8192 }
            }, 0);

            if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                aiResponse = response.data.candidates[0].content.parts[0].text.trim();
            } else {
                aiResponse = "NO_INFO_FOUND";
            }
        }

        let finalAnswer = "";

        if (aiResponse.includes("NO_INFO_FOUND") || aiResponse.length < 5) {
            const safeQuestion = escapeHtml(question);
            const msgContent = `❓ <b>CÂU HỎI CẦN HỖ TRỢ</b>\n\n"${safeQuestion}"\n\n👉 <i>Reply tin nhắn này để trả lời.</i>\n\n<pre>ID:${socketId}</pre>`;
        
            try {
                const teleRes = await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                    chat_id: TELEGRAM_CHAT_ID,
                    text: msgContent,
                    parse_mode: 'HTML'
                });

                if (teleRes.data && teleRes.data.result && socketId) {
                    const msgId = teleRes.data.result.message_id;
                    pendingRequests.set(msgId, { socketId: socketId, timestamp: Date.now() });
                    
                    if (!socketToMsgId.has(socketId)) {
                        socketToMsgId.set(socketId, []);
                    }
                    socketToMsgId.get(socketId).push(msgId);
                }
            } catch (teleErr) {
                console.error("⚠️ Lỗi gửi thông báo Telegram:", teleErr.message);
            }

            if (isChinese) {
                finalAnswer = "对不起，目前文本数据中没有这个问题。\n\n🚀 **我已经将问题转交给支持团队。**\n师兄请保持此屏幕打开，收到回复后会立刻显示！ ⏳";
            } else {
                finalAnswer = "Dạ, câu hỏi này hiện chưa có trong dữ liệu văn bản.\n\n🚀 **Đệ đã chuyển câu hỏi về nhóm hỗ trợ.**\nSư huynh vui lòng giữ màn hình này, câu trả lời sẽ hiện ra ngay khi có phản hồi ạ! ⏳";
            }

        } else {
            if (isChinese) {
                finalAnswer = "**来自虚拟志愿者的回答：**\n\n" + aiResponse;
            } else {
                finalAnswer = "**Phụng Sự Viên Ảo Trả Lời :**\n\n" + aiResponse;
            }
        }

        // Ghi log lên sheets
        logToGoogleSheets(clientIp, question, finalAnswer, dailyOrder);
        res.json({ answer: finalAnswer });

    } catch (error) {
        console.error("Lỗi:", error.message);
        await sendTelegramAlert(`❌ LỖI HỆ THỐNG:\n${error.message}`);
        res.status(503).json({ error: "Dạ hiện tại mạng của đệ đang hơi chậm, Sư huynh có thể chat @psv : [nội dung] để nhắn trực tiếp cho Ban phụng sự nhé!" });
    }
});

app.post('/api/telegram-webhook', async (req, res) => {
    try {
        const { message } = req.body;
        
        // Nếu không có message thì bỏ qua
        if (!message) return res.sendStatus(200);
        
        // --- TÍNH NĂNG MỚI: NHẬN LỆNH TỪ ADMIN ---
        // Nếu admin gõ lệnh /baocao trên Telegram
        if (message.text && message.text.trim().toLowerCase() === '/baocao') {
            const total = dailyUsers.size;
            
            // Gửi trả lại báo cáo ngay lập tức
            await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
                chat_id: message.chat.id,
                text: `📊 <b>BÁO CÁO TỨC THỜI</b>\nSố lượt khách truy cập hôm nay tính đến hiện tại là: <b>${total}</b> người.`,
                parse_mode: 'HTML'
            });
            
            return res.sendStatus(200); // Trả về thành công và kết thúc
        }

        // --- TÍNH NĂNG CŨ: ADMIN REPLY KHÁCH ---
        if (message.reply_to_message) {
            const replyMsg = message.reply_to_message;
            const originalMsgId = replyMsg.message_id; 
            
            let userSocketId = null;

            if (pendingRequests.has(originalMsgId)) {
                userSocketId = pendingRequests.get(originalMsgId).socketId; 
            } 
            else if (replyMsg.text || replyMsg.caption) {
                const originalText = replyMsg.text || replyMsg.caption || "";
                const match = originalText.match(/ID:([a-zA-Z0-9_-]+)/);
                if (match && match[1]) {
                    userSocketId = match[1];
                }
            }

            if (userSocketId) {
                if (message.photo) {
                     try {
                        const fileId = message.photo[message.photo.length - 1].file_id;
                        const getFileUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`;
                        const fileInfoRes = await axios.get(getFileUrl);
                        const filePath = fileInfoRes.data.result.file_path;
                        const downloadUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
                        
                        const imageRes = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
                        const base64Image = Buffer.from(imageRes.data).toString('base64');
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
            }
        }
        res.sendStatus(200);
    } catch (e) {
        console.error("❌ Lỗi Webhook:", e);
        res.sendStatus(500);
    }
});

// --- TỰ ĐỘNG CHỐT SỐ LIỆU VÀ RESET LÚC 23:59 MỖI NGÀY ---
cron.schedule('59 23 * * *', async () => {
    const total = dailyUsers.size;
    
    if (total > 0) {
        await sendTelegramAlert(`📊 <b>BÁO CÁO TỔNG KẾT CUỐI NGÀY</b>\n` +
                                `Tổng số lượt khách truy cập hôm nay: <b>${total}</b> người.\n` +
                                `<i>🔄 Hệ thống đã tự động làm mới bộ đếm cho ngày mai!</i>`);
    }
    
    dailyUsers.clear();
}, {
    scheduled: true,
    timezone: "Asia/Ho_Chi_Minh" 
});

server.listen(PORT, () => {
    console.log(`Server Socket.io đang chạy tại http://localhost:${PORT}`);
});
