import { buildApp } from "./app";
import { adminKeyWarning } from "./adminAuth";
import { loadConfig } from "./config";
import { createDatabase } from "./db";

const config = loadConfig();
const keyWarning = adminKeyWarning(config.adminApiKey);
if (keyWarning) {
  console.warn(keyWarning);
}
const db = createDatabase(config.dbPath);
db.migrate();

const app = buildApp({ db, config });

app.listen({ host: config.host, port: config.port }).then(() => {
  console.log(`GPU dashboard listening on http://${config.host}:${config.port}`);
  console.log(`Inventory: ${config.machinesPath}`);
  console.log(`Database: ${config.dbPath}`);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
