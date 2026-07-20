import { createServer } from './http/server.js';
import { config } from './config.js';

const app = createServer();
app.listen(config.port, () => {
  console.log(`Integrator API listening on :${config.port}`);
});
