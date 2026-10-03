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

    // Lấy IP & Ghi lại thông tin
    let rawIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    const userIp = rawIp.split(',')[0].trim(); 
    
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

// ========================================================
// HÀM LỌC TỪ KHÓA (RAG) ĐỂ LẤY TOP 15 BÀI VIẾT LIÊN QUAN
// ========================================================
function filterRelevantContext(question, fullContext) {
    // Tách văn bản thành mảng các dòng
    const lines = fullContext.split('\n');
    
    // Tách câu hỏi thành các từ khóa (loại bỏ các từ ngắn hơn 3 ký tự)
    const keywords = question.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    
    let matchedLines = [];
    
    // Chấm điểm từng dòng dựa trên số lượng từ khóa xuất hiện
    for (const line of lines) {
        if (line.trim().length === 0) continue;
        
        const lowerLine = line.toLowerCase();
        let score = 0;
        
        for (const kw of keywords) {
            if (lowerLine.includes(kw)) {
                score++;
            }
        }
        
        // Nếu dòng có chứa ít nhất 1 từ khóa, đưa vào danh sách
        if (score > 0) {
            matchedLines.push({ line: line.trim(), score: score });
        }
    }
    
    // Sắp xếp các dòng theo điểm số giảm dần
    matchedLines.sort((a, b) => b.score - a.score);
    
    // Chỉ lấy Top 15 dòng liên quan nhất để đưa cho Gemini
    const topResults = matchedLines.slice(0, 15).map(item => item.line);
    
    return topResults.length > 0 ? topResults.join('\n') : "";
}


