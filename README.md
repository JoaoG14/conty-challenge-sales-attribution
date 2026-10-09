## Nota para quem avalia

`src/attribution.ts` define a regra de atribuição e os criadores de exemplo. `src/sales.ts` recebe os pedidos e estornos, evita duplicações e aplica os estornos pendentes quando o pedido chega. `src/db.ts` define as tabelas e as transações. `test/sales.test.ts` verifica o desempate entre cupom e UTM, pedidos duplicados, estornos parciais, totais, repetidos e antecipados, o limite do valor aplicado e a persistência após reabrir o banco.

Cupom conhecido tem prioridade sobre UTM. Sem cupom conhecido, vale `utm_content`. Sem correspondência, a venda fica sem criador. Um estorno reduz o valor atribuído sem apagar o criador original nem o histórico; a soma aplicada nunca passa do total do pedido.

Com mais tempo, implementaria:

- Integração real com Shopify
- Cadastro de criadores no banco
- Autenticação da API

Defini o escopo e arquitetura e usei IA para implementar

Revisei a prioridade do cupom sobre a UTM. Também conferi se estornos recebidos antes do pedido ficam pendentes e são aplicados sem ultrapassar o valor da venda nem apagar o histórico

## Como rodar

Node 22 atualizado (22.13 ou superior).

```bash
npm ci
npm test
npm run typecheck
npm run dev
```

A API sobe em `http://127.0.0.1:3005`
O banco fica em `data/sales.sqlite`

## Exemplo de Request e Response

Envie um pedido pago. O formato é reduzido e aceita apenas `status: "paid"`, para uma loja e uma moeda. Os valores são inteiros em centavos; `10000` representa R$ 100,00.

Os criadores de exemplo são `crt_ana` (cupom `ANA10`, UTM `ana`) e `crt_bruno` (cupom `BRUNO10`, UTM `bruno`). Cupom e UTM são opcionais. Neste pedido, o cupom aponta para Ana e a UTM para Bruno; a venda fica com Ana.

```bash
curl -s -X POST localhost:3005/webhooks/orders \
  -H 'content-type: application/json' \
  -d '{"id":"order_1","total_cents":10000,"status":"paid","coupon":"ANA10","utm_content":"bruno"}'
```

Resposta `201` (a data é gerada pelo servidor):

```json
{
  "duplicate": false,
  "order": {
    "id": "order_1",
    "total_cents": 10000,
    "status": "paid",
    "coupon": "ANA10",
    "utm_content": "bruno",
    "creator_id": "crt_ana",
    "attribution_source": "coupon",
    "received_at": "2026-10-09T18:00:00.000Z",
    "refunded_cents": 0,
    "net_cents": 10000,
    "attributed_cents": 10000,
    "refunds": []
  }
}
```

Repetir esse pedido retorna `200`, com `duplicate: true`, sem somar a venda novamente. Reutilizar o ID com dados diferentes retorna `409`.

Envie um estorno parcial e consulte o pedido. Os próximos exemplos usam `jq` só para mostrar os campos principais da resposta.

```bash
curl -s -X POST localhost:3005/webhooks/refunds \
  -H 'content-type: application/json' \
  -d '{"id":"refund_1","order_id":"order_1","amount_cents":3000}' \
  | jq '{duplicate, refund: (.refund | {id, amount_cents, applied_cents})}'
# {"duplicate":false,"refund":{"id":"refund_1","amount_cents":3000,"applied_cents":3000}}

curl -s localhost:3005/orders/order_1 \
  | jq '{creator_id, refunded_cents, net_cents, attributed_cents}'
# {"creator_id":"crt_ana","refunded_cents":3000,"net_cents":7000,"attributed_cents":7000}
```

Repetir `refund_1` retorna `200`, com `duplicate: true`, e mantém os mesmos valores. Um novo estorno do mesmo pedido precisa de outro ID e informa apenas o valor daquela devolução, não o total acumulado. Reutilizar o ID com outro valor retorna `409`.

`amount_cents` preserva o valor recebido; `applied_cents` mostra quanto foi aplicado, limitado ao saldo da venda. No estorno total, `attributed_cents` fica em zero e o histórico permanece.

Um estorno também pode chegar antes do pedido. Ele fica salvo com `applied_cents: null` e é aplicado quando o pedido chega:

```bash
curl -s -X POST localhost:3005/webhooks/refunds \
  -H 'content-type: application/json' \
  -d '{"id":"refund_2","order_id":"order_2","amount_cents":2000}' \
  | jq '.refund | {applied_cents, applied_at}'
# {"applied_cents":null,"applied_at":null}

curl -s localhost:3005/orders/order_2/refunds | jq

curl -s -X POST localhost:3005/webhooks/orders \
  -H 'content-type: application/json' \
  -d '{"id":"order_2","total_cents":5000,"status":"paid","utm_content":"bruno"}' \
  | jq '.order | {creator_id, refunded_cents, attributed_cents}'
# {"creator_id":"crt_bruno","refunded_cents":2000,"attributed_cents":3000}
```
