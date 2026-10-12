import express from 'express';

import { isEnterpriseMode } from '../enterprise-mode.js';
import { callDaemon } from './mcpx-daemon.js';
import {
  MCPX_SECRETS_ENTERPRISE_REFUSAL,
  declineSecretRequest,
  listSecretRequests,
  listSecrets,
  storeSecret,
} from './mcpx-secrets.js';

// A body that fails to parse can carry the secret inside the error object, and
// the framework logs the errors it is handed. These answers stay here, so the
// body never reaches a log.
const parseSecretBody = express.json({ limit: '64kb' });
const readSecretBody = (req, res, next) => parseSecretBody(req, res, (error) => {
  if (!error) return next();
  if (error.status === 413) return res.status(413).json({ error: 'The secret value is too large' });
  return res.status(400).json({ error: 'Send the secret as a JSON object with a value' });
});

const secretResponse = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

// Enterprise mode keeps secrets out of OpenChamber. This refuses before the body is read.
const refuseSecretsInEnterpriseMode = (_req, res, next) => (
  isEnterpriseMode() ? res.status(403).json(MCPX_SECRETS_ENTERPRISE_REFUSAL) : next()
);

export const registerMcpxRoutes = (app) => {
  // 1. GET /api/mcpx/status
  app.get('/api/mcpx/status', async (_req, res) => {
    try {
      const status = await callDaemon('/v1/status');
      res.json(status);
    } catch (err) {
      res.status(502).json({ error: err.message || 'mcpx daemon unreachable' });
    }
  });

  // 2. GET /api/mcpx/namespaces
  app.get('/api/mcpx/namespaces', async (_req, res) => {
    try {
      const namespaces = await callDaemon('/v1/namespaces');
      res.json(namespaces);
    } catch (err) {
      res.status(502).json({ error: err.message || 'mcpx daemon unreachable' });
    }
  });

  // 3. GET /api/mcpx/tools
  app.get('/api/mcpx/tools', async (req, res) => {
    try {
      const query = req.query.ns ? `?ns=${encodeURIComponent(req.query.ns)}` : '';
      const tools = await callDaemon(`/v1/tools${query}`);
      res.json(tools);
    } catch (err) {
      res.status(502).json({ error: err.message || 'mcpx daemon unreachable' });
    }
  });

  // 4. GET /api/mcpx/types
  app.get('/api/mcpx/types', async (req, res) => {
    try {
      const query = req.query.namespace ? `?namespace=${encodeURIComponent(req.query.namespace)}` : '';
      const types = await callDaemon(`/v1/types${query}`);
      res.json({ types });
    } catch (err) {
      res.status(502).json({ error: err.message || 'mcpx daemon unreachable' });
    }
  });

  // 5. GET /api/mcpx/log
  app.get('/api/mcpx/log', async (req, res) => {
    try {
      const query = req.query.since ? `?since=${encodeURIComponent(req.query.since)}` : '';
      const log = await callDaemon(`/v1/log${query}`);
      res.json(log);
    } catch (err) {
      res.status(502).json({ error: err.message || 'mcpx daemon unreachable' });
    }
  });

  // Secret prompts. The daemon keeps the values in memory; this server only
  // relays them, so no response or log here may carry a value.
  app.get('/api/mcpx/secret-requests', secretResponse, refuseSecretsInEnterpriseMode, async (_req, res) => {
    const outcome = await listSecretRequests();
    res.status(outcome.status).json(outcome.body);
  });

  app.get('/api/mcpx/secrets', secretResponse, refuseSecretsInEnterpriseMode, async (_req, res) => {
    const outcome = await listSecrets();
    res.status(outcome.status).json(outcome.body);
  });

  app.put('/api/mcpx/secrets/:name', secretResponse, refuseSecretsInEnterpriseMode, readSecretBody, async (req, res) => {
    const outcome = await storeSecret(req.params.name, req.body?.value);
    res.status(outcome.status).json(outcome.body);
  });

  app.delete('/api/mcpx/secret-requests/:id', secretResponse, refuseSecretsInEnterpriseMode, async (req, res) => {
    const outcome = await declineSecretRequest(req.params.id);
    res.status(outcome.status).json(outcome.body);
  });
};
