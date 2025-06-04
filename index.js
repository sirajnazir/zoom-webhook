require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const RecordingProcessor = require('./recording-processor');

const app = express();
app.use(express.json());

// Initialize the recording processor
const recordingProcessor = new RecordingProcessor();

app.post('/zoom-webhook', async (req, res) => {
  const event = req.body.event;
  const payload = req.body.payload;
  const download_token = req.body.download_token; // Extract download_token from webhook

  console.log('Webhook received:', {
    event: event,
    payload: {
      ...payload,
      object: payload?.object ? {
        ...payload.object,
        recording_files: payload.object.recording_files ? '[Array]' : undefined
      } : undefined
    },
    event_ts: req.body.event_ts,
    download_token: download_token ? '[TOKEN PRESENT]' : 'No token'
  });

  // Handle Zoom webhook validation
  if (event === 'endpoint.url_validation') {
    const secretToken = process.env.SECRET_TOKEN || process.env.WEBHOOK_SECRET;
    if (!secretToken) {
      console.error('SECRET_TOKEN is not set in environment variables');
      return res.status(500).json({ error: 'Server configuration error: SECRET_TOKEN missing' });
    }
    const plainToken = payload.plainToken;
    const hash = crypto.createHmac('sha256', secretToken)
      .update(plainToken)
      .digest('hex');
    console.log('Validation response:', { plainToken, encryptedToken: hash });
    return res.json({
      plainToken: plainToken,
      encryptedToken: hash
    });
  }

  // Handle recording completed event
  if (event === 'recording.completed') {
    console.log('Recording completed:', {
      topic: payload.object?.topic,
      id: payload.object?.id,
      uuid: payload.object?.uuid,
      host_email: payload.object?.host_email,
      recording_count: payload.object?.recording_count,
      has_download_token: !!download_token
    });
    
    // Process the recording asynchronously with download_token
    recordingProcessor.processWebhookPayload(payload, download_token)
      .then(result => {
        console.log('✅ Recording processed successfully:', result);
      })
      .catch(error => {
        console.error('❌ Error processing recording:', error.message);
        console.error('Stack:', error.stack);
      });
    
    // Respond to Zoom immediately (important!)
    return res.status(200).send('Webhook processed');
  }

  // Log other events for debugging
  if (event) {
    console.log(`Received event: ${event}`);
  }

  // Default response for other events
  res.status(200).send('Webhook processed');
});

// Add a health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'IL Zoom Webhook',
    timestamp: new Date().toISOString(),
    environment: {
      hasZoomCreds: !!(process.env.ZOOM_CLIENT_ID && process.env.ZOOM_CLIENT_SECRET),
      hasGoogleCreds: !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64,
      hasDriveFolderId: !!process.env.DRIVE_ROOT_FOLDER_ID,
      hasMappingsSheetId: !!process.env.MAPPINGS_SHEET_ID
    }
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'IL Zoom Webhook Service',
    status: 'running',
    endpoints: {
      webhook: '/zoom-webhook',
      health: '/health'
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`==> Your service is live 🎉`);
  console.log(`Server running on port ${PORT}`);
  console.log('Environment check:');
  console.log('- Zoom credentials:', !!(process.env.ZOOM_CLIENT_ID && process.env.ZOOM_CLIENT_SECRET) ? '✓' : '✗');
  console.log('- Google credentials:', !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 ? '✓' : '✗');
  console.log('- Drive folder ID:', !!process.env.DRIVE_ROOT_FOLDER_ID ? '✓' : '✗');
  console.log('- Mappings sheet ID:', !!process.env.MAPPINGS_SHEET_ID ? '✓' : '✗');
});