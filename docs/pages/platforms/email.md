## Email integration

LLM Engine can create an event from either of two kinds of inbound email, both arriving at the same webhook.

Email integration requires the use of [Postmark](https://postmarkapp.com), a third party service that receives mail on your behalf and posts it to your server as JSON.

### The two paths

- **Calendar invite.** An organizer adds the event setup bot as an attendee on a meeting invite. The webhook parses the attached `.ics` file for the title, time, and location, matches the invite title against a `Prefix:` in one of the organizer's existing Topics, and creates a draft event on that schedule.
- **Plain email, on demand.** An organizer emails the bot directly with a Zoom link and no calendar invite. An LLM call reads the email for the Zoom link, speakers, and, if stated, a start time. With no stated time, the Event Assistant joins the call right away; with a future time, the event is scheduled instead. Either way the organizer gets a reply with direct links to the event, the moderator view, and the participant view, and the bot leaves the call automatically once it ends.

Both paths are gated by `ALLOWED_ORGANIZER_EMAIL_DOMAINS` (see below): a sender outside the allowlist gets no event and no reply of any kind, not even an error.

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

| Variable                           | Required | Purpose                                                                                                                                                                                                |
| ---------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POSTMARK_WEBHOOK_AUTH_USER`       | yes      | Username half of the Basic Auth credentials configured on the Postmark inbound webhook. Must match the value Postmark sends.                                                                           |
| `POSTMARK_WEBHOOK_AUTH_SECRET`     | yes      | Secret half of the same credentials. Generate it randomly and rotate it periodically. Must match the value Postmark sends.                                                                             |
| `ALLOWED_ORGANIZER_EMAIL_DOMAINS`  | no       | Comma-separated domains allowed to create an event on either path. A sender outside this list gets no event and no reply, silently. **Leaving this unset drops every inbound message, on both paths.** |
| `ON_DEMAND_EVENT_DURATION_MINUTES` | no       | Default length, in minutes, for an on-demand event whose email states no duration. Defaults to 60.                                                                                                     |
| `EVENT_PARTICIPANT_PATH`           | no       | Path appended to `APP_HOST` for the participant link emailed to the organizer. Defaults to `/assistant/`.                                                                                              |
| `EVENT_MODERATOR_PATH`             | no       | Path appended to `APP_HOST` for the moderator link emailed to the organizer. Defaults to `/moderator/`.                                                                                                |

`POSTMARK_WEBHOOK_AUTH_USER` and `POSTMARK_WEBHOOK_AUTH_SECRET` are required to use this endpoint, but neither is required to boot the server. If either is unset, the handler rejects every request rather than accepting unverified ones, and logs that it is not configured.

### How verification works

Postmark does not sign inbound webhooks, so there is no signature to check. Basic Auth over TLS is the verification method Postmark's documentation recommends for inbound, and it is what this handler implements.

Rejected requests return `401`, never `403`. Postmark stops retrying a message permanently once it sees a `403`, so that status is reserved for messages that should never be delivered again.

### Reading the logs

The handler answers `200` on every path, including failures, because Postmark retries any non-`200` up to 10 times over roughly 10.5 hours. A `200` therefore means the message was accepted, not that it parsed. The log is where the outcome shows up:

| Log line                                                                     | Meaning                                                                      |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `parsed invite "..." (UID ...) ...`                                          | The calendar attachment parsed. Start and end times are in UTC.              |
| `no calendar attachment from ...; treating as a plain on-demand email`       | No `.ics` file was attached, so the message is routed to the on-demand path. |
| `sender ... is outside the allowlisted domains; rejecting, no event created` | `ALLOWED_ORGANIZER_EMAIL_DOMAINS` rejected the sender. No event, no reply.   |
| `no Zoom link found in email from ...; nothing created`                      | An on-demand email had no usable link. A failure email was sent.             |
| `"..." from ... is not a valid Zoom link`                                    | An on-demand email linked to a non-Zoom platform. A failure email was sent.  |
| `failed to parse inbound invite: ...`                                        | The message could not be processed at all (either path).                     |

Start and end times log as UTC. Calendar files state times in the organizer's zone, and Outlook names zones the Windows way (`Eastern Standard Time`) rather than the IANA way, shipping the matching definition inside the file. Those resolve through the file's own definition, so no timezone configuration is needed on this side. Times that look an hour off in the log point at that resolution failing.
