// server.js - cleaned + fixed version
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

// Safe fetch: use global fetch if available (Node 18+/22+), otherwise require node-fetch
let fetchFn;
if (typeof globalThis.fetch === 'function') {
  fetchFn = globalThis.fetch;
} else {
  // eslint-disable-next-line global-require
  fetchFn = require('node-fetch');
}
const fetch = fetchFn;

const app = express();
app.use(bodyParser.json());
app.use(cors());

// serve the measurements page directly (for direct access during testing)
app.get('/measurements.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'measurements.html'));
});

// Helper that performs Admin REST requests for any shop you pass in
async function adminRequestForShop(shop, path, method = 'GET', body = null, apiVersion = '2025-10') {
  const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
  if (!ADMIN_TOKEN) throw new Error('ADMIN_TOKEN not configured in env');

  const url = `https://${shop}/admin/api/${apiVersion}${path}`;
  const opts = {
    method,
    headers: {
      'X-Shopify-Access-Token': ADMIN_TOKEN,
      'Content-Type': 'application/json'
    }
  };
  if (body !== null) opts.body = JSON.stringify(body);

  const r = await fetch(url, opts);
  const txt = await r.text().catch(() => null);
  try {
    return { ok: r.ok, status: r.status, body: JSON.parse(txt) };
  } catch (e) {
    return { ok: r.ok, status: r.status, body: txt };
  }
}

// GET selected measurements for a customer (tries metaobjects then metafields)
app.get('/apps/measurements/selected', async (req, res) => {
  try {
    const shopFromReq = (req.query.shop || '').toString().replace(/^https?:\/\//, '').trim();
    const shop = shopFromReq || (process.env.SHOP || '').replace(/^https?:\/\//, '').trim();
    const customer_id = req.query.customer_id;
    const API_VERSION = process.env.API_VERSION || '2025-10';
    const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

    if (!shop) return res.status(400).json({ ok: false, error: 'Missing shop' });
    if (!customer_id) return res.status(400).json({ ok: false, error: 'Missing customer_id' });
    if (!ADMIN_TOKEN) return res.status(500).json({ ok: false, error: 'Admin token not configured' });

    // 1) Try metaobjects via GraphQL (if store supports)
    try {
      const graphUrl = `https://${shop}/admin/api/${API_VERSION}/graphql.json`;
      const gql = `{
        metaobjects(query: "type:measurement owner_id:${customer_id} owner_resource:customer") {
          edges {
            node {
              id
              type
              handle
              fields { key type value }
            }
          }
        }
      }`;
      const mg = await fetch(graphUrl, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': ADMIN_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query: gql })
      });

      if (mg.ok) {
        const mgj = await mg.json().catch(() => null);
        const edges = (mgj && mgj.data && mgj.data.metaobjects && mgj.data.metaobjects.edges) || [];
        if (edges.length) {
          const items = edges.map(e => {
            const node = e.node || {};
            const fields = (node.fields || []).reduce((acc, f) => { acc[f.key] = f.value; return acc; }, {});
            return { id: node.id, type: node.type, fields };
          });
          return res.json({ ok: true, selected: items[0].id, items });
        }
      }
    } catch (e) {
      // ignore and fallback to metafields
      console.warn('metaobjects check failed', e && e.message);
    }

    // 2) Fallback: list customer metafields in namespace 'measurements'
    const restUrl = `/metafields.json?owner_id=${encodeURIComponent(customer_id)}&owner_resource=customer&namespace=measurements`;
    const listResult = await adminRequestForShop(shop, restUrl, 'GET', null, API_VERSION);

    if (!listResult.ok) {
      // forward raw response for debugging
      const payload = listResult.body || `metafields list failed ${listResult.status}`;
      console.error('metafields list failed', listResult.status, payload);
      return res.status(listResult.status).send(payload);
    }

    const mf = (listResult.body && listResult.body.metafields) || [];
    if (!mf.length) return res.json({ ok: false }); // no measurements found

    // Map metafields to items
    const items = mf.map(mfItem => {
      let parsed = mfItem.value;
      try { parsed = JSON.parse(mfItem.value); } catch (e) { /* keep raw */ }
      return {
        id: mfItem.id || mfItem.key,
        key: mfItem.key,
        namespace: mfItem.namespace,
        value: parsed
      };
    });

    // If there is a 'selected' single_line_text_field metafield pointing to a key, pick that.
    const sel = items.find(i => i.key === 'selected') || null;
    let selected = null;
    if (sel && sel.value) {
      const selKey = (typeof sel.value === 'string') ? sel.value : (sel.value && sel.value.key) || null;
      if (selKey) {
        const found = items.find(it => it.key === selKey || String(it.id) === selKey);
        if (found) selected = found.id || found.key;
      }
    }

    return res.json({ ok: true, items, selected });
  } catch (err) {
    console.error('Error in /apps/measurements/selected', err && err.stack || err);
    return res.status(500).json({ ok: false, error: err && err.message });
  }
});

// POST /apps/measurements/save
app.post('/apps/measurements/save', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const { customer_id, label, values } = body;
    // allow shop param optionally, otherwise use env SHOP
    const shopFromReq = (req.query.shop || '').toString().replace(/^https?:\/\//, '').trim();
    const shop = shopFromReq || (process.env.SHOP || '').replace(/^https?:\/\//, '').trim();
    const API_VER = process.env.API_VERSION || '2025-10';
    const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

    if (!shop) return res.status(400).json({ ok: false, error: 'Missing shop' });
    if (!customer_id) return res.status(400).json({ ok: false, error: 'Missing customer_id' });
    if (!values || typeof values !== 'object') return res.status(400).json({ ok: false, error: 'Missing values object' });
    if (!ADMIN_TOKEN) return res.status(500).json({ ok: false, error: 'Admin token not configured' });

    const key = `measurement_${Date.now()}`;
    const payload = {
      metafield: {
        namespace: 'measurements',
        key,
        type: 'json',
        value: JSON.stringify({ label: label || '', values }),
        owner_id: Number(customer_id),
        owner_resource: 'customer'
      }
    };

    const urlPath = '/metafields.json';
    const r = await fetch(`https://${shop}/admin/api/${API_VER}${urlPath}`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': ADMIN_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    // parse response safely
    const respText = await r.text().catch(() => null);
    let j = null;
    try { j = respText ? JSON.parse(respText) : null; } catch (e) { j = respText; }

    if (!r.ok) {
      console.error('metafield create failed', r.status, j);
      return res.status(r.status).json({ ok: false, error: j || 'metafield create failed' });
    }

    // try to create a 'selected' metafield that points to the new key (non-fatal)
    try {
      const sel = {
        metafield: {
          namespace: 'measurements',
          key: 'selected',
          type: 'single_line_text_field',
          value: key,
          owner_id: Number(customer_id),
          owner_resource: 'customer'
        }
      };
      // create selected metafield (ignore failure)
      await fetch(`https://${shop}/admin/api/${API_VER}${urlPath}`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': ADMIN_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(sel)
      }).catch(e => console.warn('selected metafield create ignored', e && e.message));
    } catch (e) {
      console.warn('selected metafield ignored', e && e.message);
    }

    return res.json({ ok: true, metafield: j && j.metafield ? j.metafield : j });
  } catch (err) {
    console.error('Error in /apps/measurements/save', err && (err.stack || err));
    return res.status(500).json({ ok: false, error: err && err.message });
  }
});

// Port
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
