export default {
  async fetch(req, env) {
    /* ---------- helper ---------- */
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: {
          Authorization: `Bearer ${env.MEETUP_TOKEN}`,
          'User-Agent': 'Mozilla/5.0 (MeetupRSVP)',
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': 'content-type'
        }
      });

    /* CORS pre‑flight */
    if (req.method === 'OPTIONS') return json(null);

    const url = new URL(req.url);

    /* ---------- GET /events ---------- */
    if (req.method === 'GET' && url.pathname === '/events') {
      /* 1 – refresh access‑token if needed (same helper you already have) */
      const token = await getAccess(env);   // see below

      /* 2 – GraphQL POST */
      const gqlBody = JSON.stringify({
        query: `
          query ($slug: ID!) {
            proNetwork(urlname: $slug) {
              eventsSearch(
                input: { first: 20, filter: { status: "UPCOMING" } }
              ) {
              totalCount
              pageInfo {
                endCursor  
              }  
              edges {
                  node {
                    id
                    title
                    dateTime
                    rsvps { totalCount }
                  }
                }
              }
            }
          }`,
        variables: { slug: env.GROUP_URLNAME }
      });


      const res = await fetch('https://api.meetup.com/gql-ext', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'User-Agent': 'Mozilla/5.0 (MeetupRSVP)',
          'content-type': 'application/json',
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': 'content-type'
        },
        body: gqlBody
      });

      if (!res.ok) return json({ error:'Meetup API error', status:res.status }, 502);

      const data = await res.json();
      const edges = data?.data?.groupByUrlname?.events?.edges || [];
      const eventsArray = edges.map(e => ({
        id:   e.node.id,
        name: e.node.title,
        time: new Date(e.node.dateTime).getTime(),
        meetup_rsvps: e.node.rsvps?.totalCount ?? 0
      }));

      /* merge local RSVPs stored in KV */
      const local = await env.RSVPS.get('data', { type: 'json' }) || {};
      const combined = eventsArray.map(ev => {
        const names = local[ev.id] || [];
        return {
          ...ev,
          local_rsvps: names.length,
          total_rsvps: ev.meetup_rsvps + names.length
        };
      });

      return json(combined);
    }

    /* ---------- POST /rsvp ---------- */
    if (req.method === 'POST' && url.pathname === '/rsvp') {
      const { event_id, name } = await req.json();
      if (!event_id || !name?.trim()) return json({ error:'Bad Request' }, 400);

      const store = await env.RSVPS.get('data', { type: 'json' }) || {};
      store[event_id] = store[event_id] || [];
      if (!store[event_id].includes(name.trim())) store[event_id].push(name.trim());
      await env.RSVPS.put('data', JSON.stringify(store));

      return json({ ok:true });
    }

    return json({ error:'Not found' }, 404);
  }
}

/* ---- token‑refresh helper (unchanged from earlier) ---- */
async function getAccess(env) {
  const C = 'meetup_access';
  const saved = await env.RSVPS.get(C, { type:'json' }) || {};
  if (saved.token && saved.expires > Date.now()/1000 + 60) return saved.token;

  const body = new URLSearchParams({
    client_id:     env.MEETUP_CLIENT_ID,
    client_secret: env.MEETUP_CLIENT_SECRET,
    grant_type:    'refresh_token',
    refresh_token: env.MEETUP_REFRESH_TOKEN
  });

  const r = await fetch('https://secure.meetup.com/oauth2/access', { method:'POST', body });
  const j = await r.json();
  await env.RSVPS.put(C, JSON.stringify({
    token:   j.access_token,
    expires: Math.floor(Date.now()/1000) + j.expires_in
  }));
  return j.access_token;
}
