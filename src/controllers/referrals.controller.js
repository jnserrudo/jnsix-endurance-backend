const { getMyReferralStats } = require('../services/referral.service');

const getMyReferrals = async (req, res) => {
  try {
    res.json(await getMyReferralStats(req.user.id));
  } catch (error) {
    console.error('[REFERRALS] Failed to load referral stats:', error.message);
    res.status(500).json({ error: 'No pudimos cargar tus referidos.' });
  }
};

module.exports = { getMyReferrals };
