import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { openDatabase } from "./db.ts";

const db = openDatabase(process.env.DATABASE_PATH ?? "data/sales.sqlite");
const app = createApp(db);
const port = Number(process.env.PORT ?? 3005);

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
  console.log(`vendas atribuídas em http://127.0.0.1:${info.port}`);
});

function shutdown(): void {
  server.close(() => db.close());
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
