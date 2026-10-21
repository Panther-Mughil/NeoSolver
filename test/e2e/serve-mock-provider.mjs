#!/usr/bin/env node
/**
 * Standalone OpenAI-compatible mock provider, used by the recorded end-to-end
 * transcript:
 *
 *   node test/e2e/serve-mock-provider.mjs &
 *   NEOSOLVER_PROVIDER_URL=http://127.0.0.1:8899 ...
 *
 * The port defaults to 8899 and can be overridden with MOCK_PORT.
 */

import { createMockProvider } from '../helpers/mock-provider.mjs';

const port = Number(process.env.MOCK_PORT ?? 8899);
const { server } = createMockProvider();

server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  process.stdout.write(
    `mock provider listening on http://127.0.0.1:${boundPort}/v1/chat/completions\n`,
  );
});

const stop = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
