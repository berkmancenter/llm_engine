// ──────────────────────────────────────────────
// HTML page served to recall.ai's embedded browser
// ──────────────────────────────────────────────
const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Agent</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: 100vw; height: 100vh; background: #E9EBFF; overflow: hidden; position: relative; }
  #bot { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
</style>
</head>
<body>
<svg id="bot" viewBox="-583 -299 2400 1350" role="img" aria-label="Bot">
  <defs>
    <clipPath id="visorClip"><rect x="153" y="153" width="929" height="447" rx="223"/></clipPath>
  </defs>
  <g id="rig">
    <g id="hand">
      <rect x="1025" y="40" width="80" height="260" rx="40" fill="#4747CB"/>
      <ellipse cx="985" cy="20" rx="34" ry="52" transform="rotate(-28 985 20)" fill="#A8B2F5" stroke="#4747CB" stroke-width="16"/>
      <rect x="995" y="-120" width="140" height="190" rx="70" fill="#A8B2F5" stroke="#4747CB" stroke-width="16"/>
    </g>
    <path d="M380 18 H855 A362 362 0 0 1 1217 380 V735 H380 A362 358.5 0 0 1 18 376.5 A362 358.5 0 0 1 380 18 Z" fill="#4747CB"/>
    <rect x="153" y="153" width="929" height="447" rx="223" fill="#A8B2F5"/>
    <g clip-path="url(#visorClip)">
      <rect id="glow" x="153" y="153" width="929" height="447" fill="#fff" opacity="0"/>
    </g>
    <g id="eyeL"><circle cx="380" cy="377" r="113"/><circle cx="337" cy="332" r="23" fill="#fff"/></g>
    <g id="eyeR"><circle cx="878" cy="377" r="113"/><circle cx="834" cy="332" r="23" fill="#fff"/></g>
    <rect id="mouth" x="569" y="515" width="120" height="10" rx="5" fill="#000" opacity="0"/>
  </g>
</svg>

