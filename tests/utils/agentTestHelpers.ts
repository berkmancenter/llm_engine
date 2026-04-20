import mongoose from 'mongoose'
import faker from 'faker'
import { Agent, Channel, Conversation, Message } from '../../src/models/index.js'
import { insertUsers } from '../fixtures/user.fixture.js'
import { publicTopic } from '../fixtures/conversation.fixture.js'
import { insertTopics } from '../fixtures/topic.fixture.js'
import loadTranscript from './transcriptUtils.js'
import transcript from '../../src/agents/helpers/transcript.js'
import { IMessage } from '../../src/types/index.types.js'

/**
 * NOTE: this video transcript is from TedX Talks
 * Why your company should consider part-time work by Jessica Drain
 * Jun 22, 2025
 * Available at: https://www.youtube.com/watch?v=foHEGfmvE9c
 */
const partTimeWorkTranscript = `00:23 | Jessica: true or false no one wants to work
00:28 | Jessica: anymore this is a common refrain I've
00:31 | Jessica: heard from business owners over the past
00:34 | Jessica: 5 to 10 years especially over the last
00:37 | Jessica: five you may have even said it
00:41 | Jessica: yourself owners and managers are always
00:44 | Jessica: looking for help especially in today's
00:47 | Jessica: market and many struggle to find and
00:50 | Jessica: retain good
00:52 | Jessica: help and it is
00:54 | Jessica: true employees have the absolute pick of
00:58 | Jessica: the litter when it comes to their chosen
01:00 | Jessica: jobs and careers so they won't apply for
01:03 | Jessica: let alone stay at a job that doesn't fit
01:06 | Jessica: their values desired lifestyle or their
01:10 | Jessica: life
01:11 | Jessica: circumstances not only that in the
01:13 | Jessica: United States we are generally sicker
01:16 | Jessica: and die earlier than our other wealthy
01:18 | Jessica: Nation counterparts and I believe our
01:21 | Jessica: traditional work structures are
01:23 | Jessica: contributing to that so it's up to us
01:26 | Jessica: the employers to change we have to
01:29 | Jessica: change how we hire and how we manage to
01:32 | Jessica: keep our businesses running efficiently
01:34 | Jessica: and profitably we need to offer
01:36 | Jessica: part-time positions that are paid
01:38 | Jessica: full-time and offer greater flexibility
01:41 | Jessica: and
01:42 | Jessica: autonomy for businesses struggling to
01:45 | Jessica: find good workers to find employees
01:48 | Jessica: offering part-time positions will help
01:50 | Jessica: you appeal to people who maybe only have
01:53 | Jessica: a select hours to give to a
01:56 | Jessica: career I realize that certain businesses
01:59 | Jessica: and Industry and job types may not be
02:03 | Jessica: able to accommodate this or it will be
02:04 | Jessica: harder for them too but at the very
02:07 | Jessica: least if you take anything away from my
02:09 | Jessica: talk today I challenge you to question
02:13 | Jessica: why 40 hours per week is
02:16 | Jessica: fulltime why 20 hours per week is
02:20 | Jessica: part-time and why we're adhering to
02:23 | Jessica: these Frameworks set over a hundred
02:25 | Jessica: years
02:26 | Jessica: ago our world our work and our culture
02:31 | Jessica: are all vastly different than they were
02:32 | Jessica: then so hear me out for a few
02:35 | Jessica: minutes so here's a personal story that
02:38 | Jessica: illustrates why I feel this shift is so
02:40 | Jessica: crucial when I first became a single mom
02:43 | Jessica: I decided I needed to get a real job I
02:47 | Jessica: had owned my own business for several
02:49 | Jessica: years but it suffered at the end of my
02:51 | Jessica: marriage and I yearned for some
02:53 | Jessica: Financial
02:54 | Jessica: stability a consistent known income if
02:58 | Jessica: you will so I hired on founded a company
03:01 | Jessica: that I absolutely loved and I still love
03:03 | Jessica: and respect the work that they're doing
03:04 | Jessica: it's very important and I committed to
03:07 | Jessica: 30 hours per week I still worked on my
03:10 | Jessica: freelance business and on a second
03:12 | Jessica: business that my sister and I had
03:13 | Jessica: recently started because I still needed
03:16 | Jessica: to make more money than I was making in
03:18 | Jessica: the real job to make ends
03:22 | Jessica: meet two years later for a variety of
03:25 | Jessica: reasons some of which were admittedly my
03:27 | Jessica: own
03:28 | Jessica: failings I was told I had to leave the
03:31 | Jessica: company my position was eliminated but I
03:34 | Jessica: could take a new position with the same
03:38 | Jessica: responsibilities and
03:40 | Jessica: pay at 40 hours per week because they
03:44 | Jessica: needed more out of
03:45 | Jessica: me I initially accepted the position
03:48 | Jessica: because I felt I had very few options at
03:50 | Jessica: the time I was living in a town of 2,000
03:52 | Jessica: people and this was right before the
03:54 | Jessica: pandemic so there were hardly any remote
03:56 | Jessica: options offered then I immediately did
03:60 | Jessica: not sleep enough a foundational physical
04:02 | Jessica: and psychological need nor was I eating
04:05 | Jessica: well I skip meals when I'm stressed or
04:08 | Jessica: moving my body
04:09 | Jessica: consistently every waking moment was
04:12 | Jessica: filled with household duties parenting
04:16 | Jessica: my two small children or working one of
04:18 | Jessica: my three
04:20 | Jessica: jobs as a result I was completely
04:24 | Jessica: exhausted and in a state of utter
04:26 | Jessica: survival mode within just a couple of
04:28 | Jessica: weeks my
04:30 | Jessica: I had an irregular heartbeat which was
04:33 | Jessica: something that I had had happen when I
04:34 | Jessica: overworked myself
04:36 | Jessica: previously and I was in a complete state
04:39 | Jessica: of overwhelm and
04:41 | Jessica: exhaustion not only that I was
04:45 | Jessica: mad because I had done it before I knew
04:48 | Jessica: I could make more money in fewer hours
04:52 | Jessica: without the detriment to my mental and
04:54 | Jessica: physical
04:55 | Jessica: health so I quit after only three months
04:58 | Jessica: in the new position
05:01 | Jessica: because I was unwilling to work 50 to 60
05:04 | Jessica: hours per week as a single mom with a
05:07 | Jessica: child who actually needed some Therapies
05:08 | Jessica: in a town 40 miles away just to make
05:11 | Jessica: ends
05:12 | Jessica: meet that experience and the experience
05:16 | Jessica: I've had since have lit a fire under me
05:19 | Jessica: to create opportunities for others like
05:22 | Jessica: me fast forward to today and I've helped
05:26 | Jessica: build that company that my sister and I
05:28 | Jessica: started to an annual revenue of over a
05:30 | Jessica: million dollars all thank
05:36 | Jessica: you all in part-time
05:42 | Jessica: hours strong women cry
05:45 | Jessica: too um all in part-time hours with a
05:49 | Jessica: small team of part-time employees I work
05:52 | Jessica: on gen generally 20 to 25 hours per week
05:55 | Jessica: my teammates work 10 to 30 my employees
05:59 | Jessica: were all all earning incomes on par with
06:01 | Jessica: our more full-time counterparts while
06:04 | Jessica: still being able to take care of
06:06 | Jessica: ourselves and our families and my
06:08 | Jessica: employees constantly say how grateful
06:11 | Jessica: they are to work for such an amazing
06:13 | Jessica: company and how they never thought
06:14 | Jessica: they'd be able to find something like
06:16 | Jessica: this if I can do it I truly believe that
06:19 | Jessica: you can
06:21 | Jessica: too so how do I think you should go
06:23 | Jessica: about it well first create jobs with
06:25 | Jessica: lower hour requirements with some as 8
06:28 | Jessica: to 10 hours per week Max out at 32 hours
06:31 | Jessica: per
06:32 | Jessica: week by creating these lower hour
06:35 | Jessica: requirement jobs you are going to appeal
06:37 | Jessica: to people who have less time to work but
06:41 | Jessica: these people still might desire to work
06:43 | Jessica: and earn an income for their families
06:45 | Jessica: consider these statistics caregivers one
06:49 | Jessica: in five us adults identifies as a
06:53 | Jessica: caregiver six out of 10 of them report
06:55 | Jessica: cutting work hours taking leaves of
06:58 | Jessica: absence or receiving per performance
07:00 | Jessica: warnings as a result of being caregivers
07:04 | Jessica: and again that's 53 million people
07:07 | Jessica: single parents like I said I'm one of
07:09 | Jessica: them comprise 25 to 30% of us households
07:12 | Jessica: with children under 18 comprising 8 to
07:15 | Jessica: 12 million people depending on the
07:17 | Jessica: source that you look
07:18 | Jessica: at people with disabilities account for
07:21 | Jessica: over 44 million people in the United
07:24 | Jessica: States and we cannot forget those who
07:29 | Jessica: are primary parents in two parent
07:31 | Jessica: households who aren't working at all or
07:33 | Jessica: very little to take care of their
07:34 | Jessica: households and their
07:35 | Jessica: families as well as retirees and those
07:39 | Jessica: simply wanting a flexible lifestyle
07:41 | Jessica: which in my anecdotal experience I think
07:43 | Jessica: is one of the biggest shifts since the
07:45 | Jessica: pandemic people have realized they want
07:47 | Jessica: flexibility and autonomy over their time
07:49 | Jessica: and their lives for example a couple of
07:52 | Jessica: years ago when I put together the job
07:54 | Jessica: description for a marketing coordinator
07:56 | Jessica: and estimated the number of hours we
07:57 | Jessica: needed the person to work I came up with
08:00 | Jessica: about
08:02 | Jessica: 10 my sister and I discussed increasing
08:05 | Jessica: the role to 20 hours per week but
08:08 | Jessica: because we really like we thought who in
08:10 | Jessica: the heck would want to work only 10
08:12 | Jessica: hours per week like we didn't even get
08:14 | Jessica: it then but it was all we needed and so
08:17 | Jessica: we just decided to post the job and see
08:19 | Jessica: what happened and I am telling you we
08:22 | Jessica: were absolutely
08:24 | Jessica: shocked we had hundreds of applicants
08:28 | Jessica: from all over the country and the world
08:30 | Jessica: for that matter apply and from
08:33 | Jessica: incredibly high level
08:36 | Jessica: individuals mind you this was a position
08:38 | Jessica: that we felt was entry level at the time
08:40 | Jessica: it was very rot routine tasks but we had
08:44 | Jessica: applicants working as key Marketing
08:46 | Jessica: Executives for Fortune 500 companies and
08:50 | Jessica: large industry organizations
08:52 | Jessica: apply one had even written a book on
08:56 | Jessica: marketing it turns out that people are
08:59 | Jessica: starving for jobs that allow them to
09:01 | Jessica: provide value while being able to take
09:04 | Jessica: care of their most important
09:07 | Jessica: priorities the woman we eventually hired
09:09 | Jessica: was the one who had written the book on
09:11 | Jessica: marketing she and her husband have
09:14 | Jessica: become parents to four
09:16 | Jessica: children through foster care and
09:18 | Jessica: adoption essentially overnight you
09:21 | Jessica: should hear the story it's crazy and
09:23 | Jessica: they are ages zero five months three and
09:25 | Jessica: four as you can imagine that's a lot
09:29 | Jessica: right
09:31 | Jessica: so she immediately shut down her
09:32 | Jessica: business and decided to focus on finding
09:35 | Jessica: their new normal as a family she still
09:38 | Jessica: wanted and in some ways needed to work
09:40 | Jessica: and earn an income for her family but
09:42 | Jessica: she didn't think she was going to fit
09:43 | Jessica: anywhere until her kids were much
09:46 | Jessica: older until as a customer of ours she
09:49 | Jessica: got our weird hiring
09:52 | Jessica: email and got so excited about the
09:55 | Jessica: opportunity she locked herself in the
09:57 | Jessica: bathroom texted her husband to to take
09:60 | Jessica: care of the kids and make sure everyone
10:01 | Jessica: was safe and didn't die and applied for
10:04 | Jessica: the
10:05 | Jessica: job over the past two years she has
10:07 | Jessica: helped grow our business exponentially
10:10 | Jessica: working 10 hours per week on
10:12 | Jessica: average around her family's life as
10:18 | Jessica: well so you are going to appeal to these
10:22 | Jessica: people
10:24 | Jessica: and breaking it out into breaking the if
10:27 | Jessica: you're only if you're currently only
10:29 | Jessica: offering tradition part-time and
10:30 | Jessica: full-time positions break them out into
10:33 | Jessica: what I'm calling the smallest viable job
10:36 | Jessica: and the way you can do that can think
10:38 | Jessica: about it and the way I think about it is
10:40 | Jessica: if you have a job that has multiple
10:43 | Jessica: responsibilities which most jobs do
10:45 | Jessica: right like customer service data entry
10:48 | Jessica: or
10:50 | Jessica: reconciliation break each set of
10:52 | Jessica: responsibilities out into a separate
10:54 | Jessica: role and post it I know you're kind of
10:58 | Jessica: thinking like I'm not sure I want to
10:59 | Jessica: take the time to do that and hire them
11:02 | Jessica: and train them for just eight to 10
11:03 | Jessica: hours per
11:04 | Jessica: week but if that position is a great fit
11:08 | Jessica: for that person they're going to stay on
11:11 | Jessica: with you for years to come and it will
11:12 | Jessica: be well worth the time I took to train
11:15 | Jessica: them not only that think about what you
11:18 | Jessica: or the person being freed up from that
11:19 | Jessica: time can do with extra eight to 10 hours
11:21 | Jessica: per week I know I can get a lot done in
11:24 | Jessica: that amount of
11:25 | Jessica: time then to help retain these employees
11:28 | Jessica: pay them on par with their more
11:29 | Jessica: full-time counterparts and for the value
11:32 | Jessica: they provide your
11:33 | Jessica: company so if somebody's working 30 to
11:36 | Jessica: 32 hours per week pay them on power with
11:38 | Jessica: 40 hour per week rates if somebody is
11:40 | Jessica: working on average 15 pay them on power
11:43 | Jessica: with 20 hour per week rates or simply
11:45 | Jessica: for the value they provide your business
11:48 | Jessica: don't worry about how much time it's
11:50 | Jessica: taking them to do the job what matters
11:52 | Jessica: is the value they
11:57 | Jessica: provide lastly offer them more more
11:59 | Jessica: flexibility and autonomy than the
12:01 | Jessica: typical 9 to-5
12:03 | Jessica: job the first way again I do know that
12:06 | Jessica: not every business or job type can do
12:08 | Jessica: this but just I challenge you to think
12:10 | Jessica: about how you might be able to in your
12:11 | Jessica: business allow them to work two days per
12:14 | Jessica: week from home a landmark study
12:17 | Jessica: published in nature earlier this year
12:18 | Jessica: showed increased employee satisfaction
12:21 | Jessica: and a
12:22 | Jessica: 33% reduction and
12:24 | Jessica: quitting especially among women and long
12:27 | Jessica: commuters who implemented this type of
12:29 | Jessica: work hybrid work policy and they
12:32 | Jessica: experienced no losses in performance or
12:36 | Jessica: promotion rates that is pretty powerful
12:40 | Jessica: and then in my opinion let them work
12:42 | Jessica: when it works for them have core hours
12:44 | Jessica: if you need it but otherwise like 10 to
12:47 | Jessica: two 9 to three otherwise let them work
12:49 | Jessica: when it works for them at my company we
12:53 | Jessica: uh work around our kids schedules school
12:56 | Jessica: and summer schedules
13:00 | Jessica: and I know you might be thinking like
13:02 | Jessica: how exactly am I can I really trust this
13:05 | Jessica: is going to work but it is here where
13:07 | Jessica: research proved my point but also I also
13:10 | Jessica: want us to as business owners trust that
13:12 | Jessica: our employees are adults and are going
13:14 | Jessica: to do the job that they're said they're
13:16 | Jessica: going to do and giving them immediate
13:18 | Jessica: feedback if they don't do
13:21 | Jessica: it so here's a a graph from the European
13:24 | Jessica: think take autonomy that shows the
13:27 | Jessica: strong correlation between reduced
13:29 | Jessica: working hours and productivity among
13:31 | Jessica: wealthy Nations as you can see all of
13:34 | Jessica: the most imp productive nations are leak
13:38 | Jessica: are working the least amount of hours
13:40 | Jessica: and it's actually only improving except
13:42 | Jessica: for Norway not really sure what's
13:43 | Jessica: happening with them but um uh everyone
13:46 | Jessica: else is improving most likely due to
13:48 | Jessica: Technologies a review of seven studies
13:51 | Jessica: in 2022 showed increased employee
13:54 | Jessica: satisfaction better work life balance
13:56 | Jessica: better sleep reduced stress among
13:59 | Jessica: employees who worked 30 to 32 hours per
14:01 | Jessica: week on average and a 2022 review uh
14:05 | Jessica: Gallup stud Gallup
14:07 | Jessica: survey showed that pay and work life
14:11 | Jessica: balance matter the most when it comes to
14:13 | Jessica: employee satisfaction so if you're doing
14:15 | Jessica: both very well you're going to attract
14:17 | Jessica: more people and retain
14:20 | Jessica: them so fellow business owners and
14:23 | Jessica: managers please join me in being leaders
14:26 | Jessica: of what I feel is the employment
14:28 | Jessica: Revolution or is the employment
14:31 | Jessica: Revolution not victims of
14:34 | Jessica: it you're you'll attract better help
14:37 | Jessica: retain them and increase your profits
14:40 | Jessica: ultimately allowing you to achieve your
14:42 | Jessica: personal and professional goals and I
14:44 | Jessica: believe positively impacting our culture
14:47 | Jessica: at large the businesses of the future
14:50 | Jessica: are human not cogs in an industrial
14:53 | Jessica: machine thank you`

