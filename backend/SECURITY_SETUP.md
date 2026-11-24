# MIC authentication rollout (staging only)

This branch contains an authentication implementation. It is **not enabled on the production Render service**.

## Required Render environment

Before starting this version, configure these variables in the staging service:

- `DATABASE_URL`: the staging PostgreSQL connection string.
- `JWT_SECRET`: a randomly generated secret with at least 32 bytes. Keep it private.
- Existing AI variables used by the application, if defect analysis is required.

Never commit these values or send them in chat.

## Create the first administrator

The database must be empty of user accounts. Run the following from the `backend` directory in a trusted one-off environment connected to the staging database:

1. Set `DATABASE_URL`, `MIC_ADMIN_LOGIN`, `MIC_ADMIN_NAME`, and `MIC_ADMIN_PASSWORD` as private environment variables. The password must be at least 12 characters.
2. Run `node scripts/bootstrap-admin.js`.
3. Confirm that the script reports the new administrator.
4. Remove `MIC_ADMIN_LOGIN`, `MIC_ADMIN_NAME`, and `MIC_ADMIN_PASSWORD` from the environment after the one-off run. Keep `JWT_SECRET` configured for the API.

The script refuses to run if a user already exists. It hashes the password and does not print it.

## Employee onboarding

1. An administrator creates an employee with a unique login in the MIC admin panel.
2. The app displays a one-time activation code. Pass it to that employee privately.
3. The employee chooses **Первый вход? Активировать аккаунт**, enters the login and code, then sets and confirms a password of at least 12 characters.
4. The code expires after 15 minutes and can be used only once.
5. The employee then signs in with the new password.

The API stores only bcrypt hashes for passwords and activation codes. Login and activation attempts are throttled per login and client IP in PostgreSQL.

## Before production rollout

- Run GitHub Actions checks and review every result.
- Test on a separate staging API and staging database.
- Exercise each role: administrator, production master, control master, controller, worker.
- Verify unauthorized requests return 401/403 and cannot impersonate another user by changing request IDs.
- Test the mobile app end-to-end, including photo upload and defect analysis.
- Only after acceptance, schedule a coordinated backend + mobile release. Do not point the live mobile app at this branch while the production backend remains unchanged.
