const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { awardPoints } = require('./scoring.service');
const scoringConfig = require('./scoringConfig.service');

// Solo afecta a los códigos nuevos: los `JNSIX-XXXX` ya emitidos se siguen
// resolviendo porque la validación busca el código en la base, no por prefijo.
const REFERRAL_CODE_PREFIX = 'MERYT';
const MONTHLY_SUCCESS_CAP = 10;

class ReferralValidationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ReferralValidationError';
    this.code = code;
  }
}

const normalizeReferralCode = (code) =>
  typeof code === 'string' ? code.trim().toUpperCase() : '';

async function generateReferralCode(client = prisma) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const suffix = crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 4);
    const referralCode = `${REFERRAL_CODE_PREFIX}-${suffix}`;
    const existing = await client.user.findUnique({
      where: { referralCode },
      select: { id: true },
    });
    if (!existing) return referralCode;
  }
  throw new Error('Could not generate a unique referral code.');
}

async function ensureUserReferralCode(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { referralCode: true },
  });
  if (!user) throw new Error('User not found.');
  if (user.referralCode) return user.referralCode;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const referralCode = await generateReferralCode();
    try {
      const updated = await prisma.user.update({
        where: { id: userId },
        data: { referralCode },
        select: { referralCode: true },
      });
      return updated.referralCode;
    } catch (error) {
      if (error?.code !== 'P2002') throw error;
    }
  }
  throw new Error('Could not assign a unique referral code.');
}

async function attachReferralOnRegister({ inviteeId, referralCode, client = prisma }) {
  const code = normalizeReferralCode(referralCode);
  if (!code) return null;

  const inviter = await client.user.findUnique({
    where: { referralCode: code },
    select: { id: true },
  });
  if (!inviter) {
    throw new ReferralValidationError('El código de referido no es válido.', 'INVALID_REFERRAL_CODE');
  }
  if (inviter.id === inviteeId) {
    throw new ReferralValidationError('No podés usar tu propio código de referido.', 'SELF_REFERRAL');
  }

  const invitee = await client.user.findUnique({
    where: { id: inviteeId },
    select: { referredByUserId: true },
  });
  if (!invitee) throw new Error('Invitee not found.');
  if (invitee.referredByUserId) {
    throw new ReferralValidationError('Esta cuenta ya tiene un referido asociado.', 'REFERRAL_ALREADY_ATTACHED');
  }

  await client.user.update({
    where: { id: inviteeId },
    data: { referredByUserId: inviter.id },
  });
  return client.referral.create({
    data: { inviterId: inviter.id, inviteeId },
  });
}

async function maybeRewardOnFirstActivity(userId, activityId) {
  const referral = await prisma.referral.findUnique({
    where: { inviteeId: userId },
    select: { id: true, inviterId: true, status: true },
  });
  if (!referral || referral.status !== 'pending') return { rewarded: false, reason: 'no_pending_referral' };

  const firstActivity = await prisma.activity.findFirst({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!firstActivity || firstActivity.id !== activityId) {
    return { rewarded: false, reason: 'not_first_activity' };
  }

  const rewardDecision = await prisma.$transaction(async (tx) => {
    // Serialize qualification decisions per inviter so concurrent invitees
    // cannot jointly exceed the monthly cap.
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${referral.inviterId} FOR UPDATE`;
    const pendingReferral = await tx.referral.findUnique({
      where: { inviteeId: userId },
      select: { id: true, status: true },
    });
    if (!pendingReferral || pendingReferral.status !== 'pending') {
      return { reward: false, reason: 'already_processed' };
    }

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const rewardedThisMonth = await tx.referral.count({
      where: {
        inviterId: referral.inviterId,
        status: 'rewarded',
        rewardedAt: { gte: monthStart },
      },
    });
    if (rewardedThisMonth >= MONTHLY_SUCCESS_CAP) {
      await tx.referral.update({
        where: { id: pendingReferral.id },
        data: { status: 'rejected' },
      });
      return { reward: false, reason: 'monthly_cap_reached' };
    }

    await tx.referral.update({
      where: { id: pendingReferral.id },
      data: {
        status: 'rewarded',
        qualifyingActivityId: activityId,
        rewardedAt: new Date(),
      },
    });
    return { reward: true };
  });
  if (!rewardDecision.reward) return { rewarded: false, reason: rewardDecision.reason };

  const [inviterPoints, inviteePoints] = await Promise.all([
    scoringConfig.getValue('referral.inviter_points'),
    scoringConfig.getValue('referral.invitee_points'),
  ]).then((values) => values.map((v) => Math.round(v)));

  await Promise.all([
    awardPoints(referral.inviterId, {
      points: inviterPoints,
      reason: 'referral_invite_success',
      source: 'REFERRAL',
    }),
    awardPoints(userId, {
      points: inviteePoints,
      reason: 'referral_welcome_bonus',
      source: 'REFERRAL',
    }),
  ]);
  return { rewarded: true, inviterPoints, inviteePoints };
}

async function getMyReferralStats(userId) {
  const referralCode = await ensureUserReferralCode(userId);
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const [pending, completed, rejected, successfulThisMonth] = await Promise.all([
    prisma.referral.count({ where: { inviterId: userId, status: 'pending' } }),
    prisma.referral.count({ where: { inviterId: userId, status: 'rewarded' } }),
    prisma.referral.count({ where: { inviterId: userId, status: 'rejected' } }),
    prisma.referral.count({
      where: { inviterId: userId, status: 'rewarded', rewardedAt: { gte: monthStart } },
    }),
  ]);
  return {
    referralCode,
    pending,
    completed,
    rejected,
    successfulThisMonth,
    remaining: Math.max(0, MONTHLY_SUCCESS_CAP - successfulThisMonth),
    monthlyCap: MONTHLY_SUCCESS_CAP,
  };
}

module.exports = {
  ReferralValidationError,
  generateReferralCode,
  ensureUserReferralCode,
  attachReferralOnRegister,
  maybeRewardOnFirstActivity,
  getMyReferralStats,
};
