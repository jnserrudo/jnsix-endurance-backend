const validator = require('validator');
const jwt = require('jsonwebtoken');

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const API_KEY = process.env.BREVO_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'jnserrudo@gmail.com';
const FROM_NAME = process.env.FROM_NAME || 'Jnsix Sport';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const JWT_SECRET = process.env.JWT_SECRET;

const generateUnsubscribeToken = (email) => {
  return jwt.sign({ email, purpose: 'unsubscribe' }, JWT_SECRET, { expiresIn: '30d' });
};

const generateMarketingFooter = (email) => {
  const token = generateUnsubscribeToken(email);
  const unsubscribeUrl = `${FRONTEND_URL}/unsubscribe?token=${token}`;
  
  return `
    <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #333; text-align: center; font-size: 12px; color: #888;">
      <p>Estás recibiendo este correo porque te registraste en JNSIX Endurance.</p>
      <p>Si no deseas recibir más correos como este, puedes <a href="${unsubscribeUrl}" style="color: #4CAF50; text-decoration: underline;">desuscribirte aquí</a>.</p>
    </div>
  `;
};

const sendEmail = async (to, subject, text, html, isMarketing = false) => {
  if (!validator.isEmail(to)) {
    throw new Error(`Dirección de correo inválida: ${to}`);
  }

  const finalHtml = isMarketing ? `${html}${generateMarketingFooter(to)}` : html;

  if (!API_KEY) {
    console.log(`[Email Service - SIMULATION] Email to: ${to} | Subject: ${subject}`);
    return { success: true, simulated: true };
  }

  const payload = {
    sender: { name: FROM_NAME, email: FROM_EMAIL },
    to: [{ email: to }],
    subject,
    htmlContent: finalHtml,
    textContent: text
  };

  const response = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      'api-key': API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(`Error en Brevo API: ${JSON.stringify(errorData)}`);
  }

  const data = await response.json();
  console.log(`[Email Service] Correo enviado a ${to} (Message ID: ${data.messageId})`);
  return data;
};

const sendVerificationOTP = async (email, otpCode, nombre) => {
  const subject = 'Verifica tu cuenta - JNSIX Endurance';
  const text = `Hola ${nombre}, tu código de verificación es: ${otpCode}. Expira en 15 minutos.`;
  const html = `
    <div style="font-family: Arial, sans-serif; background-color: #1a1a1a; color: #ffffff; padding: 30px; text-align: center;">
      <h1 style="color: #4CAF50;">Verificación de Cuenta</h1>
      <p style="font-size: 16px;">Hola ${nombre}, usa el siguiente código para verificar tu cuenta:</p>
      <div style="margin: 30px auto; padding: 20px; background-color: #333; border-radius: 8px; font-size: 32px; font-weight: bold; letter-spacing: 5px; width: fit-content;">
        ${otpCode}
      </div>
      <p style="font-size: 14px; color: #888;">Este código expira en 15 minutos. Si no solicitaste esto, ignora este correo.</p>
    </div>
  `;
  return sendEmail(email, subject, text, html, false);
};

const sendResetPasswordEmail = async (email, resetToken, nombre) => {
  const subject = 'Recuperación de contraseña - JNSIX Endurance';
  const resetUrl = `${FRONTEND_URL}/reset-password?token=${resetToken}`;
  const text = `Hola ${nombre}, has solicitado restablecer tu contraseña. Haz clic aquí: ${resetUrl}`;
  const html = `
    <div style="font-family: Arial, sans-serif; background-color: #1a1a1a; color: #ffffff; padding: 30px; text-align: center;">
      <h1 style="color: #4CAF50;">Recuperación de Contraseña</h1>
      <p style="font-size: 16px;">Hola ${nombre}, has solicitado restablecer tu contraseña.</p>
      <a href="${resetUrl}" style="display: inline-block; margin: 30px 0; padding: 15px 30px; background-color: #4CAF50; color: #fff; text-decoration: none; border-radius: 5px; font-weight: bold;">
        Restablecer Contraseña
      </a>
      <p style="font-size: 14px; color: #888;">Este link es válido por 1 hora. Si no lo solicitaste, ignora este correo.</p>
    </div>
  `;
  return sendEmail(email, subject, text, html, false);
};

