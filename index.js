const express = require('express');
const app = express();
app.use(express.json());
app.post('/zoom-webhook', (req, res) => {
  console.log('Webhook received:', req.body);
  res.status(200).send('Webhook processed');
});
app.listen(process.env.PORT || 3000, () => {
  console.log('Server running on port', process.env.PORT || 3000);
});
