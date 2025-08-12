// PD-SMS — Pipedrive + Twilio + Slack SMS bridge
// Endpoints:
//   GET  /                     (hello)
//   GET  /health               (uptime check)
//   POST /inbound              (Twilio webhook: logs [SMS In])
//   GET  /send-form            (Tiny form to send SMS manually)
//   POST /send                 (Programmatic send + [SMS Out] log)
//   POST /slack/sms            (Slash command /sms — public confirmation)
//   POST /slack/events         (Reply in Slack thread -> SMS + PD log; idempotent)
//   POST /pipedrive-webhook    (Pipedrive Note "SMS:" -> SMS)

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const twilioLib = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false })); // Slack & Twilio (form-encoded)
app.use(bodyParser.json());                           // Pipedrive + Slack events (JSON)

// ---- Env ----
const {
  PORT = 3000,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER, // e.g. +1480...
  TWILIO_MESSAGING_SERVICE_SID, // MG… (recommended)
  PIPEDRIVE_API_TOKEN,
  PIPEDRIVE_BASE = 'https://primepc.pipedrive.com/api/v1', // your PD domain
  SLACK_WEBHOOK_URL,                 // optional: inbound alerts to a channel
  SLACK_ALLOWED_TEAM = 'studioprime',// your workspace guard for /sms
  SLACK_BOT_TOKEN                    // required for reply-in-thread feature
} = process.env;

// ---- Clients ----
const twilio = twilioLib(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const pd = axios.create({ baseURL: PIPEDRIVE_BASE, params: { api_token: PIPEDRIVE_API_TOKEN } });
const slack = SLACK_BOT_TOKEN
  ? axios.create({
      baseURL: 'https://slack.com/api',
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
    })
  : null;

// ===== Helpers =====
function buildSendOpts(to, body) {
  return TWILIO_MESSAGING_SERVICE_SID
    ? { to, messagingServiceSid: TWILIO_MESSAGING_SERVICE_SID, body }
    : { to, from: TWILIO_NUMBER, body };
}

async function findPersonByPhone(phone) {
  if (!phone) return null;
  const original = String(phone).trim();
  const digits = original.replace(/\D/g, '');
  const candidates = [];
  if (digits.length >= 10) {
    const last10 = digits.slice(-10);
    candidates.push(last10, '+1' + last10, '1' + last10);
  }
  if (original.startsWith('+')) candidates.push(original);
  const uniq = [...new Set(candidates)];
  for (const term of uniq) {
    try {
      const { data } = await pd.get('/persons/search', {
        params: { term, fields: 'phone', exact_match: false, limit: 1 }
      });
      const item = data?.data?.items?.[0]?.item;
      if (item) return item;
    } catch (_) {}
  }
  return null;
}

async function createPersonForPhone(phone) {
  const digits = String(phone).replace(/\D/g, '');
  const last10 = digits.slice(-10);
  const e164 = (digits.length === 11 && digits.startsWith('1')) ? ('+' + digits) : ('+1' + last10);
  const { data } = await pd.post('/persons', {
    name: e164,
    phone: [
      { value: e164, primary: true, label: 'mobile' },
      { value: last10, primary: false, label: 'alt' }
    ]
  });
  return data?.data || null;
}

async function getPrimaryDealForPerson(personId) {
  const { data } = await pd.get(`/persons/${personId}/deals`, { params: { status: 'open', limit: 1 } });
  return (data && data.data && data.data[0]) || null;
}

async function logNote({ content, personId, dealId }) {
  return pd.post('/notes', {
    content,
    person_id: personId || undefined,
    deal_id: dealId || undefined
  });
}

async function notify(text) {
  if (!SLACK_WEBHOOK_URL) return;
  try { await axios.post(SLACK_WEBHOOK_URL, { text }); } catch (_) {}
}

// ---- Slack event de-dup (in-memory, 10 min TTL)
const processedEvents = new Map(); // event_id -> timestamp
const EVENT_TTL_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of processedEvents) if (now - ts > EVENT_TTL_MS) processedEvents.delete(id);
}, 60 * 1000);

// ===== Routes =====
app.get('/', (req, res) => res.send('pd-sms is running'));
app.get('/health', (req, res) => res.send('ok'));

