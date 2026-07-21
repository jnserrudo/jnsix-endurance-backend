const prisma = require('../lib/prisma');

const listPublicPlans = async (req, res) => {
  try {
    const plans = await prisma.plan.findMany({
      where: { isActive: true },
      include: {
        features: true
      },
      orderBy: { price: 'asc' }
    });

    const mapped = plans.map((plan) => ({
      ...plan,
      monthlyPrice: plan.price,
      features: (plan.features || []).map((f) => ({
        ...f,
        name: f.featureKey
      }))
    }));

    res.json(mapped);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  listPublicPlans
};
