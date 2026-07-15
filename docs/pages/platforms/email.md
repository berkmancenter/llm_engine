## Email integration

LLM Engine can receive calendar invites by email. An event organizer adds the event setup bot as an attendee on a meeting invite, and the invite arrives here as an inbound webhook.

Email integration requires the use of [Postmark](https://postmarkapp.com), a third party service that receives mail on your behalf and posts it to your server as JSON.

> **Current scope:** the webhook verifies the request, parses the attached calendar file, and logs what it found. It does not create events or send mail yet.

### Set up Postmark

#### One Time Setup

1. Create a Postmark account and a server with an inbound stream.
2. Choose a username and generate a secret for the webhook. The secret is a random string, not a hand-picked password:

   ```
   openssl rand -base64 32
   ```

3. Set the inbound webhook URL to `[baseUrl]/v1/webhooks/email`, with the credentials from step 2 embedded in it:

   ```
   https://[username]:[secret]@[baseUrl]/v1/webhooks/email
   ```

   Postmark sends those as an HTTP Basic Auth header on every inbound message. If you create the webhook through Postmark's API instead of the dashboard, use the `HttpAuth` field rather than embedding them in the URL.

4. Set the same pair in the LLM Engine `.env` file. The handler compares every incoming request against these, so a mismatch between Postmark and `.env` rejects the message as a 401.

#### Add environment variables

| Variable                       | Required | Purpose                                                                                                                      |
| ------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `POSTMARK_WEBHOOK_AUTH_USER`   | yes      | Username half of the Basic Auth credentials configured on the Postmark inbound webhook. Must match the value Postmark sends. |
| `POSTMARK_WEBHOOK_AUTH_SECRET` | yes      | Secret half of the same credentials. Generate it randomly and rotate it periodically. Must match the value Postmark sends.   |

Both are required to use this endpoint, but neither is required to boot the server. If either is unset, the handler rejects every request rather than accepting unverified ones, and logs that it is not configured.

### How verification works

Postmark does not sign inbound webhooks, so there is no signature to check. Basic Auth over TLS is the verification method Postmark's documentation recommends for inbound, and it is what this handler implements.

Rejected requests return `401`, never `403`. Postmark stops retrying a message permanently once it sees a `403`, so that status is reserved for messages that should never be delivered again.

### Reading the logs

The handler answers `200` on every path, including failures, because Postmark retries any non-`200` up to 10 times over roughly 10.5 hours. A `200` therefore means the message was accepted, not that it parsed. The log is where the outcome shows up:

| Log line                                            | Meaning                                                         |
| --------------------------------------------------- | --------------------------------------------------------------- |
| `parsed invite "..." (UID ...) ...`                 | The calendar attachment parsed. Start and end times are in UTC. |
| `inbound message had no calendar (.ics) attachment` | The message arrived but carried nothing to process.             |
| `failed to parse inbound invite: ...`               | A calendar attachment was present but unreadable.               |

Start and end times log as UTC. Calendar files state times in the organizer's zone, and Outlook names zones the Windows way (`Eastern Standard Time`) rather than the IANA way, shipping the matching definition inside the file. Those resolve through the file's own definition, so no timezone configuration is needed on this side. Times that look an hour off in the log point at that resolution failing.
