const express = require('express');
const baileys = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const http = require('https');

const makeWASocket = baileys.default || baileys;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || "JOR_TECH_SECRET_2026";
// رابط موقعك على هوستنجر لاستقبال الرسائل وتخزينها
const WEBHOOK_URL = "https://blue-crane-604835.hostingersite.com/whatsapp/webhook.php";

let sock = null;
let qrCodeData = null;
let isConnected = false;

// إرسال البيانات لموقعك عبر الويب هوك
function sendToWebhook(data) {
    try {
        const payload = JSON.stringify(data);
        const url = new URL(WEBHOOK_URL);
        const req = http.request({
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': API_SECRET,
                'Content-Length': Buffer.byteLength(payload)
            }
        });
        req.on('error', () => {});
        req.write(payload);
        req.end();
    } catch (e) {}
}

async function connectToWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_session');
        const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

        sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            browser: ["Social Tech Hub", "Chrome", "20.0.04"],
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 10000
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                qrCodeData = await QRCode.toDataURL(qr);
            }
            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                isConnected = false;
                if (statusCode !== DisconnectReason.loggedOut) {
                    setTimeout(connectToWhatsApp, 3000);
                }
            } else if (connection === 'open') {
                isConnected = true;
                qrCodeData = null;
                console.log('✅ WhatsApp Connected Successfully!');
            }
        });

        // رصد الرسائل الواردة والصادرة وإرسالها لموقعك فوراً
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type === 'notify' || type === 'append') {
                for (const msg of messages) {
                    if (!msg.message) continue;
                    const from = msg.key.remoteJid;
                    const isFromMe = msg.key.fromMe;
                    const sender = isFromMe ? 'me' : (msg.key.participant || from);
                    const pushName = msg.pushName || '';

                    // استخراج نص الرسالة
                    let text = msg.message.conversation || 
                               msg.message.extendedTextMessage?.text || 
                               msg.message.imageMessage?.caption || 
                               msg.message.videoMessage?.caption || '';

                    let mediaType = 'text';
                    if (msg.message.imageMessage) mediaType = 'image';
                    else if (msg.message.videoMessage) mediaType = 'video';

                    sendToWebhook({
                        chatId: from,
                        sender: sender,
                        senderName: pushName,
                        messageText: text,
                        mediaType: mediaType,
                        isFromMe: isFromMe ? 1 : 0,
                        timestamp: msg.messageTimestamp
                    });
                }
            }
        });

    } catch (err) {
        setTimeout(connectToWhatsApp, 5000);
    }
}

connectToWhatsApp();

// مسار فحص الـ QR
app.get('/qr', (req, res) => {
    if (isConnected) {
        return res.send(`<div style="font-family:sans-serif; text-align:center; padding:50px; direction:rtl;"><h1 style="color:#10b981;">✅ الواتساب متصل بنجاح وجاهز للعمل!</h1></div>`);
    }
    if (!qrCodeData) {
        return res.send(`<div style="font-family:sans-serif; text-align:center; padding:50px; direction:rtl;"><h2>⏳ جاري تجهيز كود الـ QR...</h2><script>setTimeout(() => location.reload(), 4000);</script></div>`);
    }
    res.send(`<div style="font-family:sans-serif; text-align:center; padding:30px; direction:rtl;"><h2>امسح الكود لربط الرقم 📱</h2><img src="${qrCodeData}" style="width:280px; border:3px solid #10b981; border-radius:20px; padding:10px; margin:15px 0;" /><script>setTimeout(() => location.reload(), 9000);</script></div>`);
});

// حماية المسارات
app.use((req, res, next) => {
    const key = req.headers['x-api-key'] || req.query.key;
    if (key !== API_SECRET) {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    next();
});

// سحب القروبات
app.get('/groups', async (req, res) => {
    if (!isConnected || !sock) return res.status(500).json({ success: false, error: 'Not connected' });
    try {
        const groups = await sock.groupFetchAllParticipating();
        const list = Object.values(groups).map(g => ({ id: g.id, name: g.subject }));
        res.json({ success: true, count: list.length, groups: list });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// إنشاء قروب جديد من الموقع
app.post('/groups/create', async (req, res) => {
    if (!isConnected || !sock) return res.status(500).json({ success: false, error: 'Not connected' });
    const { name, participants } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'اسم القروب مطلوب' });

    try {
        let users = [];
        if (participants && Array.isArray(participants)) {
            users = participants.map(p => p.includes('@') ? p : `${p.replace(/[^0-9]/g, '')}@s.whatsapp.net`);
        }
        const group = await sock.groupCreate(name, users);
        res.json({ success: true, group: { id: group.id, name: group.subject } });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// إرسال رسالة لقروب أو شخص
app.post('/send', async (req, res) => {
    if (!isConnected || !sock) return res.status(500).json({ success: false, error: 'Not connected' });
    const { to, message, mediaUrl, mediaType } = req.body;
    try {
        let sent;
        if (mediaType === 'image' && mediaUrl) {
            sent = await sock.sendMessage(to, { image: { url: mediaUrl }, caption: message || '' });
        } else if (mediaType === 'video' && mediaUrl) {
            sent = await sock.sendMessage(to, { video: { url: mediaUrl }, caption: message || '' });
        } else {
            sent = await sock.sendMessage(to, { text: message });
        }
        res.json({ success: true, messageId: sent.key.id });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.listen(PORT, () => console.log(`Server on port ${PORT}`));
