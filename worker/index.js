export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // -------- GET /events --------
    if (req.method === 'GET' && url.pathname === '/events') {
      const meetup = await fetch(
        `https://api.meetup.com/${env.GROUP_URLNAME}/events?sign=true&key=${env.MEETUP_TOKEN}`,
        { headers: { Authorization: `Bearer ${env.MEETUP_TOKEN}` } }
      );
      const events = await meetup.json();

      // Pull local RSVPs object from KV: {eventId: [names]}
      const local = await env.RSVPS.get('data', { type: 'json' }) || {};

      const combined = events.map(ev => {
        const names = local[ev.id] || [];
        return {
          id: ev.id,
          name: ev.name,
          time: ev.time,
          meetup_rsvps: ev.yes_rsvp_count,
          local_rsvps: names.length,
          total_rsvps: ev.yes_rsvp_count + names.length,
          local_names: names                // optional for display
        };
      });
      return json(combined);
    }

    // -------- POST /rsvp --------
    if (req.method === 'POST' && url.pathname === '/rsvp') {
      const { event_id, name } = await req.json();
      if (!event_id || !name?.trim()) {
        return new Response('Bad Request', { status: 400 });
      }

      // optimistic update of JSON blob
      const stored = await env.RSVPS.get('data', { type: 'json' }) || {};
      stored[event_id] = stored[event_id] || [];
      if (!stored[event_id].includes(name.trim())) {
        stored[event_id].push(name.trim());
      }
      await env.RSVPS.put('data', JSON.stringify(stored));
      return new Response('Saved', { status: 200 });
    }

    return new Response('Not found', { status: 404 });
  }
};

function json(body, status=200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS'
    }
  });
}
