const validator = require('validator');
const jwt = require('jsonwebtoken');
const { APP_NAME } = require('../constants/brand');

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

function cleanEnv(value) {
  if (typeof value !== 'string') return '';
  let v = value.trim();
  // Quita comillas accidentales del .env: BREVO_API_KEY="xxx"
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

function isPlaceholderKey(apiKey) {
  if (!apiKey) return true;
  const lower = apiKey.toLowerCase();
  return (
    lower.includes('your-brevo') ||
    lower.includes('your_api') ||
    lower === 'changeme' ||
    lower === 'xxx'
  );
}

const getEmailConfig = () => {
  const apiKey = cleanEnv(process.env.BREVO_API_KEY);
  return {
    apiKey: isPlaceholderKey(apiKey) ? '' : apiKey,
    fromEmail: cleanEnv(process.env.FROM_EMAIL) || 'jnserrudo@gmail.com',
    fromName: cleanEnv(process.env.FROM_NAME) || APP_NAME,
  };
};
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const JWT_SECRET = process.env.JWT_SECRET;

const getEmailStatus = () => {
  const { apiKey, fromEmail } = getEmailConfig();
  const rawPresent = Boolean(cleanEnv(process.env.BREVO_API_KEY));
  return {
    configured: Boolean(apiKey),
    provider: 'brevo',
    fromEmail,
    // Diagnóstico seguro (no expone la key)
    keyPresentInEnv: rawPresent,
    keyLength: apiKey ? apiKey.length : 0,
    keyPrefix: apiKey ? `${apiKey.slice(0, 8)}…` : null,
  };
};

const generateUnsubscribeToken = (email) => {
  return jwt.sign({ email, purpose: 'unsubscribe' }, JWT_SECRET, { expiresIn: '30d' });
};

const generateMarketingFooter = (email) => {
  const token = generateUnsubscribeToken(email);
  const unsubscribeUrl = `${FRONTEND_URL}/unsubscribe?token=${token}`;
  
  return `
    <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #333; text-align: center; font-size: 12px; color: #888;">
      <p>Estás recibiendo este correo porque te registraste en ${APP_NAME}.</p>
      <p>Si no deseas recibir más correos como este, puedes <a href="${unsubscribeUrl}" style="color: #4CAF50; text-decoration: underline;">desuscribirte aquí</a>.</p>
    </div>
  `;
};

const sendEmail = async (to, subject, text, html, isMarketing = false) => {
  if (!validator.isEmail(to)) {
    throw new Error(`Dirección de correo inválida: ${to}`);
  }

  const finalHtml = isMarketing ? `${html}${generateMarketingFooter(to)}` : html;

  const { apiKey, fromEmail, fromName } = getEmailConfig();
  if (!apiKey) {
    const raw = cleanEnv(process.env.BREVO_API_KEY);
    console.error(
      `[Email Service - NOT SENT] BREVO_API_KEY unavailable. ` +
        `rawPresent=${Boolean(raw)} rawLength=${raw.length} cwd=${process.cwd()} To: ${to}`
    );
    return { success: false, simulated: true, reason: 'EMAIL_NOT_CONFIGURED' };
  }

  const payload = {
    sender: { name: fromName, email: fromEmail },
    to: [{ email: to }],
    subject,
    htmlContent: finalHtml,
    textContent: text
  };

  const response = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
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
  const subject = `Verifica tu cuenta - ${APP_NAME}`;
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
  // resetToken es el código OTP de 6 dígitos que el usuario debe ingresar en la app.
  const subject = `Recuperación de contraseña - ${APP_NAME}`;
  const text = `Hola ${nombre}, tu código para restablecer la contraseña es: ${resetToken}. Es válido por 1 hora. Si no lo solicitaste, ignora este correo.`;
  const html = `
    <div style="font-family: Arial, sans-serif; background-color: #1a1a1a; color: #ffffff; padding: 30px; text-align: center;">
      <h1 style="color: #4CAF50;">Recuperación de Contraseña</h1>
      <p style="font-size: 16px;">Hola ${nombre}, usá el siguiente código para restablecer tu contraseña:</p>
      <div style="margin: 30px auto; padding: 20px; background-color: #333; border-radius: 8px; font-size: 32px; font-weight: bold; letter-spacing: 5px; width: fit-content;">
        ${resetToken}
      </div>
      <p style="font-size: 14px; color: #888;">Ingresá este código en la app para elegir una nueva contraseña. El código es válido por 1 hora.</p>
      <p style="font-size: 14px; color: #888;">Si no solicitaste este cambio, ignorá este correo: tu contraseña seguirá siendo la misma.</p>
    </div>
  `;
  return sendEmail(email, subject, text, html, false);
};

const sendWelcomeEmail = async (email, nombre) => {
  const subject = `¡Bienvenido a ${APP_NAME}!`;
  const text = `Hola ${nombre}, tu cuenta ha sido verificada con éxito. ¡A entrenar!`;
  const html = `
    <div style="font-family: Arial, sans-serif; background-color: #1a1a1a; color: #ffffff; padding: 30px; text-align: center;">
      <h1 style="color: #4CAF50;">¡Cuenta Verificada!</h1>
      <p style="font-size: 16px;">Hola ${nombre}, tu cuenta ha sido configurada y verificada exitosamente.</p>
      <a href="${FRONTEND_URL}/dashboard" style="display: inline-block; margin: 30px 0; padding: 15px 30px; background-color: #4CAF50; color: #fff; text-decoration: none; border-radius: 5px; font-weight: bold;">
        Ir a mi Dashboard
      </a>
    </div>
  `;
  return sendEmail(email, subject, text, html, true);
};

const sendAdminAlert = async (emails, data) => {
  const subject = `[WARN] ALERTA DEL SISTEMA: ${data.alertType}`;
  const text = `Alerta: ${data.alertType} - Detalles: ${data.details}`;
  const html = `
    <div style="font-family: Arial, sans-serif; background-color: #1a1a1a; color: #ffffff; padding: 30px;">
      <h1 style="color: #F44336; border-bottom: 2px solid #F44336; padding-bottom: 10px;">[WARN] ALERTA: ${data.alertType}</h1>
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
  const subject = `Reporte Semanal ${APP_NAME} - ${data.period}`;
  const text = `Reporte Semanal. Usuarios Activos: ${data.activeUsers}. Actividades Sincronizadas: ${data.totalActivities}.`;
  const html = `
    <div style="font-family: Arial, sans-serif; background-color: #1a1a1a; color: #ffffff; padding: 30px;">
      <h1 style="color: #2196F3;">Reporte Semanal ${APP_NAME}</h1>
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

const sendBusinessPendingEmail = async (email, businessName) => {
  const subject = `Solicitud recibida — ${APP_NAME} Club de Beneficios`;
  const text = `Hola, recibimos la solicitud de "${businessName}". Un administrador la revisará pronto. Te avisaremos cuando puedas publicar beneficios.`;
  const html = `
    <div style="font-family: Arial, sans-serif; background-color: #1a1a1a; color: #ffffff; padding: 30px; text-align: center;">
      <h1 style="color: #818cf8;">Solicitud recibida</h1>
      <p style="font-size: 16px;">Recibimos la solicitud de <strong>${businessName}</strong>.</p>
      <p style="font-size: 16px;">Un administrador la revisará pronto. Cuando esté aprobada, podrás publicar beneficios para atletas.</p>
      <p style="font-size: 14px; color: #888; margin-top: 24px;">No necesitás verificar un código por ahora — el siguiente paso es la aprobación del admin.</p>
    </div>
  `;
  return sendEmail(email, subject, text, html, false);
};

module.exports = {
  getEmailStatus,
  sendEmail,
  sendVerificationOTP,
  sendResetPasswordEmail,
  sendWelcomeEmail,
  sendAdminAlert,
  sendWeeklyReport,
  sendBusinessPendingEmail,
  generateUnsubscribeToken,
  generateMarketingFooter
};
