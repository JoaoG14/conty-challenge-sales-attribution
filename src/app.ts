import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { Context } from "hono";
import { getOrder, getRefunds, receiveOrder, receiveRefund, SalesError } from "./sales.ts";

async function readBody(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new SalesError("corpo deve ser um objeto JSON", 400);
  }
  return body as Record<string, unknown>;
}

function requiredText(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) throw new SalesError(`${field} é obrigatório`, 400);
  return value.trim();
}

function optionalText(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new SalesError(`${field} deve ser texto`, 400);
  return value.trim() || null;
}

function cents(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new SalesError(`${field} deve ser um inteiro positivo em centavos`, 400);
  }
  return value;
}

export function createApp(db: DatabaseSync, now: () => Date = () => new Date()) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof SalesError) return c.json({ error: error.message }, error.status);
    console.error(error);
    return c.json({ error: "erro interno" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/webhooks/orders", async (c) => {
    const body = await readBody(c);
    if (body.status !== "paid") throw new SalesError("este webhook aceita apenas pedidos com status paid", 400);
    const result = receiveOrder(db, {
      id: requiredText(body, "id"),
      total_cents: cents(body, "total_cents"),
      status: "paid",
      coupon: optionalText(body, "coupon")?.toUpperCase() ?? null,
      utm_content: optionalText(body, "utm_content")?.toLowerCase() ?? null,
    }, now().toISOString());
    return c.json(result, result.duplicate ? 200 : 201);
  });

  app.post("/webhooks/refunds", async (c) => {
    const body = await readBody(c);
    const result = receiveRefund(db, {
      id: requiredText(body, "id"),
      order_id: requiredText(body, "order_id"),
      amount_cents: cents(body, "amount_cents"),
    }, now().toISOString());
    return c.json(result, result.duplicate ? 200 : 201);
  });

  app.get("/orders/:id", (c) => c.json(getOrder(db, c.req.param("id"))));
  app.get("/orders/:id/refunds", (c) => c.json({ refunds: getRefunds(db, c.req.param("id")) }));
  return app;
}
