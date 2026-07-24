const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const stravaService = require('../services/strava.service');
const emailService = require('../services/email.service');
const pushService = require('../services/push.service');
const prisma = require('../lib/prisma');

const generateToken = (userId, email, role) => {
  return jwt.sign(
    { userId, email, role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
};

const register = async (req, res) => {
  try {
    console.log('[INFO] [REGISTER] Intento de registro:', req.body.email);
    const { email, password, username } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Por favor, ingresa un correo y una contraseña.' });
    }

    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email },
          ...(username ? [{ username }] : [])
        ]
      }
    });

    if (existingUser) {
      if (existingUser.email === email) {
        return res.status(409).json({ error: 'Ya existe una cuenta registrada con este correo.' });
      } else {
        return res.status(409).json({ error: 'Este nombre de usuario ya está ocupado, por favor elige otro.' });
      }
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        email,
        username: username || null,
        password: hashedPassword,
        role: 'ATHLETE'
      }
    });
    console.log('[SUCCESS] [REGISTER] Usuario creado exitosamente:', user.id);

    // Create 6-digit OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    await prisma.emailVerification.create({
      data: {
        userId: user.id,
        token: otpCode,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000) // 15 minutes
      }
    });

    // Send OTP email
    try {
      const nombre = user.email.split('@')[0];
      await emailService.sendVerificationOTP(user.email, otpCode, nombre);
    } catch (mailErr) {
      console.error('[ERROR] [REGISTER] Error enviando email de verificación:', mailErr.message);
    }

    const token = generateToken(user.id, user.email, user.role);

    res.status(201).json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        emailVerified: user.emailVerified,
        firstName: user.firstName,
        lastName: user.lastName,
        avatarUrl: user.avatarUrl,
        coverUrl: user.coverUrl,
        profileVisibility: user.profileVisibility,
        statsVisible: user.statsVisible,
        activitiesVisible: user.activitiesVisible,
        createdAt: user.createdAt
      },
      token,
      message: 'Registration successful. Please check your email to verify your account.'
    });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const registerBusiness = async (req, res) => {
  try {
    const { email, password, username, businessName } = req.body;

    if (!email || !password || !businessName?.trim()) {
      return res.status(400).json({ error: 'Email, password and business name are required.' });
    }

    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email },
          ...(username ? [{ username }] : [])
        ]
      }
    });

    if (existingUser) {
      if (existingUser.email === email) {
        return res.status(409).json({ error: 'Ya existe una cuenta registrada con este correo.' });
      }
      return res.status(409).json({ error: 'Este nombre de usuario ya está ocupado.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // Negocios: la puerta real es la aprobación del admin (no OTP de email).
    // Evita el doble gate confuso "éxito → verifica tu mail" sin correo.
    const user = await prisma.user.create({
      data: {
        email,
        username: username || null,
        password: hashedPassword,
        role: 'BUSINESS',
        emailVerified: true,
        business: {
          create: {
            name: businessName.trim(),
            status: 'PENDING'
          }
        }
      },
      include: { business: true }
    });

    try {
      await emailService.sendBusinessPendingEmail(user.email, businessName.trim());
    } catch (mailErr) {
      console.error('[ERROR] [REGISTER BUSINESS] Email error:', mailErr.message);
    }

    try {
      const { notifyAdmins } = require('../services/notifications.service');
      await notifyAdmins('BUSINESS_PENDING', {
        title: 'Nuevo negocio pendiente',
        body: `"${businessName.trim()}" solicitó unirse al Club de Beneficios. Revisá y aprobá desde Negocios.`,
        payload: {
          type: 'BUSINESS_PENDING',
          businessId: user.business.id,
          screen: 'AdminBusinesses'
        },
        dedupeKey: `business:pending:${user.business.id}`
      });
    } catch (notifyErr) {
      console.error('[ERROR] [REGISTER BUSINESS] Notify admins:', notifyErr.message);
    }

    const token = generateToken(user.id, user.email, user.role);

    res.status(201).json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        emailVerified: true,
        business: user.business
      },
      token,
      message: 'Business registration successful. Awaiting admin approval.'
    });
  } catch (error) {
    console.error('[ERROR] registerBusiness:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const login = async (req, res) => {
  try {
    console.log('[INFO] [LOGIN] Intento de login:', req.body.email);
    const { email, password } = req.body; // email field may contain username or email
    const identifier = email;

    if (!identifier || !password) {
      return res.status(400).json({ error: 'Por favor, completa tu correo/usuario y tu contraseña.' });
    }

    const isEmail = identifier.includes('@');

    const user = await prisma.user.findFirst({
      where: isEmail ? { email: identifier } : { username: identifier },
      include: {
        userScore: { include: { currentRank: true } },
        business: { select: { id: true, name: true, status: true, logoUrl: true } }
      }
    });

    if (!user || !user.password) {
      return res.status(401).json({ error: 'Tus credenciales son incorrectas. Verifica tu usuario/correo y contraseña.' });
    }

    if (!user.isActive || user.deletedAt) {
      return res.status(403).json({ error: 'Tu cuenta ha sido deshabilitada. Contactá a soporte si creés que es un error.' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);

    if (!isValidPassword) {
      return res.status(401).json({ error: 'Tus credenciales son incorrectas. Verifica tu usuario/correo y contraseña.' });
    }

    // Cuentas BUSINESS creadas antes del fix pueden quedar con emailVerified=false
    // y quedar atrapadas en VerifyEmail. La aprobación admin es el gate real.
    let emailVerified = user.emailVerified;
    if (user.role === 'BUSINESS' && !emailVerified) {
      await prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: true }
      });
      emailVerified = true;
    }

    const token = generateToken(user.id, user.email, user.role);
    console.log('[SUCCESS] [LOGIN] Login exitoso:', user.email);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
        stravaId: user.stravaId,
        emailVerified,
        firstName: user.firstName,
        lastName: user.lastName,
        avatarUrl: user.avatarUrl,
        coverUrl: user.coverUrl,
        bio: user.bio,
        birthDate: user.birthDate,
        gender: user.gender,
        heightCm: user.heightCm,
        weightKg: user.weightKg,
        primarySport: user.primarySport,
        experienceLevel: user.experienceLevel,
        phone: user.phone,
        city: user.city,
        country: user.country,
        instagramUrl: user.instagramUrl,
        profileVisibility: user.profileVisibility,
        statsVisible: user.statsVisible,
        activitiesVisible: user.activitiesVisible,
        subscriptionTier: user.subscriptionTier,
        userScore: user.userScore,
        business: user.business
      },
      token
    });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const stravaAuth = async (req, res) => {
  try {
    console.log('[DEBUG] [STRAVA AUTH] Iniciando autorización con Strava');
    const state = req.query.state || Math.random().toString(36).substring(7);
    const authUrl = stravaService.getAuthorizationUrl(state);
    console.log('[DEBUG] [STRAVA AUTH] URL generada:', authUrl);
    
    res.json({ authUrl });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const stravaCallback = async (req, res) => {
  try {
    console.log('[DEBUG] [STRAVA CALLBACK] Recibiendo callback de Strava');
    const { code, state } = req.query;
    console.log('[DEBUG] [STRAVA CALLBACK] Code:', code ? 'Recibido' : 'No recibido', 'State:', state);

    if (!code) {
      console.error('[ERROR] [STRAVA CALLBACK] Error: No se recibió código');
      return res.status(400).json({ error: 'Falta el código de autorización de Strava.' });
    }

    console.log('[DEBUG] [STRAVA CALLBACK] Intercambiando código por token...');
    const tokenData = await stravaService.exchangeToken(code);
    const athlete = tokenData.athlete;
    console.log('[DEBUG] [STRAVA CALLBACK] Atleta:', athlete.id, athlete.firstname, athlete.lastname);

    let user = await prisma.user.findUnique({
      where: { stravaId: athlete.id.toString() }
    });

    if (user) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          stravaAccessToken: tokenData.access_token,
          stravaRefreshToken: tokenData.refresh_token,
          stravaTokenExpiry: new Date(tokenData.expires_at * 1000)
        }
      });
    } else {
      user = await prisma.user.create({
        data: {
          email: `${athlete.id}@strava.local`,
          stravaId: athlete.id.toString(),
          stravaAccessToken: tokenData.access_token,
          stravaRefreshToken: tokenData.refresh_token,
          stravaTokenExpiry: new Date(tokenData.expires_at * 1000),
          role: 'ATHLETE'
        }
      });
    }

    const token = generateToken(user.id, user.email, user.role);
    console.log('[SUCCESS] [STRAVA CALLBACK] Token JWT generado para usuario:', user.id);

    let redirectUrl;
    if (state && state.startsWith('mobile_')) {
      const mobileDeepLink = state.replace('mobile_', '');
      redirectUrl = `${mobileDeepLink}?token=${token}`;
    } else {
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      redirectUrl = `${frontendUrl}/auth/callback?token=${token}`;
    }
    
    console.log('[DEBUG] [STRAVA CALLBACK] Redirigiendo a:', redirectUrl);
    res.redirect(redirectUrl);
  } catch (error) {
    console.error('[ERROR] [STRAVA CALLBACK] Error:', error.message);
    console.error('[ERROR] [STRAVA CALLBACK] Stack:', error.stack);
    
    const { state } = req.query;
    let errorRedirectUrl;
    if (state && state.startsWith('mobile_')) {
      const mobileDeepLink = state.replace('mobile_', '');
      errorRedirectUrl = `${mobileDeepLink}?error=${encodeURIComponent(error.message)}`;
    } else {
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      errorRedirectUrl = `${frontendUrl}/auth/error?message=${encodeURIComponent(error.message)}`;
    }
    res.redirect(errorRedirectUrl);
  }
};

