const prisma = require('../lib/prisma');
const storage = require('../services/storage.service');
const { notify } = require('../services/notifications.service');
const discountService = require('../services/discount.service');

const requestManualPayment = async (req, res) => {
  try {
    const { planName, amount, discountCode } = req.body;
    const file = req.file;

    if (!planName || !amount || !file) {
      return res.status(400).json({ error: 'Faltan datos obligatorios (planName, amount, receiptImage)' });
    }

    // El código se valida antes de subir el comprobante: si está vencido no
    // tiene sentido guardar el archivo ni avisarle a los admins.
    let discount = null;
    let finalAmount = parseFloat(amount);
    if (discountCode) {
      try {
        discount = await discountService.validateCode(discountCode, req.user.id);
        finalAmount = discountService.applyToAmount(discount, finalAmount).finalAmount;
      } catch (error) {
        if (error instanceof discountService.DiscountError) {
          return res.status(error.status).json({ error: error.message });
        }
        throw error;
      }
    }

    // Subir imagen
    const uploadedFile = await storage.uploadFile(file, req.user.id);

    // Crear transacción PENDING
    const transaction = await prisma.transaction.create({
      data: {
        userId: req.user.id,
        planName,
        amount: finalAmount,
        currency: 'USD',
        method: 'MANUAL_TRANSFER',
        status: 'PENDING',
        receiptUrl: uploadedFile.url,
      }
    });

    // Recién acá se consume: si algo falló antes, el código sigue disponible.
    if (discount) {
      try {
        await discountService.redeemCode(discount.code, req.user.id);
      } catch (error) {
        console.error('[Payments] No se pudo registrar el uso del código:', error.message);
      }
    }

    // Notificar a todos los admins
    const { notifyAdmins } = require('../services/notifications.service');
    await notifyAdmins('PAYMENT_REVIEW', {
      title: 'Nuevo Comprobante de Pago',
      body: `El usuario ${req.user.email} subió un comprobante para el plan ${planName}.`,
      payload: { transactionId: transaction.id, type: 'PAYMENT_REVIEW', screen: 'AdminPayments' },
      dedupeKey: `payment:review:${transaction.id}`
    });

    res.status(201).json({ message: 'Comprobante subido exitosamente', transaction });
  } catch (error) {
    console.error('Error in requestManualPayment:', error);
    res.status(500).json({ error: 'Error al procesar la solicitud de pago' });
  }
};

const getPendingPayments = async (req, res) => {
  try {
    const payments = await prisma.transaction.findMany({
      where: {
        method: 'MANUAL_TRANSFER',
        status: 'PENDING'
      },
      include: {
        user: { select: { email: true, stravaId: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(payments);
  } catch (error) {
    console.error('Error fetching pending payments:', error);
    res.status(500).json({ error: 'Error al obtener pagos pendientes' });
  }
};

const approvePayment = async (req, res) => {
  try {
    const { id } = req.params;
    const transaction = await prisma.transaction.findUnique({ where: { id } });

    if (!transaction || transaction.status !== 'PENDING') {
      return res.status(404).json({ error: 'Transacción no encontrada o ya procesada' });
    }

    const plan = await prisma.plan.findUnique({ where: { name: transaction.planName } });
    if (!plan) {
      return res.status(400).json({ error: `No existe un plan llamado "${transaction.planName}"` });
    }

    const updatedTx = await prisma.transaction.update({
      where: { id },
      data: { status: 'COMPLETED' }
    });

    // Desactivar suscripciones activas previas y crear la nueva
    await prisma.subscription.updateMany({
      where: { userId: transaction.userId, status: 'ACTIVE', isActive: true },
      data: { status: 'CANCELED', isActive: false }
    });

    const endDate = plan.interval === 'LIFETIME'
      ? null
      : new Date(Date.now() + (plan.interval === 'YEARLY' ? 365 : 30) * 24 * 60 * 60 * 1000);

    await prisma.subscription.create({
      data: {
        userId: transaction.userId,
        planId: plan.id,
        status: 'ACTIVE',
        isActive: true,
        endDate
      }
    });

    await prisma.user.update({
      where: { id: transaction.userId },
      data: { subscriptionTier: transaction.planName }
    });

    await notify(transaction.userId, 'PAYMENT_APPROVED', {
      title: '¡Pago Aprobado!',
      body: `Tu plan ${transaction.planName} ya está activo. ¡A entrenar!`,
      payload: { type: 'PLAN_CHANGED', plan: transaction.planName },
      dedupeKey: `payment:approved:${transaction.id}`
    });

    res.json({ message: 'Pago aprobado', transaction: updatedTx });
  } catch (error) {
    console.error('Error in approvePayment:', error);
    res.status(500).json({ error: 'Error al aprobar el pago' });
  }
};

const rejectPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    
    if (!reason) {
      return res.status(400).json({ error: 'Debe proveer un motivo de rechazo' });
    }

    const transaction = await prisma.transaction.findUnique({ where: { id } });

    if (!transaction || transaction.status !== 'PENDING') {
      return res.status(404).json({ error: 'Transacción no encontrada o ya procesada' });
    }

    const updatedTx = await prisma.transaction.update({
      where: { id },
      data: { status: 'REJECTED', rejectionReason: reason }
    });

    await notify(transaction.userId, 'PAYMENT_REJECTED', {
      title: 'Problema con tu Pago',
      body: `Tu comprobante fue rechazado. Motivo: ${reason}`,
      payload: { type: 'PAYMENT_REJECTED' },
      dedupeKey: `payment:rejected:${transaction.id}`
    });

    res.json({ message: 'Pago rechazado', transaction: updatedTx });
  } catch (error) {
    console.error('Error in rejectPayment:', error);
    res.status(500).json({ error: 'Error al rechazar el pago' });
  }
};

module.exports = {
  requestManualPayment,
  getPendingPayments,
  approvePayment,
  rejectPayment
};
