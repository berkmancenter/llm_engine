# Vibes Analyst: metrics reference

Every number the Vibes Analyst (VA) recap can show, what it means, how it is calculated,
and what it cannot tell you. All of these are computed in
[`conversationAnalytics.service.ts`](../../services/conversationAnalytics.service.ts) as a
`ConversationMetrics` object (its shape is in
[`index.types.ts`](../../types/index.types.ts)), then handed to the curator and the
fact-checking critic that write the card. Keep this file in sync when a metric changes.

Each metric has a plain-English meaning. The code names and formulas in `monospace` are
there for developers; a non-technical reader can skip them.

## Two trust tiers

The card keeps two kinds of numbers separate, and so should a reader:

- **Exact.** Counted directly from our own records, so the card states these plainly with
  no caveat. This covers who posted, the activity timeline, the busy spikes, the public
  versus private split, how often people called on the bot, the resource list, the event
  platform, and the audience-reaction quotes.
- **Estimate.** Pulled from a web-analytics tool (for example Matomo). These can run low,
  so the card always labels them as estimates and warns that the real number may be higher.
  This covers the visit counts and everything built on them (lurker counts, the share who
  spoke, and the typical-event averages).

## Which messages we count

Most of the exact numbers below count the same group of messages: the live chat that real
people typed during the event. We leave out three things: messages the bot itself sent,
messages that were never shown in the open chat (hidden ones, and private notes people sent
to the backchannel bot), and the speaker's spoken words written out as a transcript (that is
talk, not chat). We do count replies posted inside a thread. Developers: this shared rule is
`visibleHumanFilter` (`fromAgent: false`, `visible: true`, `channels != 'transcript'`).

## Participation (exact)

Source: `computeParticipation`. We count each real person once, even if they posted many
times. When a message has no person attached to it (rare), we fall back to the display name
it was posted under. Developers: grouped by `owner`, falling back to `pseudonymId`.

| Metric                       | Meaning                                                                                                               | How it is calculated                                                                                                                                                                                                                                   | Known limitations                                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `posterCount`                | How many different people posted at least one message                                                                 | We count each distinct person across the messages described above                                                                                                                                                                                      | A signed-out guest who changes their display name mid-event can be counted as two people; only a real signed-in account fully de-duplicates one person |
| `messageCount`               | The total number of messages those people sent                                                                        | We count all the messages that pass the filter above                                                                                                                                                                                                   | This includes replies posted inside a thread, so it can be higher than a simpler count that only tallies top-level posts                               |
| `frequentPosterCount`        | How many people did most of the talking                                                                               | We take the busiest tenth of the people who posted, ranked by how many messages they sent. If several people are tied right at the cutoff, we include all of them, so the group can be a little larger than a strict tenth (`ceil(posterCount * 0.1)`) | With fewer than 5 posters there is no meaningful "busiest tenth", so this is reported as 0                                                             |
| `frequentPosterMessageShare` | The slice of all messages this busiest group sent, written as a decimal: 0.4 means they sent 40 percent of everything | We add up that group's messages and divide by the total number of messages                                                                                                                                                                             | Not available when there are fewer than 5 posters, the same cutoff as the busiest-group count above                                                    |

## Tracked sessions (estimate)

Source: `deriveTrackedSessions`. A tracked session is one visit to the event page in a
browser, recorded by a web-analytics tool (for example Matomo) that watches how people use
the page. These numbers describe the people who joined the event. There is one set of
figures per analytics tool that recorded data.

| Metric                 | Meaning                                                                                  | How it is calculated                                                                                                                                          | Known limitations                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `trackedSessions`      | How many times someone opened the event page in a browser                                | The tool's total visit count                                                                                                                                  | This runs low: people using privacy browsers or ad and tracker blockers are not counted, so the real number is higher                   |
| `attendeeCount`        | How many people were registered or expected                                              | The figure the analytics tool reports                                                                                                                         | This comes straight from the analytics tool. It is not something we counted from the chat                                               |
| `avgDwellSeconds`      | On average, how long each visit to the page lasted, in seconds                           | We add up the time spent across all visits and divide by the number of visits                                                                                 | This counts visits, not people. If one person opens the page twice, that is two visits, which pulls the average toward shorter sessions |
| `totalActions`         | How many things people did on the page in total: clicks, page loads, and similar actions | The total the analytics tool reports                                                                                                                          | This is one lumped-together number. It cannot tell you which specific buttons or links people clicked (see "What we cannot track")      |
| `deviceBreakdown`      | How many visits came from each kind of device (phone, desktop, and so on)                | The per-device counts the analytics tool reports                                                                                                              | Runs low for the same reason visits do (blockers and privacy browsers are not counted)                                                  |
| `trackedSessionStatus` | Whether visit data exists for this event                                                 | One of three states: data is available; no analytics tool was set up for this event (`notTracked`); or a tool was set up but recorded nothing (`unavailable`) | This is just a status, not a number. The card uses it to decide which caveat to show                                                    |

