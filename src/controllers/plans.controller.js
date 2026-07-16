const prisma = require('../lib/prisma');

const listPublicPlans = async (req, res) => {
  try {
    const plans = await prisma.plan.findMany({
      where: { isActive: true },
      include: {
        features: true
      },
      orderBy: { monthlyPrice: 'asc' }
    });
    res.json(plans);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  listPublicPlans
};
