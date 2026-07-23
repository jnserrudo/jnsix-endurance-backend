const prisma = require('../lib/prisma');

const getMyRedemptions = async (req, res) => {
  try {
    const status = req.query.status;

    const redemptions = await prisma.redemption.findMany({
      where: {
        userId: req.user.id,
        ...(status ? { status } : {})
      },
      include: {
        reward: {
          include: {
            business: { select: { id: true, name: true, logoUrl: true, address: true, instagramUrl: true } }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(redemptions);
  } catch (error) {
    console.error('[ERROR] getMyRedemptions:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const getRedemptionById = async (req, res) => {
  try {
    const redemption = await prisma.redemption.findFirst({
      where: { id: req.params.id, userId: req.user.id },
      include: {
        reward: {
          include: {
            business: { select: { id: true, name: true, logoUrl: true, address: true, instagramUrl: true, websiteUrl: true } }
          }
        }
      }
    });

    if (!redemption) return res.status(404).json({ error: 'Redemption not found' });

    res.json({
      ...redemption,
      qrPayload: {
        type: 'jnsix_redemption',
        code: redemption.code,
        redemptionId: redemption.id
      }
    });
  } catch (error) {
    console.error('[ERROR] getRedemptionById:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

module.exports = {
  getMyRedemptions,
  getRedemptionById
};
