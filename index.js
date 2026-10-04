const express = require('express');
const baileys = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');

const makeWASocket = baileys.default || baileys;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, delay, downloadMediaMessage } = baileys;

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || "JOR_TECH_SECRET_2026";
// رابط موقعك لاستقبال الرسائل
const PHP_WEBHOOK_URL = "https://blue-crane-604835.hostingersite.com/whatsapp/webhook.php"; 

let sock = null;
let qrCodeData = null;
let isConnected = false;

async function connectToWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('wa_session_super');
        const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
            syncFullHistory: false,
            markOnlineOnConnect: true,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 10000,
            getMessage: async () => { return { conversation: 'hello' } }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) qrCodeData = await QRCode.toDataURL(qr);
            
            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                isConnected = false;
                if (statusCode !== DisconnectReason.loggedOut) setTimeout(connectToWhatsApp, 3000);
            } else if (connection === 'open') {
                isConnected = true;
                qrCodeData = null;
                console.log('✅ WhatsApp Connected Successfully! (Pro Mode)');
            }
        });

        // استقبال الرسائل والميديا وصور البروفايل
        sock.ev.on('messages.upsert', async m => {
            if (m.type === 'notify') {
                const msg = m.messages[0];
                if (!msg.message || msg.key.fromMe) return;

                const senderJid = msg.key.remoteJid;
                const isGroup = senderJid.endsWith('@g.us');
                
                const text = msg.message.conversation || 
                             msg.message.extendedTextMessage?.text || 
                             msg.message.imageMessage?.caption || 
                             msg.message.videoMessage?.caption || '';
                             
                const pushName = msg.pushName || 'مستخدم';

                // جلب صورة البروفايل
                let profilePic = null;
                try {
                    profilePic = await sock.profilePictureUrl(senderJid, 'image');
                } catch (error) {
                    profilePic = null;
                }

                // معالجة الميديا الواردة
                let mediaBase64 = null;
                let mediaType = 'text';
                
                try {
                    if (msg.message.imageMessage || msg.message.videoMessage) {
                        mediaType = msg.message.imageMessage ? 'image' : 'video';
                        const buffer = await downloadMediaMessage(msg, 'buffer', { }, { 
                            logger: console,
                            reuploadRequest: sock.updateMediaMessage
                        });
                        mediaBase64 = buffer.toString('base64');
                    }
                } catch (err) {
                    console.error('❌ فشل تحميل الميديا الواردة:', err);
                }

                try {
                    await fetch(PHP_WEBHOOK_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-api-key': API_SECRET },
                        body: JSON.stringify({
                            chatId: senderJid,
                            senderName: pushName,
                            messageText: text,
                            mediaType: mediaType,
                            mediaBase64: mediaBase64,
                            profilePic: profilePic,
                            isGroup: isGroup
                        })
                    });
                    console.log(`📩 تم تحويل رسالة من ${pushName} بنجاح.`);
                } catch (err) {
                    console.error('❌ فشل إرسال الرسالة إلى الـ Webhook.');
                }
            }
        });

    } catch (err) {
        setTimeout(connectToWhatsApp, 5000);
    }
}

connectToWhatsApp();

app.get('/qr', (req, res) => {
    if (isConnected) return res.send(`<div style="font-family:sans-serif; text-align:center; padding:50px; direction:rtl;"><h1 style="color:#10b981;">✅ الواتساب متصل وجاهز!</h1></div>`);
    if (!qrCodeData) return res.send(`<div style="font-family:sans-serif; text-align:center; padding:50px; direction:rtl;"><h2>⏳ جاري التجهيز...</h2><script>setTimeout(() => location.reload(), 4000);</script></div>`);
    res.send(`<div style="font-family:sans-serif; text-align:center; padding:30px; direction:rtl;"><h2>امسح الكود لربط الرقم 📱</h2><img src="${qrCodeData}" style="width:280px; border:3px solid #10b981; border-radius:20px; padding:10px; margin:15px 0;" /><script>setTimeout(() => location.reload(), 9000);</script></div>`);
});

app.use((req, res, next) => {
    const key = req.headers['x-api-key'] || req.query.key;
    if (key !== API_SECRET) return res.status(403).json({ success: false, error: 'Unauthorized' });
    next();
});

// 🌟 تم التعديل هنا: جلب صور القروبات أثناء المزامنة
app.get('/groups', async (req, res) => {
    if (!isConnected || !sock) return res.status(500).json({ success: false, error: 'الواتساب غير متصل بالسيرفر' });
    try {
        const groups = await sock.groupFetchAllParticipating();
        
        // جلب الصور لكل قروب بشكل متوازي لتسريع العملية
        const list = await Promise.all(Object.values(groups).map(async g => {
            let picUrl = null;
            try {
                picUrl = await sock.profilePictureUrl(g.id, 'image');
            } catch (err) {
                picUrl = null; // إذا لم يكن للقروب صورة
            }
            return { id: g.id, name: g.subject, pic: picUrl };
        }));

        res.json({ success: true, count: list.length, groups: list });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 🌟 تم التعديل هنا: حل مشكلة الـ Timeout (40002)
app.post('/send', async (req, res) => {
    if (!isConnected || !sock) return res.status(500).json({ success: false, error: 'الواتساب غير متصل' });

    let { to, message, mediaUrl, mediaType } = req.body;
    if (!to) return res.status(400).json({ success: false, error: 'الرقم مفقود' });

    let rawTarget = decodeURIComponent(String(to).trim());
    let cleanId = rawTarget.replace(/[^0-9-]/g, ''); 
    let target = (cleanId.length >= 17 || cleanId.includes('-')) ? `${cleanId}@g.us` : `${cleanId}@s.whatsapp.net`;

    try {
        const processSend = async () => {
            if (!target.endsWith('@g.us')) {
                sock.presenceSubscribe(target).catch(() => {});
                sock.sendPresenceUpdate('composing', target).catch(() => {});
                await delay(1000);
                sock.sendPresenceUpdate('paused', target).catch(() => {});
            }

            if (mediaType === 'image' && mediaUrl) {
                return await sock.sendMessage(target, { image: { url: mediaUrl }, caption: message });
            } else if (mediaType === 'video' && mediaUrl) {
                return await sock.sendMessage(target, { video: { url: mediaUrl }, caption: message });
            } else {
                return await sock.sendMessage(target, { text: String(message) });
            }
        };

        // إجبار السيرفر على الرد خلال 15 ثانية كحد أقصى لتجنب خطأ الـ PHP
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT_ERROR')), 15000));
        const sentMsg = await Promise.race([processSend(), timeoutPromise]);

        res.json({ success: true, messageId: sentMsg?.key?.id });

    } catch (e) {
        res.status(500).json({ success: false, error: e.message === 'TIMEOUT_ERROR' ? 'تأخر الرد من سيرفر الواتساب، يرجى المحاولة مرة أخرى' : e.message });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
