export const config = {
  api: {
    bodyParser: false,
  },
};

import crypto from 'crypto';

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function getNested(obj, path, fallback = undefined) {
  try {
    return path.split('.').reduce((acc, key) => acc?.[key], obj) ?? fallback;
  } catch {
    return fallback;
  }
}

async function forwardToWoll(rawBody, headers) {
  const url = process.env.WOLL_WEBHOOK_URL;
  if (!url) return { ok: false, skipped: true, reason: 'WOLL_WEBHOOK_URL ausente' };

  const outHeaders = {
    'content-type': headers['content-type'] || 'application/json',
  };

  if (headers['x-hub-signature-256']) {
    outHeaders['x-hub-signature-256'] = headers['x-hub-signature-256'];
  }

  if (process.env.WOLL_VERIFY_TOKEN) {
    outHeaders['x-woll-verify-token'] = process.env.WOLL_VERIFY_TOKEN;
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers: outHeaders,
    body: rawBody,
  });

  const text = await resp.text();
  return { ok: resp.ok, status: resp.status, body: text.slice(0, 500) };
}

function extractMessageInfo(payload) {
  const entries = payload?.entry || [];
  const changes = entries.flatMap((e) => e.changes || []);

  for (const change of changes) {
    const value = change?.value;
    const contact = value?.contacts?.[0];
    const msg = value?.messages?.[0];
    const status = value?.statuses?.[0];

    if (msg) {
      const from = msg.from || 'desconhecido';
      const name = contact?.profile?.name || from;
      const type = msg.type || 'unknown';

      let text = '';
      if (type === 'text') text = msg.text?.body || '';
      else if (type === 'image') text = '[imagem recebida]';
      else if (type === 'audio') text = '[áudio recebido]';
      else if (type === 'document') text = `[documento recebido: ${msg.document?.filename || 'sem nome'}]`;
      else if (type === 'video') text = '[vídeo recebido]';
      else if (type === 'location') text = '[localização recebida]';
      else if (type === 'button') text = `[botão: ${msg.button?.text || ''}]`;
      else if (type === 'interactive') text = '[interação recebida]';
      else text = `[mensagem do tipo ${type}]`;

      return {
        kind: 'message',
        phone: from,
        name,
        text,
        waMessageId: msg.id || null,
        timestamp: msg.timestamp || null,
      };
    }

    if (status) {
      return {
        kind: 'status',
        phone: status.recipient_id || 'desconhecido',
        name: status.recipient_id || 'desconhecido',
        text: `[status da mensagem: ${status.status}]`,
        waMessageId: status.id || null,
        timestamp: status.timestamp || null,
      };
    }
  }

  return null;
}

async function kommoRequest(path, method = 'GET', body = null) {
  const rawSubdomain = process.env.KOMMO_SUBDOMAIN;
  const token = process.env.KOMMO_LONG_LIVED_TOKEN;

  if (!rawSubdomain || !token) {
    throw new Error('Kommo não configurado');
  }

  const subdomain = rawSubdomain
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace('.kommo.com', '')
    .trim();

  const url = `https://${subdomain}.kommo.com${path}`;

  let lastError;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'Vercel-WhatsApp-Proxy/1.0',
          Connection: 'close',
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      const text = await resp.text();
      const data = safeJsonParse(text) || text;

      console.log(`Kommo ${method} ${url} -> ${resp.status}`);

      if (!resp.ok) {
        throw new Error(
          `Kommo ${method} ${path} falhou: ${resp.status} ${
            typeof data === 'string' ? data : JSON.stringify(data)
          }`
        );
      }

      return data;
    } catch (err) {
      lastError = err;
      console.error(`Tentativa ${attempt} no Kommo falhou:`, err);

      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }

  throw lastError;
}

async function findOrCreateContact(name, phone) {
  const query = encodeURIComponent(phone);
  const search = await kommoRequest(`/api/v4/contacts?query=${query}`);
  const existing = search?._embedded?.contacts?.[0];
  if (existing?.id) return existing.id;

  const created = await kommoRequest('/api/v4/contacts', 'POST', [
    {
      name,
      custom_fields_values: [
        {
          field_code: 'PHONE',
          values: [{ value: `+${phone}` }],
        },
      ],
    },
  ]);

  return created?._embedded?.contacts?.[0]?.id;
}

async function createLead(contactId, name) {
  const pipelineId = process.env.KOMMO_PIPELINE_ID ? Number(process.env.KOMMO_PIPELINE_ID) : undefined;
  const statusId = process.env.KOMMO_STATUS_ID ? Number(process.env.KOMMO_STATUS_ID) : undefined;

  const payload = [{
    name: `WhatsApp - ${name}`,
    pipeline_id: pipelineId,
    status_id: statusId,
    _embedded: {
      contacts: [{ id: contactId }],
    },
  }];

  if (!pipelineId) delete payload[0].pipeline_id;
  if (!statusId) delete payload[0].status_id;

  const created = await kommoRequest('/api/v4/leads', 'POST', payload);
  return created?._embedded?.leads?.[0]?.id;
}

async function addNoteToLead(leadId, text) {
  await kommoRequest(`/api/v4/leads/${leadId}/notes`, 'POST', [
    {
      note_type: 'common',
      params: { text },
    },
  ]);
}

function verifyMetaSignature(rawBody, signature, appSecret) {
  if (!signature || !appSecret) return true;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawBody = await readRawBody(req);
  const rawText = rawBody.toString('utf8');
  const payload = safeJsonParse(rawText);

  if (!payload) {
    return res.status(400).json({ error: 'JSON inválido' });
  }

  const signature = req.headers['x-hub-signature-256'];
  const appSecret = process.env.META_APP_SECRET || '';
  if (!verifyMetaSignature(rawBody, signature, appSecret)) {
    return res.status(401).json({ error: 'Assinatura inválida' });
  }

  res.status(200).json({ ok: true });

  try {
    await forwardToWoll(rawBody, req.headers);
  } catch (err) {
    console.error('Erro ao enviar para o Woll:', err);
  }

  try {
    const info = extractMessageInfo(payload);
    if (!info) return;

    const contactId = await findOrCreateContact(info.name, info.phone);
    const leadId = await createLead(contactId, info.name);

    const note = [
      `Origem: WhatsApp`,
      `Tipo: ${info.kind}`,
      `Nome: ${info.name}`,
      `Telefone: +${info.phone}`,
      `Mensagem: ${info.text}`,
      info.waMessageId ? `WA ID: ${info.waMessageId}` : null,
      info.timestamp ? `Timestamp: ${info.timestamp}` : null,
    ].filter(Boolean).join('\n');

    await addNoteToLead(leadId, note);
  } catch (err) {
    console.error('Erro ao salvar no Kommo:', err);
  }
}