/**
 * NOTE: this video transcript is excerpted from
 * the TED YouTube channel
 * 'Where are all the Aliens?' by Stephen Webb
 * Available at: https://www.youtube.com/watch?v=qaIghx4QRN4
 */
const aliensTranscript = `00:13 - Speaker: I saw a UFO once.
00:15 - Speaker:  I was eight or nine,
00:17 - Speaker:  playing in the street with a friend who was a couple of years older,
00:21 - Speaker:  and we saw a featureless silver disc hovering over the houses.
00:25 - Speaker:  We watched it for a few seconds,
00:27 - Speaker:  and then it shot away incredibly quickly.
00:30 - Speaker:  Even as a kid,
00:32 - Speaker:  I got angry it was ignoring the laws of physics.
00:35 - Speaker:  We ran inside to tell the grown-ups,
00:37 - Speaker:  and they were skeptical --
00:39 - Speaker:  you'd be skeptical too, right?
00:42 - Speaker:  I got my own back a few years later:
00:44 - Speaker:  one of those grown-ups told me,
00:45 - Speaker:  "Last night I saw a flying saucer.
00:47 - Speaker:  I was coming out of the pub after a few drinks."
00:50 - Speaker:  I stopped him there. I said, "I can explain that sighting."
00:54 - Speaker:  Psychologists have shown we can't trust our brains
00:57 - Speaker:  to tell the truth.
00:58 - Speaker:  It's easy to fool ourselves.
00:60 - Speaker:  I saw something,
01:01 - Speaker:  but what's more likely --
01:03 - Speaker:  that I saw an alien spacecraft,
01:05 - Speaker:  or that my brain misinterpreted the data my eyes were giving it?
01:10 - Speaker:  Ever since though I've wondered:
01:12 - Speaker:  Why don't we see flying saucers flitting around?
01:15 - Speaker:  At the very least,
01:16 - Speaker:  why don't we see life out there in the cosmos?
01:19 - Speaker:  It's a puzzle,
01:20 - Speaker:  and I've discussed it with dozens of experts
01:23 - Speaker:  from different disciplines over the past three decades.
01:26 - Speaker:  And there's no consensus.
01:28 - Speaker:  Frank Drake began searching for alien signals back in 1960 --
01:32 - Speaker:  so far, nothing.
01:34 - Speaker:  And with each passing year,
01:35 - Speaker:  this nonobservation,
01:37 - Speaker:  this lack of evidence for any alien activity gets more puzzling
01:43 - Speaker:  because we should see them, shouldn't we?
01:47 - Speaker:  The universe is 13.8 billion years old,
01:51 - Speaker:  give or take.
01:52 - Speaker:  If we represent the age of the universe by one year,
01:56 - Speaker:  then our species came into being about 12 minutes before midnight,
02:00 - Speaker:  31st December.
02:02 - Speaker:  Western civilization has existed for a few seconds.
02:06 - Speaker:  Extraterrestrial civilizations could have started in the summer months.
02:11 - Speaker:  Imagine a summer civilization
02:13 - Speaker:  developing a level of technology more advanced than ours,
02:18 - Speaker:  but tech based on accepted physics though,
02:20 - Speaker:  I'm not talking wormholes or warp drives -- whatever --
02:24 - Speaker:  just an extrapolation of the sort of tech that TED celebrates.
02:29 - Speaker:  That civilization could program self-replicating probes
02:32 - Speaker:  to visit every planetary system in the galaxy.
02:36 - Speaker:  If they launched the first probes just after midnight one August day,
02:41 - Speaker:  then before breakfast same day,
02:43 - Speaker:  they could have colonized the galaxy.
02:47 - Speaker:  Intergalactic colonization isn't much more difficult,
02:49 - Speaker:  it just takes longer.
02:51 - Speaker:  A civilization from any one of millions of galaxies
02:54 - Speaker:  could have colonized our galaxy.
02:57 - Speaker:  Seems far-fetched?
02:59 - Speaker:  Maybe it is,
02:60 - Speaker:  but wouldn't aliens engage in some recognizable activity --
03:05 - Speaker:  put worldlets around a star to capture free sunlight,
03:09 - Speaker:  collaborate on a Wikipedia Galactica,
03:13 - Speaker:  or just shout out to the universe, "We're here"?`

