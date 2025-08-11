// PD-SMS — Pipedrive + Twilio + Slack minimal SMS bridge
// Endpoints:
//   GET  /health
//   POST /inbound              (Twilio webhook: logs [SMS In])
//   GET  /send-form            (Tiny form to send SMS manually)
//   POST /send                 (Programmatic send + [SMS Out] log)
//   POST /slack/sms            (Slack slash command /sms) — instant ACK to avoid dispatch_failed
//   POST /pipedrive-webhook    (Pipedrive: Note added -> if "SMS:" then send)

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const twilioLib = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false })); // Slack & Twilio post urlencoded
app.use(bodyParser.json());                           // Pipedrive posts JSON

// ---- Env ----
const {
  PORT = 3000,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER, // e.g. +14805305004
  TWILIO_MESSAGING_SERVICE_SID, // optional: MGxxxxxxxx; recommended for A2P
  PIPEDRIVE_API_TOKEN,
  // Your Pipedrive domain API base:
  PIPEDRIVE_BASE = 'https://primepc.pipedrive.com/api/v1',
  SLACK_WEBHOOK_URL, // optional: inbound alerts to Slack channel
  // Only allow your Slack workspace to use /sms:
  SLACK_ALLOWED_TEAM = 'studioprime'
} = process.env;

// ---- Clients ----
const twilio = twilioLib(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const pd = axios.create({ baseURL: PIPEDRIVE_BASE, params: { api_token: PIPEDRIVE_API_TOKEN } });

// ============ Helpers ============
function buildSendOpts(to, body) {
  return TWILIO_MESSAGING_SERVICE_SID
    ? { to, messagingServiceSid: TWILIO_MESSAGING_SERVICE_SID, body }
    : { to, from: TWILIO_NUMBER, body };
}

async function findPersonByPhone(phone) {
  if (!phone) return null;

  const original = String(phone).trim();
  const digits = original.replace(/\D/g, '');

  // Try multiple formats so we match numbers saved like 480-xxx-xxxx, (480) xxx-xxxx, etc.
  const candidates = [];
  if (digits.length >= 10) {
    const last10 = digits.slice(-10);
    candidates.push(last10);        // 4805551234
    candidates.push('+1' + last10); // +14805551234
    candidates.push('1' + last10);  // 14805551234
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

  const payload = {
    name: e164, // rename later in Pipedrive
    phone: [
      { value: e164, primary: true, label: 'mobile' },
      { value: last10, primary: false, label: 'alt' }
    ]
  };

  const { data } = await pd.post('/persons', payload);
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

// ============ Routes ============

// Health
app.get('/health', (req, res) => res.send('ok'));

// Inbound SMS from Twilio -> log [SMS In]
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
      personId: person?.id,
      dealId: deal?.id
    });

    await notify(`📲 New SMS from ${from}${person ? ` (${person.name || ''})` : ''}: ${body}`);
    res.type('text/xml').send('<Response/>'); // minimal TwiML response
  } catch (e) {
    console.error(e);
    res.status(500).send('error');
  }
});

// Tiny manual send form (optional convenience)
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

// Programmatic send (used by form)
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

// Slack slash command: /sms 4805551234 Your message...
// Sends an immediate ACK so Slack doesn't time out (fixes "dispatch_failed")
app.post('/slack/sms', async (req, res) => {
  // 1) ACK immediately
  res.status(200).send('Sending…');

  // 2) Continue in the background and post back to Slack via response_url
  (async () => {
    const responseUrl = req.body?.response_url;
    const postBack = async (text) => {
      if (!responseUrl) return;
      try {
        await axios.post(responseUrl, { text, response_type: 'ephemeral' });
      } catch (_) {}
    };

    try {
      // Only allow your workspace "studioprime"
      if (req.body?.team_domain && req.body.team_domain !== 'studioprime') {
        return postBack('Unauthorized workspace for /sms');
      }

      const text = (req.body?.text || '').trim();
      const [first, ...rest] = text.split(/\s+/);
      const message = rest.join(' ');

      if (!first || !message) {
        return postBack('Usage: /sms 4805551234 Your message');
      }

      // Normalize number
      const digits = first.replace(/\D/g, '');
      const to = first.startsWith('+')
        ? first
        : (digits.length === 11 && digits.startsWith('1')) ? ('+' + digits)
        : (digits.length === 10) ? ('+1' + digits)
        : null;

      if (!to) return postBack('Please enter a US number like 4805551234 or +14805551234');

      // Find/create contact and log
      let person = await findPersonByPhone(to);
      if (!person) person = await createPersonForPhone(to);
      const deal = person ? await getPrimaryDealForPerson(person.id) : null;

      await twilio.messages.create(buildSendOpts(to, message));
      await logNote({
        content: `[SMS Out] ${new Date().toLocaleString()} – "${message}"`,
        personId: person?.id, dealId: deal?.id
      });

      return postBack(`Sent to ${to} ✅`);
    } catch (e) {
      console.error(e);
      return postBack('Something went wrong sending your SMS.');
    }
  })();
});

// Pipedrive webhook: on Note added -> if starts with "SMS:", send via Twilio
app.post('/pipedrive-webhook', async (req, res) => {
  try {
    const current = req.body?.current || {};
    const noteId   = current?.id;
    const personId = current?.person_id;
    const dealId   = current?.deal_id;
    let content    = current?.content || ''; // HTML

    // Strip HTML tags
    const plain = content.replace(/<[^>]*>/g, '').trim();

    // Only act on notes that BEGIN with "SMS:"
    const match = plain.match(/^SMS:\s*(.+)$/i);
    if (!match) return res.send('ok');

    const message = match[1];

    // Load the person's phone
    const { data: personResp } = await pd.get(`/persons/${personId}`);
    const phones = personResp?.data?.phone || [];
    let to = (phones.find(p => p.primary)?.value || phones[0]?.value || '').replace(/\D/g, '');
    if (!to) return res.send('no phone on person');

    // Normalize to E.164
    to = to.startsWith('+')
      ? to
      : (to.length === 11 && to.startsWith('1')) ? ('+' + to)
      : ('+1' + to.slice(-10));

    // Send and log
    await twilio.messages.create(buildSendOpts(to, message));

    // Rewrite the original note so the timeline is clean
    await pd.put(`/notes/${noteId}`, {
      content: `[SMS Out] ${new Date().toLocaleString()} – "${message}"`
    });

    // (Optional extra log)
    await logNote({
      content: `[SMS Out] ${new Date().toLocaleString()} – "${message}"`,
      personId, dealId
    });

    return res.send('ok');
  } catch (e) {
    console.error(e);
    // Return 200 so Pipedrive doesn't keep retrying
    return res.status(200).send('ok');
  }
});

// Boot
app.listen(PORT, () => console.log(`pd-sms running on :${PORT}`));

