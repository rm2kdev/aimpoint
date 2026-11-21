# Public project stats and README badges

A public project can expose task counts for README badges (VEC-363). It is opt-in per project:
`ProjectDoc.publicAccess.showStats`, default off, saved by admins through the public-access action
(`setProjectPublicAccess(slug, projectId, {showStats: true})`, Project settings > Public access).

Stats are served only when the project is public, not archived, its org is not locked, and `showStats` is on.
Anything else (including an unknown org, project or metric) is a bare `404 {"error":"Not found."}`, the same as
the public page. No session is needed.

## URLs

`<origin>` is the Aimpoint host (prod: `https://app.aimpoint.dev`). `<org>` is the org slug and `<KEY>` the project
key, as in the public page `/p/<org>/<KEY>` (both case-insensitive).

- `GET <origin>/api/public/<org>/<KEY>/stats`: JSON counts.
- `GET <origin>/api/public/<org>/<KEY>/badge/<metric>`: shields.io endpoint JSON.

```json
{
  "project": { "key": "AIM", "name": "Aimpoint" },
  "total": 9, "open": 6, "inProgress": 2, "done": 2, "cancelled": 1,
  "byType": {
    "issue":   { "total": 4, "open": 3, "inProgress": 1, "done": 1, "cancelled": 0 },
    "feature": { "total": 4, "open": 3, "inProgress": 1, "done": 0, "cancelled": 1 },
    "task":    { "total": 1, "open": 0, "inProgress": 0, "done": 1, "cancelled": 0 }
  }
}
```

Counts cover the project's non-archived tasks, by status stage, so custom status names don't matter: `open` =
backlog + triage + not started + started, `inProgress` = started, `done`, `cancelled`, `total` = all.

## Badges

| metric | label | message | colour |
|---|---|---|---|
| `open` | open | open tasks | blue |
| `in-progress` | in progress | started tasks | yellow |
| `done` | done | done tasks | brightgreen |
| `total` | tasks | all tasks | informational |
| `bugs` | open bugs | open issues (type `issue`) | red, brightgreen at 0 |
| `features` | feature requests | open feature requests | blueviolet |

The response is exactly the [shields.io endpoint schema](https://shields.io/badges/endpoint-badge):
`{"schemaVersion": 1, "label": "open bugs", "message": "3", "color": "red"}`. Render it with

```markdown
![Open bugs](https://img.shields.io/endpoint?url=https%3A%2F%2Fapp.aimpoint.dev%2Fapi%2Fpublic%2Frm2kdev%2FAIM%2Fbadge%2Fbugs)
```

(URL-encode the endpoint URL). Project settings > Public access > README badges (VEC-364) lists every metric with a
live preview and copies this Markdown, wrapped in a link to the public board: `[![Open bugs](<shields url>)](<origin>/p/<org>/<KEY>)`.
With statistics on, the public page header also shows the open / in progress / done / total counts. shields.io query options such as `&label=issues` or `&style=flat-square` override
the label and style on its side.

## Caching and limits

- 200 responses: `Cache-Control: public, s-maxage=300, stale-while-revalidate=600` and
  `Access-Control-Allow-Origin: *`; shields.io caches as well, so a change shows within about 5 to 10 minutes.
- 404 and 429 responses: `no-store`.
- Rate limit: 120 requests per client IP per project per minute (`PUBLIC_STATS_RATE_LIMIT`), then
  `429` with `Retry-After`.
- One aggregation (`$group` by status and type) per request; no titles, descriptions, people or ids are read
  into the response.

Code: `computeStats` / `shapeBadge` in `src/lib/project-public-core.ts` (unit tested),
`loadPublicStats` in `src/lib/project-public.ts`, routes under `src/app/api/public/[org]/[key]/stats` and
`.../badge/[metric]`.
