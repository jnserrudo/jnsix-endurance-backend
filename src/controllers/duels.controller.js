const gamificationService = require('../services/gamification.service');

const createDuel = async (req, res) => {
  try {
    const { opponentId, metric } = req.body;
    if (!opponentId) {
      return res.status(400).json({ error: 'opponentId es requerido' });
    }
    const duel = await gamificationService.createDuel(req.user.id, opponentId, metric);
    res.status(201).json(duel);
  } catch (error) {
    console.error('[CREATE DUEL ERROR]', error);
    res.status(error.status || 500).json({ error: error.message || 'Error al crear duelo' });
  }
};

const patchDuel = async (req, res) => {
  try {
    const accept = req.body.accept === true || req.body.accept === 'true' || req.body.accept === 1;
    const decline = req.body.accept === false || req.body.decline === true;
    if (!accept && !decline && req.body.accept === undefined) {
      return res.status(400).json({ error: 'Enviá { accept: true|false }' });
    }
    const duel = await gamificationService.acceptOrDeclineDuel(
      req.params.id,
      req.user.id,
      accept && !decline
    );
    res.json(duel);
  } catch (error) {
    console.error('[PATCH DUEL ERROR]', error);
    res.status(error.status || 500).json({ error: error.message || 'Error al actualizar duelo' });
  }
};

const listMine = async (req, res) => {
  try {
    const duels = await gamificationService.listMyDuels(req.user.id);
    res.json(duels);
  } catch (error) {
    console.error('[LIST DUELS ERROR]', error);
    res.status(500).json({ error: 'Error al listar duelos' });
  }
};

module.exports = { createDuel, patchDuel, listMine };
