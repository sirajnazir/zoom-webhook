const express = require('express');
const app = express();

app.use(express.json());

app.post('/zoom-webhook', (req, res) => {
  console.log('Webhook received:', req.body);
  if (req.body.event === 'endpoint.url_validation') {
    // Handle Zoom validation request
    const crypto = require('crypto');
    const hash = crypto.createHmac('sha256', 'YOUR_SECRET_TOKEN')
      .update(req.body.payload.plainToken)
      .digest('hex');
    res.json({ plainToken: req.body.payload.plainToken, encryptedToken: hash });
  } else {
    // Handle recording completed event
    res.status(200).send('Webhook received');
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
