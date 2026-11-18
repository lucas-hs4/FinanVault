import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticate } from '../middlewares/authenticate.js';

const objectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, 'ID inválido');

export async function transactionRoutes(app: FastifyInstance) {
	app.addHook('preHandler', authenticate);

	app.get('/', async (request, reply) => {
		const querySchema = z.object({
			month: z.coerce.number().int().min(1).max(12).optional(),
			year: z.coerce.number().int().min(2000).max(2100).optional(),
		});

		const parsedQuery = querySchema.safeParse(request.query);
		if (!parsedQuery.success) {
			return reply.status(400).send({ error: 'Filtro de mês ou ano inválido' });
		};

		const { month, year }= parsedQuery.data;
		const dateFilter =
			month && year
				? {
						gte: new Date(Date.UTC(year, month - 1, 1)),
						lt: new Date(Date.UTC(year, month, 1)),
					}
				: undefined;
		
		const transactions = await prisma.transaction.findMany({
			where: dateFilter ? { date: dateFilter } : undefined,
			include: {
				account: { select: { id: true, name: true, type: true } },
				destinationAccount: { select: { id: true, name: true, type: true } },
			},
			orderBy: { date: 'desc' },
			take: dateFilter ? undefined : 50,
		});

		const totalIncome = transactions
			.filter((t) => t.type === 'INCOME')
			.reduce((acc, t) => acc + t.amount, 0);
		
		const totalExpense = transactions
			.filter((t) => t.type === 'EXPENSE')
			.reduce((acc, t) => acc+ t.amount, 0);

		return { transactions, totalIncome, totalExpense };
	});

	app.post('/', async (request, reply) => {
		const bodySchema = z.object({
			description: z.string().min(1, 'Descrição obrigatória'),
			amount: z.number().positive('Valor deve ser maior que zero'),
			type: z.enum(['INCOME', 'EXPENSE', 'TRANSFER']),
			category: z.string().min(1, 'Categoria obrigatória'),
			date: z.coerce.date().optional(),
			accountId: objectIdSchema,
			destinationAccountId: objectIdSchema.optional(),
		});

		const parsed = bodySchema.safeParse(request.body);
		if (!parsed.success) {
			return reply.status(400).send({ error: parsed.error.issues[0]?.message });
		}

		const {
			description,
			amount,
			type,
			category,
			date,
			accountId,
			destinationAccountId,
		} = parsed.data;

		if (type === 'TRANSFER') {
			if (!destinationAccountId) {
				return reply.status(400).send({ error: 'Informe a conta de destino' });
			}
			if (destinationAccountId === accountId) {
				return reply.status(400).send({ error: 'Origem e destino devem ser diferentes' });
			}
		}

		const originAccount = await prisma.account.findUnique({ where: { id: accountId } });
		if (!originAccount) {
			return reply.status(404).send({ error: 'Conta de origem não encontrada' });
		}

		if (type === 'TRANSFER' && destinationAccountId) {
			const destAccount = await prisma.account.findUnique({
				where: { id: destinationAccountId },
			});
			if (!destAccount) {
				return reply.status(404).send({ error: 'Conta de destino não encontrada' });
			}
		}

		const transaction = await prisma.$transaction(async (tx) => {
			const created = await tx.transaction.create({
				data: {
					description,
					amount,
					type,
					category,
					date: date ?? new Date(),
					accountId,
					destinationAccountId: type === 'TRANSFER' ? destinationAccountId : null,
				},
			});

			await tx.account.update({
				where: { id: accountId },
				data: {
					balance: type === 'INCOME' ? { increment: amount } : { decrement: amount },
				},
			});

			if (type === 'TRANSFER' && destinationAccountId) {
				await tx.account.update({
					where: { id: destinationAccountId },
					data: { balance: { increment: amount } },
				});
			}

			return created;
		});

		return reply.status(201).send({ transaction });
	});
}