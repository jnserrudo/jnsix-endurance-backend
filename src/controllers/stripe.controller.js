const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_dummy');
const prisma = require('../lib/prisma');

const createCheckoutSession = async (req, res) => {
  try {
    const { planId } = req.body;
    const userId = req.user.id;

    const plan = await prisma.plan.findUnique({ where: { id: planId } });
    if (!plan || !plan.stripePriceId) {
      return res.status(404).json({ error: 'Plan not found or Stripe Price ID missing' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });

    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { userId: user.id }
      });
      customerId = customer.id;
      await prisma.user.update({
        where: { id: userId },
        data: { stripeCustomerId: customerId }
      });
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [
        {
          price: plan.stripePriceId,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: `${process.env.FRONTEND_URL || 'exp://localhost:19000'}/--/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'exp://localhost:19000'}/--/payment-cancelled`,
      metadata: {
        userId: user.id,
        planId: plan.id
      }
    });

    res.json({ sessionId: session.id, url: session.url });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const createCustomerPortal = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user.stripeCustomerId) {
      return res.status(400).json({ error: 'No active Stripe customer found' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${process.env.FRONTEND_URL || 'exp://localhost:19000'}/--/settings/billing`,
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const handleStripeWebhook = async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    // Requires express.raw() in the router!
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const { userId, planId } = session.metadata;
        const subscriptionId = session.subscription;

        // Cancel old subscriptions
        await prisma.subscription.updateMany({
          where: { userId, isActive: true },
          data: { isActive: false, status: 'CANCELED', endDate: new Date() }
        });

        // Fetch plan interval to calculate endDate
        const plan = await prisma.plan.findUnique({ where: { id: planId } });
        let endDate = new Date();
        if (plan.interval === 'MONTHLY') endDate.setMonth(endDate.getMonth() + 1);
        if (plan.interval === 'YEARLY') endDate.setFullYear(endDate.getFullYear() + 1);

        await prisma.subscription.create({
          data: {
            userId,
            planId,
            status: 'ACTIVE',
            stripeSubscriptionId: subscriptionId,
            startDate: new Date(),
            endDate,
            isActive: true
          }
        });

        await prisma.user.update({
          where: { id: userId },
          data: { subscriptionTier: plan.name.toUpperCase() }
        });

        break;
      }
      
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const subscriptionId = invoice.subscription;
        if (subscriptionId) {
          const sub = await prisma.subscription.findUnique({ where: { stripeSubscriptionId: subscriptionId }, include: { plan: true } });
          if (sub) {
            let endDate = new Date();
            if (sub.plan.interval === 'MONTHLY') endDate.setMonth(endDate.getMonth() + 1);
            if (sub.plan.interval === 'YEARLY') endDate.setFullYear(endDate.getFullYear() + 1);

            await prisma.subscription.update({
              where: { id: sub.id },
              data: { status: 'ACTIVE', isActive: true, endDate }
            });
          }
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const sub = await prisma.subscription.findUnique({ where: { stripeSubscriptionId: subscription.id } });
        if (sub) {
          await prisma.subscription.update({
            where: { id: sub.id },
            data: { status: 'CANCELED', isActive: false, endDate: new Date() }
          });
          
          await prisma.user.update({
            where: { id: sub.userId },
            data: { subscriptionTier: 'FREE' }
          });
        }
        break;
      }

      default:
        console.log(`Unhandled event type ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Stripe webhook error:', error);
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

module.exports = {
  createCheckoutSession,
  createCustomerPortal,
  handleStripeWebhook
};
