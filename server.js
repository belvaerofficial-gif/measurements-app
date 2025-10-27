require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(bodyParser.json());
app.use(cors());
// serve the measurements page directly
app.get('/measurements.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'measurements.html'));
});

const SHOP = process.env.SHOP;
const TOKEN = process.env.ADMIN_TOKEN;
const API_VER = process.env.API_VERSION || '2025-07';

async function adminRequest(path, method = 'GET', body = null) {
  const url = `https://${SHOP}/admin/api/${API_VER}${path}`;
  const opts = {
    method,
    headers: {
      'X-Shopify-Access-Token': TOKEN,
      'Content-Type': 'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// --- ROUTES ---

app.get('/apps/measurements/test', (req, res) => {
  res.json({ ok: true, shop: SHOP });
});

app.get('/apps/measurements/list', async (req, res) => {
  const id = req.query.customer_id;
  if (!id) return res.status(400).json({ error: 'customer_id required' });
  const r = await adminRequest(`/customers/${id}/metafields.json`);
  const mf = (r.metafields || []).find(m => m.namespace === 'measurements' && m.key === 'list');
  const data = mf ? JSON.parse(mf.value) : [];
  res.json({ data });
});

app.post('/apps/measurements/save', async (req, res) => {
  const { customer_id, id, label, neck, chest, waist, hip } = req.body;
  if (!customer_id) return res.status(400).json({ error: 'customer_id required' });
  const r = await adminRequest(`/customers/${customer_id}/metafields.json`);
  const mf = (r.metafields || []).find(m => m.namespace === 'measurements' && m.key === 'list');
  let data = mf ? JSON.parse(mf.value) : [];
  if (id) data = data.map(x => x.id === id ? { ...x, label, neck, chest, waist, hip } : x);
  else data.push({ id: Date.now().toString(), label, neck, chest, waist, hip });

  const payload = {
    metafield: { namespace: 'measurements', key: 'list', value: JSON.stringify(data), type: 'json' }
  };

  if (mf) await adminRequest(`/metafields/${mf.id}.json`, 'PUT', payload);
  else await adminRequest(`/customers/${customer_id}/metafields.json`, 'POST', payload);

  res.json({ ok: true });
});

app.post('/apps/measurements/delete', async (req, res) => {
  const { customer_id, id } = req.body;
  const r = await adminRequest(`/customers/${customer_id}/metafields.json`);
  const mf = (r.metafields || []).find(m => m.namespace === 'measurements' && m.key === 'list');
  if (!mf) return res.json({ ok: true });
  const data = JSON.parse(mf.value).filter(x => x.id !== id);
  await adminRequest(`/metafields/${mf.id}.json`, 'PUT', {
    metafield: { id: mf.id, value: JSON.stringify(data), type: 'json' }
  });
  res.json({ ok: true });
});

const port = process.env.PORT || 3000;
// Ensure fetch is available (Node 18+ has global.fetch; otherwise use node-fetch)
const fetch = global.fetch || require('node-fetch');

app.get('/apps/measurements/selected', async (req, res) => {
  try {
    const shop = (req.query.shop || process.env.SHOP || '').replace(/^https?:\/\//, '');
    const customer_id = req.query.customer_id;

    if (!shop) return res.status(400).json({ ok: false, error: 'Missing shop' });
    if (!customer_id) return res.status(400).json({ ok: false, error: 'Missing customer_id' });

    const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
    const API_VERSION = process.env.API_VERSION || '2025-10';

    if (!ADMIN_TOKEN) return res.status(500).json({ ok: false, error: 'Admin token not configured' });

    const url = `https://${shop}/admin/api/${API_VERSION}/customers/${encodeURIComponent(customer_id)}/metafields.json`;
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': ADMIN_TOKEN,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error('Shopify metafields fetch failed', resp.status, text);
      return res.status(resp.status).send(text);
    }

    const json = await resp.json();
    const metafields = Array.isArray(json.metafields) ? json.metafields : [];

    const measurementMeta = metafields.find(m => m.namespace === 'measurements' && (m.key === 'selected' || m.key === 'measurement'));
    const anyMeasurement = metafields.some(m => m.namespace === 'measurements');

    if (measurementMeta) {
      return res.json({ ok: true, selected: measurementMeta.value });
    } else if (anyMeasurement) {
      return res.json({ ok: true, selected: true });
    } else {
      return res.json({ ok: false });
    }
  } catch (err) {
    console.error('Error in /apps/measurements/selected:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(port, () => console.log(`Server running on port ${port}`));
