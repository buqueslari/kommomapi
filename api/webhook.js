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

async function forwardToWoll(rawBody, headers) {
  const url = process.env.WOLL_WEBHOOK_URL;
  if (!url) {
    return { ok: false, skipped: true, reason: 'WOLL_WEBHOOK_URL ausente' };
  }

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
  console.log('Resposta Woll:', resp.status, text.slice(0, 500));

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

async function sendToDatacrazy(info) {
  const url = process.env.DATACRAZY_WEBHOOK_URL;

  if (!url) {
    throw new Error('DATACRAZY_WEBHOOK_URL ausente');
  }

  const ddi = info.phone?.startsWith('55') ? '55' : '';
  const telefone = ddi ? info.phone.slice(2) : info.phone;

  const payload = {
    nome: info.name || 'Sem nome',
    telefone: telefone || '',
    ddi: ddi || '',
    telefone_completo: info.phone ? `+${info.phone}` : '',
    mensagem: info.text || '',
    origem: 'WhatsApp',
    tipo: info.kind || 'message',
    wa_message_id: info.waMessageId || '',
    timestamp: info.timestamp || '',
    empresa: '',
    email: '',
    tags: ['whatsapp', 'woll', 'meta'],
  };

  console.log('Enviando para Datacrazy:', JSON.stringify(payload));

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const text = await resp.text();
  console.log('Resposta Datacrazy:', resp.status, text);

  if (!resp.ok) {
    throw new Error(`Datacrazy falhou: ${resp.status} ${text}`);
  }

  return text;
}

function verifyMetaSignature(rawBody, signature, appSecret) {
  if (!signature || !appSecret) return true;

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');

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

    await sendToDatacrazy(info);
  } catch (err) {
    console.error('Erro ao enviar para o Datacrazy:', err);
  }
}
