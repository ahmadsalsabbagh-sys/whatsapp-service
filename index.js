const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
// مفتاح سري لحماية سيرفرك (يمكنك تغييره لأي كلمة سر تريدها)
const API_SECRET = process.env.API_SECRET || "JOR_TECH_SECRET_2026";

let sock = null;
let qrCodeData = null;
let isConnected = false;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ["Social Tech Hub", "Chrome", "1.0.0"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrCodeData = await QRCode.toDataURL(qr);
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            isConnected = false;
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            isConnected = true;
            qrCodeData = null;
            console.log('✅ WhatsApp Connected Successfully!');
        }
    });
}

connectToWhatsApp();

// 1. صفحة مسح الـ QR Code مباشرة من المتصفح
app.get('/qr', (req, res) => {
    if (isConnected) {
        return res.send(`
            <div style="font-family:sans-serif; text-align:center; padding:50px;">
                <h1 style="color: green;">✅ الواتساب متصل بنجاح وجاهز للعمل!</h1>
                <p>يمكنك الآن إغلاق هذه الصفحة والعودة لموقعك.</p>
            </div>
        `);
    }

    if (!qrCodeData) {
        return res.send(`
            <div style="font-family:sans-serif; text-align:center; padding:50px;">
                <h2>⏳ جاري توليد كود الـ QR... يرجى تحديث الصفحة بعد 5 ثوانٍ</h2>
                <script>setTimeout(() => location.reload(), 4000);</script>
            </div>
        `);
    }

    res.send(`
        <div style="font-family:sans-serif; text-align:center; padding:40px;">
            <h2>امسح الكود لربط رقم واتساب المركز 📱</h2>
            <img src="${qrCodeData}" style="width:280px; border:2px solid #ccc; border-radius:15px; padding:10px;" />
            <p>افتح الواتساب في هاتفك > الأجهزة المرتبطة > ربط جهاز</p>
            <script>setTimeout(() => location.reload(), 6000);</script>
        </div>
    `);
});

// حماية الـ API بالمفتاح السري
app.use((req, res, next) => {
    const key = req.headers['x-api-key'] || req.query.key;
    if (key !== API_SECRET) {
        return res.status(403).json({ success: false, error: 'Unauthorized: Invalid API Key' });
    }
    next();
});

// 2. سحب جميع القروبات المشترك بها الرقم
app.get('/groups', async (req, res) => {
    if (!isConnected || !sock) {
        return res.status(500).json({ success: false, error: 'WhatsApp is not connected yet' });
    }
    try {
        const groups = await sock.groupFetchAllParticipating();
        const list = Object.values(groups).map(g => ({
            id: g.id,
            name: g.subject
        }));
        res.json({ success: true, count: list.length, groups: list });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 3. إرسال الرسالة إلى قروب محدد
app.post('/send', async (req, res) => {
    if (!isConnected || !sock) {
        return res.status(500).json({ success: false, error: 'WhatsApp is not connected' });
    }

    const { to, message, mediaUrl, mediaType } = req.body;
    if (!to) return res.status(400).json({ success: false, error: 'Missing target groupId (to)' });

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

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
