# Visitors' polaroids

Parked on the `polaroids` branch, off `main` for now (2026-11-08). An "Add your own" link under the dream
stack opened an endless grid of looping 3D polaroids, one per visitor: a 5-second clip, held for approval,
then made by the pipeline into a polaroid from panels 2 to 6, with an email when it's ready.

The branch has all of it: the public pages, the Worker's API and its D1/R2/email bindings, the admin inbox,
`/admin/record` and `/admin/polaroid`, the pipeline's polaroid steps, `models/polaroid`, its plans and its
CLAUDE.md section. The Cloudflare resources (D1 `lysterfield-polaroids`, the R2 buckets, the secrets) were
left in the account.
