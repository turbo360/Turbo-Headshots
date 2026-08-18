// QR check-in polling loop. Runs only while a shoot with a serverShootId is
// active; endpoint shapes are isolated here + gallery-client. On failure the
// Check-in screen degrades to manual register (available: false).
class Checkin {
  /**
   * @param {object} deps { settings, shoots, gallery: () => TurboIQGalleryClient|null, push }
   */
  constructor(deps) {
    this.d = deps;
    this.timer = null;
    this.entries = [];
    this.available = false;
    this.intervalMs = 5000;
  }

  activeShoot() {
    const id = this.d.settings.raw.activeShootId;
    return id ? this.d.shoots.getShoot(id) : null;
  }

  state() {
    const shoot = this.activeShoot();
    return {
      available: this.available && !!shoot?.serverShootId,
      entries: this.entries,
      url: shoot?.checkinUrl ?? null,
    };
  }

  setBlurred(blurred) {
    this.intervalMs = blurred ? 15000 : 5000;
  }

  start() {
    this.stop();
    this.timer = setInterval(() => { void this.poll(); }, this.intervalMs);
    void this.poll();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async poll() {
    const shoot = this.activeShoot();
    const client = this.d.gallery();
    if (!shoot?.serverShootId || !client || !client.isAuthenticated() || shoot.status !== 'live') {
      if (this.available || this.entries.length) {
        this.available = false;
        this.entries = [];
        this.d.push('checkin:waiting', this.state());
      }
      return;
    }
    try {
      const res = await client.getCheckinQueue(shoot.serverShootId);
      if (res.success) {
        this.available = true;
        this.entries = (res.entries || []).map((e) => ({
          id: e.id, name: e.name, email: e.email, mobile: e.mobile ?? null, createdAt: e.created_at,
        }));
      } else {
        this.available = false;
      }
    } catch {
      this.available = false;
    }
    this.d.push('checkin:waiting', this.state());
  }

  /**
   * Claim a waiting entry: atomic server-side "use", then create the Person.
   * Returns { ok, person } — 409 (someone else claimed it) surfaces as error.
   */
  async claim(entryId) {
    const shoot = this.activeShoot();
    const client = this.d.gallery();
    if (!shoot || !client) return { ok: false, error: 'No active shoot' };
    const entry = this.entries.find((e) => e.id === entryId);
    if (!entry) return { ok: false, error: 'Entry not in the waiting list' };

    const [firstName, ...rest] = entry.name.trim().split(/\s+/);
    const person = this.d.shoots.createPerson({
      shootId: shoot.id,
      firstName: firstName || entry.name,
      lastName: rest.join(' ') || '—',
      email: entry.email || '',
      mobile: entry.mobile || '',
      company: '',
    });

    const res = await client.useCheckinEntry(entryId, person.shootNumber);
    if (!res.success && res.statusCode === 409) {
      // Someone else claimed it between polls — roll back the person record.
      this.d.shoots.people.update((list) => {
        const i = list.findIndex((p) => p.id === person.id);
        if (i >= 0) list.splice(i, 1);
      });
      await this.poll();
      return { ok: false, error: 'Entry was already claimed' };
    }

    this.entries = this.entries.filter((e) => e.id !== entryId);
    this.d.push('checkin:waiting', this.state());
    this.d.push('people:changed', {});
    return { ok: true, person: this.d.shoots.getPerson(person.id) };
  }
}

module.exports = { Checkin };
