import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

/** Converts text to a WAV Buffer via macOS's `say`, held in memory only briefly (the file is
 *  a scratch temp file, always removed after reading). `voice` corresponds to `say -v <voice>`;
 *  omit for the system default. Returns raw bytes, not base64 — callers that need to transmit
 *  it (e.g. over socket.io) can send the Buffer directly as a binary payload rather than
 *  paying to stringify and re-parse it. */
async function textToAudio(text: string, voice?: string): Promise<Buffer> {
  const tmp = path.join(os.tmpdir(), `say_${process.hrtime.bigint()}.wav`)
  try {
    const voiceArgs = voice ? ['-v', voice] : []
    await execFileAsync('say', [...voiceArgs, '-o', tmp, '--data-format=LEI16@44100', text])
    // tmp is built above from os.tmpdir() + a timestamp — never user input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return fs.readFileSync(tmp)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

export default textToAudio
