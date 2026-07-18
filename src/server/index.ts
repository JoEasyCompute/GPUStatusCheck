import { buildApp } from "./app";
import { loadConfig } from "./config";
import { createDatabase } from "./db";

const config = loadConfig();
const db = createDatabase(config.dbPath);
db.migrate();

const app = buildApp({ db, config });

app.listen({ host: "127.0.0.1", port: config.port }).then(() => {
  console.log(`GPU dashboard listening on http://127.0.0.1:${config.port}`);
  console.log(`Inventory: ${config.machinesPath}`);
  console.log(`Database: ${config.dbPath}`);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
