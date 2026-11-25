import { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authenticate } from '../middlewares/authenticate.js';

const objectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, 'ID inválido');

function addMonths(month: number, year: number, offset: number) {
  const totalMonths = year * 12 + (month - 1) + offset;
	return {
		year: Math.floor(totalMonths / 12),
		month: (totalMonths % 12) + 1,
	};
}

export async function cardRoutes(app: FastifyInstance) {
	app.addHook('preHandler', authenticate);

	app.get('/', async () => {
		const cards = await prisma.creditCard.findMany({
			include: {
				invoices: {
					orderBy: [{ year: 'asc' }, { month: 'asc' }],
				},
			},
			orderBy: { name: 'asc' },
		});

		return { cards };
	});

	app.post('/', async ( request, reply) => {
		const schema = z.object({
			name: z.string().min(2, 'Nome do cartão obrigatório'),
			limit: z.number().positive('Limite deve ser maior que zero'),
			closingDay: z.number().int().min(1).max(31),
			dueDay: z.number().int().min(1).max(31),
		});

		const parsed = schema.safeParse(request.body);
		if (!parsed.success) {
			return reply.status(400).send({ error: parsed.error.issues[0]?.message });
		}

		const card = await prisma.creditCard.create({
			data: parsed.data,
		});

		return reply.status(201).send({ card });
	});

	app.get('/:id/invoices', async (request, reply) => {
		const paramsSchema = z.object({ id: objectIdSchema });
		const parsedParams = paramsSchema.safeParse(request.params);
		if (!parsedParams.success) {
			return reply.status(400).send({ error: 'ID do cartão inválido' });
		}

		const card = await prisma.creditCard.findUnique({
			where: { id: parsedParams.data.id },
			include: {
				invoices: {
					orderBy: [{ year: 'desc' }, { month: 'desc' }],
					include: {
						transactions: { orderBy: { date: 'desc' } },
					},
				},
			},
		});

		if (!card) {
			return reply.status(404).send({ error: 'Cartão não encontrado' });
		}

		return { card };
	});

	app.post('/:id/purchases', async (request, reply) => {
		const paramsSchema = z.object({ id: objectIdSchema });
		const parsedParams = paramsSchema.safeParse(request.params);
		if (!parsedParams.success) {
			return reply.status(400).send({ error: 'ID do cartão inválido' });
		}

		const bodySchema = z.object({
			description: z.string().min(1, 'Descrição obrigatória'),
			amount: z.number().positive('Valor deve ser maior que zero'),
			category: z.string().min(1, 'Categoria obrigatória'),
			installments: z.number().int().min(1).max(48).default(1),
			date: z.coerce.date().optional(),
		});

		const parsedBody = bodySchema.safeParse(request.body);
		if (!parsedBody.success) {
			return reply.status(400).send({ error: parsedBody.error.issues[0]?.message });
		}

		const card = await prisma.creditCard.findUnique({
			where: { id: parsedParams.data.id },
		});
		if (!card) {
			return reply.status(404).send({ error: 'Cartão não encontrado' });
		}

		const { description, amount, category, installments, date } = parsedBody.data;
		const purchaseDate = date ?? new Date();
		const initialOffset = purchaseDate.getUTCDate() >= card.closingDay ? 1: 0;
		const baseMonth = purchaseDate.getUTCMonth() + 1;
		const baseYear = purchaseDate.getUTCFullYear();

		const baseParcel = Math.floor((amount / installments) * 100) /100;
		const remainder = Number((amount - baseParcel * installments).toFixed(2));
		const groupId = installments > 1 ? randomUUID() : null;

		const createdTransactions = await prisma.$transaction(async (tx) => {
			const results = [];

			for (let i = 0; i < installments; i++) {
				const { month, year } = addMonths(baseMonth, baseYear, initialOffset + i);
				const parcelAmount = 
					i === 0 ? Number((baseParcel + remainder).toFixed(2)) : baseParcel;

				const invoice = await tx.invoice.upsert({
					where: {
						creditCardId_month_year: {
							creditCardId: card.id,
							month,
							year,
						},
					},
					update: {
						totalAmount: { increment: parcelAmount },
					},
					create: {
						creditCardId: card.id,
						month,
						year,
						totalAmount: parcelAmount,
					},
				});

				const item = await tx.transaction.create({
					data: {
						description,
						amount: parcelAmount,
						type: 'EXPENSE',
						category,
						date: purchaseDate,
						isInstallment: installments > 1,
						installmentNumber: installments > 1 ? i + 1 : null,
						totalInstallments: installments > 1 ? installments : null,
						installmentGroupId: groupId,
						invoiceId: invoice.id,
					},
				});

				results.push(item);
			}

			return results;
		});

		return reply.status(201).send({ transactions: createdTransactions });
	});

	app.post('/invoices/:invoiceId/pay', async (request, reply) => {
		const paramsSchema = z.object({ invoiceId: objectIdSchema });
		const parsedParams = paramsSchema.safeParse(request.params);
		if (!parsedParams.success) {
			return reply.status(400).send({ error: 'ID da fatura inválido' });
		}

		const bodySchema = z.object({
			accountId: objectIdSchema,
		});
		const parsedBody = bodySchema.safeParse(request.body);
		if (!parsedBody.success) {
			return reply.status(400).send({ error: 'ID da conta inválido' });
		}

		const invoice = await prisma.invoice.findUnique({
			where: { id: parsedParams.data.invoiceId },
		});
		if (!invoice) {
			return reply.status(404).send({ error: 'Fatura não encontrada' });
		}
		if (invoice.status === 'PAID') {
			return reply.status(400).send({ error: 'Esta fatura já foi paga' });
		}

		const account = await prisma.account.findUnique({
			where: { id: parsedBody.data.accountId },
		});
		if (!account) {
			return reply.status(404).send({ error: 'Conta não encontrada' });
		}

		const updateInvoice = await prisma.$transaction(async (tx) => {
			const paid = await tx.invoice.update({
				where: { id: invoice.id },
				data: { status: 'PAID' },
			});

			if (invoice.totalAmount > 0) {
				await tx.account.update({
					where: { id: account.id },
					data: { balance: { decrement: invoice.totalAmount } },
				});
			}

			return paid;
		});

		return { invoice: updateInvoice };
	});
}