const sendWelcomeEmail = async (email, nombre) => {
  const subject = '¡Bienvenido a JNSIX Endurance!';
  const text = `Hola ${nombre}, tu cuenta ha sido verificada con éxito. ¡A entrenar!`;
  const html = `
    <div style="font-family: Arial, sans-serif; background-color: #1a1a1a; color: #ffffff; padding: 30px; text-align: center;">
      <h1 style="color: #4CAF50;">¡Cuenta Verificada! 🏃‍♂️</h1>
      <p style="font-size: 16px;">Hola ${nombre}, tu cuenta ha sido configurada y verificada exitosamente.</p>
      <a href="${FRONTEND_URL}/dashboard" style="display: inline-block; margin: 30px 0; padding: 15px 30px; background-color: #4CAF50; color: #fff; text-decoration: none; border-radius: 5px; font-weight: bold;">
        Ir a mi Dashboard
      </a>
    </div>
  `;
  return sendEmail(email, subject, text, html, true);
};

const sendAdminAlert = async (emails, data) => {
  const subject = `⚠️ ALERTA DEL SISTEMA: ${data.alertType}`;
  const text = `Alerta: ${data.alertType} - Detalles: ${data.details}`;
  const html = `
    <div style="font-family: Arial, sans-serif; background-color: #1a1a1a; color: #ffffff; padding: 30px;">
      <h1 style="color: #F44336; border-bottom: 2px solid #F44336; padding-bottom: 10px;">⚠️ ALERTA: ${data.alertType}</h1>
      <p style="font-size: 16px;">Se ha detectado un evento que requiere atención:</p>
      <ul style="background-color: #333; padding: 20px; border-radius: 5px; list-style-type: none;">
        <li style="margin-bottom: 10px;"><strong>Fecha:</strong> ${new Date().toISOString()}</li>
        <li style="margin-bottom: 10px;"><strong>Severidad:</strong> <span style="color: #F44336; font-weight: bold;">ALTA</span></li>
        <li style="margin-bottom: 10px;"><strong>Detalles:</strong> ${data.details}</li>
      </ul>
    </div>
  `;
  
  for (const email of emails) {
    try {
      await sendEmail(email, subject, text, html, false);
    } catch (err) {
      console.error(`[Email Service] Error enviando alerta a ${email}:`, err.message);
    }
  }
};

const sendWeeklyReport = async (email, data, nombreAdmin) => {
  const subject = `Reporte Semanal JNSIX Endurance - ${data.period}`;
  const text = `Reporte Semanal. Usuarios Activos: ${data.activeUsers}. Actividades Sincronizadas: ${data.totalActivities}.`;
  const html = `
    <div style="font-family: Arial, sans-serif; background-color: #1a1a1a; color: #ffffff; padding: 30px;">
      <h1 style="color: #2196F3;">Reporte Semanal JNSIX</h1>
      <p style="font-size: 16px;">Hola ${nombreAdmin}, aquí tienes el resumen del periodo: <strong>${data.period}</strong></p>
      
      <div style="display: flex; gap: 20px; margin-top: 30px;">
        <div style="flex: 1; background-color: #333; padding: 20px; border-radius: 5px; text-align: center;">
          <h3 style="margin: 0; color: #888;">Usuarios Activos</h3>
          <p style="font-size: 32px; font-weight: bold; margin: 10px 0; color: #fff;">${data.activeUsers}</p>
        </div>
        <div style="flex: 1; background-color: #333; padding: 20px; border-radius: 5px; text-align: center;">
          <h3 style="margin: 0; color: #888;">Actividades Sincronizadas</h3>
          <p style="font-size: 32px; font-weight: bold; margin: 10px 0; color: #fff;">${data.totalActivities}</p>
        </div>
      </div>
    </div>
  `;
  return sendEmail(email, subject, text, html, false);
};

module.exports = {
  sendEmail,
  sendVerificationOTP,
  sendResetPasswordEmail,
  sendWelcomeEmail,
  sendAdminAlert,
  sendWeeklyReport,
  generateUnsubscribeToken,
  generateMarketingFooter
};
