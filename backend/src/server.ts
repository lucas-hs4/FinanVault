import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import { prisma } from './lib/prisma.js';
import { authRoutes } from './routes/auth.js';

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  throw new Error('JWT_SECRET não configurado no .env');
}

const app = Fastify({ logger: true});

app.register(cors, {
  origin: true,
  credentials: true,
});

app.register(cookie);

app.register(jwt, {
  secret: jwtSecret,
  cookie: {
    cookieName: 'finanvault_token',
    signed: false,
  },
  sign: {
    expiresIn: '15m',
  },
});

app.register(authRoutes, { prefix: '/api/auth' });

app.get('/api/status', async () => {
  const totalContas = await prisma.account.count()

  if (totalContas === 0) {
    await prisma.account.createMany({
      data: [
        { name: 'Carteira Física', type: 'WALLET', balance: 0 },
        { name: 'Conta Principal', type: 'CHECKING', balance: 0 },
        { name: 'Reserva / Guardado', type: 'SAVINGS', balance: 0 },
      ],
    });
  }

  const contas = await prisma.account.findMany();
  return {
    sistema: 'FinanVault API Online',
    contasIniciais: contas,
  };
});

const start = async () => {
  try {
    await app.listen({ port: 3333, host: '0.0.0.0' });
    console.log('🔓 Servidor FinanVault rodando na porta 3333');
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();