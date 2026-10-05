// server.js - Chatbot + Firebase Admin Lưu Lịch Sử + Smart Routing UID

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const http = require('http'); 
const { Server } = require("socket.io"); 
const cron = require('node-cron'); 
const { google } = require('googleapis');
require('dotenv').config();

// --- 1. KHỞI TẠO FIREBASE ADMIN ---
const admin = require("firebase-admin");
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("✅ Đã kết nối Firebase Admin thành công!");
} catch (error) {
    console.error("❌ Lỗi kết nối Firebase Admin. Kiểm tra lại biến FIREBASE_CREDENTIALS:", error.message);
}
const firestore = admin.firestore();


const app = express();
const PORT = process.env.PORT || 3001;

// --- CẤU HÌNH GOOGLE SHEETS ---
const SPREADSHEET_ID = process.env.MODEL_SPREADSHEET_ID;
let sheetsClient = null;

async function initGoogleSheets() {
    try {
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
    }
}
initGoogleSheets();

async function logToGoogleSheets(ip, question, answer, dailyOrder) {
    if (!sheetsClient || !SPREADSHEET_ID) return;
    try {
        const timeNow = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
        const request = {
            spreadsheetId: SPREADSHEET_ID,
            range: 'phungsuvienao!A:E', 
            valueInputOption: 'USER_ENTERED',
            insertDataOption: 'INSERT_ROWS',
            resource: {
                values: [[timeNow, ip, question, answer, dailyOrder]],
            },
        };
        await sheetsClient.spreadsheets.values.append(request);
    } catch (error) {
        console.error("❌ Lỗi ghi log Google Sheets:", error.message);
    }
}

// --- CẤU HÌNH SOCKET.IO ---
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const pendingRequests = new Map();
const socketToMsgId = new Map();
const activeUsers = new Map(); // LƯU TRỮ ĐỊNH TUYẾN UID

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
    if (deletedCount > 0) console.log(`🧹 Đã dọn dẹp ${deletedCount} tin nhắn treo quá 24h.`);
}, 60 * 60 * 1000);

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || ""; 
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

