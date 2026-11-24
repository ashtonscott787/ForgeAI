/**
 * A shell, and letting the assistant use it.
 *
 * This is the most dangerous thing in the application, so the rules come
 * before the code:
 *
 * 1. The assistant never runs anything on its own. It can only *propose* a
 *    command. The command appears in full, and nothing happens until the
 *    person presses Run on that exact text. There is no "allow all", no
 *    remembered approval and no automatic mode, because a model that has
 *    misread the situation will propose a confident, specific, wrong
 *    command, and the only thing standing between that and a wiped folder
 *    is somebody reading it.
 * 2. Some commands are refused outright, even when a person presses Run.
 *    Not because people cannot be trusted with their own computer — they
 *    can — but because a proposal that reads plausibly and recursively
 *    deletes a home directory is exactly the failure this feature invites,
 *    and the refusal costs an experienced person one trip to a real
 *    terminal.
 * 3. It runs in one working directory, chosen by the person, and says which.
 *
 * What this is NOT: a terminal emulator. Commands run through a pipe, not a
 * pseudo-terminal, so programs that take over the screen — vim, less, top,
 * anything asking for a password — will hang rather than work, and the
 * interface says so. Doing it properly needs a native pty module built for
 * each platform; a pipe is honest about what it is.
 */
const { spawn } = require("node:child_process");
const os = require("node:os");

/** Marks the end of one command's output, and carries its exit code. */
const DONE = "__forge_done_";

/**
 * Commands refused however they arrive.
 *
 * Deliberately short. A long list of patterns gives the impression of safety
 * it cannot deliver — anything here can be written another way — so this
 * catches the few shapes that are catastrophic, unambiguous and easy to
 * produce by accident or by a model's confident mistake. It is a guard
 * rail, not a sandbox, and the comment in the interface says exactly that.
 */
