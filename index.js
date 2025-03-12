const express = require('express');
const crypto = require('crypto');
const app = express();
app.use(express.json());

app.post('/zoom-webhook', (req, res) => {
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
    const recordingFiles = payload.object.recording_files;
    recordingFiles.forEach(file => {
      console.log('Recording file URL:', file.download_url);
    });
    return res.status(200).send('Webhook processed');
  }

  // Default response for other events
  res.status(200).send('Webhook processed');
});

app.listen(process.env.PORT || 3000, () => {
  console.log('Server running on port', process.env.PORT || 3000);
});
