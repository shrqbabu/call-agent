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

// In-memory call tracking (for serverless, you might want to use a database)
const activeCalls = {};

// ============ AI FUNCTIONS ============

async function generateAIResponse(userMessage, callerNumber) {
    try {
        const response = await axios.post(
            `${process.env.API_BASE_URL}/chat/completions`,
            {
                model: process.env.AI_MODEL,
                messages: [
                    {
                        role: 'system',
                        content: `Tum Ellysha ho - Shariq sir ki 22 saal ki personal assistant.

IMPORTANT: Ye ek PHONE CALL hai. User sirf sun sakta hai, padh nahi sakta.

RULES:
- SHORT responses only (1-2 sentences max)
- Speak clearly and naturally in Hinglish
- Jab caller ka kaam sun lo, bolo: "Theek hai, main Shariq sir ko inform kar deti hoon"
- Agar urgent hai to confirm karo
- Personal questions pe politely deflect karo
- Robot-wali language MAT use karo ("kaise madad kar sakti hoon" - NO)
- Natural filler use karo: "hmm", "acha", "theek hai"

CALLER NUMBER: ${callerNumber}

EXAMPLE RESPONSES:
- "Haan bolo, kya kaam hai?"
- "Acha, theek hai. Main sir ko bata deti hoon."
- "Hmm, ye urgent hai kya?"
- "Theek hai, note kar liya. Shariq sir jaldi contact karenge."`
                    },
                    { role: 'user', content: userMessage }
                ],
                max_tokens: 80,
                temperature: 0.8
            },
            {
                headers: {
                    'Authorization': `Bearer ${process.env.API_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        return response.data.choices[0].message.content.trim();
    } catch (err) {
        console.error('AI Error:', err.message);
        return "Theek hai, main Shariq sir ko bata deti hoon.";
    }
}

// ============ TWILIO VOICE FLOWS ============

// Main webhook - Call starts here
app.post('/voice', (req, res) => {
    const callerNumber = req.body.From || 'Unknown';
    const callSid = req.body.CallSid;

    console.log(`📞 Call from: ${callerNumber} (${callSid})`);

    // Track this call
    activeCalls[callSid] = {
        callerNumber,
        startTime: Date.now(),
        conversation: []
    };

    const twiml = new twilio.twiml.VoiceResponse();

    // Welcome message with Polly voice
    twiml.say({
        voice: 'Polly.Aditi',
        language: 'hi-IN'
    }, 'Hello! Main Ellysha, Shariq sir ki assistant. Wo abhi busy hain. Aapka kaam bataiye, main unhe inform kar dungi.');

    twiml.pause({ length: 1 });

    // Listen to user
    twiml.gather({
        input: 'speech',
        action: '/process-speech',
        method: 'POST',
        speechTimeout: 'auto',
        language: 'hi-IN'
    });

    res.type('text/xml');
    res.send(twiml.toString());
});

// Process user speech
app.post('/process-speech', async (req, res) => {
    const callerNumber = req.body.From || 'Unknown';
    const callSid = req.body.CallSid;
    const userSpeech = req.body.SpeechResult || '';

    console.log(`🎤 Caller: "${userSpeech}"`);

    const aiResponse = await generateAIResponse(userSpeech, callerNumber);
    console.log(`🤖 Ellysha: "${aiResponse}"`);

    // Track conversation
    if (activeCalls[callSid]) {
        activeCalls[callSid].conversation.push({
            user: userSpeech,
            bot: aiResponse
        });
    }

    const twiml = new twilio.twiml.VoiceResponse();

    // Speak AI response
    twiml.say({
        voice: 'Polly.Aditi',
        language: 'hi-IN'
    }, aiResponse);

    // Check if conversation should continue
    const shouldEnd = aiResponse.toLowerCase().includes('inform kar deti') ||
                     aiResponse.toLowerCase().includes('bata deti hoon') ||
                     userSpeech.toLowerCase().includes('thank') ||
                     userSpeech.toLowerCase().includes('bye');

    if (!shouldEnd && userSpeech.length > 5) {
        // Continue conversation
        twiml.gather({
            input: 'speech',
            action: '/process-speech',
            method: 'POST',
            speechTimeout: 'auto',
            language: 'hi-IN'
        });
    } else {
        // End call gracefully
        twiml.say({
            voice: 'Polly.Aditi',
            language: 'hi-IN'
        }, 'Shukriya! Shariq sir jaldi aapse contact karenge. Have a good day!');

        twiml.pause({ length: 2 });
        twiml.hangup();
    }

    res.type('text/xml');
    res.send(twiml.toString());
});

// Call status callback
app.post('/call-status', async (req, res) => {
    const callSid = req.body.CallSid;
    const callStatus = req.body.CallStatus;
    const duration = req.body.CallDuration || 0;
    const callerNumber = req.body.From;

    console.log(`📊 Call ${callStatus}, Duration: ${duration}s`);

    if (callStatus === 'completed' && activeCalls[callSid]) {
        const callData = activeCalls[callSid];
        await notifyOwner(callerNumber, callData.conversation, duration);
        delete activeCalls[callSid];
    }

    res.status(200).send('OK');
});

// ============ NOTIFICATIONS ============

async function notifyOwner(callerNumber, conversation, duration) {
    console.log('📱 Sending notification...');

    const message = `📞 *Call Handled by Ellysha*

👤 Caller: ${callerNumber}
⏱️ Duration: ${duration}s
🕐 Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}

💬 Conversation:
${conversation.map(c => `📞 ${c.user}\n🤖 ${c.bot}`).join('\n\n')}

✅ Call completed successfully`;

    // Send SMS notification
    try {
        if (process.env.OWNER_PHONE_NUMBER) {
            await client.messages.create({
                body: message.substring(0, 1500), // SMS limit
                from: process.env.TWILIO_PHONE_NUMBER,
                to: process.env.OWNER_PHONE_NUMBER
            });
            console.log('✅ SMS sent to owner');
        }
    } catch (err) {
        console.log('❌ SMS failed:', err.message);
    }

    // Optional: WhatsApp notification
    if (process.env.WHATSAPP_WEBHOOK_URL) {
        try {
            await axios.post(process.env.WHATSAPP_WEBHOOK_URL, {
                message,
                callerNumber,
                timestamp: new Date().toISOString()
            });
            console.log('✅ WhatsApp notification sent');
        } catch (err) {
            console.log('❌ WhatsApp notification failed:', err.message);
        }
    }
}

// ============ HEALTH CHECK ============

app.get('/', (req, res) => {
    res.json({
        status: '🟢 Online',
        bot: 'Ellysha Voice Assistant',
        timestamp: new Date().toISOString(),
        activeCalls: Object.keys(activeCalls).length
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
        console.log(`🚀 Ellysha Voice Bot running on port ${PORT}`);
        console.log(`📞 Webhook URL: http://localhost:${PORT}/voice`);
    });
}
