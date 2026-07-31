const scoringService = require('../services/scoring.service');
const scoringReferenceService = require('../services/scoringReference.service');

const getMySummary = async (req, res) => {
  try {
    const summary = await scoringService.getPointsSummary(req.user.id);
    res.json(summary);
  } catch (error) {
    console.error('[ERROR] getMySummary:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const getMyHistory = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const type = req.query.type || 'all';

    const history = await scoringService.getPointsHistory(req.user.id, { page, limit, type });
    res.json({ history, page, limit });
  } catch (error) {
    console.error('[ERROR] getMyHistory:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const getMySuggestions = async (req, res) => {
  try {
    const suggestions = await scoringService.getRewardSuggestions(req.user.id);
    res.json(suggestions);
  } catch (error) {
    console.error('[ERROR] getMySuggestions:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/** Guía de precios en puntos para los negocios. Derivada de las reglas vigentes. */
const getReference = async (req, res) => {
  try {
    const reference = await scoringReferenceService.getReference({
      userId: req.user.id,
      businessId: req.query.businessId || null,
    });
    res.json(reference);
  } catch (error) {
    console.error('[ERROR] getReference:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

module.exports = {
  getMySummary,
  getMyHistory,
  getMySuggestions,
  getReference
};
