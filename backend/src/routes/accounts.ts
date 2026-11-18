import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticate } from '../middlewares/authenticate.js';

export async function accountRoutes( app: FastifyInstance) {
	app.addHook('preHandler', authenticate);

	app.get('/', async () => {
		const accounts = await prisma.account.findMany({
			orderBy: { name: 'asc' },
		});

		const totalBalance = accounts.reduce((acc, item) => acc + item.balance, 0);

		return { accounts, totalBalance };
	});

	app.post('/', async (request, reply) => {
		const schema = z.object({
			name: z.string().min(2, 'Nome da conta obrigatório'),
			type: z.enum(['WALLET', 'CHECKING', 'SAVINGS', 'INVESTMENT']),
			balance: z.number().default(0),
		});

		const parsed = schema.safeParse(request.body);
		if (!parsed.success) {
			return reply.status(400).send({ error: parsed.error.issues[0]?.message });
		}

		const account = await prisma.account.create({
			data: parsed.data,
		});

		return reply.status(201).send({ account });
	});
}