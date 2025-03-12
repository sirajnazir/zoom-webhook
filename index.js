const express = require('express');
const app = express();
app.use(express.json());

app.post('/zoom-webhook', (req, res) => {
  const event = req.body.event;
  const payload = req.body.payload;

  // Handle Zoom webhook validation
  if (event === 'endpoint.url_validation') {
    const crypto = require('crypto');
    const secretToken = process.env.SECRET_TOKEN; // Set in Render environment variables
    const plainToken = req.body.payload.plainToken;
    const hash = crypto.createHmac('sha256', secretToken)
      .update(plainToken)
      .digest('hex');
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
      // Add logic here to process the recording (e.g., download, store, notify)
    });
    return res.status(200).send('Webhook processed');
  }

  // Default response for other events (e.g., your test event)
  res.status(200).send('Webhook processed');
});

app.listen(process.env.PORT || 3000, () => {
  console.log('Server running on port', process.env.PORT || 3000);
});
