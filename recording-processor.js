// This is the webhook handler code that should be in your main server file
// Replace or update your existing webhook handler with this version

const RecordingProcessor = require('./recording-processor');

// Initialize the processor
const processor = new RecordingProcessor();

// Webhook endpoint handler
app.post('/webhook', async (req, res) => {
    try {
        const { event, payload, download_token } = req.body;
        
        console.log(`Webhook received: ${JSON.stringify({
            event,
            payload: {
                ...payload,
                object: {
                    ...payload.object,
                    recording_files: payload.object?.recording_files ? '[Array]' : undefined
                }
            },
            event_ts: req.body.event_ts,
            download_token: download_token ? '[REDACTED]' : undefined
        }, null, 2)}`);
        
        // Handle different webhook events
        switch (event) {
            case 'recording.started':
                console.log('Recording started:', payload.object);
                res.status(200).json({ message: 'Recording started acknowledged' });
                break;
                
            case 'recording.stopped':
                console.log('Recording stopped:', payload.object);
                res.status(200).json({ message: 'Recording stopped acknowledged' });
                break;
                
            case 'recording.completed':
                console.log('Recording completed:', payload.object);
                
                // Process the recording with the download token
                processor.processWebhookPayload(payload, download_token)
                    .then(result => {
                        console.log('✅ Recording processed successfully:', result);
                    })
                    .catch(error => {
                        console.error('❌ Error processing recording:', error);
                    });
                
                // Respond immediately to Zoom
                res.status(200).json({ message: 'Recording completed acknowledged' });
                break;
                
            default:
                console.log(`Unhandled event type: ${event}`);
                res.status(200).json({ message: `Event ${event} acknowledged` });
        }
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Alternative: If you need to handle webhook validation
app.post('/webhook', async (req, res) => {
    // Zoom webhook validation
    if (req.body.event === 'endpoint.url_validation') {
        const hashForValidate = crypto
            .createHmac('sha256', process.env.WEBHOOK_SECRET || process.env.SECRET_TOKEN)
            .update(req.body.payload.plainToken)
            .digest('hex');
        
        res.status(200).json({
            plainToken: req.body.payload.plainToken,
            encryptedToken: hashForValidate
        });
        return;
    }
    
    // Rest of the webhook handling code from above...
});