/**
 * NOTE: this video transcript is excerpted from
 * the TED YouTube channel
 * 'How forgiveness can create a more just legal system' by Martha Minow
 * Available at: https://www.youtube.com/watch?v=quDwQ7W9eKc
 */

const forgivenessTranscript = `00:13 - Speaker: Would you ever forgive a person who kills a member of your family?
00:19 - Speaker:  In September of 2019,
00:22 - Speaker:  Dallas police officer Amber Guyger was sentenced for murder,
00:28 - Speaker:  and then the brother of the victim
00:31 - Speaker:  forgave her.
00:34 - Speaker:  Brandt Jean was 18 years old,
00:37 - Speaker:  and I joined the rest of the country watching on television in awe
00:42 - Speaker:  at that act of grace.
00:45 - Speaker:  But I also worried.
00:47 - Speaker:  I worried that people who are African American like Brandt Jean
00:52 - Speaker:  are expected to forgive more often than other people.
00:57 - Speaker:  And I worried that a white police officer like Amber Guyger
01:01 - Speaker:  receives a lesser sentence
01:03 - Speaker:  than other people who commit wrongful killings.
01:07 - Speaker:  But because I'm a law professor,
01:10 - Speaker:  I also worried about the law itself.
01:14 - Speaker:  The law leans so severely towards punishment these days
01:19 - Speaker:  that it's part of the problem.
01:22 - Speaker:  And that's what I want to talk about here.
01:25 - Speaker:  The powerful example of one individual's forgiveness
01:30 - Speaker:  makes me worry that lawyers and officials too often overlook the tools
01:35 - Speaker:  that law itself creates to allow forgiveness,
01:40 - Speaker:  when the principle should be the cornerstone of a thriving society.
01:46 - Speaker:  I worry that lawyers and officials do not adequately use the tools of forgiveness,
01:52 - Speaker:  by which I mean letting go of justified grievance.
01:57 - Speaker:  And those tools are many.
01:58 - Speaker:  They include pardons, commutations, expungement,
02:03 - Speaker:  bankruptcy for debt
02:05 - Speaker:  and the discretion that's held by police and prosecutors and judges.
02:11 - Speaker:  But I also worry -- I worry a lot --
02:14 - Speaker:  I worry that these tools, when used, replicate the disparities,
02:21 - Speaker:  the inequities along the lines of race and class and other markers
02:25 - Speaker:  of advantage and disadvantage.
02:27 - Speaker:  Biases or privileged access are at work
02:31 - Speaker:  when United States presidents pardon people charged with crimes.
02:37 - Speaker:  Historically, white people are pardoned four times as often
02:41 - Speaker:  as members of minority groups for the same crime, same sentence.
02:48 - Speaker:  Forgiveness between individuals is supported by every religious tradition,
02:53 - Speaker:  every philosophic tradition.
02:56 - Speaker:  And medical evidence now shows
02:58 - Speaker:  the health benefits of letting go of grievances and resentments.
03:04 - Speaker:  As Nelson Mandela led South Africa's transition
03:09 - Speaker:  from apartheid to democracy,
03:11 - Speaker:  he explained,
03:12 - Speaker:  "Resentment is like drinking a poison and hoping it will kill your enemies."
03:20 - Speaker:  Law can remove the penalties for those who apologize and seek forgiveness.
03:25 - Speaker:  For example, in 39 states in the United States
03:29 - Speaker:  and the District of Columbia,
03:31 - Speaker:  there are laws that allow medical professionals to apologize
03:34 - Speaker:  when something goes wrong
03:35 - Speaker:  and not fear that that statement could later be used against them
03:40 - Speaker:  in an action for damages.
03:43 - Speaker:  More actively, bankruptcy law offers debtors, under some conditions,
03:48 - Speaker:  the chance to start anew.
03:50 - Speaker:  Pardons and expungements sealing criminal records can, too.
03:56 - Speaker:  I have been teaching law for almost 40 years, hard to believe,
04:02 - Speaker:  but recently, I realized
04:05 - Speaker:  that we don't teach law students about the tools of forgiveness
04:09 - Speaker:  that are within the legal system,
04:11 - Speaker:  and nor do law schools usually explore
04:14 - Speaker:  the potential for new avenues for forgiveness
04:18 - Speaker:  that law can adopt or assist.
04:21 - Speaker:  These are lost opportunities.
04:23 - Speaker:  These are lost obligations, even,
04:25 - Speaker:  because the students that I teach
04:29 - Speaker:  will become prosecutors, judges, governors, presidents.
04:35 - Speaker:  Barack Obama, my former student,
04:38 - Speaker:  used his power as the President of the United States to give pardons.
04:44 - Speaker:  That released several hundred people from prison after the law changed
04:49 - Speaker:  to provide shorter sentences for the same drug crimes
04:52 - Speaker:  for which they had been convicted.
04:54 - Speaker:  But if he hadn't used his pardon power, they would still be in prison.
04:59 - Speaker:  Legal tools of forgiveness should be used more,
05:02 - Speaker:  but not without reason and not with bias.
05:06 - Speaker:  A "New Yorker" cartoon shows a judge with a big nose and a big mustache
05:10 - Speaker:  looking down at a defendant with the exact same nose
05:14 - Speaker:  and exact same mustache
05:15 - Speaker:  and says, "Obviously not guilty."
05:19 - Speaker:  Forgiveness could undermine the commitment that law has
05:24 - Speaker:  to treat people the same under the same circumstances,
05:28 - Speaker:  to apply rules evenly.
05:30 - Speaker:  In this age of resentment, mass incarceration,
05:34 - Speaker:  widespread consumer debt,
05:37 - Speaker:  we need more forgiveness, but we need a philosophy of forgiveness.
05:41 - Speaker:  We need to forgive fairly.
05:45 - Speaker:  Contrast the treatment globally of child soldiers
05:49 - Speaker:  with the treatment of juvenile offenders in the United States.
05:54 - Speaker:  International human rights condemn and punish adults
05:58 - Speaker:  who involve children in armed conflict
06:00 - Speaker:  as those most responsible,
06:02 - Speaker:  but treat the children themselves quite differently.
06:07 - Speaker:  The International Criminal Court,
06:09 - Speaker:  now with 122 member nations,
06:12 - Speaker:  convicted Thomas Lubanga, warlord in the [Democratic Republic of the] Congo,
06:17 - Speaker:  for enlisting, recruiting and deploying children, teens, as soldiers.
06:24 - Speaker:  Many nations commit to ensuring that people under the age of 15
06:29 - Speaker:  do not become child soldiers,
06:31 - Speaker:  and most nations treat those who do become soldiers
06:35 - Speaker:  not as objects of punishment
06:38 - Speaker:  but as people deserving a fresh start.
06:41 - Speaker:  Compare and contrast how the United States treats juvenile offenders,
06:47 - Speaker:  where we severely punish minors,
06:49 - Speaker:  often moving them to adult courts, even adult prisons.
06:53 - Speaker:  And yet, like child soldiers,
06:56 - Speaker:  teens and children are drawn into violent activity in the United States
07:01 - Speaker:  when there are few options,
07:03 - Speaker:  when they are threatened
07:04 - Speaker:  or when adults induce them with money or ideology.
07:09 - Speaker:  The rhetoric of innocence is resonant when we talk about child soldiers,
07:16 - Speaker:  but not when we talk about teen gang members in the United States.
07:21 - Speaker:  Yet in both settings, youth are caught in worlds that are made by adults,
07:25 - Speaker:  and forgiveness can offer both accountability and fresh starts.
07:30 - Speaker:  What if, instead, young people caught in criminal activity and violence
07:35 - Speaker:  could have chances to accept responsibility
07:39 - Speaker:  while learning and rebuilding their lives and their own communities?
07:44 - Speaker:  Legal frameworks inviting youth to describe their conduct
07:48 - Speaker:  could also involve community members to hear and forgive.
07:52 - Speaker:  Called "restorative justice,"
07:54 - Speaker:  such efforts emphasize accountability and service
07:58 - Speaker:  rather than punishment.
08:01 - Speaker:  Many schools in the United States have turned to use restorative justice methods
08:06 - Speaker:  to resolve conflicts and to prevent them,
08:10 - Speaker:  and to disrupt the school-to-prison pipeline.
08:13 - Speaker:  Some American high schools have replaced automatic suspensions
08:17 - Speaker:  with opportunities for victims to narrate their experiences
08:21 - Speaker:  and for offenders to take responsibility for their actions.
08:25 - Speaker:  As they describe their experiences and feelings about a theft
08:29 - Speaker:  or hateful graffiti or a verbal or physical assault,
08:34 - Speaker:  the victims and offenders often express strong emotions.
08:38 - Speaker:  And other members of the community take turns
08:41 - Speaker:  describing the impact of the offense on them.
08:45 - Speaker:  The leader is often a student peer, who is trained to deescalate the conflict
08:51 - Speaker:  and orchestrate a conversation about what the offender can do
08:55 - Speaker:  that would help the victim.
08:57 - Speaker:  Together, they come to an agreement about how to move forward,
09:01 - Speaker:  what the wrongdoer can do to repair the injury
09:04 - Speaker:  and what all could do to better avoid future conflicts.
09:08 - Speaker:  Consider this example, recently in a publication.
09:12 - Speaker:  A young woman named Mercedes M. transferred, in California,
09:17 - Speaker:  from one high school to another
09:19 - Speaker:  after she was so repeatedly suspended in her old high school
09:22 - Speaker:  for getting into fights.
09:24 - Speaker:  And here in her new high school,
09:27 - Speaker:  two other young women accused her of lying
09:32 - Speaker:  and called her the b-word.
09:35 - Speaker:  A counselor came over and talked to her and earned enough trust
09:39 - Speaker:  that she acknowledged she had stolen the shoes of one of the other classmates.
09:45 - Speaker:  Turns out, the three of them had known each other for a long time,
09:48 - Speaker:  and they didn't know any other way to deal with each other
09:51 - Speaker:  other than to fight.
09:53 - Speaker:  The facilitator invited them to participate in a circle,
09:58 - Speaker:  a confidential conversation about what happened,
09:60 - Speaker:  and they agreed.
10:01 - Speaker:  And initially, each of them expressed a lot of emotion.
10:07 - Speaker:  And then Mercedes apologized.
10:11 - Speaker:  And she said she had stolen the shoes,
10:13 - Speaker:  but she did so because she wanted to sell them
10:17 - Speaker:  and take the money to pay for a drug test
10:21 - Speaker:  so that her mother could show she was clean
10:24 - Speaker:  and try to regain custody of two younger children
10:28 - Speaker:  who were then in state protective care.
10:33 - Speaker:  The other girls heard this,
10:35 - Speaker:  saw Mercedes crying
10:37 - Speaker:  and they hugged her.
10:39 - Speaker:  They did not ask her to return what she'd stolen,
10:42 - Speaker:  but they did say they wanted a restart.
10:44 - Speaker:  They wanted a reason they could trust her.
10:47 - Speaker:  Later, Mercedes explained
10:49 - Speaker:  that she was sure she would have been suspended
10:51 - Speaker:  if they hadn't had this process.
10:53 - Speaker:  And her high school has reduced suspensions by more than half
10:57 - Speaker:  through the use of this kind of restorative justice method.
11:01 - Speaker:  Restorative justice alternatives involve offenders and victims
11:05 - Speaker:  in communicating in ways
11:07 - Speaker:  that an adversarial and defensive process does not allow,
11:10 - Speaker:  and it's become the go-to method
11:13 - Speaker:  in places like the District of Columbia juvenile justice system
11:17 - Speaker:  and innovations like Los Angeles's Teen Court.
11:22 - Speaker:  If tuned to fairness,
11:25 - Speaker:  forgiveness methods like bankruptcy would be available
11:29 - Speaker:  not only for the for-profit college that goes belly-up
11:33 - Speaker:  but also for the students stuck with the loans;
11:37 - Speaker:  pardons would not be given to campaign contributors;
11:40 - Speaker:  and black men would no longer have 20 percent longer criminal sentences
11:45 - Speaker:  than do white men,
11:46 - Speaker:  due to how judges exercise discretion.
11:50 - Speaker:  Forgiveness across the board is one way to avoid such biases.
11:56 - Speaker:  Sometimes, a society just needs a reset
12:00 - Speaker:  when it comes to punishment and debt.
12:03 - Speaker:  The Bible calls for periodic forgiveness of debts
12:08 - Speaker:  and freeing prisoners,
12:11 - Speaker:  and it recently helped to inspire a global movement.
12:15 - Speaker:  Jubilee 2000 joined Pope John Paul II
12:19 - Speaker:  and rock star Bono and over 60 nations
12:22 - Speaker:  in an effort to seek the cancellation and succeed in canceling
12:27 - Speaker:  the debt of developing countries,
12:29 - Speaker:  amounting to over 100 billion dollars of debt canceled,
12:36 - Speaker:  resulting in measurable reduction in poverty.
12:41 - Speaker:  In a similar spirit, there are people who are copying the techniques
12:44 - Speaker:  of commercial debt collectors
12:46 - Speaker:  who purchase debt for pennies on the dollar
12:49 - Speaker:  and then seek to enforce it.
12:52 - Speaker:  Late-night television host John Oliver partnered with a nonprofit group
12:56 - Speaker:  called RIP Medical Debt,
12:60 - Speaker:  and for only 60,000 dollars,
13:02 - Speaker:  they purchased 15 million dollars' worth of medical debt,
13:07 - Speaker:  and then they forgave it.
13:16 - Speaker:  That allowed nearly 9,000 people to have a restart in their lives.
13:23 - Speaker:  This kind of precedent should trigger and encourage more such actions.
13:28 - Speaker:  It's time for a reset,
13:30 - Speaker:  given mass incarceration,
13:31 - Speaker:  medical and consumer debt
13:34 - Speaker:  and given indigent criminal defendants
13:36 - Speaker:  who are charged and put in debt
13:39 - Speaker:  because they're expected to pay for their own probation officers
13:43 - Speaker:  and their own electronic monitors.
13:46 - Speaker:  Forgiving violations of law
13:49 - Speaker:  or promises to pay back loans
13:51 - Speaker:  does pose risks.
13:53 - Speaker:  Forgiveness may encourage more violations.
13:56 - Speaker:  Economists even have a name for it.
13:58 - Speaker:  They call it "moral hazard."
14:02 - Speaker:  Should there be amnesty for immigration violations?
14:05 - Speaker:  Should a president offer pardons to protect himself
14:09 - Speaker:  or to induce lawbreaking?
14:11 - Speaker:  These are tough questions for our time.
14:15 - Speaker:  But escalating resentments hold their own dangers.
14:19 - Speaker:  So does attributing blame to individuals
14:22 - Speaker:  for circumstances largely outside their own control.
14:26 - Speaker:  To ask how law may forgive is not to deny the fact of wrongdoing.
14:33 - Speaker:  Rather, it's to widen the lens
14:37 - Speaker:  to enable glimpses of the larger patterns
14:40 - Speaker:  and to enable new choices that can go forward
14:44 - Speaker:  if we can wipe the slate clean.
14:47 - Speaker:  Thank you.`

