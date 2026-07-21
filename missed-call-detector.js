const axios = require('axios');
const { exec } = require('child_process');
require('dotenv').config();

// Configuration
const SERVER_URL = process.env.SERVER_URL || 'https://shrq-agent.vercel.app';
const OWNER_NUMBER = process.env.OWNER_NUMBER; // Your personal number
const CHECK_INTERVAL = 10000; // Check every 10 seconds
const COOLDOWN_TIME = 5 * 60 * 1000; // 5 minutes cooldown between same number

// Track processed calls
let lastProcessedTime = Date.now();
let processedCalls = new Set();

console.log('🚀 Missed Call Detector Started!');
console.log(`📱 Monitoring calls for: ${OWNER_NUMBER}`);
console.log(`🌐 Server URL: ${SERVER_URL}`);
console.log('──────────────────────────────────────');

// Main monitoring function
function monitorMissedCalls() {
    setInterval(async () => {
        try {
            // Get recent call log using Termux API
            exec('termux-telephony-calllog -l 5', async (err, stdout, stderr) => {
                if (err) {
                    console.log('⚠️ Call log access error:', err.message);
                    return;
                }

                try {
                    const calls = JSON.parse(stdout);

                    for (const call of calls) {
                        await processCall(call);
                    }
                } catch (parseErr) {
                    console.log('📞 No new calls or parse error');
                }
            });
        } catch (err) {
            console.log('❌ Monitor error:', err.message);
        }
    }, CHECK_INTERVAL);
}

// Process individual call
async function processCall(call) {
    try {
        const {
            number: callerNumber,
            type: callType,
            date: callTime,
            duration
        } = call;

        // Only process INCOMING calls
        if (callType !== 'INCOMING') {
            return;
        }

        // Only process MISSED calls (duration = 0)
        if (duration > 0) {
            return;
        }

        // Only process NEW calls (after our start time)
        if (callTime < lastProcessedTime) {
            return;
        }

        // Skip if already processed
        const callKey = `${callerNumber}_${callTime}`;
        if (processedCalls.has(callKey)) {
            return;
        }

        // Skip invalid numbers
        if (!callerNumber || callerNumber.length < 10) {
            return;
        }

        // Skip if same number called recently (cooldown)
        const recentCall = Array.from(processedCalls).find(key =>
            key.startsWith(callerNumber) &&
            (Date.now() - parseInt(key.split('_')[1])) < COOLDOWN_TIME
        );

        if (recentCall) {
            console.log(`⏸️ Cooldown active for ${callerNumber}`);
            return;
        }

        console.log(`\n📞 NEW MISSED CALL DETECTED!`);
        console.log(`   From: ${callerNumber}`);
        console.log(`   Time: ${new Date(callTime).toLocaleString('en-IN')}`);

        // Mark as processed
        processedCalls.add(callKey);

        // Clean old entries (keep only last 50)
        if (processedCalls.size > 50) {
            const oldEntries = Array.from(processedCalls).slice(0, 10);
            oldEntries.forEach(entry => processedCalls.delete(entry));
        }

        // Send SMS first
        await sendImmediateSMS(callerNumber);

        // Schedule delayed callback (60 seconds)
        console.log(`⏰ Callback scheduled in 60 seconds...`);
        setTimeout(async () => {
            // Check if user called again in meantime
            const calledAgain = await checkRecentCalls(callerNumber, callTime);

            if (calledAgain) {
                console.log(`⏸️ User called again, skipping callback for ${callerNumber}`);
                return;
            }

            // Trigger callback
            await triggerCallback(callerNumber, callTime);
        }, 60000); // 60 seconds delay

    } catch (err) {
        console.log('❌ Process call error:', err.message);
    }
}

// Send immediate SMS notification
async function sendImmediateSMS(callerNumber) {
    try {
        console.log(`📱 Sending SMS to: ${callerNumber}`);

        const message = `Hello! Main Ellysha, Shariq sir ki AI assistant. Wo abhi busy hain. Aapko +1 605 574 6387 se 1 minute mein call aayega. Please pick karein 🙂`;

        exec(`termux-sms-send -n "${callerNumber}" "${message}"`, (err) => {
            if (err) {
                console.log(`⚠️ SMS failed: ${err.message}`);
            } else {
                console.log(`✅ SMS sent to ${callerNumber}`);
            }
        });

    } catch (err) {
        console.log(`❌ SMS error: ${err.message}`);
    }
}

// Check if user called again after missed call
async function checkRecentCalls(callerNumber, originalCallTime) {
    return new Promise((resolve) => {
        exec('termux-telephony-calllog -l 5', (err, stdout) => {
            if (err) {
                resolve(false);
                return;
            }

            try {
                const calls = JSON.parse(stdout);

                // Check if this number called again after original missed call
                const recentCall = calls.find(call =>
                    call.number === callerNumber &&
                    call.type === 'INCOMING' &&
                    call.date > originalCallTime
                );

                resolve(!!recentCall);
            } catch (parseErr) {
                resolve(false);
            }
        });
    });
}

// Trigger callback via server API
async function triggerCallback(callerNumber, missedTime) {
    try {
        console.log(`🤖 Triggering callback for: ${callerNumber}`);

        const response = await axios.post(`${SERVER_URL}/missed-call`, {
            callerNumber,
            missedTime,
            ownerNumber: OWNER_NUMBER
        }, {
            timeout: 10000,
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.MISSED_CALL_SECRET || ''
            }
        });

        if (response.data.success) {
            console.log(`✅ Callback initiated successfully!`);

            // Show notification
            exec(`termux-notification --title "📞 Callback Initiated" --content "Calling back: ${callerNumber}"`);
        } else {
            console.log(`⚠️ Callback skipped: ${response.data.message}`);
        }

    } catch (err) {
        console.log(`❌ Callback trigger failed: ${err.message}`);

        // Show error notification
        exec(`termux-notification --title "❌ Callback Failed" --content "Error calling: ${callerNumber}"`);
    }
}

// Start monitoring
monitorMissedCalls();

// Keep alive message
setInterval(() => {
    const uptime = Math.floor(process.uptime() / 60);
    console.log(`💓 Alive for ${uptime} minutes | Processed: ${processedCalls.size} calls`);
}, 2 * 60 * 1000); // Every 2 minutes

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n👋 Missed Call Detector stopping...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n👋 Missed Call Detector terminated');
    process.exit(0);
});