<script src="/socket.io/socket.io.js"></script>
<script type="module">
  import { createAudioQueue } from '/client.js'

  // ── Bot animation: idle / hand-raised / speaking ────────────────────
  // Runs continuously (idle included) so the character always reads as alive, not frozen.
  const rig = document.getElementById('rig')
  const hand = document.getElementById('hand')
  const eyeL = document.getElementById('eyeL')
  const eyeR = document.getElementById('eyeR')
  const mouth = document.getElementById('mouth')
  const glow = document.getElementById('glow')

  const botState = { current: 'idle', handRaisedAt: 0 }
  const cur = { lx: 0, ly: 0, eyeS: 1, tilt: 0, hand: 0, mouth: 0, glow: 0 }
  let level = 0
  let last = performance.now()
  let blinkAt = last + 1800
  let blinkStart = -1
  let wander = { x: 0, y: 0 }
  let nextWander = last + 3000
  let syl = { start: 0, dur: 0, amp: 0 }

  // Real amplitude, from the envelope the server computed for whichever chunk is currently
  // playing (see audioEnvelope.ts) — fed in by the audio queue's play() below, keyed to real
  // playback position. extAt tracks when it was last updated so a stale value (nothing
  // playing, or between chunks) doesn't linger: frame() falls back to the synthetic babble
  // curve below once a beat has passed since the last update.
  let extLevel = null
  let extAt = 0
  const EXT_LEVEL_STALE_MS = 300
  // state flips to 'speaking' the instant call-upon matches, before the first queued chunk
  // has actually started playing (see audio queue below) — without this, frame() would fall
  // back to the synthetic babble immediately and the mouth would start moving before any
  // real audio has begun. Reset false on every fresh entry into 'speaking'; only set true once
  // a real chunk has actually started (see 'playing' in the audio queue below), so babble is
  // only ever used to bridge a gap between chunks that are already underway, never to cover
  // for one that hasn't started yet.
  let hasPlayedAudioThisTurn = false

  function setExternalLevel(v) {
    extLevel = Math.max(0, Math.min(1, Number(v) || 0))
    extAt = performance.now()
    hasPlayedAudioThisTurn = true
  }

  // Fallback for when there's no fresh real level to use — between chunks, or if envelope
  // computation failed for one server-side (see engineSocket.ts's message:chunk handler).
  function simLevel(now) {
    if (now > syl.start + syl.dur) {
      const pause = Math.random() < 0.16
      syl = {
        start: now,
        dur: pause ? 220 + Math.random() * 320 : 120 + Math.random() * 150,
        amp: pause ? 0 : 0.45 + Math.random() * 0.55
      }
    }
    const p = Math.min(1, (now - syl.start) / syl.dur)
    return syl.amp * Math.pow(Math.sin(Math.PI * p), 0.8)
  }

  function targets() {
    const T = { lx: wander.x, ly: wander.y, eyeS: 1, tilt: 0, hand: 0, mouth: 0, glow: 0 }
    if (botState.current === 'hand-raised') {
      T.lx = 22; T.ly = -20; T.eyeS = 1.08; T.tilt = 3; T.hand = 1
    } else if (botState.current === 'speaking') {
      T.lx = wander.x * 0.3; T.ly = 0; T.mouth = 1; T.glow = 0.4
    }
    return T
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    const t = now / 1000
    const k = 1 - Math.exp(-dt * 7)

    if (now > nextWander) {
      wander = { x: (Math.random() * 2 - 1) * 18, y: (Math.random() * 2 - 1) * 10 }
      nextWander = now + 3500 + Math.random() * 4500
    }
    const T = targets()
    for (const key in cur) cur[key] += (T[key] - cur[key]) * k

    const hasFreshExtLevel = extLevel !== null && now - extAt < EXT_LEVEL_STALE_MS
    const raw =
      botState.current === 'speaking'
        ? hasFreshExtLevel
          ? extLevel
          : hasPlayedAudioThisTurn
            ? simLevel(now)
            : 0
        : 0
    level += (raw - level) * (1 - Math.exp(-dt * 22))
    const sp = botState.current === 'speaking' ? level : 0

    // blink
    let blink = 1
    if (blinkStart < 0 && now > blinkAt) blinkStart = now
    if (blinkStart >= 0) {
      const p = (now - blinkStart) / 170
      if (p >= 1) {
        blinkStart = -1
        blinkAt = now + 2200 + Math.random() * 3500
      } else {
        blink = 1 - 0.92 * Math.sin(Math.PI * p)
      }
    }

    // body: slow breathing at rest, a small bob while speaking
    const breathe = 1 + 0.008 * Math.sin((t * 2 * Math.PI) / 4)
    const ty = -14 * sp
    const sy = 1 + 0.025 * sp
    rig.setAttribute(
      'transform',
      \`translate(0 \${ty.toFixed(2)}) translate(617 376) rotate(\${cur.tilt.toFixed(2)}) scale(\${breathe.toFixed(4)} \${(breathe * sy).toFixed(4)}) translate(-617 -376)\`
    )

    // eyes
    const squint = 1 - 0.1 * sp
    const es = cur.eyeS
    const ey = es * blink * squint
    eyeL.setAttribute(
      'transform',
      \`translate(\${cur.lx.toFixed(2)} \${cur.ly.toFixed(2)}) translate(380 377) scale(\${es.toFixed(3)} \${ey.toFixed(3)}) translate(-380 -377)\`
    )
    eyeR.setAttribute(
      'transform',
      \`translate(\${cur.lx.toFixed(2)} \${cur.ly.toFixed(2)}) translate(878 377) scale(\${es.toFixed(3)} \${ey.toFixed(3)}) translate(-878 -377)\`
    )

    // mouth: opens/widens with the voice level (real, from the server-computed envelope,
    // when available and fresh — simulated babble otherwise)
    const mh = 10 + 62 * level
    const mw = 120 - 26 * level
    mouth.setAttribute('x', (629 - mw / 2).toFixed(1))
    mouth.setAttribute('width', mw.toFixed(1))
    mouth.setAttribute('y', (525 - mh / 2).toFixed(1))
    mouth.setAttribute('height', mh.toFixed(1))
    mouth.setAttribute('rx', Math.min(mh / 2, mw / 2).toFixed(1))
    mouth.setAttribute('opacity', cur.mouth.toFixed(3))

    // a faint visor glow that pulses with the level while speaking
    glow.setAttribute('opacity', (cur.glow * 0.38 * level).toFixed(3))

    // hand: pops up and gives a short wave, then holds raised
    const since = now - botState.handRaisedAt
    const waveAmp = botState.current === 'hand-raised' ? 11 * Math.exp(-since / 1300) + 1.5 : 0
    const wave = waveAmp * Math.sin((t * 2 * Math.PI) / 0.9)
    const hy = 380 + (-30 - 380) * cur.hand
    hand.setAttribute('transform', \`translate(0 \${hy.toFixed(2)}) rotate(\${wave.toFixed(2)} 1065 300)\`)

    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  function setBotState(state) {
    if (state === 'hand-raised' && botState.current !== 'hand-raised') botState.handRaisedAt = performance.now()
    if (state === 'speaking' && botState.current !== 'speaking') hasPlayedAudioThisTurn = false
    botState.current = state
  }

  const params = new URLSearchParams(location.search)
  const audioEnabled = params.get('audio') !== 'false'

  if (audioEnabled) {
    const conversationId = params.get('conversationId')
    const botName = params.get('botName')
    const transcriptPasscode = params.get('transcriptPasscode')
    // audio=false never reaches this branch, so no socket.io connection is opened at all
    // for it — no llm_engine socket gets created server-side (see browserIO.on('connection')).
    const socket = io({ query: { conversationId, botName, transcriptPasscode } })

    // ── Audio queue ────────────────────────────────
    // Each chunk arrives as { audio, envelope, envelopeWindowMs } — audio is a binary payload
    // (an ArrayBuffer — socket.io-client's default binaryType in a browser), not a base64
    // string, so it goes straight into a Blob with no decode step. envelope (possibly empty —
    // see engineSocket.ts) is the server-computed amplitude curve for this chunk; while it
    // plays, a timer keyed to Audio.currentTime feeds the matching envelope value into
    // setExternalLevel so the mouth tracks the real audio instead of the simulated fallback.
    const audioQueue = createAudioQueue({
      play: ({ audio: audioBytes, envelope, envelopeWindowMs }) => {
        const blob = new Blob([audioBytes], { type: 'audio/wav' })
        const url = URL.createObjectURL(blob)
        return new Promise((resolve) => {
          const audio = new Audio(url)
          let envelopeTimer = null
          // 'playing' (not the play()/'play' request) is the one event that means audio is
          // actually audible now — play() itself resolves once a request to play was
          // accepted, before decode/buffering finishes. Starting the timer any earlier reads
          // currentTime while it's still 0 and feeds in envelope[0] before any sound plays —
          // rare (only when that startup latency exceeds one tick), but a real mouth-before-
          // audio glitch when it happens.
          function startEnvelopeTimer() {
            if (envelope.length === 0 || envelopeTimer) return
            envelopeTimer = setInterval(() => {
              const idx = Math.min(envelope.length - 1, Math.floor((audio.currentTime * 1000) / envelopeWindowMs))
              setExternalLevel(envelope[idx])
            }, envelopeWindowMs)
          }
          function cleanup() {
            if (envelopeTimer) clearInterval(envelopeTimer)
            URL.revokeObjectURL(url)
          }
          audio.addEventListener('playing', startEnvelopeTimer)
          audio.onended = () => { cleanup(); resolve() }
          audio.onerror = () => { cleanup(); resolve() }
          audio.play().catch(() => { cleanup(); resolve() })
        })
      },
      onFinished: () => socket.emit('audio:finished')
    })

    socket.on('state', ({ state }) => setBotState(state))
    socket.on('audio:chunk', (chunk) => {
      audioQueue.push(chunk)
    })
    socket.on('audio:chime', () => {
      const ctx = new AudioContext()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.type = 'sine'
      osc.frequency.value = 880
      gain.gain.setValueAtTime(0.25, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6)
      osc.start(ctx.currentTime)
      osc.stop(ctx.currentTime + 0.6)
    })
  }
</script>
</body>
</html>`

export default PAGE