/**
 * NOTE: This is a fictional workshop transcript for testing engagement interventions
 * Design Thinking Workshop: Reimagining the Employee Onboarding Experience
 * Facilitator: Marcus Chen
 *
 * This transcript is designed to be participatory with natural pauses,
 * audience interaction, and moments that invite PROVOCATION and PLAY interventions.
 */
const designWorkshopTranscript = `00:15 | Marcus: Alright everyone, welcome to our design thinking workshop on reimagining employee onboarding.
00:22 | Marcus: Before we dive in, I want to set some ground rules. This is a judgment-free zone.
00:28 | Marcus: Bad ideas don't exist here - only stepping stones to better ones.
00:35 | Marcus: So who here has experienced a truly terrible onboarding? Show of hands.
00:42 | Marcus: Ha! That's about 80% of the room. We've got work to do.
00:50 | Marcus: Let's start with a quick exercise. Turn to the person next to you.
00:56 | Marcus: You have 90 seconds to share the worst onboarding experience you've ever had.
01:03 | Marcus: Go!
02:35 | Marcus: Alright, time! I heard some real horror stories over there in the back.
02:42 | Marcus: Let's hear a few. Who wants to share? Don't be shy.
02:50 | Participant: I once spent my entire first week without a computer login.
02:56 | Marcus: A week! That's impressive in the worst way. Anyone beat that?
03:04 | Participant: I didn't meet my manager for three weeks. Found out later they were on vacation.
03:12 | Marcus: Oh that's painful. These stories are gold for what we're designing against.
03:20 | Marcus: Now here's the thing - and I want you to really sit with this.
03:27 | Marcus: The average company spends $4,000 per hire on recruiting and onboarding.
03:34 | Marcus: But 33% of new hires look for a new job within their first 6 months.
03:41 | Marcus: That's a third of your investment potentially walking out the door.
03:48 | Marcus: What do you think is driving that? Shout it out.
03:54 | Participant: Unclear expectations.
03:57 | Participant: No sense of belonging.
04:00 | Participant: Information overload day one.
04:04 | Marcus: All great observations. Let me add one more that might be controversial.
04:12 | Marcus: Most onboarding programs are designed for the company, not the employee.
04:19 | Marcus: We optimize for compliance checkboxes, not human connection.
04:26 | Marcus: Agree? Disagree? I see some skeptical faces.
04:33 | Participant: I mean, compliance is important though. You can't skip that.
04:39 | Marcus: Absolutely! But does it have to be a 4-hour PowerPoint on day one?
04:46 | Marcus: Or could we find ways to weave it in over the first month?
04:53 | Marcus: That's a design challenge, not a constraint.
05:00 | Marcus: Okay, let's move to our empathy mapping exercise.
05:07 | Marcus: You each have a worksheet. I want you to think about a new hire - day one.
05:15 | Marcus: What are they thinking? What are they feeling? What are they seeing and hearing?
05:23 | Marcus: Take 5 minutes. Really put yourself in their shoes.
10:30 | Marcus: Alright, pens down. Let's hear some insights.
10:37 | Marcus: What did you put for "feeling"?
10:42 | Participant: Anxious. Excited but mostly anxious.
10:47 | Participant: Imposter syndrome kicking in hard.
10:52 | Marcus: That imposter syndrome point is huge. Everyone feels it, nobody admits it.
11:00 | Marcus: What if onboarding actually acknowledged that? What would that look like?
11:08 | Participant: Maybe having new hires meet with people who struggled at first but succeeded?
11:15 | Marcus: I love that. Normalize the struggle. What else?
11:22 | Participant: A buddy system where you can ask dumb questions safely.
11:28 | Marcus: Yes! Permission to be a beginner. Write that down everyone.
11:35 | Marcus: Now here's where it gets interesting.
11:40 | Marcus: We're going to do a crazy 8s exercise. Eight ideas in eight minutes.
11:48 | Marcus: Don't filter yourselves. Quantity over quality right now.
11:55 | Marcus: The wildest idea might contain the seed of something brilliant.
12:02 | Marcus: Ready? Your challenge: How might we make a new hire feel like they belong in week one?
12:12 | Marcus: Go!
20:15 | Marcus: Time! Let's do a gallery walk. Post your sheets on the wall.
20:23 | Marcus: I'm seeing some wild ones up here. New hire scavenger hunt - tell me more!
20:32 | Participant: It's like, they have to find and meet 10 people their first week. Each person gives them a clue to the next.
20:42 | Marcus: That's actually genius. Gamified networking. The introverts are cringing but admit it works.
20:52 | Marcus: What about this one - First day failure celebration?
21:00 | Participant: You intentionally set them up to make a small, safe mistake. Then celebrate that they learned something.
21:10 | Marcus: Oh that's provocative. Who thinks that's terrible? Be honest.
21:17 | Participant: It sounds stressful. I wouldn't want to fail on purpose.
21:23 | Marcus: Fair. But what if it reframes failure as learning? What's the fear we're trying to dissolve?
21:32 | Participant: The fear that making mistakes will get you fired.
21:37 | Marcus: Exactly. And if we don't address that fear, when does it go away? Maybe never.
21:45 | Marcus: Okay, let's vote. Everyone gets three dots. Put them on the ideas you'd want to prototype.
23:30 | Marcus: Alright, I'm seeing clear winners here. Scavenger hunt, buddy system, and wow, failure celebration got votes!
23:42 | Marcus: We're going to break into three groups. Each group prototypes one concept.
23:50 | Marcus: You have 15 minutes to create a rough prototype. Use the supplies on the table.
23:58 | Marcus: Don't overthink it. Scrappy is good. We're testing concepts, not building products.
24:06 | Marcus: Go!`

