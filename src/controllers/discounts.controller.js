const discountService = require('../services/discount.service');

const handleError = (res, error, fallback) => {
  if (error instanceof discountService.DiscountError) {
    return res.status(error.status).json({ error: error.message });
  }
  console.error('[ERROR] [DISCOUNTS]', error);
  return res.status(500).json({ error: fallback });
};

/**
 * POST /api/discounts/validate
 * El atleta escribe el código antes de pagar y ve cuánto le queda a pagar.
 * No consume el código: eso pasa recién al confirmar el pago.
 */
const validate = async (req, res) => {
  try {
    const { code, amount } = req.body;
    const discount = await discountService.validateCode(code, req.user.id);
    const applied = discountService.applyToAmount(discount, amount);

    res.json({
      valid: true,
      code: discount.code,
      discountType: discount.discountType,
      value: discount.value,
      label: discountService.describe(discount),
      expiresAt: discount.expiresAt,
      ...applied,
    });
  } catch (error) {
    handleError(res, error, 'No pudimos validar el código. Intentá de nuevo.');
  }
};

// --- Admin ---

const list = async (req, res) => {
  try {
    res.json({ codes: await discountService.listCodes() });
  } catch (error) {
    handleError(res, error, 'No pudimos cargar los códigos de descuento.');
  }
};

const create = async (req, res) => {
  try {
    const created = await discountService.createCode(req.body);
    res.status(201).json(created);
  } catch (error) {
    handleError(res, error, 'No pudimos crear el código de descuento.');
  }
};

const update = async (req, res) => {
  try {
    res.json(await discountService.updateCode(req.params.id, req.body));
  } catch (error) {
    handleError(res, error, 'No pudimos actualizar el código de descuento.');
  }
};

const remove = async (req, res) => {
  try {
    await discountService.deleteCode(req.params.id);
    res.json({ message: 'Código dado de baja.' });
  } catch (error) {
    handleError(res, error, 'No pudimos dar de baja el código.');
  }
};

module.exports = { validate, list, create, update, remove };
