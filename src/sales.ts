import type { DatabaseSync } from "node:sqlite";
import { attributeSale } from "./attribution.ts";
import { transaction } from "./db.ts";

export type OrderInput = {
  id: string;
  total_cents: number;
  status: "paid";
  coupon: string | null;
  utm_content: string | null;
};

export type RefundInput = { id: string; order_id: string; amount_cents: number };

type Order = OrderInput & ReturnType<typeof attributeSale> & { received_at: string };

type Refund = RefundInput & {
  sequence: number;
  applied_cents: number | null;
  received_at: string;
  applied_at: string | null;
};

export class SalesError extends Error {
  constructor(message: string, public status: 400 | 404 | 409) {
    super(message);
  }
}

function findOrder(db: DatabaseSync, id: string) {
  return db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as Order | undefined;
}

export function getRefunds(db: DatabaseSync, orderId: string): Refund[] {
  return db.prepare("SELECT * FROM refunds WHERE order_id = ? ORDER BY sequence").all(orderId) as Refund[];
}

export function getOrder(db: DatabaseSync, id: string) {
  const order = findOrder(db, id);
  if (!order) throw new SalesError("pedido não encontrado", 404);
  const refunds = getRefunds(db, id);
  const refundedCents = refunds.reduce((total, refund) => total + (refund.applied_cents ?? 0), 0);
  const netCents = order.total_cents - refundedCents;
  return {
    ...order,
    refunded_cents: refundedCents,
    net_cents: netCents,
    attributed_cents: order.creator_id ? netCents : 0,
    refunds,
  };
}

function applyPendingRefunds(db: DatabaseSync, orderId: string, now: string): void {
  const order = findOrder(db, orderId);
  if (!order) return;
  const refunds = getRefunds(db, orderId);
  let remaining = order.total_cents;
  for (const refund of refunds) remaining -= refund.applied_cents ?? 0;

  for (const refund of refunds) {
    if (refund.applied_cents !== null) continue;
    const applied = Math.min(refund.amount_cents, remaining);
    db.prepare("UPDATE refunds SET applied_cents = ?, applied_at = ? WHERE sequence = ?")
      .run(applied, now, refund.sequence);
    remaining -= applied;
  }
}

export function receiveOrder(db: DatabaseSync, input: OrderInput, now: string) {
  return transaction(db, () => {
    const existing = findOrder(db, input.id);
    if (existing) {
      if (existing.total_cents !== input.total_cents || existing.status !== input.status ||
          existing.coupon !== input.coupon || existing.utm_content !== input.utm_content) {
        throw new SalesError("pedido já recebido com outros dados", 409);
      }
      return { duplicate: true, order: getOrder(db, input.id) };
    }

    const attribution = attributeSale(input.coupon, input.utm_content);
    db.prepare(`
      INSERT INTO orders (id, total_cents, status, coupon, utm_content, creator_id, attribution_source, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, input.total_cents, input.status, input.coupon, input.utm_content,
      attribution.creator_id, attribution.attribution_source, now);
    applyPendingRefunds(db, input.id, now);
    return { duplicate: false, order: getOrder(db, input.id) };
  });
}

export function receiveRefund(db: DatabaseSync, input: RefundInput, now: string) {
  return transaction(db, () => {
    const existing = db.prepare("SELECT * FROM refunds WHERE order_id = ? AND id = ?")
      .get(input.order_id, input.id) as Refund | undefined;
    if (existing && existing.amount_cents !== input.amount_cents) {
      throw new SalesError("estorno já recebido com outro valor", 409);
    }
    if (!existing) {
      db.prepare("INSERT INTO refunds (id, order_id, amount_cents, received_at) VALUES (?, ?, ?, ?)")
        .run(input.id, input.order_id, input.amount_cents, now);
      applyPendingRefunds(db, input.order_id, now);
    }
    const refund = db.prepare("SELECT * FROM refunds WHERE order_id = ? AND id = ?")
      .get(input.order_id, input.id) as Refund;
    return { duplicate: Boolean(existing), refund };
  });
}
