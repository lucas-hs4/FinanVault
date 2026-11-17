import { FastifyInstance, FastifyReply } from 'fastify';
import argon2 from 'argon2';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticate } from '../middlewares/authenticate.js';

async function issueSessionCookie(
  reply: FastifyReply,
  user: { id: string; name: string }
) {
  const token = await reply.jwtSign({
      sub: user.id,
      name: user.name,
  });

	reply.setCookie('finanvault_token', token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: 60 * 15,
	});
}

export async function authRoutes(app: FastifyInstance) {
	app.get('/status', async () => {
		const totalUsers = await prisma.user.count();
		return { needsSetup: totalUsers === 0 };
	});

	app.post('/setup', async (request, reply) => {
		const totalUsers = await prisma.user.count();
		if (totalUsers > 0) {
			return reply.status(403).send({ error: 'Cofre já configurado' });
		}

		const schema = z.object({
			name: z.string().min(2, 'Nome precisa ter pelo menos 2 letras'),
			password: z.string().min(6, 'Senha precisa ter pelo menos 6 caracteres'),
			pin: z.string().regex(/^\d{4,6}$/, 'PIN deve ter 4 a 6 números'),
		});

		const parsed = schema.safeParse(request.body);
		if (!parsed.success) {
			return reply.status(400).send({ error: parsed.error.issues[0]?.message });
		}

		const passwordHash = await argon2.hash(parsed.data.password);
		const pinHash = await argon2.hash(parsed.data.pin);

		const user = await prisma.user.create({
			data: {
				name: parsed.data?.name,
				passwordHash,
				pinHash,
			},
		});

		await issueSessionCookie(reply, user);
		return reply.status(201).send({ user: { id: user.id, name: user.name } });
	});

	app.post('/login', async (request, reply) => {
		const schema = z.object({
			password: z.string().min(1, 'Informe a senha'),
		});

		const parsed = schema.safeParse(request.body);
		if (!parsed.success) {
			return reply.status(400).send({ error: parsed.error.issues[0]?.message });
		}

		const user = await prisma.user.findFirst();
		if (!user) {
			return reply.status(404).send({ error: 'Nenhum usuário cadastrado' });
		}

		const valid = await argon2.verify(user.passwordHash, parsed.data.password);
		if (!valid) {
			return reply.status(401).send({ error: 'Senha incorreta' });
		}

		await issueSessionCookie(reply, user);
		return { user: { id: user.id, name: user.name } };
	});

	app.post('/unlock-pin', async (request, reply) => {
		const schema = z.object({
			pin: z.string().regex(/^\d{4,6}$/, 'PIN inválido'),
		});

		const parsed = schema.safeParse(request.body);
		if (!parsed.success) {
			return reply.status(400).send({ error: parsed.error.issues[0]?.message });
		}

		const user = await prisma.user.findFirst();
		if (!user) {
			return reply.status(404).send({ error: 'Nenhum usuário cadastrado' });
		}

		const valid = await argon2.verify(user.pinHash, parsed.data.pin);
		if (!valid) {
			return reply.status(401).send({ error: 'PIN incorreto' });
		}

		await issueSessionCookie(reply, user);
		return { user: { id: user.id, name: user.name } };
	});

	app.post('/logout', async (_request, reply) => {
		reply.clearCookie('finanvault_token', { path: '/' });
		return { ok: true };
	});

	app.get('/me', { preHandler: [authenticate] }, async (request) => {
		return { user: request.user };
	});
}