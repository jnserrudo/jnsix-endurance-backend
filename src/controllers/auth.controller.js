const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const stravaService = require('../services/strava.service');
const emailService = require('../services/email.service');
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
    console.log('🟢 [REGISTER] Intento de registro:', req.body.email);
    const { email, password, username } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
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
        return res.status(409).json({ error: 'User already exists with this email' });
      } else {
        return res.status(409).json({ error: 'Username is already taken' });
      }
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        email,
        username: username || null,
        password: hashedPassword,
        role: 'ATHLETE'
      },
      select: {
        id: true,
        email: true,
        role: true,
        createdAt: true
      }
    });
    console.log('✅ [REGISTER] Usuario creado exitosamente:', user.id);

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
      console.error('🔴 [REGISTER] Error enviando email de verificación:', mailErr.message);
    }

    const token = generateToken(user.id, user.email, user.role);

    res.status(201).json({
      user,
      token,
      message: 'Registration successful. Please check your email to verify your account.'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const login = async (req, res) => {
  try {
    console.log('🟢 [LOGIN] Intento de login:', req.body.email);
    const { email, password } = req.body; // email field may contain username or email
    const identifier = email;

    if (!identifier || !password) {
      return res.status(400).json({ error: 'Email/Username and password are required' });
    }

    const isEmail = identifier.includes('@');

    const user = await prisma.user.findFirst({
      where: isEmail ? { email: identifier } : { username: identifier }
    });

    if (!user || !user.password) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);

    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken(user.id, user.email, user.role);
    console.log('✅ [LOGIN] Login exitoso:', user.email);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        stravaId: user.stravaId
      },
      token
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const stravaAuth = async (req, res) => {
  try {
    console.log('🔵 [STRAVA AUTH] Iniciando autorización con Strava');
    const state = req.query.state || Math.random().toString(36).substring(7);
    const authUrl = stravaService.getAuthorizationUrl(state);
    console.log('🔵 [STRAVA AUTH] URL generada:', authUrl);
    
    res.json({ authUrl });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const stravaCallback = async (req, res) => {
  try {
    console.log('🔵 [STRAVA CALLBACK] Recibiendo callback de Strava');
    const { code, state } = req.query;
    console.log('🔵 [STRAVA CALLBACK] Code:', code ? 'Recibido' : 'No recibido', 'State:', state);

    if (!code) {
      console.error('🔴 [STRAVA CALLBACK] Error: No se recibió código');
      return res.status(400).json({ error: 'Authorization code required' });
    }

    console.log('🔵 [STRAVA CALLBACK] Intercambiando código por token...');
    const tokenData = await stravaService.exchangeToken(code);
    const athlete = tokenData.athlete;
    console.log('🔵 [STRAVA CALLBACK] Atleta:', athlete.id, athlete.firstname, athlete.lastname);

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
    console.log('✅ [STRAVA CALLBACK] Token JWT generado para usuario:', user.id);

    let redirectUrl;
    if (state && state.startsWith('mobile_')) {
      const mobileDeepLink = state.replace('mobile_', '');
      redirectUrl = `${mobileDeepLink}?token=${token}`;
    } else {
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      redirectUrl = `${frontendUrl}/auth/callback?token=${token}`;
    }
    
    console.log('🔵 [STRAVA CALLBACK] Redirigiendo a:', redirectUrl);
    res.redirect(redirectUrl);
  } catch (error) {
    console.error('🔴 [STRAVA CALLBACK] Error:', error.message);
    console.error('🔴 [STRAVA CALLBACK] Stack:', error.stack);
    
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
      return res.status(400).json({ error: 'Token required' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET, { ignoreExpiration: true });
    
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const newToken = generateToken(user.id, user.email, user.role);

    res.json({ token: newToken });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getCurrentUser = async (req, res) => {
  try {
    console.log('🟢 [GET CURRENT USER] Usuario ID:', req.user.id);
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        email: true,
        role: true,
        stravaId: true,
        createdAt: true
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    console.log('✅ [GET CURRENT USER] Usuario encontrado:', user.email, 'StravaId:', user.stravaId);
    res.json(user);
  } catch (error) {
    console.error('🔴 [GET CURRENT USER] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

const disconnectStrava = async (req, res) => {
  try {
    const userId = req.user.id;
    console.log('🟢 [DISCONNECT STRAVA] Usuario ID:', userId);

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

    console.log('✅ [DISCONNECT STRAVA] Strava desconectado para:', updatedUser.email);
    res.json(updatedUser);
  } catch (error) {
    console.error('🔴 [DISCONNECT STRAVA] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
};

const verifyEmail = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token is required' });

    const emailVerification = await prisma.emailVerification.findUnique({
      where: { token }
    });

    if (!emailVerification) {
      return res.status(400).json({ error: 'Invalid or expired verification token' });
    }

    if (emailVerification.verified) {
      return res.status(400).json({ error: 'Email is already verified' });
    }

    if (new Date() > emailVerification.expiresAt) {
      return res.status(400).json({ error: 'Verification token has expired' });
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
        console.error('🔴 [VERIFY] Error enviando email de bienvenida:', mailErr.message);
      }
    }

    res.json({ message: 'Email verified successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const resendVerification = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(404).json({ error: 'User not found' });

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
      console.error('🔴 [RESEND_VERIFICATION] Error enviando email:', mailErr.message);
    }

    res.json({ message: 'Verification OTP sent' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const unsubscribe = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token is required' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.purpose !== 'unsubscribe') {
      return res.status(400).json({ error: 'Invalid token purpose' });
    }

    const { email } = decoded;

    await prisma.user.update({
      where: { email },
      data: { marketingEnabled: false }
    });

    res.json({ message: 'Successfully unsubscribed from marketing emails' });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(400).json({ error: 'Unsubscribe token has expired' });
    }
    return res.status(400).json({ error: 'Invalid unsubscribe token' });
  }
};

module.exports = {
  register,
  login,
  stravaAuth,
  stravaCallback,
  refreshToken,
  getCurrentUser,
  disconnectStrava,
  verifyEmail,
  resendVerification,
  unsubscribe
};