export async function createUser(pseudonym) {
  const user = {
    _id: new mongoose.Types.ObjectId(),
    username: faker.name.findName(),
    email: faker.internet.email().toLowerCase(),
    password: 'password1',
    role: 'user',
    isEmailVerified: false,
    pseudonyms: [
      {
        _id: new mongoose.Types.ObjectId(),
        token: '31c5d2b7d2b0f86b2b4b204',
        pseudonym,
        active: 'true'
      }
    ]
  }
  await insertUsers([user])
  return user
}

export async function createMessage(
  body,
  user,
  conversation,
  channels: string[] = [],
  createdAt = new Date()
): Promise<IMessage> {
  const messageData = {
    body,
    bodyType: typeof body === 'object' ? 'json' : 'text',
    conversation: conversation._id,
    pseudonym: user.pseudonyms[0].pseudonym,
    pseudonymId: user.pseudonyms[0]._id,
    owner: user._id,
    channels,
    fromAgent: false,
    pause: false,
    visible: true,
    createdAt,
    updatedAt: createdAt,
    upVotes: [],
    downVotes: []
  }

  // NOTE: Message is NOT automatically saved to DB or added to conversation
  // For mediator tests, use prepareMessagesForAgent() after creating all messages
  // For other tests (eventAssistant), messages are handled differently

  return messageData
}

