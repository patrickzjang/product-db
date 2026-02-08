# web-next

## Architecture

- Frontend UI: Next.js App Router (`src/app/page.tsx`)
- Backend-for-frontend: Next API routes
  - `POST /api/search`
  - `POST /api/upload`
- Supabase access happens server-side using environment variables.

## Environment

Copy example env:

```bash
cp .env.example .env.local
```

Set values in `.env.local`:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `MASTER_USERNAME` (for test login)
- `MASTER_PASSWORD` (for test login)

## Run

```bash
npm install
npm run dev
```

## Security notes

- Do not hardcode Supabase keys in client code.
- Browser code should call local API routes only.
- Apply Supabase migration `20260208000002_fix_security_definer_views.sql` to remove `SECURITY DEFINER` behavior from public views.
- API routes require login and use an `HttpOnly` cookie session.