const REFUSED = [
  // The trailing slash matters: "rm -rf $HOME/" got through the first
  // version of this, which required whitespace or end-of-string after the
  // path. A test now covers every spelling of it.
  { re: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+(\/|~|\$HOME|\$\{HOME\}|\.\.)\/?(\s|;|&|\||$)/i, why: "it deletes a whole tree from the top of the disk or your home folder" },
  { re: /\brm\s+-[a-z]*[rf][a-z]*\s+\*/i, why: "it deletes everything in the working directory" },
  { re: /\b(mkfs|fdisk|diskutil\s+erase|format\s+[a-z]:)/i, why: "it formats a disk" },
  { re: />\s*\/dev\/(sd|disk|nvme)/i, why: "it writes directly to a disk device" },
  { re: /\bdd\b[^|;]*\bof=\/dev\//i, why: "it writes directly to a disk device" },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: "it is a fork bomb" },
  { re: /\bchmod\s+-R\s+777\s+(\/|~)(\s|$)/i, why: "it makes your whole disk writable by anything" },
  { re: /\bsudo\b/i, why: "it asks for administrator rights, and a piped shell cannot prompt for the password — it would hang" },
  { re: /\b(shutdown|reboot|halt)\b/i, why: "it turns the computer off" },
  { re: /\b(curl|wget)\b[^|;]*\|\s*(ba)?sh\b/i, why: "it runs a script downloaded from the internet without anybody reading it" },
];

/**
 * Why this command will not be run, or null if it will.
 *
 * Checked on the exact text that would be executed, every time, including
 * when a person typed it themselves.
 */
function refuse(command) {
  const text = String(command || "");
  if (!text.trim()) return "There is nothing to run.";
  if (text.length > 4000) return "That command is too long to be anything anybody meant to type.";
  if (/\0/.test(text)) return "That command contains a null byte.";
  for (const rule of REFUSED) {
    if (rule.re.test(text)) return `Forge AI will not run that: ${rule.why}. Use a real terminal if you mean it.`;
  }
  return null;
}

/** The shell this machine uses, and the flags that make it read from a pipe. */
function shellFor(platform = process.platform) {
  if (platform === "win32") return { file: process.env.COMSPEC || "cmd.exe", args: [], windows: true };
  return { file: process.env.SHELL || "/bin/bash", args: ["-s"], windows: false };
}

/**
 * The line appended to a command so the end of its output can be recognised.
 *
 * Without it there is no way to tell "the command finished" from "the
 * command is thinking": a pipe gives no prompt and no signal.
 */
function doneLine(id, windows = false) {
  return windows
    ? `echo ${DONE}${id}_%ERRORLEVEL%__`
    : `printf '\\n${DONE}${id}_%d__\\n' "$?"`;
}

const donePattern = (id) => new RegExp(`${DONE}${id}_(\\d+)__`);

/**
 * One shell, kept open, with commands fed to it one at a time.
 *
 * Kept open rather than spawned per command so that `cd` and exported
 * variables persist, which is the whole reason somebody wants a shell rather
 * than a box that runs one thing.
 */
class Session {
  constructor({ cwd, env, platform = process.platform, onData }) {
    const sh = shellFor(platform);
    this.windows = sh.windows;
    this.onData = onData;
    this.cwd = cwd;
    this.queue = [];
    this.current = null;
    this.seq = 0;
    // Its own process group, so interrupting reaches what the shell
    // started and not just the shell. Without this, a timed-out `sleep 30`
    // kept running, its end marker arrived during the next command, and the
    // output of the two ran together.
    this.proc = spawn(sh.file, sh.args, {
      cwd,
      env: { ...env, TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat" },
      windowsHide: true,
      detached: !sh.windows,
    });
    /** Markers from commands that were given up on, to be ignored if they arrive. */
    this.abandoned = new Set();
    // The shell ignores interrupts; the commands it starts do not. Without
    // this, interrupting the process group killed the shell along with the
    // runaway command, and the next command found no session at all.
    // A handler, not SIG_IGN. `trap '' INT` would be inherited by every
    // command the shell starts — an ignored signal survives exec — so the
    // runaway command ignored the interrupt too. A no-op handler leaves
    // children at the default, which is to die.
    if (!this.windows) this.proc.stdin.write("trap ':' INT\n");
    this.proc.stdout.on("data", (c) => this.#take(String(c)));
    this.proc.stderr.on("data", (c) => this.#take(String(c)));
    this.proc.on("exit", (code) => {
      this.closed = true;
      const job = this.current;
      this.current = null;
      job?.finish({ ok: false, code, why: `the shell exited (${code})` });
      for (const q of this.queue.splice(0)) q.finish({ ok: false, why: "the shell exited" });
    });
  }

  #take(chunk) {
    // A command that timed out may still finish later. Its marker is dropped
    // rather than being read as the end of whatever is running now.
    for (const id of this.abandoned) {
      const late = donePattern(id).exec(chunk);
      if (late) {
        this.abandoned.delete(id);
        chunk = chunk.slice(0, late.index) + chunk.slice(late.index + late[0].length);
      }
    }
    if (!chunk) return;
    const job = this.current;
    if (!job) {
      this.onData?.(chunk);
      return;
    }
    job.buffer += chunk;
    const m = donePattern(job.id).exec(job.buffer);
    if (!m) {
      this.onData?.(chunk);
      return;
    }
    const output = job.buffer.slice(0, m.index);
    // Only the part of this chunk that preceded the marker is new output.
    const already = job.buffer.length - chunk.length;
    if (output.length > already) this.onData?.(output.slice(already));
    this.current = null;
    job.finish({ ok: true, code: Number(m[1]), output: output.replace(/\n$/, "") });
    this.#next();
  }

  #next() {
    if (this.current || !this.queue.length || this.closed) return;
    const job = (this.current = this.queue.shift());
    this.proc.stdin.write(`${job.command}\n${doneLine(job.id, this.windows)}\n`);
  }

  /** Runs one command and resolves when its output has finished arriving. */
  run(command, { timeoutMs = 120_000 } = {}) {
    if (this.closed) return Promise.resolve({ ok: false, why: "the shell is not running" });
    return new Promise((resolve) => {
      const id = `${Date.now().toString(36)}${(this.seq += 1).toString(36)}`;
      let settled = false;
      const job = {
        id,
        command,
        buffer: "",
        finish: (r) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(r);
        },
      };
      const timer = setTimeout(() => {
        // The shell is left running: killing it would throw away the
        // directory and variables of everything that came before.
        if (this.current === job) this.current = null;
        this.abandoned.add(job.id);
        // Whatever is still running is stopped, or the next command's output
        // arrives mixed with this one's.
        this.interrupt();
        job.finish({
          ok: false,
          timedOut: true,
          output: job.buffer,
          why: `it produced no end after ${Math.round(timeoutMs / 1000)}s. A command that waits for input cannot work here, because this is a pipe and not a terminal.`,
        });
        this.#next();
      }, timeoutMs);
      this.queue.push(job);
      this.#next();
    });
  }

  /** Interrupts whatever is running, the way Ctrl-C would. */
  interrupt() {
    if (this.closed) return false;
    try {
      // The group, not the shell: a negative pid signals every process in
      // it, which is what Ctrl-C does in a real terminal.
      if (!this.windows && this.proc.pid) process.kill(-this.proc.pid, "SIGINT");
      else this.proc.kill("SIGINT");
      return true;
    } catch {
      try { this.proc.kill("SIGINT"); return true; } catch { return false; }
    }
  }

  stop() {
    this.closed = true;
    try {
      if (!this.windows && this.proc.pid) process.kill(-this.proc.pid, "SIGKILL");
      else this.proc.kill();
    } catch {
      try { this.proc.kill(); } catch { /* already gone */ }
    }
  }
}

const defaultCwd = () => os.homedir();

module.exports = { DONE, REFUSED, refuse, shellFor, doneLine, donePattern, Session, defaultCwd };
