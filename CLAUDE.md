# Ants Playing the Web — co-presence (Prabu + Nouria Da Ros)

A shared, live "ants" world in the browser. Visitors are ants that walk a long article page, take words, carry them to a vast shared nest, build rooms, visit an open-web portal and a marketplace. Everyone sees everyone. Minimal style, no complexity.

Live: https://ants.ichiokuberry.in

## Layout
- `public/index.html` — the whole client (plain canvas, no deps).
- `server/server.js` — Node server, no deps: world state, 5 server-side bot ants, proxy for portal B, persistence. `content.json` = article/word pool, `widths.json` = font widths.
- `index.html` (root) — Nouria's original p5.js + MQTT prototype, kept as reference only. Source: github nouriakiwi-glitch/ants-playing-the-web.
- `Dockerfile`, `deploy/` — container, compose file, Caddy snippet.

## Run locally
`node server/server.js` then open http://localhost:8080. State goes to `server/data/` (git-ignored). Env: `PORT`, `DATA_DIR`, `YT_KEY` (optional, enables YouTube thumbnails in portal B), `TIME_SCALE` (testing: 60 = a minute passes in a second).

## Deploy
Docker on a VPS: `docker compose -f deploy/docker-compose.yml up -d --build` from the repo folder. The nest lives in the `ants_data` volume, so rebuilds never wipe it. Caddy proxies the domain (see `deploy/Caddyfile.snippet`). Set `YT_KEY` in the environment, never in the repo.

## Agreed design
**World**
- Canvas fills the window; page A is a long scrolling Dark'Ant article. Taken words are replaced from a word pool or from words other ants dropped.
- Nest is several screens wide with three fixed portals: A main page, B Open Web, C Marketplace. An edge arrow points to off-screen portals.
- Nest look: dark earth, colour only from items ants bring; portals glow A warm white, B cool blue-green, C amber; unexplored nest stays dark; free digging; muffled sound.

**Ants**
- No names; ants differ by look/type. Soft push so they don't overlap. Shift = boost.
- Everyone sees everyone in every space (other spaces shown as small marks).
- Ants eat only their own stored words (E); eating deletes the word.
- Scent marks (key press) fade slowly; also shown on web pages in portal B. Trails fade.
- Tokens: 1 per word taken, kept in the visitor's own browser (localStorage).
- Words: click own word = pick up, click again = place (snaps next to nearest own word). Mobile: 7 touch buttons, edge-scroll.

**Rooms**
- 1 stored word makes a room; it grows with nearby words; overlapping rooms grow the nest. Several rooms per ant; empty rooms vanish.
- Anyone can enter any room; only the owner can pick up/eat. Arrows (own rooms, closest 2) shown on entering the nest.
- Rooms are lighter caves with textures: stone (free), sand/pebble/moss/clay (10 tokens each, sold in the market).

**Portal B — Open Web**
- Search bar + random button via the server proxy. Sources: Wikipedia, Commons, Are.na, Flickr (keyword filter only), YouTube thumbnails (needs `YT_KEY`). No Instagram.
- 5 links per page become underlined-word portals; closed door = shake + sound. Circle the mouse over a picture to crop; cropped letters keep their background with a random rectangle border.

**Portal C — Marketplace** (light tan)
- Types: Scout (fast, sees far), Carrier (carries 2 words), Digger (wider tunnels) = 30 tokens. Colour/size = 5. Re-selecting owned items is free. Out-of-palette colours, glow, stroke, patterns are sold. No selling/trading yet.

**Interactions:** following, trail-writing with dropped words, sleeping-ant shape on leave, joint digging, distance sound, passing a word, antennae touch, call pulse, shared nest, gift, same-word moment, waiting ant.

**Out for now:** carrying together, echo, roll call, names, Instagram, trading.

## Open items / risks
- Real-device test still to do (mouse crop, sound, phone).
- `YT_KEY` not set yet, so YouTube is off.
- Some sites won't open through the proxy; the content filter is weak (Flickr keyword filter only).
- Bots do not visit portals B/C.

## Working conventions
- Don't build or change anything until the user says "GO"; until then we only discuss.
- Keep it minimal. No dependencies unless unavoidable.
- Never commit secrets (.env, API keys).
