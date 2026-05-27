const verifyStravaWebhook = async (req, res) => {
  try {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
      if (mode === 'subscribe' && token === process.env.STRAVA_VERIFY_TOKEN) {
        console.log('Webhook verified');
        res.json({ 'hub.challenge': challenge });
      } else {
        res.sendStatus(403);
      }
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const handleStravaWebhook = async (req, res) => {
  try {
    console.log('Strava webhook event received:', req.body);
    res.status(200).json({ message: 'Event received' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  verifyStravaWebhook,
  handleStravaWebhook
};