// Inbound SMS -> [SMS In]
app.post('/inbound', async (req, res) => {
  try {
    const from = req.body.From;
    const body = req.body.Body || '';
    const mediaCount = Number(req.body.NumMedia || 0);
    let person = await findPersonByPhone(from);
    if (!person) person = await createPersonForPhone(from);
    const deal = person ? await getPrimaryDealForPerson(person.id) : null;
    await logNote({
      content: `[SMS In] ${new Date().toLocaleString()} – ${body}${mediaCount ? ' (MMS attached)' : ''}`,
      personId: person?.id, dealId: deal?.id
    });
    await notify(`📲 New SMS from ${from}${person ? ` (${person.name || ''})` : ''}: ${body}`);
    res.type('text/xml').send('<Response/>');
  } catch (e) {
    console.error(e);
    res.status(500).send('error');
  }
});

// Tiny manual send form
app.get('/send-form', (req, res) => {
  const { phone = '', person_id = '', deal_id = '' } = req.query;
  res.send(`
    <html><body style="font-family: sans-serif; max-width: 440px; margin: 40px auto;">
      <h3>Send SMS</h3>
      <form method="POST" action="/send">
        <label>To</label><br/>
        <input name="to" value="${phone}" style="width:100%;padding:8px"/><br/><br/>
        <label>Message</label><br/>
        <textarea name="message" rows="5" style="width:100%;padding:8px"></textarea><br/><br/>
        <input type="hidden" name="personId" value="${person_id}"/>
        <input type="hidden" name="dealId" value="${deal_id}"/>
        <button type="submit" style="padding:10px 16px;">Send</button>
      </form>
    </body></html>
  `);
});

// Programmatic send
app.post('/send', async (req, res) => {
  try {
    const { to, message, personId, dealId } = req.body;
    await twilio.messages.create(buildSendOpts(to, message));
    await logNote({
      content: `[SMS Out] ${new Date().toLocaleString()} – "${message}"`,
      personId, dealId
    });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false });
  }
});

// Slack /sms — public confirmation (in_channel) & no "Sending..." bubble
app.post('/slack/sms', async (req, res) => {
  console.log('Slash /sms hit', req.body?.team_domain, req.body?.text);
  res.status(200).send(); // empty ACK so Slack shows nothing immediately

  (async () => {
    const responseUrl = req.body?.response_url;
    const postBack = async (text) => {
      if (!responseUrl) return;
      try { await axios.post(responseUrl, { text, response_type: 'in_channel' }); } catch (_) {}
    };

    try {
      if (req.body?.team_domain && req.body.team_domain !== SLACK_ALLOWED_TEAM) {
        return postBack('Unauthorized workspace for /sms');
      }
      const text = (req.body?.text || '').trim();
      const [first, ...rest] = text.split(/\s+/);
      const message = rest.join(' ');
      if (!first || !message) return postBack('Usage: /sms 4805551234 Your message');

      const digits = first.replace(/\D/g, '');
      const to = first.startsWith('+')
        ? first
        : (digits.length === 11 && digits.startsWith('1')) ? ('+' + digits)
        : (digits.length === 10) ? ('+1' + digits)
        : null;
      if (!to) return postBack('Please enter a US number like 4805551234 or +14805551234');

      let person = await findPersonByPhone(to);
      if (!person) person = await createPersonForPhone(to);
      const deal = person ? await getPrimaryDealForPerson(person.id) : null;

      await twilio.messages.create(buildSendOpts(to, message));
      await logNote({
        content: `[SMS Out] ${new Date().toLocaleString()} – "${message}"`,
        personId: person?.id, dealId: deal?.id
      });

      return postBack(`Sent to ${to}: "${message}" ✅`);
    } catch (e) {
      console.error(e);
      return postBack('Something went wrong sending your SMS.');
    }
  })();
});