## Audience engagement (estimate, derived)

Source: `computeAudienceEngagement`. This section compares two kinds of numbers: the people
we counted exactly from our own chat records, and the people the web-analytics estimate says
joined.

| Metric                         | Meaning                                                                                                                       | How it is calculated                                                                                              | Known limitations                                                                                                                                                                                                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `participantCount`             | How many people joined, based on tracked sessions                                                                             | Taken from the tracked-session figures above                                                                      | An estimate, so it inherits the same undercount                                                                                                                                                                                                                                 |
| `lurkerCount`                  | How many people watched without ever posting in chat (we call these lurkers)                                                  | We take the estimated number who joined and subtract the number who posted (`participantCount - posterCount`)     | Not available when more people posted than the visit estimate shows. The two numbers come from different systems (our own records for posters, the web-analytics estimate for joiners), so they do not always line up, and subtracting them would give a number we do not trust |
| `participationRate`            | The share of the room that spoke up, written as a decimal: 0.25 means a quarter of the people who joined posted at least once | We divide the number who posted by the estimated number who joined (`posterCount / participantCount`)             | Not available in the same case as the lurker count above. It is only approximate, because the joiner count is an estimate that can run low                                                                                                                                      |
| `postersExceedTrackedSessions` | A yes/no marker that more people posted than the visit estimate counted, which means the two numbers cannot be combined       | Yes when the number of posters is greater than the estimated number of joiners (`posterCount > participantCount`) | When this is yes, the card shows both raw numbers and some likely reasons for the gap. It does not show a lurker count or a participation share, because those would be misleading                                                                                              |

When more than one analytics tool recorded data, these figures use only the first one.

## Activity over time (exact)

Source: `bucketMessagesOverTime` then `toActivitySeries`.

| Metric           | Meaning                                                                                               | How it is calculated                                                                                                                                                                                                           | Known limitations                                                                                                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `activitySeries` | How many messages landed in each stretch of the event, so you can see when the room was busy or quiet | We split the event's running time (start to end) into 6 equal stretches and count the messages in each. Each stretch is labeled by its minute range from the start, so "0-9" is the first ten minutes and "10-19" the next ten | Only messages between the event's start and end are counted, so the stretches can add up to less than the total message count. If the start or end time is missing, we use the first and last message times instead |

## Spikes (exact counts, with optional read quote)

Source: `computeSpikes`, then `attributeSpikeSources`, then `annotateSpikes`. A spike is one
of the activity stretches above that ran much busier than the rest.

