// This is the webhook handler code that should be in your main server file
// Replace or update your existing webhook handler with this version

const RecordingProcessor = require('./recording-processor');
require('dotenv').config();
const axios = require('axios');
const { google } = require('googleapis');
const path = require('path');

// Initialize the processor
const processor = new RecordingProcessor();

// Handle SECRET_TOKEN for webhook secret
if (process.env.SECRET_TOKEN && !process.env.WEBHOOK_SECRET) {
    process.env.WEBHOOK_SECRET = process.env.SECRET_TOKEN;
}

// ADD THIS CODE BLOCK HERE - This decodes the key when the app starts
if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64) {
    const keyJson = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64, 'base64').toString();
    require('fs').writeFileSync('./service-account-key.json', keyJson);
    console.log('✓ Service account key decoded');
}

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

class RecordingProcessor {
    constructor() {
        // Zoom credentials
        this.zoomAccountId = process.env.ZOOM_ACCOUNT_ID;
        this.zoomClientId = process.env.ZOOM_CLIENT_ID;
        this.zoomClientSecret = process.env.ZOOM_CLIENT_SECRET;
        
        // Google credentials
        this.driveRootFolderId = process.env.DRIVE_ROOT_FOLDER_ID;
        this.mappingsSheetId = process.env.MAPPINGS_SHEET_ID;
        
        // Caches
        this.studentMappings = new Map();
        this.folderCache = new Map();
        this.tokenCache = { token: null, expires: 0 };
        
        // Known coach names from ConvertNames.py
        this.knownCoachNames = new Set([
            'noor', 'jenny', 'aditi', 'marissa', 'rishi', 'erin',
            'janice', 'summer', 'jamie', 'alice', 'alan', 'andrew', 'juli'
        ]);
        
        this.initialized = false;
    }

    async downloadAndStoreFile(file, folderId, downloadToken, fileType) {
        console.log(`  📥 Downloading ${fileType}...`);
        
        // Download with retries
        let stream;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                // First try with download token
                const response = await axios.get(file.download_url, {
                    headers: {
                        'Authorization': `Bearer ${downloadToken}`
                    },
                    responseType: 'stream',
                    timeout: 300000,
                    maxRedirects: 5
                });
                stream = response.data;
                break;
            } catch (error) {
                if (attempt === 3) {
                    // On last attempt, try with OAuth token
                    try {
                        const serverToken = await this.getZoomToken();
                        const response = await axios.get(file.download_url, {
                            headers: {
                                'Authorization': `Bearer ${serverToken}`
                            },
                            responseType: 'stream',
                            timeout: 300000,
                            maxRedirects: 5
                        });
                        stream = response.data;
                        break;
                    } catch (fallbackError) {
                        throw new Error(`Failed to download with both download token and OAuth token: ${fallbackError.message}`);
                    }
                }
                console.log(`  Retry ${attempt}/3 for ${fileType}`);
                await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
            }
        }
        
        // Determine file extension and MIME type
        let extension, mimeType;
        switch (fileType) {
            case 'MP4':
                extension = '.mp4';
                mimeType = 'video/mp4';
                break;
            case 'M4A':
                extension = '.m4a';
                mimeType = 'audio/mp4';
                break;
            case 'TRANSCRIPT':
            case 'VTT':
                extension = '.vtt';
                mimeType = 'text/vtt';
                break;
            case 'CHAT':
                extension = '.txt';
                mimeType = 'text/plain';
                break;
            case 'TIMELINE':
                extension = '.json';
                mimeType = 'application/json';
                break;
            default:
                console.log(`Skipping unknown file type: ${fileType}`);
                return null;
        }
        
        const tempFileName = `${fileType}${extension}`;
        
        // Upload to temp folder
        console.log(`  📤 Uploading ${tempFileName} to temp folder...`);
        const upload = await this.uploadToDrive(stream, tempFileName, folderId, mimeType);
        
        console.log(`  ✓ ${tempFileName} uploaded to temp folder`);
        return upload;
    }

    // ... [Keep all other existing methods] ...

    async processWebhookPayload(payload) {
        await this.initialize();
        
        const recording = payload.object || payload;
        const downloadToken = payload.download_token;
        
        if (!downloadToken) {
            console.error('No download token provided in webhook payload');
            return {
                success: false,
                reason: 'missing_download_token'
            };
        }

        console.log(`\n📹 Processing recording: ${recording.topic}`);
        
        // ... [Rest of the processWebhookPayload method remains the same] ...
    }
}

// Export for use in other files
module.exports = RecordingProcessor;

// If run directly, process from command line
if (require.main === module) {
    const processor = new RecordingProcessor();
    
    // Example: node recording-processor.js process-webhook '{"object": {...}}'
    if (process.argv[2] === 'process-webhook' && process.argv[3]) {
        const payload = JSON.parse(process.argv[3]);
        processor.processWebhookPayload(payload)
            .then(result => {
                console.log('Result:', result);
                process.exit(0);
            })
            .catch(error => {
                console.error('Error:', error);
                process.exit(1);
            });
    } else {
        console.log('Usage: node recording-processor.js process-webhook \'{"object": {...}}\'');
    }
}