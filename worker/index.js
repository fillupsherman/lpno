export default {
  
  async fetch(req, env) {
    async function getAccess(env) {
      const C = 'meetup_access';
      const saved = await env.RSVPS.get(C, { type: 'json' }) || {};
      if (saved.token && saved.expires > Date.now()/1000 + 60) return saved.token;

      const body = new URLSearchParams({
        client_id:     env.MEETUP_CLIENT_ID,
        client_secret: env.MEETUP_CLIENT_SECRET,
        grant_type:    'refresh_token',
        refresh_token: env.MEETUP_REFRESH_TOKEN
      });
      const res = await fetch('https://secure.meetup.com/oauth2/access', { method:'POST', body });
      const j   = await res.json();
      await env.RSVPS.put(C, JSON.stringify({
        token:   j.access_token,
        expires: Math.floor(Date.now()/1000) + j.expires_in
      }));
      return j.access_token;
    }
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: {
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': 'content-type'
        }
      });

    // Handle CORS pre‑flight
    if (req.method === 'OPTIONS') return json(null);

    const url = new URL(req.url);

    // Simple health‑check
    if (url.pathname === '/debug') {
      return json({ ok: true, group: env.GROUP_URLNAME });
    }

    try {
      // ----------  GET /events  ----------
      const token = await getAccess(env);
      if (req.method === 'GET' && url.pathname === '/events') {
        const meetupURL = `https://api.meetup.com/${env.GROUP_URLNAME}/events`;

        const meetupRes = await fetch(meetupURL, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'Mozilla/5.0 (MeetupRSVP/1.0)',
            'Accept': 'application/json'
          }
        });

        if (!meetupRes.ok)
          return json({ error: 'Meetup API error', status: meetupRes.status }, 502);

        if (!meetupRes.headers
               .get('content-type')
               ?.includes('application/json')) {
          return json({ error: 'Unexpected Meetup response' }, 502);
        }

        const eventsArray = await meetupRes.json();
        const raw = await meetupRes.text();
        console.log('MEETUP‑STATUS', meetupRes.status);
        console.log('MEETUP‑BODY', raw.slice(0, 300));
        if (!Array.isArray(eventsArray))
          return json({ error: 'Meetup payload not an array' }, 502);

        // local RSVP counts
        const local = await env.RSVPS.get('data', { type: 'json' }) || {};

        const combined = eventsArray.map(ev => {
          const names = local[ev.id] || [];
          return {
            id: ev.id,
            name: ev.name,
            time: ev.time,
            meetup_rsvps: ev.yes_rsvp_count,
            local_rsvps: names.length,
            total_rsvps: ev.yes_rsvp_count + names.length
          };
        });

        return json(combined);
      }

      // ----------  POST /rsvp  ----------
      if (req.method === 'POST' && url.pathname === '/rsvp') {
        const { event_id, name } = await req.json();
        if (!event_id || !name?.trim())
          return json({ error: 'Bad Request' }, 400);

        // optimistic write
        const stored = await env.RSVPS.get('data', { type: 'json' }) || {};
        stored[event_id] = stored[event_id] || [];
        if (!stored[event_id].includes(name.trim()))
          stored[event_id].push(name.trim());

        await env.RSVPS.put('data', JSON.stringify(stored));
        return json({ ok: true });
      }

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      // Catch *all* unexpected errors so Worker never 500s without CORS
      console.error('Worker uncaught', err);
      return json({ error: 'Internal error' }, 500);
    }
  }
}
