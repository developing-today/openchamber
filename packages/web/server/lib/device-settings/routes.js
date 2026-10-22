import express from 'express';

/**
 * `PUT /api/config/device-settings`: a window reports its device settings
 * (`store.js`). `GET` lists what the windows reported, for the agent tool and
 * for diagnostics. Both sit behind the same UI auth as `/api/config/settings`.
 */
export const registerDeviceSettingsRoutes = (app, { store }) => {
  app.put('/api/config/device-settings', express.json({ limit: '128kb' }), (req, res) => {
    const result = store.report(req.body);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.status(204).end();
  });

  app.get('/api/config/device-settings', (_req, res) => {
    res.json({ devices: store.list() });
  });
};
