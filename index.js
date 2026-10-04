const express = require('express');
const baileys = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');

const makeWASocket = baileys.default || baileys;
// أعدنا دالة fetchLatestBaileysVersion لكي يقبل واتساب إعطاءنا الـ QR
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
        const { state, saveCreds } = await useMultiFileAuthState('wa_session_final');
        
        // جلب أحدث إصدار لواتساب لتجنب رفض الاتصال
        const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

        sock = makeWASocket({
            version, // تمرير الإصدار هنا
            auth: state,
            printQRInTerminal: false,
            // المتصفح الرسمي لمنع تجميد الرسائل (Shadow Ban)
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
            syncFullHistory: false,
            markOnlineOnConnect: true,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
            getMessage: async () => { return { conversation: 'hello' } }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                qrCodeData = await QRCode.toDataURL(qr);
                console.log('✅ تم جلب كود الـ QR بنجاح!');
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
                console.log('✅ WhatsApp Connected Successfully! (Stable Mode)');
            }
        });

        // الاستماع للرسائل (دليل قاطع على أن القناة تعمل)
        sock.ev.on('messages.upsert', async m => {
            if (m.type === 'notify') {
                console.log('📩 تم استقبال رسالة جديدة، قناة الرسائل تعمل بنجاح!');
            }
        });

    } catch (err) {
        setTimeout(connectToWhatsApp, 5000);
    }
}

connectToWhatsApp();

app.get('/qr', (req, res) => {
    if (isConnected) {
        return res.send(`<div style="font-family:sans-serif; text-align:center; padding:50px; direction:rtl;"><h1 style="color:#10b981;">✅ الواتساب متصل بنجاح وجاهز للعمل!</h1></div>`);
    }
    if (!qrCodeData) {
        return res.send(`<div style="font-family:sans-serif; text-align:center; padding:50px; direction:rtl;"><h2>⏳ جاري تجهيز كود الـ QR...</h2><script>setTimeout(() => location.reload(), 4000);</script></div>`);
    }
    res.send(`<div style="font-family:sans-serif; text-align:center; padding:30px; direction:rtl;"><h2>امسح الكود لربط الرقم 📱</h2><img src="${qrCodeData}" style="width:280px; border:3px solid #10b981; border-radius:20px; padding:10px; margin:15px 0;" /><script>setTimeout(() => location.reload(), 9000);</script></div>`);
});

app.use((req, res, next) => {
    const key = req.headers['x-api-key'] || req.query.key;
    if (key !== API_SECRET) {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
    }
    next();
});

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

app.post('/send', async (req, res) => {
    if (!isConnected || !sock) {
        return res.status(500).json({ success: false, error: 'الواتساب غير متصل حالياً بالسيرفر' });
    }

    let { to, message, mediaUrl, mediaType } = req.body;
    if (!to || !message) return res.status(400).json({ success: false, error: 'البيانات غير مكتملة' });

    let rawTarget = decodeURIComponent(String(to).trim());
    let cleanId = rawTarget.replace(/[^0-9-]/g, ''); 
    
    let target = '';
    if (cleanId.length >= 17 || cleanId.includes('-')) {
        target = `${cleanId}@g.us`;
    } else {
        target = `${cleanId}@s.whatsapp.net`;
    }

    try {
        console.log(`[جاري الإرسال] محاولة الإرسال إلى: ${target}`);

        const sendPromise = (async () => {
            if (mediaType === 'image' && mediaUrl) {
                return await sock.sendMessage(target, { image: { url: mediaUrl }, caption: message });
            } else {
                return await sock.sendMessage(target, { text: String(message) });
            }
        })();

        // إعطاء مهلة أطول قليلاً (20 ثانية)
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('TIMEOUT_ERROR')), 20000)
        );

        const sentMsg = await Promise.race([sendPromise, timeoutPromise]);

        console.log(`✅ تم التسليم بنجاح! ID: ${sentMsg?.key?.id}`);
        res.json({ success: true, messageId: sentMsg?.key?.id });

    } catch (e) {
        console.error(`❌ فشل الإرسال الفعلي:`, e.message);
        let errorMessage = e.message;
        if (errorMessage === 'TIMEOUT_ERROR') {
            errorMessage = 'تعذر تسليم الرسالة (حاول مرة أخرى)، تأكد أن الرقم عضو في القروب.';
        }
        res.status(500).json({ success: false, error: errorMessage });
    }
});

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
