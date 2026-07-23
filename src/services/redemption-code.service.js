const crypto = require('crypto');
const prisma = require('../lib/prisma');

const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const generateCode = () => {
  const part1 = Array.from({ length: 4 }, () => CHARSET[crypto.randomInt(CHARSET.length)]).join('');
  const part2 = Array.from({ length: 4 }, () => CHARSET[crypto.randomInt(CHARSET.length)]).join('');
  return `${part1}-${part2}`;
};

const generateUniqueCode = async (tx) => {
  const client = tx || prisma;
  for (let i = 0; i < 10; i++) {
    const code = generateCode();
    const existing = await client.redemption.findUnique({ where: { code } });
    if (!existing) return code;
  }
  throw new Error('Failed to generate unique redemption code');
};

module.exports = { generateCode, generateUniqueCode };
