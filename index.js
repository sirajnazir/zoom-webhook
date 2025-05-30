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

  console.log('Webhook received:', req.body); // Log all incoming requests

  // Handle Zoom webhook validation
  if (event === 'endpoint.url_validation') {
    const secretToken = process.env.SECRET_TOKEN;
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
    console.log('Recording completed:', payload);
    
    // Process the recording asynchronously
    recordingProcessor.processWebhookPayload(payload)
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

  // Default response for other events
  res.status(200).send('Webhook processed');
});

// Add a health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'IL Zoom Webhook',
    timestamp: new Date().toISOString()
  });
});

app.listen(process.env.PORT || 3000, () => {
  console.log('Server running on port', process.env.PORT || 3000);
});