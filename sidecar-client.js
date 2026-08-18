/**
 * Node client for the headshot-sidecar Swift binary.
 * One long-running subprocess; JSON-RPC over stdin/stdout, one line per message.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class SidecarClient {
  constructor(binaryPath) {
    this.binaryPath = binaryPath;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject}
    this.buffer = '';
  }

  start() {
    if (this.proc) return;
    if (!fs.existsSync(this.binaryPath)) {
      throw new Error(`Sidecar binary not found at ${this.binaryPath}`);
    }
    this.proc = spawn(this.binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdin.on('error', (err) => {
      // Sidecar died mid-write: EPIPE here must not crash the app; pending
      // calls are rejected by the 'exit' handler.
      console.error('[sidecar] stdin error:', err.code || err.message);
    });
    this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      // Swift sidecar writes structured logs to stderr. Surface as warnings.
      const trimmed = chunk.trim();
      if (trimmed) console.log(`[sidecar] ${trimmed}`);
    });

    this.proc.on('exit', (code) => {
      console.log(`[sidecar] exited with code ${code}`);
      // Reject all pending
      for (const { reject } of this.pending.values()) {
        reject(new Error(`Sidecar exited with code ${code}`));
      }
      this.pending.clear();
      this.proc = null;
    });
  }

  stop() {
    if (this.proc) {
      try { this.proc.kill('SIGTERM'); } catch (_) { /* ignore */ }
      this.proc = null;
    }
  }

  _onStdout(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const id = msg.id;
        const handler = this.pending.get(id);
        if (handler) {
          this.pending.delete(id);
          if (msg.error) {
            handler.reject(new Error(msg.error));
          } else {
            handler.resolve(msg.result);
          }
        }
      } catch (e) {
        console.log(`[sidecar] non-JSON line: ${line}`);
      }
    }
  }

  async _call(method, params, timeoutMs = 60000) {
    if (!this.proc) this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Sidecar timeout (${timeoutMs}ms) for ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });

      const payload = JSON.stringify({ id, method, params }) + '\n';
      this.proc.stdin.write(payload, (err) => {
      if (err) {
        const pending = this.pending.get(id);
        if (pending) { this.pending.delete(id); pending.reject(new Error(`sidecar write failed: ${err.code || err.message}`)); }
      }
    });
    });
  }

  async ping() { return this._call('ping', {}); }
  async detectFace(imagePath) { return this._call('detectFace', { path: imagePath }); }
  async foregroundMask(imagePath, outputPath) { return this._call('foregroundMask', { path: imagePath, outputPath }, 90000); }
  async qualityCheck(imagePath) { return this._call('qualityCheck', { path: imagePath }); }
}

module.exports = SidecarClient;
