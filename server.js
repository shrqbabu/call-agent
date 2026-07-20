require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Twilio client
const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

// Call state tracking
const activeCalls = {};

// ============ AI FUNCTIONS ============

// Generate AI response
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

    console.log(`\n📞 Incoming call from: ${callerNumber}`);
    console.log(`   Call SID: ${callSid}`);

    // Track this call
    activeCalls[callSid] = {
        callerNumber,
        startTime: Date.now(),
        conversation: []
    };

    const twiml = new twilio.twiml.VoiceResponse();

    // Welcome message
    twiml.say({
        voice: 'Polly.Aditi',
        language: 'hi-IN'
    }, 'Hello! Main Ellysha, Shariq sir ki assistant. Wo abhi busy hain. Aapka kaam bataiye, main unhe inform kar dungi.');

    // Pause for user to speak
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

    console.log(`\n🎤 Caller said: "${userSpeech}"`);

    // Get AI response
    const aiResponse = await generateAIResponse(userSpeech, callerNumber);
    console.log(`🤖 Ellysha: "${aiResponse}"`);

    // Track conversation
    if (activeCalls[callSid]) {
        activeCalls[callSid].conversation.push(
            { user: userSpeech, bot: aiResponse }
        );
    }

    const twiml = new twilio.twiml.VoiceResponse();

    // Speak AI response
    twiml.say({
        voice: 'Polly.Aditi',
        language: 'hi-IN'
    }, aiResponse);

    // Check if conversation should continue
    const shouldContinue = !aiResponse.toLowerCase().includes('main sir ko bata deti') &&
                          !aiResponse.toLowerCase().includes('inform kar deti');

    if (shouldContinue && userSpeech.length > 5) {
        // Listen again
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

        // Hang up after 2 seconds
        twiml.pause({ length: 2 });
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

    console.log(`\n📊 Call Status: ${callStatus}`);
    console.log(`   Duration: ${duration} seconds`);

    // If call ended, send notification
    if (callStatus === 'completed' && activeCalls[callSid]) {
        const callData = activeCalls[callSid];

        // Send notification to owner
        await notifyOwner(callerNumber, callData.conversation, duration);

        // Clean up
        delete activeCalls[callSid];
    }

    res.status(200).send('OK');
});

// ============ NOTIFICATIONS ============

// Notify owner via WhatsApp
async function notifyOwner(callerNumber, conversation, duration) {
    console.log('\n📱 Sending notification to owner...');

    const message = `📞 *Missed Call Handled*

👤 Caller: ${callerNumber}
⏱️ Duration: ${duration}s

💬 Conversation:
${conversation.map(c => `Caller: ${c.user}\nEllysha: ${c.bot}`).join('\n\n')}

✅ Call handled by Ellysha`;

    // Option 1: WhatsApp API (if configured)
    if (process.env.WHATSAPP_BOT_URL) {
        try {
            await axios.post(`${process.env.WHATSAPP_BOT_URL}/notify`, {
                message,
                callerNumber
            });
            console.log('✅ WhatsApp notification sent');
        } catch (err) {
            console.log('❌ WhatsApp notification failed:', err.message);
        }
    }

    // Option 2: SMS via Twilio
    try {
        await client.messages.create({
            body: message.substring(0, 1600), // SMS limit
            from: process.env.TWILIO_PHONE_NUMBER,
            to: process.env.OWNER_PHONE_NUMBER
        });
        console.log('✅ SMS notification sent');
    } catch (err) {
        console.log('❌ SMS notification failed:', err.message);
    }
}

// ============ HEALTH CHECK ============

app.get('/', (req, res) => {
    res.json({
        status: 'online',
        bot: 'Ellysha Voice Assistant',
        activeCalls: Object.keys(activeCalls).length
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// ============ START SERVER ============

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('\n🚀 Ellysha Voice Bot is running!');
    console.log(`📞 Server: http://localhost:${PORT}`);
    console.log(`🌐 Public URL needed for Twilio webhook`);
    console.log('\n📱 Setup Instructions:');
    console.log('1. Deploy this server (Render.com / AWS EC2)');
    console.log('2. Update SERVER_URL in .env');
    console.log('3. Configure Twilio webhook: https://your-url/voice');
    console.log('4. Setup call forwarding on your SIM');
    console.log('');
});