// --- API CHAT CHÍNH ---
app.post('/api/chat', async (req, res) => {
    if (apiKeys.length === 0) return res.status(500).json({ error: 'Chưa cấu hình API Key.' });

    try {
        const { question, socketId } = req.body;
        if (!question) return res.status(400).json({ error: 'Thiếu câu hỏi.' });

        let clientIp = "Unknown IP";
        if (io.sockets.sockets.get(socketId)) {
            clientIp = io.sockets.sockets.get(socketId).userIp || "Unknown IP";
        }
        const dailyOrder = trackNewUser(clientIp) || "N/A";

        if (question.length > 1000) {
            return res.json({ answer: "Dạ, câu hỏi của Sư huynh dài quá, Sư huynh tóm tắt lại cho đệ dễ hiểu nhé!" });
        }

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

                logToGoogleSheets(clientIp, question, "Chuyển tiếp cho Ban Quản Trị", dailyOrder);
                return res.json({ answer: "✅ Đệ đã chuyển tin nhắn riêng của Sư huynh tới Ban quản trị. Sư huynh vui lòng giữ kết nối và chờ phản hồi nhé! 🙏" });

            } catch (err) {
                console.error("Lỗi gửi tin nhắn trực tiếp:", err.message);
                return res.json({ answer: "❌ Lỗi kết nối, không gửi được tin nhắn. Sư huynh thử lại sau nhé." });
            }
        }

        // ========================================================
        // THIẾT QUÂN LUẬT: CHẶN CÁC CÂU HỎI VỀ GIẤC MƠ / CHIÊM BAO
        // ========================================================
        const dreamRegex = /(giấc mơ|nằm mơ|chiêm bao|mộng thấy|nằm mộng|đệ mộng|mình mơ|đệ mơ|giải mã giấc mơ|ngủ mơ|trong mơ|giấc mộng|ác mộng)|(^|\s|[.,:;!?])(mơ|mộng)(?=\s|$|[.,:;!?])/i;
        
        if (dreamRegex.test(question)) {
            const dreamAnswer = "Dạ Sư huynh vui lòng tra cứu các khai thị của Sư Phụ về giấc mơ tại địa chỉ : https://blogs.pmtl.site/tim-kiem/";
            logToGoogleSheets(clientIp, question, dreamAnswer, dailyOrder);
            return res.json({ answer: dreamAnswer });
        }

        const isChinese = /[\u4e00-\u9fa5]/.test(question);

        // ========================================================
        // TẢI VÀ LỌC DỮ LIỆU (TỪ 8000 BÀI XUỐNG 15 BÀI)
        // ========================================================
        const fullContext = await getDocumentContext();
        const context = filterRelevantContext(question, fullContext);

        // NẾU KHÔNG TÌM THẤY TỪ KHÓA NÀO KHỚP -> CHUYỂN TELEGRAM NGAY LẬP TỨC
        if (!context) {
            let finalAnswer = isChinese 
                ? "对不起，目前文本数据中没有这个问题。\n\n🚀 **我已经将问题转交给支持团队。**\n师兄请保持此屏幕打开，收到回复后会立刻显示！ ⏳" 
                : "Dạ, câu hỏi này hiện chưa có trong dữ liệu văn bản.\n\n🚀 **Đệ đã chuyển câu hỏi về nhóm hỗ trợ.**\nSư huynh vui lòng giữ màn hình này, câu trả lời sẽ hiện ra ngay khi có phản hồi ạ! ⏳";

            const safeQuestion = escapeHtml(question);
            const msgContent = `❓ <b>CÂU HỎI CẦN HỖ TRỢ (TỪ KHÓA MỚI)</b>\n\n"${safeQuestion}"\n\n👉 <i>Reply tin nhắn này để trả lời.</i>\n\n<pre>ID:${socketId}</pre>`;
            
            try {
                const teleRes = await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                    chat_id: TELEGRAM_CHAT_ID,
                    text: msgContent,
                    parse_mode: 'HTML'
                });

                if (teleRes.data && teleRes.data.result && socketId) {
                    const msgId = teleRes.data.result.message_id;
                    pendingRequests.set(msgId, { socketId: socketId, timestamp: Date.now() });
                    if (!socketToMsgId.has(socketId)) socketToMsgId.set(socketId, []);
                    socketToMsgId.get(socketId).push(msgId);
                }
            } catch (teleErr) {
                console.error("⚠️ Lỗi gửi thông báo Telegram:", teleErr.message);
            }

            logToGoogleSheets(clientIp, question, "NO_INFO_FOUND - Chuyển Admin", dailyOrder);
            return res.json({ answer: finalAnswer });
        }


        // ========================================================
        // NẾU CÓ DỮ LIỆU THÌ MỚI GỌI GEMINI
        // ========================================================
        const safetySettings = [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        ];

        let systemRules = "";
        let userContent = "";

        if (isChinese) {
            systemRules = `你是一个绝对准确的信息提取工具。你的任务是仅从提供的“源文本”中提取用户问题的答案。
            **必须严格遵守的绝对规则：**
            1. **禁止推理与联想：** 只有当源文本中明确、直接提到与问题相关的信息时才回答。绝对不允许将相似的概念等同起来。
            2. **唯一数据源：** 绝对不可使用外部知识。
            3. **如果找不到直接信息，请准确回答：** "NO_INFO_FOUND"。不要找借口，不要解释。
            4. **分点说明：** 简明扼要，直奔主题。返回网址。
            5. **称呼：** 你自称 "弟" (đệ)，称呼提问者为 "师兄" (Sư huynh)。
            6. **语言强制：** 必须使用 100% 中文回答。绝对不要在答案中混入任何越南语。`;
            
            userContent = `--- 源文本 ---\n${context}\n--- 结束 ---\n\n问题: ${question}\n答案:`;
        } else {
            systemRules = `Bạn là một công cụ trích xuất thông tin chính xác tuyệt đối. Nhiệm vụ của bạn là trích xuất câu trả lời CHỈ từ trong VĂN BẢN NGUỒN.
            **QUY TẮC BẮT BUỘC PHẢI TUÂN THEO TUYỆT ĐỐI:**
            1. **CẤM SUY LUẬN VÀ NỘI SUY (ZERO-INFERENCE):** Chỉ trả lời khi văn bản nguồn có nhắc đến thông tin trực tiếp, cụ thể. TUYỆT ĐỐI KHÔNG tự ý đánh đồng các khái niệm.
            2. **NGUỒN DỮ LIỆU DUY NHẤT:** TUYỆT ĐỐI KHÔNG sử dụng kiến thức bên ngoài văn bản.
            3. **KHÔNG CÓ THÔNG TIN TRỰC TIẾP:** Trả lời chính xác duy nhất chuỗi: "NO_INFO_FOUND". Không giải thích, không xin lỗi.
            4. **CHIA NHỎ:** Không viết thành đoạn văn dài. Tách từng ý thành các gạch đầu dòng.
            5. **XƯNG HÔ:** Bạn tự xưng là "đệ" và gọi người hỏi là "Sư huynh". Trả về URL thuần túy, KHÔNG dùng Markdown link. Bắt buộc trả lời 100% bằng Tiếng Việt.`;
            
            userContent = `--- VĂN BẢN NGUỒN ---\n${context}\n--- HẾT ---\n\nCâu hỏi: ${question}\nCâu trả lời:`;
        }

        let response = await callGeminiWithRetry({
            system_instruction: { parts: [{ text: systemRules }] }, 
            contents: [{ parts: [{ text: userContent }] }],         
            safetySettings: safetySettings,
            generationConfig: { 
                temperature: 0.0, 
                maxOutputTokens: 8192 
            } 
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
            console.log("⚠ Cảnh báo: Trả lời quá dài bị cắt ngang (MAX_TOKENS).");
            if (isChinese) {
                 aiResponse += "\n\n*(抱歉，因为内容太长，我先暂停在这里。师兄可以针对每个具体部分详细提问！)*";
            } else {
                 aiResponse += "\n\n*(Dạ, do nội dung quá dài nên đệ xin phép tạm dừng ở đây. Sư huynh vui lòng đặt câu hỏi chi tiết hơn vào từng phần cụ thể nhé ạ!)*";
            }
        } 
        else if ((finishReason === "RECITATION" || finishReason === "SAFETY" || !aiResponse) && finishReason !== "STOP") {
            aiResponse = "NO_INFO_FOUND"; // Nếu bị chặn an toàn hoặc lỗi ngớ ngẩn thì báo luôn là không có
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
        
        // 1. Xử lý lệnh /start
        if (message.text && message.text.trim().toLowerCase() === '/start') {
            await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`, {
                chat_id: message.chat.id,
                text: `👋 Chào Admin! Bot đang hoạt động bình thường.\n\n👉 Nhấn lệnh /baocao để xem lượng khách truy cập hôm nay nhé!`,
                parse_mode: 'HTML'
            });
            return res.sendStatus(200); // Trả về thành công và kết thúc
        }

        // 2. Nếu admin gõ lệnh /baocao trên Telegram
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