export async function createDirectMessage(body, user, conversation, createdAt = new Date()) {
  const msg = await createMessage(body, user, conversation, [`direct-agents-${user._id}`], createdAt)
  return msg
}

export async function createParticipantMessage(user, body, conversation, createdAt = new Date()) {
  const msg = await createMessage(body, user, conversation, ['participant'], createdAt)
  return msg
}

export async function createPublicTopic() {
  await insertTopics([{ ...publicTopic, _id: new mongoose.Types.ObjectId() }])
  return publicTopic
}

export async function loadTestTranscript(conversation, testTranscript, rag = false, delimiter = '|') {
  await loadTranscript(testTranscript, conversation, ['transcript'], delimiter, conversation.startTime)
  if (rag) {
    await transcript.loadEventMetadataIntoVectorStore(conversation)
    await transcript.loadTranscriptIntoVectorStore(conversation.messages, conversation._id)
  }
}

export async function loadPartTimeWorkTranscript(conversation, rag = false) {
  await loadTestTranscript(conversation, partTimeWorkTranscript, rag)
}

export async function loadAliensTranscript(conversation, rag = false) {
  await loadTestTranscript(conversation, aliensTranscript, rag, '-')
}

export async function loadDesignWorkshopTranscript(conversation, rag = false) {
  await loadTestTranscript(conversation, designWorkshopTranscript, rag)
}

