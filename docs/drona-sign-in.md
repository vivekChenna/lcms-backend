# Drona sign-in

Same approach as the QMS360 reference app. Off by default.

## Turning it on

Set `AUTH_STRATEGY=drona` on the backend and restart it. Leave it as `local` (the default) for email + password.

| | `local` | `drona` |
|---|---|---|
| `POST /auth/login` | works | 503, password sign-in is off |
| `POST /auth/drona` | 409 | works |
| `GET /auth/config` | `{ mode: "local", localLoginAllowed: true }` | `{ mode: "drona", localLoginAllowed: false }` |

## How it works

1. The login page reads `GET /auth/config`. In `drona` mode it loads the DronaHQ SDK (`public/dronahq.js` in the frontend) and reads the profile email from the container.
2. It posts `{ email }` to `POST /auth/drona`.
3. The backend signs in the **existing, active** user with that email and sets the usual session cookies. It never creates an account; an unknown or deactivated email gets 401.

Outside the DronaHQ container there is no profile, so the page says to open LCMS from Drona.

## Limitation (same as the reference)

The email is not proof of who is asking. Anyone who can reach `POST /auth/drona` and knows a user's email, an admin's included, can sign in as them. There is no Drona session or nonce check. Keep the backend reachable only by the intended Drona users until Drona provides a way to verify its session. Password sign-in is also off in this mode, so keep `AUTH_STRATEGY=local` available as the way back if Drona is unreachable.