io.on('connection', (socket) => {
    let rawIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    const userIp = rawIp.split(',')[0].trim(); 
    socket.userIp = userIp; 
    trackNewUser(userIp); 

    socket.on('user_login', (uid) => {
        if (uid) {
            activeUsers.set(uid, socket.id); 
            socket.uid = uid;
        }
    });

    socket.on('disconnect', () => {
        if (socket.uid && activeUsers.get(socket.uid) === socket.id) {
            activeUsers.delete(socket.uid);
        }
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
    if (globalContextCache && ((now - lastFetchTime < CACHE_TTL) || isFetching)) return globalContextCache;
    isFetching = true; 
    try {
        const response = await axios.get(`${DEFAULT_DOCUMENT_URL}?v=${now}`);
        globalContextCache = response.data;
        lastFetchTime = now;
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

// --- XỬ LÝ DANH SÁCH KEY GEMINI ---
const rawKeys = process.env.GEMINI_API_KEYS || "";
const apiKeys = rawKeys.split(',').map(key => key.trim()).filter(key => key.length > 0);

if (apiKeys.length > 0) console.log(`✅ Đã tìm thấy [${apiKeys.length}] API Keys.`);
else console.error("❌ CẢNH BÁO: Chưa cấu hình API Key!");

app.get('/api/health', (req, res) => { res.status(200).json({ status: "OK", server: "Ready" }); });

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function sendTelegramAlert(message) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return; 
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: `🤖 <b>Phụng Sự Viên Ảo</b> 🚨\n\n${message}`,
            parse_mode: 'HTML'
        });
    } catch (error) {}
}

const dailyUsers = new Map(); 
function trackNewUser(userId) {
    if (!userId) return null;
    if (!dailyUsers.has(userId)) {
        const orderNumber = dailyUsers.size + 1;
        dailyUsers.set(userId, orderNumber);
        return orderNumber;
    }
    return dailyUsers.get(userId);
}

function escapeHtml(text) {
    if (!text) return "";
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function filterRelevantContext(question, fullContext) {
    const lines = fullContext.split('\n');
    const keywords = question.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    let matchedLines = [];
    for (const line of lines) {
        if (line.trim().length === 0) continue;
        const lowerLine = line.toLowerCase();
        let score = 0;
        for (const kw of keywords) {
            if (lowerLine.includes(kw)) score++;
        }
        if (score > 0) matchedLines.push({ line: line.trim(), score: score });
    }
    matchedLines.sort((a, b) => b.score - a.score);
    const topResults = matchedLines.slice(0, 30).map(item => item.line);
    return topResults.length > 0 ? topResults.join('\n') : "";
}

async function callGeminiWithRetry(payload, keyIndex = 0, retryCount = 0) {
    if (keyIndex >= apiKeys.length) {
        if (retryCount < 1) {
            await sleep(2000);
            return callGeminiWithRetry(payload, 0, retryCount + 1);
        }
        await sendTelegramAlert("🆘 HẾT SẠCH API KEY! Hệ thống không thể phản hồi.");
        throw new Error("ALL_KEYS_EXHAUSTED");
    }

    const currentKey = apiKeys[keyIndex];
    const model = "gemini-2.5-flash"; 
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${currentKey}`;

    try {
        const response = await axios.post(apiUrl, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 90000 });
        return response;
    } catch (error) {
        const status = error.response ? error.response.status : 0;
        const isTimeout = error.code === 'ECONNABORTED' || error.message.includes('timeout');
        if (isTimeout || status === 429 || status === 400 || status === 403 || status >= 500) {
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
        const { question, socketId, uid } = req.body; 
        if (!question) return res.status(400).json({ error: 'Thiếu câu hỏi.' });

        let clientIp = "Unknown IP";
        if (io.sockets.sockets.get(socketId)) {
            clientIp = io.sockets.sockets.get(socketId).userIp || "Unknown IP";
        }
        const dailyOrder = trackNewUser(clientIp) || "N/A";

        if (question.length > 1000) {
            return res.json({ answer: "Dạ, câu hỏi của Sư huynh dài quá, Sư huynh tóm tắt lại cho đệ dễ hiểu nhé!" });
        }

        // --- NHẮN TIN TRỰC TIẾP (@psv) ---
        if (question.trim().toLowerCase().startsWith("@psv")) {
            const parts = question.split(':');
            if (parts.length < 2) return res.json({ answer: "Sư huynh vui lòng nhập nội dung sau dấu hai chấm.\nVí dụ: @psv : Cho mình hỏi việc riêng này với ạ" });
            const msgContent = parts.slice(1).join(':').trim();
            if (!msgContent) return res.json({ answer: "Sư huynh chưa nhập nội dung tin nhắn ạ!" });

            try {
                const safeMsg = escapeHtml(msgContent); 
                const teleRes = await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
                    chat_id: process.env.TELEGRAM_CHAT_ID,
                    text: `📨 <b>TIN NHẮN TRỰC TIẾP TỪ KHÁCH [IP: ${clientIp}]</b>\n\nNội dung: "${safeMsg}"\n\n👉 <i>Admin hãy Reply tin nhắn này để trả lời trực tiếp.</i>\n\n<pre>ID:${socketId} | UID:${uid || 'none'}</pre>`,
                    parse_mode: 'HTML'
                });

                if (teleRes.data && teleRes.data.result && socketId) {
                    const msgId = teleRes.data.result.message_id;
                    pendingRequests.set(msgId, { socketId: socketId, uid: uid, timestamp: Date.now() });
                    if (!socketToMsgId.has(socketId)) socketToMsgId.set(socketId, []);
                    socketToMsgId.get(socketId).push(msgId);
                }
                logToGoogleSheets(clientIp, question, "Chuyển tiếp cho Ban Quản Trị", dailyOrder);
                return res.json({ answer: "🙏Đệ đã chuyển tin nhắn riêng của Sư huynh tới Ban quản trị, Sư huynh có thể tìm kiếm khai thị trực tiếp tại : https://timkhaithi.pmtl.site/p/tim-kiem-khai-thi.html " });
            } catch (err) {
                return res.json({ answer: "❌ Lỗi kết nối, không gửi được tin nhắn. Sư huynh thử lại sau nhé." });
            }
        }

        const dreamRegex = /(giấc mơ|nằm mơ|chiêm bao|mộng thấy|nằm mộng|đệ mộng|mình mơ|đệ mơ|giải mã giấc mơ|ngủ mơ|trong mơ|giấc mộng|ác mộng)|(^|\s|[.,:;!?])(mơ|mộng)(?=\s|$|[.,:;!?])/i;
        if (dreamRegex.test(question)) {
            const dreamAnswer = "Dạ Sư huynh vui lòng tra cứu các khai thị của Sư Phụ về giấc mơ tại địa chỉ : https://blogs.pmtl.site/tim-kiem/";
            logToGoogleSheets(clientIp, question, dreamAnswer, dailyOrder);
            return res.json({ answer: dreamAnswer });
        }

        const fullContext = await getDocumentContext();
        const context = filterRelevantContext(question, fullContext);
        const isChinese = /[\u4e00-\u9fa5]/.test(question);

        if (!context) {
            let finalAnswer = isChinese 
                ? "对不起，目前文本数据中没有这个问题。\n\n🚀 **我已经将问题转交给支持团队。**\n师兄请保持此屏幕打开，收到回复后会立刻显示！ ⏳" 
                : "Dạ, câu hỏi này hiện chưa có trong dữ liệu văn bản.\n\n🚀 **Đệ đã chuyển câu hỏi về nhóm hỗ trợ.**\nSư huynh có thể tra cứu ngay tại : https://timkhaithi.pmtl.site/p/tim-kiem-khai-thi.html ";

            const safeQuestion = escapeHtml(question);
            const msgContent = `❓ <b>CÂU HỎI CẦN HỖ TRỢ (TỪ KHÓA MỚI)</b>\n\n"${safeQuestion}"\n\n👉 <i>Reply tin nhắn này để trả lời.</i>\n\n<pre>ID:${socketId} | UID:${uid || 'none'}</pre>`;
            
            try {
                const teleRes = await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                    chat_id: TELEGRAM_CHAT_ID,
                    text: msgContent,
                    parse_mode: 'HTML'
                });
                if (teleRes.data && teleRes.data.result && socketId) {
                    const msgId = teleRes.data.result.message_id;
                    pendingRequests.set(msgId, { socketId: socketId, uid: uid, timestamp: Date.now() });
                    if (!socketToMsgId.has(socketId)) socketToMsgId.set(socketId, []);
                    socketToMsgId.get(socketId).push(msgId);
                }
            } catch (teleErr) {}
            logToGoogleSheets(clientIp, question, "NO_INFO_FOUND - Chuyển Admin", dailyOrder);
            return res.json({ answer: finalAnswer });
        }

        const safetySettings = [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        ];

        let systemRules = "";
        let userContent = "";

        if (isChinese) {
            systemRules = `你是一个专业的文献检索助手。你的任务是理解用户的意图，并仅从提供的“源文本”中提取最相关的文章。
            **必须严格遵守的绝对规则：**
            1. **语义推理：** 允许分析用户意图以匹配相似的标题（例如：“生病”可以匹配“治病”，“求子”可以匹配“怀孕”等）。
            2. **原文引用：** 找到相关文章后，必须原封不动地引用源文本中的格式来回答，格式必须是：“* 文章标题 : 文章链接”。
            3. **唯一数据源：** 绝对不可使用外部知识，绝对不能捏造源文本中不存在的链接或标题。
            4. **如果没有直接信息：** 请准确回答："NO_INFO_FOUND"。不要找借口，不要解释。
            5. **称呼：** 你自称 "弟" (đệ)，称呼提问者为 "师兄" (Sư huynh)。必须使用 100% 中文回答。`;
            userContent = `--- 源文本 ---\n${context}\n--- 结束 ---\n\n问题: ${question}\n答案:`;
        } else {
            systemRules = `Bạn là một trợ lý ảo tra cứu tài liệu chuyên nghiệp. Nhiệm vụ của bạn là suy luận, đọc hiểu ý định của người dùng và tìm ra các bài viết phù hợp nhất CHỈ từ VĂN BẢN NGUỒN.
            **QUY TẮC BẮT BUỘC PHẢI TUÂN THEO TUYỆT ĐỐI:**
            1. **SUY LUẬN NGỮ NGHĨA:** Cho phép phân tích ý định của người dùng để khớp với các tiêu đề bài viết tương đồng (Ví dụ: "muốn có thai" có thể khớp với tiêu đề "cầu con", "đau ốm" khớp với "trị bệnh", "cãi nhau" khớp với "oán kết").
            2. **TRÍCH DẪN NGUYÊN VĂN:** Khi tìm thấy bài viết phù hợp, BẮT BUỘC trả lời bằng cách trích dẫn nguyên văn dữ liệu bài viết theo đúng cấu trúc có trong nguồn: "* Tiêu đề bài viết : Link bài viết". 
            3. **NGUỒN DỮ LIỆU DUY NHẤT:** TUYỆT ĐỐI KHÔNG sử dụng kiến thức bên ngoài, KHÔNG TỰ BỊA RA LINK hoặc tự tạo tiêu đề không có trong văn bản nguồn.
            4. **NẾU KHÔNG CÓ THÔNG TIN LIÊN QUAN:** Trả lời chính xác duy nhất chuỗi: "NO_INFO_FOUND". Không giải thích, không xin lỗi.
            5. **XƯNG HÔ VÀ TRÌNH BÀY:** Tự xưng là "đệ" và gọi người hỏi là "Sư huynh". Trình bày rõ ràng, mỗi bài viết một dòng. Bắt buộc trả lời 100% bằng Tiếng Việt.`;
            userContent = `--- VĂN BẢN NGUỒN ---\n${context}\n--- HẾT ---\n\nCâu hỏi: ${question}\nCâu trả lời (hãy gửi kèm tiêu đề và link gốc):`;
        }

        let response = await callGeminiWithRetry({
            system_instruction: { parts: [{ text: systemRules }] }, 
            contents: [{ parts: [{ text: userContent }] }],         
            safetySettings: safetySettings,
            generationConfig: { temperature: 0.0, maxOutputTokens: 8192 } 
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
            aiResponse += isChinese ? "\n\n*(抱歉，因为内容太长，我先暂停在这里。师兄可以针对每个具体部分详细提问！)*" : "\n\n*(Dạ, do nội dung quá dài nên đệ xin phép tạm dừng ở đây. Sư huynh vui lòng đặt câu hỏi chi tiết hơn vào từng phần cụ thể nhé ạ!)*";
        } else if ((finishReason === "RECITATION" || finishReason === "SAFETY" || !aiResponse) && finishReason !== "STOP") {
            aiResponse = "NO_INFO_FOUND";
        }

        let finalAnswer = "";

        if (aiResponse.includes("NO_INFO_FOUND") || aiResponse.length < 5) {
            const safeQuestion = escapeHtml(question);
            const msgContent = `❓ <b>CÂU HỎI CẦN HỖ TRỢ</b>\n\n"${safeQuestion}"\n\n👉 <i>Reply tin nhắn này để trả lời.</i>\n\n<pre>ID:${socketId} | UID:${uid || 'none'}</pre>`;
         
            try {
                const teleRes = await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                    chat_id: TELEGRAM_CHAT_ID,
                    text: msgContent,
                    parse_mode: 'HTML'
                });
                if (teleRes.data && teleRes.data.result && socketId) {
                    const msgId = teleRes.data.result.message_id;
                    pendingRequests.set(msgId, { socketId: socketId, uid: uid, timestamp: Date.now() });
                    if (!socketToMsgId.has(socketId)) socketToMsgId.set(socketId, []);
                    socketToMsgId.get(socketId).push(msgId);
                }
            } catch (teleErr) {}

            finalAnswer = isChinese ? "对不起，目前文本数据中没有这个问题。\n\n🚀 **我已经将问题转交给支持团队。**\n师兄请保持此屏幕打开，收到回复后会立刻显示！ ⏳" : "Dạ, câu hỏi này hiện chưa có trong dữ liệu văn bản.\n\n🚀 **Đệ đã chuyển câu hỏi về nhóm hỗ trợ.**\nSư huynh có thể tra cứu ngay tại : https://timkhaithi.pmtl.site/p/tim-kiem-khai-thi.html ";
        } else {
            finalAnswer = (isChinese ? "**来自虚拟志愿者的回答：**\n\n" : "**Phụng Sự Viên Ảo Trả Lời :**\n\n") + aiResponse;
        }

        logToGoogleSheets(clientIp, question, finalAnswer, dailyOrder);
        res.json({ answer: finalAnswer });

    } catch (error) {
        await sendTelegramAlert(`❌ LỖI HỆ THỐNG:\n${error.message}`);
        res.status(503).json({ error: "Dạ hiện tại mạng của đệ đang hơi chậm, Sư huynh có thể chat @psv : [nội dung] để nhắn trực tiếp cho Ban phụng sự nhé!" });
    }
});

// --- API WEBHOOK TRẢ LỜI TỪ ADMIN BỔ SUNG LƯU DATABASE ---
app.post('/api/telegram-webhook', async (req, res) => {
    try {
        const { message } = req.body;
        
        if (!message) return res.sendStatus(200);
        
        if (message.text && message.text.trim().toLowerCase() === '/start') {
            await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
                chat_id: message.chat.id,
                text: `👋 Chào Admin! Bot đang hoạt động bình thường.`,
                parse_mode: 'HTML'
            });
            return res.sendStatus(200);
        }

        if (message.text && message.text.trim().toLowerCase() === '/baocao') {
            const total = dailyUsers.size;
            await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
                chat_id: message.chat.id,
                text: `📊 <b>BÁO CÁO TỨC THỜI</b>\nSố lượt khách truy cập hôm nay: <b>${total}</b> người.`,
                parse_mode: 'HTML'
            });
            return res.sendStatus(200);
        }

        if (message.reply_to_message) {
            const replyMsg = message.reply_to_message;
            const originalMsgId = replyMsg.message_id; 
            
            let userSocketId = null;
            let userUid = null; 

            // TÌM SOCKET ID VÀ UID 
            if (pendingRequests.has(originalMsgId)) {
                const reqData = pendingRequests.get(originalMsgId);
                userSocketId = reqData.socketId; 
                userUid = reqData.uid;
            } 
            else if (replyMsg.text || replyMsg.caption) {
                const originalText = replyMsg.text || replyMsg.caption || "";
                const match = originalText.match(/ID:([a-zA-Z0-9_-]+)(?:\s*\|\s*UID:([a-zA-Z0-9_-]+))?/);
                if (match) {
                    userSocketId = match[1];
                    if (match[2] && match[2] !== 'none') userUid = match[2];
                }
            }

            // ĐỊNH TUYẾN THÔNG MINH BẰNG UID
            if (userUid && activeUsers.has(userUid)) {
                userSocketId = activeUsers.get(userUid);
            }

            // Lấy nội dung tin nhắn (chữ hoặc tải ảnh về)
            let textToEmit = message.text || "";
            let captionToEmit = message.caption || "";
            let base64Image = "";

            if (message.photo) {
                try {
                    const fileId = message.photo[message.photo.length - 1].file_id;
                    const fileInfoRes = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
                    const filePath = fileInfoRes.data.result.file_path;
                    const imageRes = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`, { responseType: 'arraybuffer' });
                    base64Image = `data:image/jpeg;base64,${Buffer.from(imageRes.data).toString('base64')}`;
                } catch (imgErr) {
                    console.error("❌ Lỗi tải ảnh từ Telegram:", imgErr.message);
                }
            }

            // --- 1. LƯU VÀO FIREBASE NẾU KHÁCH ĐÃ ĐĂNG NHẬP ---
            if (userUid) {
                try {
                    if (base64Image) {
                        await firestore.collection('chats').add({
                            uid: userUid,
                            text: base64Image,
                            sender: 'admin',
                            msgType: 'image',
                            cssType: 'normal',
                            timestamp: admin.firestore.FieldValue.serverTimestamp()
                        });
                        if (captionToEmit) {
                            await firestore.collection('chats').add({
                                uid: userUid,
                                text: "**Ban Quản Trị Trả Lời:**\n\n" + captionToEmit,
                                sender: 'admin',
                                msgType: 'normal',
                                cssType: 'normal',
                                timestamp: admin.firestore.FieldValue.serverTimestamp()
                            });
                        }
                    } else if (textToEmit) {
                        await firestore.collection('chats').add({
                            uid: userUid,
                            text: "**Ban Quản Trị Trả Lời:**\n\n" + textToEmit,
                            sender: 'admin',
                            msgType: 'normal',
                            cssType: 'normal',
                            timestamp: admin.firestore.FieldValue.serverTimestamp()
                        });
                    }
                } catch (dbErr) {
                    console.error("❌ Lỗi lưu tin nhắn Admin vào Firebase:", dbErr.message);
                }
            }

            // --- 2. PHÁT QUA SOCKET NẾU KHÁCH ĐANG MỞ WEB ---
            if (userSocketId) {
                if (base64Image) {
                    io.to(userSocketId).emit('admin_reply_image', base64Image);
                    if (captionToEmit) io.to(userSocketId).emit('admin_reply', captionToEmit);
                } else if (textToEmit) {
                    io.to(userSocketId).emit('admin_reply', textToEmit);
                }
            }
        }
        res.sendStatus(200);
    } catch (e) {
        res.sendStatus(500);
    }
});

cron.schedule('59 23 * * *', async () => {
    const total = dailyUsers.size;
    if (total > 0) {
        await sendTelegramAlert(`📊 <b>BÁO CÁO TỔNG KẾT CUỐI NGÀY</b>\nTổng lượt khách: <b>${total}</b> người.`);
    }
    dailyUsers.clear();
}, { scheduled: true, timezone: "Asia/Ho_Chi_Minh" });

server.listen(PORT, () => {
    console.log(`Server Socket.io đang chạy tại http://localhost:${PORT}`);
});