const refreshToken = async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Se requiere un token de sesión para continuar.' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true });
    
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId }
    });

    if (!user) {
      return res.status(404).json({ error: 'No hemos podido encontrar tu cuenta.' });
    }

    const newToken = generateToken(user.id, user.email, user.role);

    res.json({ token: newToken });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const getCurrentUser = async (req, res) => {
  try {
    console.log('[INFO] [GET CURRENT USER] Usuario ID:', req.user.id);
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        stravaId: true,
        emailVerified: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
        coverUrl: true,
        bio: true,
        birthDate: true,
        gender: true,
        heightCm: true,
        weightKg: true,
        primarySport: true,
        experienceLevel: true,
        phone: true,
        city: true,
        country: true,
        instagramUrl: true,
        profileVisibility: true,
        statsVisible: true,
        activitiesVisible: true,
        createdAt: true,
        subscriptionTier: true,
        userScore: {
          include: { currentRank: true }
        },
        business: {
          select: {
            id: true,
            name: true,
            status: true,
            logoUrl: true,
            coverUrl: true
          }
        }
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'No hemos podido encontrar tu cuenta.' });
    }

    console.log('[SUCCESS] [GET CURRENT USER] Usuario encontrado:', user.email, 'StravaId:', user.stravaId);
    res.json(user);
  } catch (error) {
    console.error('[ERROR] [GET CURRENT USER] Error:', error.message);
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const disconnectStrava = async (req, res) => {
  try {
    const userId = req.user.id;
    console.log('[INFO] [DISCONNECT STRAVA] Usuario ID:', userId);

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        stravaId: null,
        stravaAccessToken: null,
        stravaRefreshToken: null,
        stravaTokenExpiry: null,
        lastSyncDate: null
      },
      select: {
        id: true,
        email: true,
        role: true,
        stravaId: true,
        createdAt: true
      }
    });

    console.log('[SUCCESS] [DISCONNECT STRAVA] Strava desconectado para:', updatedUser.email);
    res.json(updatedUser);
  } catch (error) {
    console.error('[ERROR] [DISCONNECT STRAVA] Error:', error.message);
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const verifyEmail = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Falta el código de verificación.' });

    const emailVerification = await prisma.emailVerification.findUnique({
      where: { token }
    });

    if (!emailVerification) {
      return res.status(400).json({ error: 'El código de verificación es inválido o ha caducado.' });
    }

    if (emailVerification.verified) {
      return res.status(400).json({ error: 'Este correo electrónico ya ha sido verificado.' });
    }

    if (new Date() > emailVerification.expiresAt) {
      return res.status(400).json({ error: 'Tu código de verificación ha expirado. Por favor, solicita uno nuevo.' });
    }

    await prisma.$transaction([
      prisma.emailVerification.update({
        where: { id: emailVerification.id },
        data: { verified: true }
      }),
      prisma.user.update({
        where: { id: emailVerification.userId },
        data: { emailVerified: true }
      })
    ]);

    const user = await prisma.user.findUnique({ where: { id: emailVerification.userId } });
    if (user) {
      try {
        const nombre = user.email.split('@')[0];
        await emailService.sendWelcomeEmail(user.email, nombre);
      } catch (mailErr) {
        console.error('[ERROR] [VERIFY] Error enviando email de bienvenida:', mailErr.message);
      }
    }

    res.json({ message: 'Email verified successfully' });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const resendVerification = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Por favor, ingresa tu correo electrónico.' });

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(404).json({ error: 'No hemos podido encontrar una cuenta con este correo.' });

    // Invalidate previous tokens
    await prisma.emailVerification.deleteMany({
      where: { userId: user.id, verified: false }
    });

    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    await prisma.emailVerification.create({
      data: {
        userId: user.id,
        token: otpCode,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000)
      }
    });

    try {
      const nombre = user.email.split('@')[0];
      await emailService.sendVerificationOTP(user.email, otpCode, nombre);
    } catch (mailErr) {
      console.error('[ERROR] [RESEND_VERIFICATION] Error enviando email:', mailErr.message);
    }

    res.json({ message: 'Verification OTP sent' });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const registerPushToken = async (req, res) => {
  try {
    const { token, device } = req.body;
    if (!token) return res.status(400).json({ error: 'Push token is required' });

    await pushService.registerPushToken(req.user.id, token, device);
    res.json({ message: 'Push token registered' });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const removePushToken = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Push token is required' });

    await pushService.removePushToken(token);
    res.json({ message: 'Push token removed' });
  } catch (error) {
    console.error('[ERROR]', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

const unsubscribe = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Falta el token de validación.' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.purpose !== 'unsubscribe') {
      return res.status(400).json({ error: 'El código proporcionado no es válido para esta acción.' });
    }

    const { email } = decoded;

    await prisma.user.update({
      where: { email },
      data: { marketingEnabled: false }
    });

    res.json({ message: 'Te has desuscrito de los correos promocionales con éxito.' });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(400).json({ error: 'El enlace para desuscribirse ha caducado.' });
    }
    return res.status(400).json({ error: 'El enlace para desuscribirse no es válido.' });
  }
};

module.exports = {
  register,
  registerBusiness,
  login,
  stravaAuth,
  stravaCallback,
  refreshToken,
  getCurrentUser,
  disconnectStrava,
  verifyEmail,
  resendVerification,
  unsubscribe,
  registerPushToken,
  removePushToken
};

