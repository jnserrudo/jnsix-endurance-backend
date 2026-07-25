const prisma = require('../lib/prisma');
const { notifyAdmins } = require('../services/notifications.service');

const VALID_TARGET_TYPES = ['POST', 'COMMENT', 'STORY', 'USER', 'GROUP', 'COMMUNITY', 'ACTIVITY'];
const VALID_STATUSES = ['PENDING', 'REVIEWED', 'DISMISSED', 'ACTIONED'];

/** Crea un reporte de contenido/usuario. */
const createReport = async (req, res) => {
  try {
    const reporterId = req.user.id;
    const { targetType, targetId, reason } = req.body;

    if (!targetType || !targetId || !reason) {
      return res.status(400).json({ error: 'targetType, targetId y reason son requeridos' });
    }
    const type = String(targetType).toUpperCase();
    if (!VALID_TARGET_TYPES.includes(type)) {
      return res.status(400).json({ error: `targetType inválido. Debe ser uno de: ${VALID_TARGET_TYPES.join(', ')}` });
    }

    // Evitar duplicados del mismo reporte pendiente por el mismo usuario
    const existing = await prisma.contentReport.findFirst({
      where: { reporterId, targetType: type, targetId, status: 'PENDING' }
    });
    if (existing) {
      return res.status(200).json({ ...existing, duplicated: true });
    }

    const report = await prisma.contentReport.create({
      data: { reporterId, targetType: type, targetId, reason: String(reason).slice(0, 1000) }
    });

    try {
      await notifyAdmins('SYSTEM', {
        title: 'Nuevo reporte de contenido',
        body: `Se reportó un ${type.toLowerCase()} por: ${String(reason).slice(0, 80)}`,
        payload: { reportId: report.id, targetType: type, targetId },
        dedupeKey: `report:${report.id}`
      });
    } catch (e) {
      console.warn('[reports] notifyAdmins failed:', e.message);
    }

    res.status(201).json(report);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/** [Admin] Lista reportes, opcionalmente filtrados por estado. */
const listReports = async (req, res) => {
  try {
    const { status } = req.query;
    const where = {};
    if (status && VALID_STATUSES.includes(String(status).toUpperCase())) {
      where.status = String(status).toUpperCase();
    }

    const reports = await prisma.contentReport.findMany({
      where,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      include: {
        reporter: { select: { id: true, username: true, email: true, avatarUrl: true } }
      }
    });

    res.json(reports);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

/** [Admin] Actualiza el estado de un reporte. */
const updateReport = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status || !VALID_STATUSES.includes(String(status).toUpperCase())) {
      return res.status(400).json({ error: `status inválido. Debe ser uno de: ${VALID_STATUSES.join(', ')}` });
    }

    const existing = await prisma.contentReport.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Reporte no encontrado' });

    const report = await prisma.contentReport.update({
      where: { id },
      data: {
        status: String(status).toUpperCase(),
        reviewedAt: new Date()
      }
    });

    res.json(report);
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

module.exports = { createReport, listReports, updateReport };