// Slack Events — reply in inbound alert thread -> SMS + PD log (idempotent)
app.post('/slack/events', async (req, res) => {
  if (req.body?.type === 'url_verification') return res.send(req.body.challenge);

  if (req.headers['x-slack-retry-num']) res.set('X-Slack-No-Retry', '1');
  res.status(200).send();

  if (!slack) return; // feature not enabled without bot token

  const eventId = req.body?.event_id;
  if (eventId) {
    if (processedEvents.has(eventId)) return;
    processedEvents.set(eventId, Date.now());
  }

  const ev = req.body?.event;
  if (!ev) return;
  if (ev.type !== 'message') return;
  if (ev.subtype || ev.bot_id || !ev.user) return; // skip bot/system/edited etc.
  if (!ev.thread_ts) return; // only act on thread replies

  try {
    const parent = await slack.get('/conversations.replies', {
      params: { channel: ev.channel, ts: ev.thread_ts, limit: 1 }
    });
    const parentText = parent.data?.messages?.[0]?.text || '';

    let match = parentText.match(/\+1\d{10}/);
    if (!match) {
      const d = (parentText.match(/\d/g) || []).join('');
      if (d.length >= 10) match = ['+1' + d.slice(-10)];
    }
    if (!match) {
      await slack.post('/chat.postMessage', {
        channel: ev.channel,
        text: "Couldn't find a phone number in the parent message.",
        thread_ts: ev.thread_ts
      });
      return;
    }
    const to = match[0];
    const message = (ev.text || '').trim();
    if (!message) return;

    let person = await findPersonByPhone(to);
    if (!person) person = await createPersonForPhone(to);
    const deal = person ? await getPrimaryDealForPerson(person.id) : null;

    await twilio.messages.create(buildSendOpts(to, message));
    await logNote({
      content: `[SMS Out] ${new Date().toLocaleString()} – "${message}"`,
      personId: person?.id, dealId: deal?.id
    });

    await slack.post('/chat.postMessage', {
      channel: ev.channel,
      text: `Sent to ${to}: "${message}" ✅`,
      thread_ts: ev.thread_ts
    });
  } catch (e) {
    console.error('slack reply error', e?.response?.data || e);
    try {
      await slack.post('/chat.postMessage', {
        channel: ev.channel,
        text: 'Error sending SMS from this reply.',
        thread_ts: ev.thread_ts
      });
    } catch (_) {}
  }
});

// Pipedrive webhook — Note added -> if starts with "SMS:", send
app.post('/pipedrive-webhook', async (req, res) => {
  try {
    const current = req.body?.current || {};
    const noteId  = current?.id;
    const dealId  = (current?.deal_id?.value ?? current?.deal_id ?? null);
    let personId  = (current?.person_id?.value ?? current?.person_id ?? null);

    let content = current?.content || ''; // HTML
    const plain = content.replace(/<[^>]*>/g, '').trim();

    const match = plain.match(/^SMS:\s*(.+)$/i);
    if (!match) return res.send('ok'); // Not an SMS note
    const message = match[1];

    if (!personId && dealId) {
      try {
        const { data: dealResp } = await pd.get(`/deals/${dealId}`);
        personId = dealResp?.data?.person_id?.value ?? dealResp?.data?.person_id ?? null;
      } catch (e) {
        console.error('Failed to load deal for person_id', e?.response?.status, e?.response?.data);
      }
    }
    if (!personId) {
      console.error('No person_id on note; cannot send SMS');
      return res.send('ok');
    }

    const { data: personResp } = await pd.get(`/persons/${personId}`);
    const phones = personResp?.data?.phone || [];
    let to = (phones.find(p => p.primary)?.value || phones[0]?.value || '').replace(/\D/g, '');
    if (!to) {
      console.error(`No phone numbers on person ${personId}`);
      return res.send('ok');
    }
    to = to.startsWith('+')
      ? to
      : (to.length === 11 && to.startsWith('1')) ? ('+' + to)
      : ('+1' + to.slice(-10));

    await twilio.messages.create(buildSendOpts(to, message));

    await pd.put(`/notes/${noteId}`, {
      content: `[SMS Out] ${new Date().toLocaleString()} – "${message}"`
    });

    await logNote({
      content: `[SMS Out] ${new Date().toLocaleString()} – "${message}"`,
      personId, dealId: (dealId ?? undefined)
    });

    return res.send('ok');
  } catch (e) {
    console.error('PD webhook error', e?.response?.status, e?.response?.data || e);
    return res.status(200).send('ok'); // avoid PD retries
  }
});

// Boot
app.listen(PORT, () => console.log(`pd-sms running on :${PORT}`));
