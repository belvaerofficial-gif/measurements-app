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

// GET selected measurements for a customer (tries metaobjects then metafields)
app.get('/apps/measurements/selected', async (req, res) => {
  try {
    const shop = (req.query.shop || process.env.SHOP || '').replace(/^https?:\/\//,'');
    const customer_id = req.query.customer_id;
    if (!shop) return res.status(400).json({ ok:false, error:'Missing shop' });
    if (!customer_id) return res.status(400).json({ ok:false, error:'Missing customer_id' });

    const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
    const API_VERSION = process.env.API_VERSION || '2025-10';
    if (!ADMIN_TOKEN) return res.status(500).json({ ok:false, error:'Admin token not configured' });

    // 1) Try metaobjects (GraphQL) if your store has them
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
        const mgj = await mg.json();
        const edges = mgj.data && mgj.data.metaobjects && mgj.data.metaobjects.edges || [];
        if (edges.length) {
          const items = edges.map(e => {
            const node = e.node;
            const fields = (node.fields || []).reduce((acc,f) => { acc[f.key]=f.value; return acc; }, {});
            return { id: node.id, type: node.type, fields };
          });
          // return first as selected and list
          return res.json({ ok:true, selected: items[0].id, items });
        }
      }
    } catch(e){
      // ignore and fallback to metafields
      console.warn('metaobjects check failed', e && e.message);
    }

    // 2) Fallback: list customer metafields in namespace 'measurements'
    // Note: GET metafields with owner_id & owner_resource filter
    const restUrl = `https://${shop}/admin/api/${API_VERSION}/metafields.json?owner_id=${encodeURIComponent(customer_id)}&owner_resource=customer&namespace=measurements`;
    const r = await fetch(restUrl, {
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': ADMIN_TOKEN,
        'Content-Type': 'application/json'
      }
    });
    if (!r.ok) {
      const txt = await r.text().catch(()=>null);
      console.error('metafields list failed', r.status, txt);
      return res.status(r.status).send(txt || `metafields list failed ${r.status}`);
    }
    const j = await r.json();
    const mf = j.metafields || [];
    if (!mf.length) return res.json({ ok:false }); // no measurements found

    // Map metafields to items
    const items = mf.map(mfItem => {
      let parsed = mfItem.value;
      try { parsed = JSON.parse(mfItem.value); } catch(e){}
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

    return res.json({ ok:true, items, selected });
  } catch (err) {
    console.error('Error in /apps/measurements/selected', err);
    return res.status(500).json({ ok:false, error: err.message });
  }
});
// use the environment-provided PORT (Render sets this), fallback to 3000 for local dev
const port = process.env.PORT || 3000;


app.listen(port, () => console.log(`Server running on port ${port}`));
