# Implementation Walkthrough: OpenAPI 3.1.0 Specification

We have analyzed the Express API implementation in `server.js` and successfully built a comprehensive OpenAPI 3.1.0 specification detailing all endpoints, authentication mechanisms, parameters, request bodies, and responses.

## Key Actions Taken

1. **API Endpoint Identification**:
   - Analyzed route definition and handler registration logic in `server.js`.
   - Identified 24 distinct API endpoints handling Authentication, Profile management, Weekly Session setup, Roster Sign-up, Pairings generation, Match Scoring, push notification subscription, and tournament/leaderboard analytics.

2. **Security & Authentication Schema Mapping**:
   - Documented the JWT Bearer token authentication mechanism.
   - Documented the Google OAuth path (`POST /api/auth/google`) including the handling of incomplete registrations (where `gender` or `level` must be supplied if registering a new profile).
   - Indicated public vs. protected endpoints clearly with explicit `security: []` and `security: [{ bearerAuth: [] }]` descriptors to satisfy standard schema validation.

3. **Data Model Design (Schemas & Components)**:
   - Defined robust OpenAPI schemas for `PlayerProfile`, `MatchDetails`, `DraftPlayer`, and `ErrorResponse`.
   - Adopted OpenAPI 3.1.0 specifications by mapping nullable database fields to standard JSON schema multi-type fields (e.g., `type: [string, "null"]` and `oneOf: - type: "null"`).
   - Handled multipart file uploads (`multipart/form-data`) on the registration and profile updates endpoints (avatar image uploads).

4. **Linting and Validation**:
   - Validated the generated `openapi.yaml` configuration using `@redocly/cli`.
   - Resolved all structural errors (e.g. deprecated `nullable` properties) to achieve a clean compilation status.

## Verification Details

The specification was successfully linted and validated with `@redocly/cli`:
```bash
npx @redocly/cli lint openapi.yaml
```
Output:
```text
validating openapi.yaml...
openapi.yaml: validated in 99ms

Woohoo! Your API description is valid. 🎉
You have 3 warnings.
```

The 3 minor warnings are context-specific and standard (use of local server url host and endpoints without 4xx responses, which is expected for static public configuration parameters).
