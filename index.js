const express = require('express');
const baileys = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');

const makeWASocket = baileys.default || baileys;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || "JOR_TECH_SECRET_2026";

let sock = null;
let qrCodeData = null;
let isConnected = false;

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
            if (qr) qrCodeData = await QRCode.toDataURL(qr);
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

    } catch (err) {
        setTimeout(connectToWhatsApp, 5000);
    }
}

connectToWhatsApp();

// فحص الـ QR
app.get('/qr', (req, res) => {
    if (isConnected) {
        return res.send(`<div style="font-family:sans-serif; text-align:center; padding:50px; direction:rtl;"><h1 style="color:#10b981;">✅ الواتساب متصل بنجاح وجاهز للعمل!</h1></div>`);
    }
    if (!qrCodeData) {
        return res.send(`<div style="font-family:sans-serif; text-align:center; padding:50px; direction:rtl;"><h2>⏳ جاري تجهيز كود الـ QR...</h2><script>setTimeout(() => location.reload(), 4000);</script></div>`);
    }
    res.send(`<div style="font-family:sans-serif; text-align:center; padding:30px; direction:rtl;"><h2>امسح الكود لربط الرقم 📱</h2><img src="${qrCodeData}" style="width:280px; border:3px solid #10b981; border-radius:20px; padding:10px; margin:15px 0;" /><script>setTimeout(() => location.reload(), 9000);</script></div>`);
});

// حماية المسارات بالمفتاح السري
app.use((req, res, next) => {
    const key = req.headers['x-api-key'] || req.query.key;
    if (key !== API_SECRET) {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    next();
});

// سحب القروبات
app.get('/groups', async (req, res) => {
    if (!isConnected || !sock) return res.status(500).json({ success: false, error: 'الواتساب غير متصل بالسيرفر' });
    try {
        const groups = await sock.groupFetchAllParticipating();
        const list = Object.values(groups).map(g => ({ id: g.id, name: g.subject }));
        res.json({ success: true, count: list.length, groups: list });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// إرسال رسالة لقروب أو شخص (مع حماية صارمة من التعليق أقصاها 10 ثوانٍ)
app.post('/send', async (req, res) => {
    if (!isConnected || !sock) {
        return res.status(500).json({ success: false, error: 'الواتساب غير متصل حالياً، يرجى فتح صفحة QR' });
    }

    let { to, message, mediaUrl, mediaType } = req.body;
    if (!to) return res.status(400).json({ success: false, error: 'معرف القروب أو الرقم مفقود' });

    // تنظيف المعرف وضمان صيغة الواتساب الصحيحة
    let target = decodeURIComponent(String(to).trim());
    if (!target.includes('@')) {
        target = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    }

    try {
        console.log(`📩 جاري الإرسال إلى: ${target} - النص: ${message}`);

        // دالة الإرسال الفعلية
        const sendAction = (async () => {
            if (mediaType === 'image' && mediaUrl) {
                return await sock.sendMessage(target, { image: { url: mediaUrl }, caption: message || '' });
            } else if (mediaType === 'video' && mediaUrl) {
                return await sock.sendMessage(target, { video: { url: mediaUrl }, caption: message || '' });
            } else {
                return await sock.sendMessage(target, { text: String(message || '') });
            }
        })();

        // منع التعليق: إذا لم يرد الواتساب خلال 10 ثوانٍ يقطع فوراً ويعطي خطأ واضحاً
        const timeoutAction = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('انتهت مهلة انتظار خادم الواتساب (10 ثوانٍ)')), 10000)
        );

        const sent = await Promise.race([sendAction, timeoutAction]);
        console.log(`✅ تم الإرسال بنجاح! ID: ${sent?.key?.id}`);
        res.json({ success: true, messageId: sent?.key?.id });

    } catch (e) {
        console.error(`❌ خطأ في الإرسال:`, e.message);
        res.status(500).json({ success: false, error: e.message || 'فشل تسليم الرسالة' });
    }
});

// إنشاء قروب جديد
app.post('/groups/create', async (req, res) => {
    if (!isConnected || !sock) return res.status(500).json({ success: false, error: 'الواتساب غير متصل' });
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

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
