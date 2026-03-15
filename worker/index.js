/*
 * ============================================================
 * Facebook Developer Setup (one-time, before deploying)
 * ============================================================
 * 1. Go to https://developers.facebook.com → Create App → Business type
 * 2. Add the "Pages API" product
 * 3. In Graph API Explorer:
 *    - Select your App and your Facebook Page
 *    - Request permissions: pages_manage_events, pages_read_engagement
 *    - Generate a User Token, exchange it for a Long-Lived Page Access Token
 *    - For a non-expiring token, create a System User in Business Manager
 * 4. Find your Page ID:
 *    GET https://graph.facebook.com/v19.0/me/accounts?access_token=<TOKEN>
 * 5. Store secrets in Cloudflare:
 *    wrangler secret put FB_PAGE_ACCESS_TOKEN
 *    wrangler secret put ADMIN_KEY   (any random string, used to protect GET /sync)
 * 6. Set FB_PAGE_ID in wrangler.toml [vars]
 * ============================================================
 */

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

    if (req.method === 'POST' && url.pathname === '/subscribe') {
      try {
        const { email, hp = '' } = await req.json().catch(() => ({}));
        if (hp) return json({ ok: true }); // honeypot -> silently ignore
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return json({ ok:false, error:'Invalid email' }, 400);
        }
        const key = email.trim().toLowerCase();
        await env.SUBSCRIBERS.put(key, JSON.stringify({ email:key, ts:Date.now() }));
        // TODO (optional): call Mailchimp/ConvertKit/Resend webhook here
        return json({ ok: true });
      } catch (e) {
        return json({ ok:false, error:'Server error' }, 500);
      }
    }
    
    /* ---------- GET /events ---------- */
    if (req.method === 'GET' && url.pathname === '/events') {
      /* 1 – refresh access‑token if needed (same helper you already have) */
      const token = await getAccess(env);   // see below

      /* 2 – GraphQL POST */
      const gqlBody = JSON.stringify({
        query: `
          query ($slug: String!) {
            groupByUrlname(urlname: $slug) {
              events(
                first: 20,
                filter: { status: ACTIVE }
              ) {
                edges {
                  node {
                    id
                    title
                    dateTime
                    description
                    venues {
                      name
                      city
                      state
                      lat
                      lon
                    }
                    rsvps { 
                      totalCount 
                      edges {
                        node {
                          member {
                            name
                          }
                        }
                      }
                    }
                    featuredEventPhoto {
                      baseUrl
                      id
                    }
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
      if (data.errors) return json({ api_errors: data.errors }, 502);
      const edges = data?.data?.groupByUrlname?.events?.edges || [];
      const eventsArray = edges.map(e => {
        const photo = e.node.featuredEventPhoto;
        const meetupNames = e.node.rsvps?.edges?.map(r => r.node.member.name) || [];
        console.log(e.node.venues);
        return {
          id: e.node.id,
          name: e.node.title,
          time: new Date(e.node.dateTime).getTime(),
          meetup_rsvps: e.node.rsvps?.totalCount ?? 0,
          meetup_names: meetupNames,
          image_url: photo ? `${photo.baseUrl}${photo.id}/1024x576.jpg` : null,
          description: e.node.description,
          location_name: e.node.venues[0].name,
          location_city: e.node.venues[0].city + ', ' + e.node.venues[0].state,
          lat: e.node.venues[0].lat,
          lon: e.node.venues[0].lon
        };
      });

      // filter out past events so the site only shows upcoming events
      const upcoming = eventsArray.filter(ev => ev.time && ev.time > Date.now());

      // merge local RSVPs
      const local = await env.RSVPS.get('data', { type: 'json' }) || {};
      const combined = upcoming.map(ev => {
        const localNames = local[ev.id] || [];
        return {
          ...ev,
          local_rsvps: localNames.length,
          local_names: localNames,
          total_rsvps: ev.meetup_rsvps + localNames.length,
          all_names: [...ev.meetup_names, ...localNames]
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

    /* ---------- GET /sync (manual trigger, protected) ---------- */
    if (req.method === 'GET' && url.pathname === '/sync') {
      if (!env.ADMIN_KEY || req.headers.get('X-Admin-Key') !== env.ADMIN_KEY) {
        return json({ error: 'Unauthorized' }, 401);
      }
      const result = await syncToFacebook(env);
      return json(result);
    }

    return json({ error:'Not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncToFacebook(env));
  }
}

/* ---- Meetup → Facebook sync ---- */

/**
 * Normalise a name + ISO date string into a stable match key.
 * Strips extra whitespace/case from name; rounds time to the minute.
 */
function matchKey(name, isoDateTime) {
  const normName = name.trim().toLowerCase().replace(/\s+/g, ' ');
  const dt = new Date(isoDateTime);
  // zero out seconds/ms so minor differences don't break matching
  dt.setSeconds(0, 0);
  return `${normName}|${dt.toISOString()}`;
}

/**
 * Strip basic HTML tags from Meetup descriptions before sending to Facebook.
 */
function stripHtml(html = '') {
  return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();
}

/**
 * Fetch all upcoming events from the Facebook Page.
 * Returns a Map of matchKey → { id, name, start_time }.
 */
async function getFacebookEvents(env) {
  const fields = 'id,name,start_time,description,place';
  const url = `https://graph.facebook.com/v19.0/${env.FB_PAGE_ID}/events?fields=${fields}&time_filter=upcoming&limit=100&access_token=${env.FB_PAGE_ACCESS_TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FB events fetch failed: ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`FB API error: ${data.error.message}`);

  const map = new Map();
  for (const ev of (data.data || [])) {
    map.set(matchKey(ev.name, ev.start_time), ev);
  }
  return map;
}

/**
 * Fetch upcoming events from Meetup via GraphQL.
 */
async function getMeetupEvents(env) {
  const token = await getAccess(env);
  const gqlBody = JSON.stringify({
    query: `
      query ($slug: String!) {
        groupByUrlname(urlname: $slug) {
          events(first: 20, filter: { status: ACTIVE }) {
            edges {
              node {
                id title dateTime description
                venues { name city state }
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
      'content-type': 'application/json'
    },
    body: gqlBody
  });

  if (!res.ok) throw new Error(`Meetup API error: ${res.status}`);
  const data = await res.json();
  if (data.errors) throw new Error(`Meetup GQL errors: ${JSON.stringify(data.errors)}`);

  return (data?.data?.groupByUrlname?.events?.edges || []).map(e => {
    const v = e.node.venues?.[0] || {};
    return {
      id:          e.node.id,
      name:        e.node.title,
      start_time:  e.node.dateTime,            // ISO 8601
      description: stripHtml(e.node.description),
      location:    [v.name, v.city && v.state ? `${v.city}, ${v.state}` : v.city || ''].filter(Boolean).join(' – ')
    };
  });
}

/**
 * Main sync: pull Meetup events, compare to existing Facebook events,
 * update matches and create new ones.
 */
async function syncToFacebook(env) {
  const [meetupEvents, fbEventsMap] = await Promise.all([
    getMeetupEvents(env),
    getFacebookEvents(env)
  ]);

  const results = { created: [], updated: [], errors: [] };

  for (const ev of meetupEvents) {
    const key = matchKey(ev.name, ev.start_time);
    const fbMatch = fbEventsMap.get(key);
    const payload = new URLSearchParams({
      name:        ev.name,
      start_time:  new Date(ev.start_time).toISOString(),
      description: ev.description || 'No description provided',
      access_token: env.FB_PAGE_ACCESS_TOKEN
    });

    try {
      if (fbMatch) {
        /* Update existing FB event */
        const endpoint = `https://graph.facebook.com/v19.0/${fbMatch.id}`;
        console.log('[FB Sync] Updating FB event', { endpoint, meetup_id: ev.id, fb_id: fbMatch.id, name: ev.name, start_time: payload.get('start_time'), description: payload.get('description') });
        const r = await fetch(endpoint, { method: 'POST', body: payload });
        const text = await r.text();
        let body;
        try { body = JSON.parse(text); } catch (e) { body = { raw: text }; }
        console.log('[FB Sync] FB update response', { status: r.status, body });
        if (!r.ok || body.error) {
          const msg = (body && body.error && body.error.message) || `HTTP ${r.status}`;
          throw new Error(msg);
        }
        results.updated.push({ meetup_id: ev.id, fb_id: fbMatch.id, name: ev.name, fb_response: body });
      } else {
        /* Create new FB event */
        const endpoint = `https://graph.facebook.com/v19.0/${env.FB_PAGE_ID}/events`;
        console.log('[FB Sync] Creating FB event', { endpoint, meetup_id: ev.id, name: ev.name, start_time: payload.get('start_time'), description: payload.get('description') });
        const r = await fetch(endpoint, { method: 'POST', body: payload });
        const text = await r.text();
        let body;
        try { body = JSON.parse(text); } catch (e) { body = { raw: text }; }
        console.log('[FB Sync] FB create response', { status: r.status, body });
        if (!r.ok || body.error) {
          const msg = (body && body.error && body.error.message) || `HTTP ${r.status}`;
          throw new Error(msg);
        }
        results.created.push({ meetup_id: ev.id, fb_id: body.id, name: ev.name, fb_response: body });
      }
    } catch (err) {
      results.errors.push({ meetup_id: ev.id, name: ev.name, error: err.message });
    }
  }

  console.log(`[FB Sync] created=${results.created.length} updated=${results.updated.length} errors=${results.errors.length}`);
  return results;
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