| Metric             | Meaning                                                                                                        | How it is calculated                                                                                                                                                                                                                                                                                                                                                                  | Known limitations                                                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spikes`           | The stretches that got noticeably busier than the rest, each with its minute range and message count           | A stretch counts as a spike when two things are both true: it had at least twice as many messages as a typical stretch, and it cleared a minimum size so a tiny burst does not qualify (at least 3 messages, or a tenth of the number of posters, whichever is larger, `max(3, ceil(posterCount * 0.1))`). The event also needs at least 3 stretches before we look for spikes at all | We look across every channel except the speaker's transcript, so a busy stretch can be driven by something other than public chat (for example a flurry of private messages to the bot) |
| `spike.ratio`      | How much busier this stretch was than normal, as a multiple: 3 means three times as busy as a typical stretch  | We divide this stretch's message count by the average message count of all the other stretches                                                                                                                                                                                                                                                                                        | Not available when every other stretch had no messages at all, because you cannot multiply against zero. In that case the card just points to the single busiest stretch instead        |
| `spike.source`     | Where the busy stretch came from: the public chat, the moderators, or private one-on-one messages with the bot | We look at the messages we are allowed to read and pick whichever source most of them came from. We label a stretch private only when there are no readable messages in it at all                                                                                                                                                                                                     | If a stretch is mostly private but has even one readable message, we credit that readable source instead of calling it private                                                          |
| `spike.annotation` | A short topic for the busy stretch plus one word-for-word quote showing what it was about                      | An AI model reads the public-chat and moderator messages from the two biggest spikes and writes the topic. It keeps a quote only if the words match the chat exactly                                                                                                                                                                                                                  | Only the two biggest spikes get this. Private spikes are never read or quoted, so all you see for those is the count                                                                    |

## Participation history and baseline (mixed)

Source: `computeHistoryAndBaseline`, over up to 10 recent past events in the same topic (the
recurring space these events live under).

| Metric                     | Meaning                                                                                                                                                                              | How it is calculated                                                                                                              | Known limitations                                                                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `participationHistory`     | A list covering this event and recent past events in the same space. For each one it shows how many people posted and how many watched without posting (lurkers)                     | Each entry carries an exact poster count and lurker count, labeled by the event's name and date, or "Today" for the current event | The lurker count is not available for a past event that had no visit data. Two events with the same name on the same day share one label. Dates use a single global time zone (UTC), so for an event far from that zone the date can read a day off |
| `baseline.avgPosterCount`  | The typical number of people who posted at recent events in this space. We call this the baseline: it is what "normal" looks like, so you can see whether this event ran high or low | The average poster count across the recent past events; `baseline.eventCount` is how many events went into that average           | Leaves out events marked as experimental. Not available when this is the only event in the space, since there is nothing to average                                                                                                                 |
| `baseline.avgLurkerCount`  | The typical number of lurkers at recent events in this space                                                                                                                         | The average across only the past events that had visit data; `baseline.trackedEventCount` is how many                             | This usually covers fewer events than the poster average above, because not every event had visit data, so do not read it as the average across every past event                                                                                    |
| `baseline.avgDwellSeconds` | The typical length of a visit at recent events in this space, in seconds                                                                                                             | The average across only the past events that had visit data (`baseline.trackedEventCount`)                                        | Covers only the same smaller set of events as the lurker average above                                                                                                                                                                              |

## Channel split (exact)

Source: `computeChannelSplit`.

| Metric                                         | Meaning                                                                            | How it is calculated                                                                                      | Known limitations                                                                             |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `channelSplit.public` / `channelSplit.private` | How many messages went to public chat versus private one-on-one chats with the bot | A message counts as private when it was a one-on-one message to the bot; everything else counts as public | This counts messages, not people. A handful of chatty people can run up a large private total |

## Bot invocations (exact)

Source: `computeBotInvocations`.

| Metric           | Meaning                                                       | How it is calculated                                                                                                          | Known limitations                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `botInvocations` | The bot's name and how many times people called on it by name | We count the chat messages where someone wrote the bot's name, using the same loose matching the bot uses to recognize itself | This works by spotting the name. A misspelling or an "@" in front still counts, but if someone refers to the bot without naming it (for example "can it summarize this?"), that does not count |

## Resource summary (exact)

Source: `computeResourceSummary`. Counts only the resources the audience could actually see.

| Metric                                                  | Meaning                                                                | How it is calculated                                                               | Known limitations                                                                                               |
| ------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `resourceSummary.total`                                 | How many readings and reference materials the audience was able to see | We count the resources on the event that were visible to participants              | Leaves out any resource that was hidden from participants                                                       |
| `resourceSummary.required` / `referenced` / `suggested` | The same count split by kind                                           | The visible resources sorted by their category: required, referenced, or suggested | Same visible-only scope                                                                                         |
| `resourceSummary.withLinks`                             | How many of those visible resources had a web link                     | The visible resources that had a link attached                                     | This only tells you a link was there. It cannot tell you whether anyone clicked it (see "What we cannot track") |

## Event platform (exact)

Source: `deriveEventPlatform`.

| Metric          | Meaning                                                   | How it is calculated                                                                  | Known limitations                                   |
| --------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `eventPlatform` | Which platform the event ran on: Nextspace, Zoom, or both | "both" when the event lists both Nextspace and Zoom, otherwise whichever one it lists | Defaults to Nextspace when no platform was recorded |

## Receptions (exact quotes, model-selected)

Source: `annotateReceptions`, filled in by the agent from the messages it is allowed to read.

| Metric       | Meaning                                                                                        | How it is calculated                                                                                                                                                                                                                                              | Known limitations                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `receptions` | Moments where something the speaker said got the chat talking, along with how the room reacted | An AI model finds a line the speaker said and the chat replies it set off. For each one it records how many replies followed, one example reply, and whether the room mostly agreed, pushed back, or was split. It keeps quotes only when the words match exactly | These are chosen by the model. The card reports the reaction only as the model classified it, and never reinterprets it |

## What we cannot track on the backend

Some signals the recap would want are not available here, because only the browser sees
them: reading-link clicks, tab clicks (Berkie, Group chat, References), and quick-guide
clicks. The engine cannot compute them. A client like Nextspace has to record them and send them to the
analytics provider, which the engine then reads generically. They would be estimates (the
same undercount as tracked sessions), so they would carry the may-undercount caveat, unlike
the exact resource counts above. Until that tracking exists on the client side, the recap can say how many
readings and links an event had, never whether anyone opened them.
