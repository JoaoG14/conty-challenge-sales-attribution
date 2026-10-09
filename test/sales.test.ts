import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import type { getOrder } from "../src/sales.ts";

type Order = ReturnType<typeof getOrder>;
const order = { id: "order_1", total_cents: 10000, status: "paid", coupon: "ANA10", utm_content: "bruno" };
const refund = { id: "refund_1", order_id: "order_1", amount_cents: 3000 };

describe("atribuição de vendas", () => {
  let db: DatabaseSync;
  let app: ReturnType<typeof createApp>;
  let time: string;
  let directory: string | undefined;

  beforeEach(() => {
    time = "2026-10-09T18:00:00.000Z";
    db = openDatabase();
    app = createApp(db, () => new Date(time));
  });

  afterEach(() => {
    db.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  function post(path: string, body: unknown) {
    return app.request(`/webhooks/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function read(): Promise<Order> {
    const response = await app.request("/orders/order_1");
    expect(response.status).toBe(200);
    return response.json() as Promise<Order>;
  }

  it.each([
    ["ANA10", "bruno", "crt_ana", "coupon"],
    [null, "bruno", "crt_bruno", "utm"],
    ["UNKNOWN", "ana", "crt_ana", "utm"],
    ["UNKNOWN", "unknown", null, null],
  ])("atribui cupom %s e UTM %s a %s", async (coupon, utm, creator, source) => {
    expect((await post("orders", { ...order, coupon, utm_content: utm })).status).toBe(201);
    expect(await read()).toMatchObject({
      creator_id: creator,
      attribution_source: source,
      attributed_cents: creator ? 10000 : 0,
      net_cents: 10000,
      refunds: [],
    });
  });

  it("não duplica o pedido, inclusive após normalizar cupom e UTM", async () => {
    expect((await post("orders", order)).status).toBe(201);
    const before = await read();
    const response = await post("orders", { ...order, coupon: " ana10 ", utm_content: " BRUNO " });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ duplicate: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM orders").get()).toEqual({ count: 1 });
    expect(await read()).toEqual(before);
  });

  it("aplica estorno parcial sem apagar a atribuição original", async () => {
    await post("orders", order);
    time = "2026-10-12T18:00:00.000Z";
    expect((await post("refunds", refund)).status).toBe(201);
    expect(await read()).toMatchObject({
      creator_id: "crt_ana", attribution_source: "coupon", total_cents: 10000,
      refunded_cents: 3000, net_cents: 7000, attributed_cents: 7000,
      refunds: [{ ...refund, applied_cents: 3000, received_at: time, applied_at: time }],
    });
  });

  it("zera a venda no estorno total e mantém o histórico", async () => {
    await post("orders", order);
    await post("refunds", { ...refund, amount_cents: 10000 });
    const result = await read();
    expect(result).toMatchObject({ creator_id: "crt_ana", refunded_cents: 10000, attributed_cents: 0, net_cents: 0 });
    expect(result.refunds).toHaveLength(1);
    expect((await post("orders", order)).status).toBe(200);
    expect(await read()).toEqual(result);
  });

  it("não reaplica um estorno repetido", async () => {
    await post("orders", order);
    await post("refunds", refund);
    const before = await read();
    time = "2026-10-13T18:00:00.000Z";
    const response = await post("refunds", refund);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ duplicate: true });
    expect(await read()).toEqual(before);
  });

  it("limita a soma dos estornos e registra o excesso recebido", async () => {
    await post("orders", order);
    await post("refunds", refund);
    await post("refunds", { ...refund, id: "refund_2", amount_cents: 9000 });
    await post("refunds", { ...refund, id: "refund_3", amount_cents: 500 });
    const result = await read();
    expect(result).toMatchObject({ refunded_cents: 10000, net_cents: 0, attributed_cents: 0 });
    expect(result.refunds.map((item) => [item.amount_cents, item.applied_cents])).toEqual([
      [3000, 3000], [9000, 7000], [500, 0],
    ]);
  });

  it("guarda vários estornos pendentes e aplica uma vez, na ordem de chegada", async () => {
    const response = await post("refunds", refund);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ refund: { applied_cents: null, applied_at: null } });
    expect((await post("refunds", refund)).status).toBe(200);
    await post("refunds", { ...refund, id: "refund_2", amount_cents: 8000 });
    expect((await app.request("/orders/order_1")).status).toBe(404);
    const pending = await (await app.request("/orders/order_1/refunds")).json() as { refunds: unknown[] };
    expect(pending.refunds).toHaveLength(2);

    time = "2026-10-12T18:00:00.000Z";
    await post("orders", order);
    const result = await read();
    expect(result).toMatchObject({ refunded_cents: 10000, attributed_cents: 0, net_cents: 0 });
    expect(result.refunds.map((item) => item.applied_cents)).toEqual([3000, 7000]);
    expect(result.refunds[0]).toMatchObject({ received_at: "2026-10-09T18:00:00.000Z", applied_at: time });
    await post("refunds", refund);
    await post("orders", order);
    expect(await read()).toEqual(result);
  });

  it("rejeita pedido com ID repetido e valor alterado", async () => {
    await post("orders", order);
    const before = await read();
    expect((await post("orders", { ...order, total_cents: 20000 })).status).toBe(409);
    expect(await read()).toEqual(before);
  });

  it("rejeita valor alterado no mesmo estorno, inclusive quando pendente", async () => {
    await post("refunds", refund);
    expect((await post("refunds", { ...refund, amount_cents: 7000 })).status).toBe(409);
    await post("orders", order);
    expect((await post("refunds", { ...refund, amount_cents: 7000 })).status).toBe(409);
    expect((await read()).refunded_cents).toBe(3000);
  });

  it("isola estornos de pedidos diferentes, mesmo com o mesmo ID de estorno", async () => {
    await post("orders", order);
    await post("orders", { ...order, id: "order_2", coupon: "BRUNO10" });
    await post("refunds", refund);
    await post("refunds", { ...refund, order_id: "order_2", amount_cents: 6000 });
    expect((await read()).net_cents).toBe(7000);
    expect(await (await app.request("/orders/order_2")).json()).toMatchObject({ creator_id: "crt_bruno", net_cents: 4000 });
  });

  it("mantém venda sem criador sem atribuição depois de um estorno", async () => {
    await post("orders", { ...order, coupon: null, utm_content: null });
    await post("refunds", refund);
    expect(await read()).toMatchObject({ creator_id: null, attributed_cents: 0, net_cents: 7000 });
  });

  it.each([0, -1, 1.5, "100", Number.MAX_SAFE_INTEGER + 1])("rejeita valor inválido: %s", async (amount) => {
    expect((await post("orders", { ...order, total_cents: amount })).status).toBe(400);
    expect((await post("refunds", { ...refund, amount_cents: amount })).status).toBe(400);
    expect((await app.request("/orders/order_1")).status).toBe(404);
    expect(await (await app.request("/orders/order_1/refunds")).json()).toEqual({ refunds: [] });
  });

  it.each([
    { id: " " }, { status: "pending" }, { coupon: 123 },
  ])("rejeita pedido inválido: %j", async (changes) => {
    expect((await post("orders", { ...order, ...changes })).status).toBe(400);
  });

  it("rejeita estorno sem ID do pedido", async () => {
    expect((await post("refunds", { ...refund, order_id: " " })).status).toBe(400);
  });

  it("rejeita JSON malformado", async () => {
    for (const path of ["orders", "refunds"]) {
      const response = await app.request(`/webhooks/${path}`, { method: "POST", body: "{" });
      expect(response.status).toBe(400);
    }
  });

  it("mantém pendências e idempotência depois de reabrir o banco", async () => {
    directory = mkdtempSync(join(tmpdir(), "conty-sales-"));
    const path = join(directory, "sales.sqlite");
    db.close();
    db = openDatabase(path);
    app = createApp(db);
    await post("refunds", refund);
    db.close();
    db = openDatabase(path);
    app = createApp(db);
    await post("orders", order);
    const before = await read();
    expect(before.attributed_cents).toBe(7000);
    db.close();
    db = openDatabase(path);
    app = createApp(db);
    expect((await post("orders", order)).status).toBe(200);
    expect((await post("refunds", refund)).status).toBe(200);
    expect(await read()).toEqual(before);
  });
});
