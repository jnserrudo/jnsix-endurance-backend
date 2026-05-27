const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const stravaService = require('../services/strava.service');

const prisma = new PrismaClient();

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
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const existingUser = await prisma.user.findUnique({
      where: { email }
    });

    if (existingUser) {
      return res.status(409).json({ error: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        email,
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

    const token = generateToken(user.id, user.email, user.role);

    res.status(201).json({
      user,
      token
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const login = async (req, res) => {
  try {
    console.log('🟢 [LOGIN] Intento de login:', req.body.email);
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await prisma.user.findUnique({
      where: { email }
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
    const { code } = req.query;
    console.log('🔵 [STRAVA CALLBACK] Code:', code ? 'Recibido' : 'No recibido');

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

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const redirectUrl = `${frontendUrl}/auth/callback?token=${token}`;
    console.log('🔵 [STRAVA CALLBACK] Redirigiendo a:', redirectUrl);
    res.redirect(redirectUrl);
  } catch (error) {
    console.error('🔴 [STRAVA CALLBACK] Error:', error.message);
    console.error('🔴 [STRAVA CALLBACK] Stack:', error.stack);
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    res.redirect(`${frontendUrl}/auth/error?message=${encodeURIComponent(error.message)}`);
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

module.exports = {
  register,
  login,
  stravaAuth,
  stravaCallback,
  refreshToken,
  getCurrentUser
};