export async function loadForgivenessTranscript(conversation, rag = false) {
  await loadTestTranscript(conversation, forgivenessTranscript, rag, '-')
}

export async function createConversation(conversationObj, owner, topic, startTime = new Date()) {
  const conversationConfig = {
    ...conversationObj,
    owner: owner._id,
    topic: topic._id,
    enableAgents: true,
    agents: [],
    messages: [],
    startTime
  }
  const conversation = new Conversation(conversationConfig)
  await conversation.save()
  return conversation
}

export async function createEventAssistantConversation(conversationObj, owner, topic, startTime, llmPlatform?, llmModel?) {
  const conversation = await createConversation(conversationObj, owner, topic, startTime)
  const agent = new Agent({
    agentType: 'eventAssistant',
    conversation,
    llmPlatform,
    llmModel
  })
  const channels = await Channel.create([
    { name: 'transcript' },
    { name: 'chat' },
    { name: 'image-gen' },
    { name: `direct-agents-${owner._id}`, direct: true, participants: [owner, agent] }
  ])
  conversation.channels.push(...channels)
  await agent.save()
  conversation.agents.push(agent)
  await conversation.save()
  await agent.initialize()
  await agent.start()
  return conversation
}

export async function createEventAssistantPlusConversation(
  conversationObj,
  owner,
  topic,
  startTime,
  llmPlatform?,
  llmModel?
) {
  const conversation = await createConversation(conversationObj, owner, topic, startTime)
  const agent = new Agent({
    agentType: 'eventAssistantPlus',
    conversation,
    llmPlatform,
    llmModel
  })
  const channels = await Channel.create([
    { name: 'transcript' },
    { name: `direct-agents-${owner._id}`, direct: true, participants: [owner, agent] },
    { name: 'participant' },
    { name: 'chat' },
    { name: 'image-gen' }
  ])
  conversation.channels.push(...channels)
  await agent.save()
  conversation.agents.push(agent)
  await conversation.save()
  await agent.initialize()
  await agent.start()
  return conversation
}

