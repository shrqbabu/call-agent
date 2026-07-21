require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const axios = require('axios');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Twilio client
const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

// NOTE: Vercel serverless = no shared memory between requests.
// Conversation state is carried inside the Twilio webhook URLs (base64 query param)
// instead of an in-memory object, so it survives across lambda instances.

// ============ STATE HELPERS (URL-safe base64 JSON) ============

const MAX_EXCHANGES = 10; // cap so the URL stays small

function encodeState(state) {
    return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

function decodeState(raw) {
    try {
        return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
}

// ============ AUTH ============

// Protect /missed-call so random people can't make the bot dial numbers
function checkApiKey(req, res) {
    const secret = process.env.MISSED_CALL_SECRET;
    if (!secret) return true; // not configured = open (set it in production!)
    if (req.headers['x-api-key'] === secret) return true;
    res.status(401).json({ error: 'Unauthorized' });
    return false;
}

// ============ MISSED CALL WEBHOOK ============

// Android app (Termux detector) POSTs here when a missed call is detected
app.post('/missed-call', async (req, res) => {
    try {
        if (!checkApiKey(req, res)) return;

        const { callerNumber, missedTime } = req.body;

        console.log(`\n📞 Missed call detected from: ${callerNumber}`);
        console.log(`   Time: ${new Date(missedTime).toLocaleString('en-IN')}`);

        // Validate
        if (!callerNumber || callerNumber.replace(/\D/g, '').length < 10) {
            return res.status(400).json({ error: 'Invalid caller number' });
        }

        // Trigger callback (detector already handles the cooldown;
        // serverless memory can't reliably dedupe here)
        const callSid = await initiateCallback(callerNumber);

        res.json({
            success: true,
            message: 'Callback initiated',
            callerNumber,
            callSid
        });

    } catch (err) {
        console.error('❌ Missed call handler error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============ INITIATE CALLBACK ============

async function initiateCallback(callerNumber) {
    // Format number (ensure +91 prefix)
    let formattedNumber = callerNumber.replace(/\s+/g, '');
    if (!formattedNumber.startsWith('+')) {
        formattedNumber = '+91' + formattedNumber.replace(/^0+/, '');
    }

    console.log(`🤖 Initiating callback to: ${formattedNumber}`);

    const call = await client.calls.create({
        url: `${process.env.SERVER_URL}/outbound-voice`,
        to: formattedNumber,
        from: process.env.TWILIO_PHONE_NUMBER,
        statusCallback: `${process.env.SERVER_URL}/call-status`,
        statusCallbackEvent: ['completed'],
        timeout: 30,
        record: false
    });

    console.log(`✅ Callback initiated: ${call.sid}`);
    return call.sid;
}

// ============ OUTBOUND VOICE FLOW ============

// When bot calls back the user
app.post('/outbound-voice', (req, res) => {
    const to = req.body.To;
    console.log(`📞 Outbound call connected to: ${to}`);

    // Fresh conversation state, carried via the action URL
    const state = encodeState({ st: Date.now(), c: [] });

    const twiml = new twilio.twiml.VoiceResponse();

    twiml.say({
        voice: 'Polly.Kajal-Neural',
        language: 'hi-IN'
    }, 'हेलो! आपने अभी शारिक़ सर को कॉल किया था। मैं एलीशा, उनकी असिस्टेंट। वो अभी बिज़ी हैं। आपका मैसेज बताइए, मैं उन्हें इनफॉर्म कर दूँगी।');

    twiml.pause({ length: 1 });

    twiml.gather({
        input: 'speech',
        action: `/process-callback-speech?s=${state}`,
        method: 'POST',
        speechTimeout: 'auto',
        language: 'hi-IN'
    });

    // Gather timed out (caller said nothing)
    twiml.say({
        voice: 'Polly.Kajal-Neural',
        language: 'hi-IN'
    }, 'कोई बात नहीं, मैं सर को बता दूँगी कि आपने कॉल किया था। शुक्रिया!');
    twiml.hangup();

    res.type('text/xml');
    res.send(twiml.toString());
});

// Process callback conversation
app.post('/process-callback-speech', async (req, res) => {
    const userSpeech = req.body.SpeechResult || '';
    const to = req.body.To;
    const state = decodeState(req.query.s || '') || { st: Date.now(), c: [] };

    console.log(`🎤 User said: "${userSpeech}"`);

    // Generate AI response (with conversation history for context)
    const aiResponse = await generateAIResponse(userSpeech, to, state.c);
    console.log(`🤖 Ellysha: "${aiResponse}"`);

    // Track conversation in state
    state.c.push({ user: userSpeech, bot: aiResponse });
    state.c = state.c.slice(-MAX_EXCHANGES);

    const twiml = new twilio.twiml.VoiceResponse();

    twiml.say({
        voice: 'Polly.Kajal-Neural',
        language: 'hi-IN'
    }, aiResponse);

    // Check if conversation should end
    const shouldEnd = aiResponse.includes('इनफॉर्म कर देती') ||
                     aiResponse.includes('बता देती हूँ') ||
                     aiResponse.includes('बता देती हूं') ||
                     aiResponse.toLowerCase().includes('inform kar deti') ||
                     aiResponse.toLowerCase().includes('bata deti hoon') ||
                     userSpeech.toLowerCase().includes('thank') ||
                     userSpeech.toLowerCase().includes('bye') ||
                     userSpeech.includes('धन्यवाद') ||
                     userSpeech.includes('शुक्रिया') ||
                     state.c.length >= MAX_EXCHANGES;

    if (!shouldEnd && userSpeech.length > 5) {
        twiml.gather({
            input: 'speech',
            action: `/process-callback-speech?s=${encodeState(state)}`,
            method: 'POST',
            speechTimeout: 'auto',
            language: 'hi-IN'
        });
        // Gather timeout fallback — end gracefully and still notify
        twiml.redirect({ method: 'POST' }, `/end-call?s=${encodeState(state)}`);

        // Send transcript-so-far NOW: if the caller hangs up mid-call,
        // Twilio never hits our next webhook and this is the only email that goes out.
        // (Latest email always has the fullest transcript.)
        await sendEmailNotification(to, state.c, Math.round((Date.now() - state.st) / 1000));
    } else {
        twiml.say({
            voice: 'Polly.Kajal-Neural',
            language: 'hi-IN'
        }, 'शुक्रिया! शारिक़ सर जल्दी आपसे कॉन्टैक्ट करेंगे। आपका दिन अच्छा रहे!');
        twiml.hangup();

        // Send email now — we have the full transcript here
        // (fire before responding so the lambda isn't frozen mid-send)
        await sendEmailNotification(to, state.c, Math.round((Date.now() - state.st) / 1000));
    }

    res.type('text/xml');
    res.send(twiml.toString());
});

// Gather timeout after mid-conversation — say goodbye and send transcript
app.post('/end-call', async (req, res) => {
    const to = req.body.To;
    const state = decodeState(req.query.s || '') || { st: Date.now(), c: [] };

    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({
        voice: 'Polly.Kajal-Neural',
        language: 'hi-IN'
    }, 'ठीक है, मैं शारिक़ सर को इनफॉर्म कर देती हूँ। शुक्रिया!');
    twiml.hangup();

    await sendEmailNotification(to, state.c, Math.round((Date.now() - state.st) / 1000));

    res.type('text/xml');
    res.send(twiml.toString());
});

// ============ AI FUNCTION ============

async function generateAIResponse(userMessage, callerNumber, history = []) {
    try {
        const historyMessages = history.flatMap(c => [
            { role: 'user', content: c.user },
            { role: 'assistant', content: c.bot }
        ]);

        const response = await axios.post(
            `${process.env.API_BASE_URL}/chat/completions`,
            {
                model: process.env.AI_MODEL,
                messages: [
                    {
                        role: 'system',
                        content: `तुम एलीशा हो - शारिक़ सर की असिस्टेंट.

IMPORTANT: ये CALLBACK कॉल है. User ने पहले शारिक़ सर को कॉल किया था, अब तुम उन्हें वापस कॉल कर रही हो.

RULES:
- हमेशा DEVANAGARI (हिंदी) script में लिखो - कभी English/Latin letters use मत करो (TTS सही से बोल सके इसलिए)
- English words भी देवनागरी में लिखो: "बिज़ी", "मैसेज", "इनफॉर्म", "कॉल"
- SHORT responses (1-2 sentences)
- Natural बोलचाल वाली हिंदी/हिंग्लिश
- जब मैसेज सुन लो: "ठीक है, मैं सर को इनफॉर्म कर देती हूँ"
- Personal सवालों पे politely टाल दो
- Natural fillers: "हम्म", "अच्छा", "ठीक है"
- Numbers/digits भी शब्दों में लिखो: "दस बजे" not "10 बजे"

CALLER: ${callerNumber}`
                    },
                    ...historyMessages,
                    { role: 'user', content: userMessage }
                ],
                max_tokens: 80,
                temperature: 0.8
            },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.API_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            }
        );

        return response.data.choices[0].message.content.trim();
    } catch (err) {
        console.error('AI Error:', err.message);
        return "ठीक है, मैं शारिक़ सर को बता देती हूँ।";
    }
}

// ============ CALL STATUS (logging only — email is sent at call end) ============

app.post('/call-status', (req, res) => {
    console.log(`📊 Call ${req.body.CallStatus}, Duration: ${req.body.CallDuration || 0}s, To: ${req.body.To}`);
    res.status(200).send('OK');
});

// ============ EMAIL NOTIFICATION ============

async function sendEmailNotification(callerNumber, conversation, duration) {
    try {
        const callTime = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

        const conversationHtml = conversation.length > 0
            ? conversation.map((c, i) => `
🤵 <strong>Caller [${i + 1}]:</strong> ${escapeHtml(c.user)}
🤖 <strong>Ellysha:</strong> ${escapeHtml(c.bot)}`
              ).join('\n\n────────────────────\n')
            : '📞 Caller ne kuch nahi bola (silent call)';

        const emailData = {
            service_id: process.env.EMAILJS_SERVICE_ID,
            template_id: process.env.EMAILJS_TEMPLATE_ID,
            user_id: process.env.EMAILJS_PUBLIC_KEY,
            accessToken: process.env.EMAILJS_PRIVATE_KEY,
            template_params: {
                to_email: process.env.OWNER_EMAIL,
                caller_number: callerNumber,
                call_duration: `${duration} seconds (${Math.floor(duration / 60)}m ${duration % 60}s)`,
                call_time: callTime,
                conversation: conversationHtml,
                total_exchanges: conversation.length
            }
        };

        await axios.post(
            'https://api.emailjs.com/api/v1.0/email/send',
            emailData,
            { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
        );

        console.log('✅ Email sent successfully');
    } catch (err) {
        console.log('❌ Email failed:', err.message);
    }
}

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ============ HEALTH CHECK ============

app.get('/', (req, res) => {
    res.json({
        status: '🟢 Online',
        bot: 'Ellysha Callback Assistant',
        timestamp: new Date().toISOString()
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// ============ EXPORT FOR VERCEL ============

module.exports = app;

// For local development
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`🚀 Ellysha Callback Bot running on port ${PORT}`);
        console.log(`📞 Webhook: http://localhost:${PORT}/missed-call`);
    });
}
