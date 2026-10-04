const express = require('express');
const baileys = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');

// دعم استدعاء الدالة سواء كانت افتراضية أو مباشرة
const makeWASocket = baileys.default || baileys;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || "JOR_TECH_SECRET_2026";

let sock = null;
let qrCodeData = null;
let isConnected = false;

async function connectToWhatsApp() {
    try {
        console.log('⏳ جاري تهيئة جلسة الواتساب...');
        const { state, saveCreds } = await useMultiFileAuthState('auth_session');
        const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

        sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'info' }),
            printQRInTerminal: false,
            browser: ["Ubuntu", "Chrome", "20.0.04"],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 10000
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('⚡ تم استلام كود QR بنجاح، جاري تحويله لصورة...');
                qrCodeData = await QRCode.toDataURL(qr);
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`⚠️ الاتصال انقطع، الرمز: ${statusCode}. هل يعيد المحاولة؟ ${shouldReconnect}`);
                isConnected = false;
                if (shouldReconnect) {
                    setTimeout(connectToWhatsApp, 3000);
                }
            } else if (connection === 'open') {
                isConnected = true;
                qrCodeData = null;
                console.log('✅ تم الاتصال بالواتساب بنجاح 100%!');
            }
        });

    } catch (err) {
        console.error('❌ خطأ في محرك الواتساب:', err);
        setTimeout(connectToWhatsApp, 5000);
    }
}

connectToWhatsApp();

// 1. مسار مسح الـ QR
app.get('/qr', (req, res) => {
    if (isConnected) {
        return res.send(`
            <div style="font-family:sans-serif; text-align:center; padding:50px; direction:rtl;">
                <h1 style="color: #10b981;">✅ الواتساب متصل بنجاح وجاهز للعمل!</h1>
                <p>يمكنك الآن إغلاق هذه الصفحة والعودة لموقعك.</p>
            </div>
        `);
    }

    if (!qrCodeData) {
        return res.send(`
            <div style="font-family:sans-serif; text-align:center; padding:50px; direction:rtl;">
                <h2>⏳ جاري تشغيل المحرك وتوليد كود الـ QR...</h2>
                <p>ستتحدث الصفحة تلقائياً خلال ثوانٍ...</p>
                <script>setTimeout(() => location.reload(), 4000);</script>
            </div>
        `);
    }

    res.send(`
        <div style="font-family:sans-serif; text-align:center; padding:30px; direction:rtl;">
            <h2 style="color:#1e293b;">امسح الكود لربط رقم المركز 📱</h2>
            <img src="${qrCodeData}" style="width:280px; border:3px solid #10b981; border-radius:20px; padding:10px; margin: 15px 0; box-shadow: 0 4px 15px rgba(0,0,0,0.1);" />
            <p style="color:#64748b; font-size:14px;">افتح الواتساب في الهاتف > الأجهزة المرتبطة > ربط جهاز</p>
            <script>setTimeout(() => location.reload(), 9000);</script>
        </div>
    `);
});

// حماية المسارات
app.use((req, res, next) => {
    const key = req.headers['x-api-key'] || req.query.key;
    if (key !== API_SECRET) {
        return res.status(403).json({ success: false, error: 'Unauthorized: Invalid API Key' });
    }
    next();
});

// 2. جلب جميع المجموعات
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

// 3. إرسال الرسالة إلى قروب
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