export async function createBackChannelConversation(conversationObj, owner, topic, startTime, llmPlatform, llmModel) {
  const conversation = await createConversation(conversationObj, owner, topic, startTime)
  const channels = await Channel.create([{ name: 'moderator' }, { name: 'participant' }])
  conversation.channels.push(...channels)

  const agent = new Agent({
    agentType: 'backChannelInsights',
    conversation,
    llmPlatform,
    llmModel
  })
  await agent.save()
  conversation.agents.push(agent)
  await conversation.save()
  await agent.initialize()
  await agent.start()
  return conversation
}

export async function createEventMediatorConversation(
  conversationObj,
  owner,
  topic,
  startTime,
  llmPlatform?,
  llmModel?,
  additionalUsers: (typeof owner)[] = []
) {
  const conversation = await createConversation(conversationObj, owner, topic, startTime)
  const agent = new Agent({
    agentType: 'eventMediator',
    conversation,
    llmPlatform,
    llmModel
  })

  // Create channels for owner and all additional users
  const allUsers = [owner, ...additionalUsers]
  const directChannels = allUsers.map((user) => ({
    name: `direct-agents-${user._id}`,
    direct: true,
    participants: [user, agent]
  }))

  // Note: Basic mediator does NOT have moderator channel - only Plus version does
  const channels = await Channel.create([{ name: 'transcript' }, { name: 'chat' }, ...directChannels])
  conversation.channels.push(...channels)
  await agent.save()
  conversation.agents.push(agent)
  await conversation.save()
  await agent.initialize()
  await agent.start()
  return conversation
}

export async function createEventMediatorPlusConversation(
  conversationObj,
  owner,
  topic,
  startTime,
  llmPlatform?,
  llmModel?,
  additionalUsers: (typeof owner)[] = []
) {
  const conversation = await createConversation(conversationObj, owner, topic, startTime)
  const agent = new Agent({
    agentType: 'eventMediatorPlus',
    conversation,
    llmPlatform,
    llmModel
  })

  // Create channels for owner and all additional users
  const allUsers = [owner, ...additionalUsers]
  const directChannels = allUsers.map((user) => ({
    name: `direct-agents-${user._id}`,
    direct: true,
    participants: [user, agent]
  }))

  const channels = await Channel.create([{ name: 'transcript' }, { name: 'chat' }, { name: 'moderator' }, ...directChannels])
  conversation.channels.push(...channels)
  await agent.save()
  conversation.agents.push(agent)
  await conversation.save()
  await agent.initialize()
  await agent.start()
  return conversation
}

export async function createEngagementAgentConversation(
  conversationObj,
  owner,
  topic,
  startTime,
  llmPlatform?,
  llmModel?,
  additionalUsers: (typeof owner)[] = []
) {
  const conversation = await createConversation(conversationObj, owner, topic, startTime)
  const agent = new Agent({
    agentType: 'engagementAgent',
    conversation,
    llmPlatform,
    llmModel
  })

  // Create channels for owner and all additional users
  const allUsers = [owner, ...additionalUsers]
  const directChannels = allUsers.map((user) => ({
    name: `direct-agents-${user._id}`,
    direct: true,
    participants: [user, agent]
  }))

  const channels = await Channel.create([{ name: 'transcript' }, { name: 'chat' }, ...directChannels])
  conversation.channels.push(...channels)
  await agent.save()
  conversation.agents.push(agent)
  await conversation.save()
  await agent.initialize()
  await agent.start()
  return conversation
}

/**
 * Prepares messages for mediator agent testing by:
 * 1. Saving messages to the Message collection in the database
 * 2. Reloading the agent's conversation from database with populated messages and channels
 *
 * This ensures the agent can see all messages when its respond() method is called.
 * This matches how the agent handler populates the conversation in production.
 *
 * @param messages - Array of message objects to add
 * @param conversation - The conversation to add messages to
 * @param agent - The agent whose conversation reference needs refreshing
 * @returns The refreshed conversation with all messages visible to agent
 */
export async function prepareMessagesForAgent(messages: IMessage[], conversation, agent) {
  // 1. Save messages to database (conversation.messages is a virtual field, so we need to insert into Message collection)
  await Message.insertMany(messages)

  // 2. Reload the agent's conversation reference from database with messages AND channels
  // This matches the pattern in src/jobs/handlers/agent.ts
  // eslint-disable-next-line no-param-reassign
  agent.conversation = await Conversation.findById(conversation._id).populate('messages').populate('channels')

  return agent.conversation
}

// TODO: refactor createJargonFilterConversation and createEngagementAgentConversation into a shared
// createAgentConversation helper that accepts agentType as a parameter.

/**
 * NOTE: Synthetic transcript designed to contain technical jargon for jargon filter agent tests.
 */
export const jargonTranscript = `00:10 | Dr. Chen: Today we'll cover how our platform achieves sub-millisecond p99 latency at scale.
00:18 | Dr. Chen: The key is our use of consistent hashing across the Kafka partitions to avoid hot spots.
00:26 | Dr. Chen: We also rely heavily on write-ahead logging to ensure durability without sacrificing throughput.
00:35 | Dr. Chen: Our SLOs are defined in terms of error budget — we allow 0.1% failure rate per rolling 30-day window.
00:44 | Dr. Chen: The service mesh handles mTLS termination at the sidecar level, so app code never touches certs.
00:52 | Dr. Chen: We use exponential backoff with jitter for all retry logic to prevent thundering herd after an outage.
01:01 | Dr. Chen: Our MTTR improved dramatically once we introduced structured logging with correlation IDs across services.`

/**
 * NOTE: Synthetic transcript with no technical jargon for negative test cases.
 */
export const plainLanguageTranscript = `00:10 | Sarah: Welcome everyone, glad you could join us today.
00:15 | Sarah: We're going to talk about how our team works together to solve problems.
00:22 | Sarah: The most important thing we've learned is that clear communication saves time.
00:30 | Sarah: When someone raises a concern early, the whole team benefits.
00:38 | Sarah: We hold a short meeting each morning to check in and share updates.
00:45 | Sarah: Anyone can bring a problem to the table — no idea is too small.`

export async function createJargonFilterConversation(
  conversationObj,
  owner,
  topic,
  startTime,
  llmPlatform?,
  llmModel?,
  additionalUsers: (typeof owner)[] = []
) {
  const conversation = await createConversation(conversationObj, owner, topic, startTime)
  const agent = new Agent({
    agentType: 'jargonFilterAgent',
    conversation,
    llmPlatform,
    llmModel
  })

  const allUsers = [owner, ...additionalUsers]
  const directChannels = allUsers.map((user) => ({
    name: `direct-agents-${user._id}`,
    direct: true,
    participants: [user, agent]
  }))

  const channels = await Channel.create([{ name: 'transcript' }, { name: 'chat' }, ...directChannels])
  conversation.channels.push(...channels)
  await agent.save()
  conversation.agents.push(agent)
  await conversation.save()
  await agent.initialize()
  await agent.start()
  return conversation
}
